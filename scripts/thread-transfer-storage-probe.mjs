import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const assets = (await import("../src/mastra/rag/storage/assets.ts")).default;
const storage = (await import("../src/mastra/storage/index.ts")).default;
const libraryDb = (await import("../src/mastra/rag/storage/db.ts")).default;
const upload = (await import("../src/mastra/rag/storage/upload.ts")).default;
const folders = (await import("../src/mastra/rag/storage/folders.ts")).default;

await libraryDb.ensureLibrarySchema();

const storageDirectory = storage.getStorageDirectory();
const globalFolder = await folders.createFolder({
  resourceId: "local-account-a",
  name: "Global",
});
const sessionFolder = await folders.createFolder({
  resourceId: "local-account-a",
  name: "Session",
  threadId: "thread-folder-owner",
});
const scopedAsset = await assets.uploadAsset(
  {
    resourceId: "local-account-a",
    filename: "session-note.txt",
    folderId: sessionFolder.id,
    threadId: "thread-folder-owner",
    bytes: Buffer.from("only this thread can retrieve this file"),
  },
  true,
);
for (const input of [
  { folderId: sessionFolder.id },
  { folderId: sessionFolder.id, threadId: "another-thread" },
  { folderId: globalFolder.id, threadId: "thread-folder-owner" },
]) {
  await assert.rejects(
    assets.uploadAsset(
      {
        resourceId: "local-account-a",
        filename: "wrong-scope.txt",
        bytes: Buffer.from(JSON.stringify(input)),
        ...input,
      },
      true,
    ),
    /目录作用域与文件所属会话不一致/,
    "folder upload must use the same global/thread scope as its folder",
  );
}
await assert.rejects(
  upload.createLibraryUploadSession({
    resourceId: "local-account-a",
    filename: "wrong-folder.txt",
    byteSize: 10,
    folderId: sessionFolder.id,
  }),
  /目录作用域与文件所属会话不一致/,
);
const scopedRefs = await libraryDb.withClient((client) =>
  client.execute({
    sql: "SELECT folder_id, thread_id FROM library_asset_refs WHERE asset_id = ?",
    args: [scopedAsset.id],
  }),
);
assert.equal(scopedRefs.rows.length, 1);
assert.equal(String(scopedRefs.rows[0].thread_id), "thread-folder-owner");
assert.equal(
  (await assets.listAssets("local-account-a", "another-thread")).some(
    (asset) => asset.id === scopedAsset.id,
  ),
  false,
);

const sourceAssetId = "source-global-asset";
const sourceStoragePath = join("library", "local-account-a", "so", "global.md");
const sourcePath = join(storageDirectory, sourceStoragePath);
await mkdir(dirname(sourcePath), { recursive: true });
await writeFile(sourcePath, "global attachment content\n");
const timestamp = new Date().toISOString();
await libraryDb.withClient((client) =>
  client.execute({
    sql: `INSERT INTO library_assets
      (id, resource_id, filename, media_type, byte_size, sha256, storage_path,
       status, extracted_text, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      sourceAssetId,
      "local-account-a",
      "global.md",
      "text/markdown",
      26,
      "a".repeat(64),
      sourceStoragePath,
      "indexed",
      "global attachment content",
      timestamp,
      timestamp,
    ],
  }),
);
await assets.attachAssetReference("local-account-a", sourceAssetId);
await assets.attachAssetReference("local-account-a", sourceAssetId, undefined, "thread-accepted");

const request = {
  threadId: "thread-accepted",
  sourceResourceId: "local-account-a",
  targetResourceId: "local-account-b",
  initiatedBy: "local-account-a",
  threadTitle: "Accepted transfer",
};
const [first, duplicate] = await Promise.all([
  assets.requestThreadAssetTransfer(request),
  assets.requestThreadAssetTransfer(request),
]);
assert.equal(first.id, duplicate.id);
assert.equal(first.status, "awaiting_confirmation");
assert.equal(
  await assets.isThreadAssetTransferWriteLocked(request.threadId),
  false,
  "a request awaiting recipient confirmation must not block source-side chats",
);

assert.equal(
  await assets.decideThreadAssetTransferRequest(first.id, "local-account-c", "accept"),
  false,
  "an unrelated local account cannot accept the request",
);
assert.equal((await assets.getThreadAssetTransfer(first.id))?.status, "awaiting_confirmation");
const pendingUpload = await upload.createLibraryUploadSession({
  resourceId: "local-account-a",
  filename: "in-flight.txt",
  byteSize: 10,
  threadId: request.threadId,
});
assert.equal(
  await assets.decideThreadAssetTransferRequest(first.id, "local-account-b", "accept"),
  false,
  "recipient acceptance must wait for an active upload session",
);
assert.equal((await assets.getThreadAssetTransfer(first.id))?.status, "awaiting_confirmation");
assert.equal(await upload.cancelLibraryUploadSession("local-account-a", pendingUpload.id), true);
assert.equal(
  await assets.decideThreadAssetTransferRequest(first.id, "local-account-b", "accept"),
  true,
);
assert.equal(
  await assets.decideThreadAssetTransferRequest(first.id, "local-account-b", "reject"),
  false,
  "a request can be decided only once",
);
assert.equal((await assets.getThreadAssetTransfer(first.id))?.status, "prepared");
assert.equal(
  await assets.isThreadAssetTransferWriteLocked(request.threadId),
  true,
  "an accepted transfer must block writes regardless of the current thread owner",
);
await assert.rejects(
  upload.createLibraryUploadSession({
    resourceId: "local-account-b",
    filename: "recipient-too-late.txt",
    byteSize: 10,
    threadId: request.threadId,
  }),
  /会话正在转交，无法开始上传附件/,
  "the durable upload-session fence must cover the recipient resource too",
);
const lockOrder = [];
let releaseFirstLock;
let firstLockStarted;
const firstLockReady = new Promise((resolve) => {
  firstLockStarted = resolve;
});
const firstLockGate = new Promise((resolve) => {
  releaseFirstLock = resolve;
});
const firstLockRun = assets.withThreadAssetTransferLock(
  "thread-lock-probe",
  async () => {
    lockOrder.push("first-start");
    firstLockStarted();
    await firstLockGate;
    lockOrder.push("first-end");
  },
);
await firstLockReady;
const secondLockRun = assets.withThreadAssetTransferLock(
  "thread-lock-probe",
  async () => lockOrder.push("second"),
);
await assets.withThreadAssetTransferLock("different-thread", async () => {
  lockOrder.push("independent");
});
assert.deepEqual(
  lockOrder,
  ["first-start", "independent"],
  "same-thread operations must wait without blocking unrelated threads",
);
releaseFirstLock();
await Promise.all([firstLockRun, secondLockRun]);
assert.deepEqual(lockOrder, ["first-start", "independent", "first-end", "second"]);
await assert.rejects(
  upload.createLibraryUploadSession({
    resourceId: "local-account-b",
    filename: "too-late.txt",
    byteSize: 10,
    threadId: request.threadId,
  }),
  /会话正在转交，无法开始上传附件/,
);
await assert.rejects(
  assets.attachAssetReference("local-account-b", "late-asset", undefined, request.threadId),
  /会话正在转交，无法添加附件/,
  "the durable attachment fence must cover the recipient resource too",
);
const recoveryOnlyAssetId = "transfer-reconciliation-reference";
await assets.attachAssetReference(
  "local-account-a",
  recoveryOnlyAssetId,
  undefined,
  request.threadId,
  { transferId: first.id },
);
const recoveryOnlyRef = await libraryDb.withClient((client) =>
  client.execute({
    sql: "SELECT 1 FROM library_asset_refs WHERE asset_id = ? AND thread_id = ?",
    args: [recoveryOnlyAssetId, request.threadId],
  }),
);
assert.equal(
  recoveryOnlyRef.rows.length,
  1,
  "the matching transfer may repair its own legacy thread references",
);
await libraryDb.withClient((client) =>
  client.execute({
    sql: "DELETE FROM library_asset_refs WHERE asset_id = ?",
    args: [recoveryOnlyAssetId],
  }),
);
await assert.rejects(
  assets.uploadAsset(
    {
      resourceId: "local-account-a",
      filename: "late-upload.txt",
      bytes: Buffer.from("must not be attached after acceptance"),
      threadId: request.threadId,
    },
    true,
  ),
  /会话正在转交，无法添加附件/,
);
const pendingAfterAcceptance = await assets.listPendingThreadAssetTransfers();
assert.ok(
  pendingAfterAcceptance.some((transfer) => transfer.id === first.id),
  "accepted transfers must be included in startup crash recovery",
);
assert.deepEqual(
  (await assets.listPendingThreadAssetTransfers(first.id)).map((transfer) => transfer.id),
  [first.id],
  "request-time reconciliation must be scoped to the transfer that just completed",
);
await assert.rejects(
  assets.requestThreadAssetTransfer({
    ...request,
    targetResourceId: "local-account-c",
  }),
  (error) => error.name === "ThreadAssetTransferRequestConflict",
  "an in-flight transfer prevents a competing recipient request",
);

const rejectRequest = await assets.requestThreadAssetTransfer({
  ...request,
  threadId: "thread-rejected",
  threadTitle: "Rejected transfer",
});
assert.equal(
  await assets.decideThreadAssetTransferRequest(
    rejectRequest.id,
    "local-account-b",
    "reject",
  ),
  true,
);
assert.equal((await assets.getThreadAssetTransfer(rejectRequest.id))?.status, "rejected");

const sourceHistory = await assets.listThreadAssetTransfersForResource("local-account-a");
const targetHistory = await assets.listThreadAssetTransfersForResource("local-account-b");
assert.equal(sourceHistory.length, 2);
assert.equal(targetHistory.length, 2);
assert.equal((await assets.listThreadAssetTransfersForResource("local-account-c")).length, 0);

const copied = await assets.transferThreadAssetReferences(
  "local-account-a",
  "local-account-b",
  "thread-accepted",
  { transferId: first.id },
);
assert.equal(copied.length, 1);
assert.equal(copied[0].mode, "cloned", "global assets must be copied, not moved");
assert.equal(await readFile(join(storageDirectory, copied[0].storagePath), "utf8"), "global attachment content\n");
assert.equal((await assets.getThreadAssetTransfer(first.id))?.status, "assets_moved");
assert.equal(
  (await assets.getThreadAssetTransfer(first.id))?.assetMappings[sourceAssetId]?.storagePath,
  copied[0].storagePath,
  "the durable journal must contain the clone path before/after copy",
);
await assets.commitThreadAssetTransfer(first.id, "local-account-b");
const sourceRefsAfterCommit = await libraryDb.withClient((client) =>
  client.execute({
    sql: "SELECT folder_id, thread_id FROM library_asset_refs WHERE asset_id = ? AND resource_id = ?",
    args: [sourceAssetId, "local-account-a"],
  }),
);
assert.equal(
  sourceRefsAfterCommit.rows.length,
  1,
  "committing a clone must remove only the source thread ref and preserve its library ref",
);
assert.equal(String(sourceRefsAfterCommit.rows[0].thread_id ?? ""), "");
assert.equal((await assets.getThreadAssetTransfer(first.id))?.status, "committed");

const interrupted = await assets.requestThreadAssetTransfer({
  ...request,
  threadId: "thread-interrupted-copy",
  threadTitle: "Interrupted copy",
});
assert.equal(
  await assets.decideThreadAssetTransferRequest(interrupted.id, "local-account-b", "accept"),
  true,
);
const partialRelativePath = join("library", "local-account-b", "xy", "partial.bin");
const partialPath = join(storageDirectory, partialRelativePath);
await mkdir(dirname(partialPath), { recursive: true });
await writeFile(partialPath, "partial");
await assets.markThreadAssetTransferAssetsPreparing(interrupted.id, "local-account-a", [
  {
    sourceAssetId: "source-partial-asset",
    targetAssetId: "target-partial-asset",
    mode: "cloned",
    storagePath: partialRelativePath,
    asset: {},
  },
]);
const interruptedRecord = await assets.getThreadAssetTransfer(interrupted.id);
assert.equal(interruptedRecord?.status, "assets_preparing");
assert.ok(interruptedRecord);
await assets.cleanupUnregisteredThreadAssetTransferCopies(interruptedRecord);
await assert.rejects(readFile(partialPath), { code: "ENOENT" });
await assert.rejects(
  assets.cleanupUnregisteredThreadAssetTransferCopies({
    ...interruptedRecord,
    assetMappings: {
      "source-partial-asset": {
        targetAssetId: "target-partial-asset",
        mode: "cloned",
        storagePath: join("library", "local-account-b", "..", "escape.bin"),
      },
    },
  }),
  /转交资产路径超出目标账户目录/,
);

const acceptedHistory = targetHistory.find((item) => item.id === first.id);
assert.equal(acceptedHistory?.threadTitle, "Accepted transfer");
assert.deepEqual(acceptedHistory?.events.map((event) => event.action), ["requested", "accepted"]);
assert.equal(acceptedHistory?.events.at(-1)?.actorResourceId, "local-account-b");

const rejectedHistory = sourceHistory.find((item) => item.id === rejectRequest.id);
assert.deepEqual(rejectedHistory?.events.map((event) => event.action), ["requested", "rejected"]);

await libraryDb.cleanupExpiredLibraryUploadSessions().catch(() => undefined);
await storage.appStorage.close();
const client = await storage.getLibsqlClient();
await client.close();
