import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { MASTRA_RESOURCE_ID_KEY, RequestContext } from "@mastra/core/request-context";

const assets = (await import("../src/mastra/rag/storage/assets.ts")).default;
const storage = (await import("../src/mastra/storage/index.ts")).default;
const libraryDb = (await import("../src/mastra/rag/storage/db.ts")).default;
const memoryModule = (await import("../src/mastra/memory/index.ts")).default;
const recoveryModule = (await import("../src/mastra/routes/threads/transfer-recovery.ts")).default;
const phase = process.env.THREAD_TRANSFER_RECOVERY_PHASE;
const sourceResourceId = "isolated-transfer-source";
const targetResourceId = "isolated-transfer-target";

function requestContext(resourceId) {
  const context = new RequestContext();
  context.setRaw(MASTRA_RESOURCE_ID_KEY, resourceId);
  return context;
}

function threadFixture(owner) {
  const expectedOwner = owner === "source-owner" ? sourceResourceId : targetResourceId;
  const threadId = `transfer-recovery-${owner}`;
  const assetId = `asset-${owner}`;
  const storagePath = join("library", sourceResourceId, "ab", `${assetId}.md`);
  return { expectedOwner, threadId, assetId, storagePath };
}

async function getMemory(resourceId) {
  return memoryModule.getMemory({
    requestContext: requestContext(resourceId),
  });
}

async function closeStorage(memory) {
  if (memory) await memory.settled();
  await storage.appStorage.close();
  await (await storage.getLibsqlClient()).close();
}

async function prepareTransfer(owner, assetMode = "cloned") {
  const fixture = threadFixture(owner);
  const memory = await getMemory(sourceResourceId);
  await memory.createThread({
    threadId: fixture.threadId,
    resourceId: sourceResourceId,
    title: fixture.threadId,
  });
  await memory.settled();
  await libraryDb.ensureLibrarySchema();

  const content = `isolated attachment for ${fixture.threadId}\n`;
  const sourcePath = join(storage.getStorageDirectory(), fixture.storagePath);
  await mkdir(dirname(sourcePath), { recursive: true });
  await writeFile(sourcePath, content);
  const timestamp = new Date().toISOString();
  await libraryDb.withClient((client) =>
    client.execute({
      sql: `INSERT INTO library_assets
        (id, resource_id, filename, media_type, byte_size, sha256, storage_path,
         status, extracted_text, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        fixture.assetId,
        sourceResourceId,
        `${fixture.threadId}.md`,
        "text/markdown",
        Buffer.byteLength(content),
        createHash("sha256").update(content).digest("hex"),
        fixture.storagePath,
        "indexed",
        content,
        timestamp,
        timestamp,
      ],
    }),
  );
  if (assetMode === "cloned") {
    await assets.attachAssetReference(sourceResourceId, fixture.assetId);
  }
  await assets.attachAssetReference(
    sourceResourceId,
    fixture.assetId,
    undefined,
    fixture.threadId,
  );

  const transfer = await assets.requestThreadAssetTransfer({
    threadId: fixture.threadId,
    sourceResourceId,
    targetResourceId,
    initiatedBy: sourceResourceId,
    threadTitle: fixture.threadId,
  });
  assert.equal(
    await assets.decideThreadAssetTransferRequest(transfer.id, targetResourceId, "accept"),
    true,
  );
  const copied = await assets.transferThreadAssetReferences(
    sourceResourceId,
    targetResourceId,
    fixture.threadId,
    { transferId: transfer.id },
  );
  assert.equal(copied.length, 1);
  assert.equal(copied[0].mode, assetMode);
  assert.equal((await assets.getThreadAssetTransfer(transfer.id))?.status, "assets_moved");

  if (owner.startsWith("target-owner")) {
    await memory.updateThreadResourceId({
      threadId: fixture.threadId,
      resourceId: targetResourceId,
    });
    await memory.settled();
  }
  await closeStorage(memory);
}

async function recoverTransfer(owner) {
  assert.equal(
    recoveryModule.rewriteTransferredAssetUrl(
      "/work/library/assets/same-id/content?resourceId=old-owner",
      new Map([["same-id", "same-id"]]),
      "new-owner",
    ),
    "/work/library/assets/same-id/content?resourceId=new-owner",
    "same-id moved assets must still rewrite the resource scope in message URLs",
  );
  const fixture = threadFixture(owner);
  const pending = (await assets.listThreadAssetTransfersForResource(sourceResourceId)).find(
    (transfer) => transfer.threadId === fixture.threadId,
  );
  assert.ok(pending, `pending transfer missing for ${fixture.threadId}`);
  assert.equal(pending.status, "assets_moved");

  const { recoverPendingThreadTransfers } = recoveryModule;
  const reindexedModes = [];
  await recoverPendingThreadTransfers({
    transferId: pending.id,
    getMemory: (context) => Promise.resolve(memoryModule.getMemory({ requestContext: context })),
    enqueueAssetIndex: async (_resourceId, items) => {
      reindexedModes.push(...items.map((item) => item.mode));
    },
  });

  const record = await assets.getThreadAssetTransfer(pending.id);
  const targetOwnsThread = owner.startsWith("target-owner");
  const expectedMode = owner.endsWith("-moved") ? "moved" : "cloned";
  assert.equal(record?.status, targetOwnsThread ? "committed" : "failed");
  assert.deepEqual(reindexedModes, targetOwnsThread ? [expectedMode] : []);

  const memory = await getMemory(sourceResourceId);
  const thread = await memory.getThreadById({ threadId: fixture.threadId });
  assert.equal(thread?.resourceId, fixture.expectedOwner);

  const sourceRefs = await libraryDb.withClient((client) =>
    client.execute({
      sql: "SELECT folder_id, thread_id FROM library_asset_refs WHERE asset_id = ? AND resource_id = ?",
      args: [fixture.assetId, sourceResourceId],
    }),
  );
  const sourceThreadRefExists = sourceRefs.rows.some(
    (row) => String(row.thread_id ?? "") === fixture.threadId,
  );
  assert.equal(sourceThreadRefExists, owner === "source-owner");

  const targetAssetId = record.assetMappings[fixture.assetId]?.targetAssetId;
  assert.ok(targetAssetId, "transfer journal must preserve the asset mapping across processes");
  const targetAsset = await assets.getLibraryAssetTransferDetails(targetResourceId, targetAssetId);
  assert.equal(Boolean(targetAsset), targetOwnsThread);
  if (targetAsset) {
    assert.equal(
      await readFile(join(storage.getStorageDirectory(), targetAsset.storagePath), "utf8"),
      `isolated attachment for ${fixture.threadId}\n`,
    );
  }
  await closeStorage(memory);
}

async function preparePartialClone() {
  const threadId = "transfer-recovery-partial-clone";
  const targetAssetId = "target-orphan-clone";
  const storagePath = join("library", targetResourceId, "or", `${targetAssetId}.md`);
  const memory = await getMemory(sourceResourceId);
  await memory.createThread({ threadId, resourceId: sourceResourceId, title: threadId });
  await memory.settled();
  await libraryDb.ensureLibrarySchema();
  const transfer = await assets.requestThreadAssetTransfer({
    threadId,
    sourceResourceId,
    targetResourceId,
    initiatedBy: sourceResourceId,
    threadTitle: threadId,
  });
  assert.equal(await assets.decideThreadAssetTransferRequest(transfer.id, targetResourceId, "accept"), true);
  const targetPath = join(storage.getStorageDirectory(), storagePath);
  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, "orphaned partial clone\n");
  await assets.markThreadAssetTransferAssetsPreparing(transfer.id, sourceResourceId, [
    {
      sourceAssetId: "source-global-asset-not-yet-registered",
      targetAssetId: targetAssetId,
      mode: "cloned",
      storagePath,
      asset: {
        id: targetAssetId,
        resourceId: targetResourceId,
        filename: "partial.md",
        mediaType: "text/markdown",
        byteSize: 25,
        sha256: "b".repeat(64),
        storagePath,
        status: "indexed",
        extractedText: "orphaned partial clone",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        folderIds: [],
        threadIds: [threadId],
        hasLibraryReference: false,
      },
    },
  ]);
  await closeStorage(memory);
}

async function recoverPartialClone() {
  const threadId = "transfer-recovery-partial-clone";
  const pending = (await assets.listThreadAssetTransfersForResource(sourceResourceId)).find(
    (transfer) => transfer.threadId === threadId,
  );
  assert.ok(pending, "partial clone journal must survive process exit");
  await recoveryModule.recoverPendingThreadTransfers({
    transferId: pending.id,
    getMemory: (context) => Promise.resolve(memoryModule.getMemory({ requestContext: context })),
    enqueueAssetIndex: async () => undefined,
  });
  assert.equal((await assets.getThreadAssetTransfer(pending.id))?.status, "failed");
  await assert.rejects(
    readFile(join(storage.getStorageDirectory(), "library", targetResourceId, "or", "target-orphan-clone.md")),
    { code: "ENOENT" },
  );
  const memory = await getMemory(sourceResourceId);
  assert.equal((await memory.getThreadById({ threadId }))?.resourceId, sourceResourceId);
  await closeStorage(memory);
}

if (phase === "prepare-source-owner") await prepareTransfer("source-owner");
else if (phase === "recover-source-owner") await recoverTransfer("source-owner");
else if (phase === "prepare-target-owner-moved") await prepareTransfer("target-owner-moved", "moved");
else if (phase === "recover-target-owner-moved") await recoverTransfer("target-owner-moved");
else if (phase === "prepare-partial-clone") await preparePartialClone();
else if (phase === "recover-partial-clone") await recoverPartialClone();
else if (phase === "prepare-target-owner") await prepareTransfer("target-owner");
else if (phase === "recover-target-owner") await recoverTransfer("target-owner");
else throw new Error(`Unknown recovery probe phase: ${phase}`);
