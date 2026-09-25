/**
 * 资产管理层:上传去重(sha256)、入库、目录/线程关联绑定与二进制读取。
 * 表结构见 ./db.ts(docs/en/reference/rag/database-config.mdx)。
 */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  realpath,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { nanoid } from "nanoid";
import { getStorageDirectory } from "../../storage";
import {
  extractText,
  isExtractable,
  normalizeFilename,
  resolveMediaType,
} from "../document/extract";
import { queueAssetIndex, waitForAssetIndexing } from "../document/indexing";
import { getLibrarySettings } from "../settings";
import { ensureFolderReference } from "./folders";
import {
  type LibraryAsset,
  MAX_LIBRARY_FILE_BYTES,
  MAX_LIBRARY_INLINE_MEDIA_BYTES,
} from "../types";
import { ensureLibrarySchema, getLatestLibraryIndexRuns, now, rowToAsset, withClient } from "./db";

/**
 * 资产管理层:
 * 上传、入库、关联绑定与读取二进制。
 */

type AssetUploadMetadata = {
  resourceId: string;
  filename: string;
  mediaType?: string;
  folderId?: string;
  threadId?: string;
};

type AssetUploadSource = {
  byteSize: number;
  sha256: string;
  writeTo: (destination: string) => Promise<void>;
  readBytes: () => Promise<Uint8Array>;
};

export const THREAD_TRANSFER_WRITE_LOCK_STATUSES = [
  "prepared",
  "assets_preparing",
  "assets_moved",
  "memory_moved",
  "messages_rewritten",
  "needs_reconciliation",
] as const;
const THREAD_TRANSFER_WRITE_LOCK_PLACEHOLDERS = THREAD_TRANSFER_WRITE_LOCK_STATUSES.map(
  () => "?",
).join(", ");
const threadAssetTransferLocks = new Map<string, Promise<void>>();

/** Serialize chat-start and transfer work for one thread within the local Mastra process. */
export async function withThreadAssetTransferLock<T>(
  threadId: string,
  resourceId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const key = JSON.stringify([resourceId, threadId]);
  const previous = threadAssetTransferLocks.get(key) ?? Promise.resolve();
  let releaseCurrent!: () => void;
  const current = new Promise<void>((resolveCurrent) => {
    releaseCurrent = resolveCurrent;
  });
  const queued = previous.then(() => current);
  threadAssetTransferLocks.set(key, queued);
  await previous;
  try {
    return await operation();
  } finally {
    releaseCurrent();
    if (threadAssetTransferLocks.get(key) === queued) threadAssetTransferLocks.delete(key);
  }
}

/** True while an accepted transfer is moving this thread's assets or history. */
export async function isThreadAssetTransferWriteLocked(
  threadId: string,
  sourceResourceId: string,
): Promise<boolean> {
  if (!threadId || !sourceResourceId) return false;
  await ensureLibrarySchema();
  return withClient(async (client) => {
    const result = await client.execute({
      sql: `SELECT 1 FROM library_thread_transfers
        WHERE thread_id = ? AND source_resource_id = ?
          AND status IN (${THREAD_TRANSFER_WRITE_LOCK_PLACEHOLDERS})
        LIMIT 1`,
      args: [threadId, sourceResourceId, ...THREAD_TRANSFER_WRITE_LOCK_STATUSES],
    });
    return result.rows.length > 0;
  });
}

async function storeAsset(
  input: AssetUploadMetadata,
  source: AssetUploadSource,
  skipIndexing: boolean,
): Promise<LibraryAsset> {
  if (source.byteSize === 0) throw new Error("文件内容不能为空");
  if (source.byteSize > MAX_LIBRARY_FILE_BYTES) {
    throw new Error(`单个文件不能超过 ${MAX_LIBRARY_FILE_BYTES / (1024 * 1024)} MB`);
  }
  await ensureLibrarySchema();
  await ensureFolderReference(input.resourceId, input.folderId, input.threadId);
  const normalized = normalizeFilename(input.filename);
  const mediaType = resolveMediaType(normalized, input.mediaType || "");
  const baseDir = getStorageDirectory();

  const existingRow = await withClient(async (client) => {
    const result = await client.execute({
      sql: "SELECT * FROM library_assets WHERE resource_id = ? AND sha256 = ? LIMIT 1",
      args: [input.resourceId, source.sha256],
    });
    return result.rows[0];
  });

  if (existingRow) {
    const asset = rowToAsset(existingRow);
    await attachAssetReference(input.resourceId, asset.id, input.folderId, input.threadId);
    return asset;
  }

  const id = nanoid();
  const relDir = join("library", input.resourceId, id.slice(0, 2));
  const relPath = join(relDir, `${id}_${normalized}`);
  const absDir = join(baseDir, relDir);
  const absPath = join(baseDir, relPath);
  await mkdir(absDir, { recursive: true });
  try {
    await source.writeTo(absPath);
  } catch (error) {
    await unlink(absPath).catch(() => undefined);
    throw error;
  }

  let extractable = false;
  let createdAsset: LibraryAsset | undefined;
  try {
    extractable = isExtractable(normalized, mediaType);
    const status: LibraryAsset["status"] = extractable
      ? skipIndexing
        ? "ready"
        : "indexing"
      : "unsupported";
    // Media files stay on disk. Text/PDF/office formats are read once only when
    // the existing extractor needs bytes; this avoids a second in-memory copy
    // for the common image/audio/video upload path.
    const extracted = extractable
      ? await extractText(await source.readBytes(), normalized, mediaType)
      : null;
    const timestamp = now();

    await withClient(async (client) => {
      const statements = [
        {
          sql: `INSERT INTO library_assets
          (id, resource_id, filename, media_type, byte_size, sha256, storage_path, status, extracted_text, created_at, updated_at)
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          WHERE ? = '' OR NOT EXISTS (
            SELECT 1 FROM library_thread_transfers
            WHERE thread_id = ? AND source_resource_id = ?
              AND status IN (${THREAD_TRANSFER_WRITE_LOCK_PLACEHOLDERS})
          )`,
          args: [
            id,
            input.resourceId,
            normalized,
            mediaType,
            source.byteSize,
            source.sha256,
            relPath,
            status,
            extracted,
            timestamp,
            timestamp,
            input.threadId ?? "",
            input.threadId ?? "",
            input.resourceId,
            ...THREAD_TRANSFER_WRITE_LOCK_STATUSES,
          ],
        },
        {
          sql: `INSERT INTO library_asset_refs
          (asset_id, resource_id, folder_id, thread_id, created_at)
          SELECT ?, ?, ?, ?, ? WHERE EXISTS (
            SELECT 1 FROM library_assets WHERE id = ? AND resource_id = ?
          )`,
          args: [
            id,
            input.resourceId,
            input.folderId ?? "",
            input.threadId ?? "",
            timestamp,
            id,
            input.resourceId,
          ],
        },
      ];
      const results = await client.batch(statements);
      if ((results[0]?.rowsAffected ?? 0) !== 1) {
        throw new Error("会话正在转交，无法添加附件");
      }
    });

    createdAsset = {
      id,
      resourceId: input.resourceId,
      folderIds: input.folderId ? [input.folderId] : [],
      threadIds: input.threadId ? [input.threadId] : [],
      hasLibraryReference: !input.folderId && !input.threadId,
      filename: normalized,
      mediaType,
      byteSize: source.byteSize,
      sha256: source.sha256,
      status,
      extractedText: extracted,
      indexAttempt: 0,
      indexStage: null,
      indexError: null,
      indexStartedAt: null,
      indexCompletedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
  } catch (error) {
    await unlink(absPath).catch(() => undefined);
    throw error;
  }

  if (!createdAsset) throw new Error("资产入库未生成记录");
  if (extractable && !skipIndexing) {
    try {
      const settings = await getLibrarySettings(input.resourceId);
      void queueAssetIndex(createdAsset, createdAsset.extractedText ?? "", settings).catch(
        () => undefined,
      );
    } catch {
      // The asset is already durable; recovery can retry indexing later.
    }
  }
  return createdAsset;
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

export async function uploadAsset(
  input: AssetUploadMetadata & { bytes: Uint8Array },
  skipIndexing = false,
): Promise<LibraryAsset> {
  const sha256 = createHash("sha256").update(input.bytes).digest("hex");
  return storeAsset(
    input,
    {
      byteSize: input.bytes.byteLength,
      sha256,
      writeTo: (destination) => writeFile(destination, input.bytes),
      readBytes: async () => input.bytes,
    },
    skipIndexing,
  );
}

/**
 * Store an already streamed temporary file without materializing media bytes
 * in the request handler. Extractable document formats may still be read once
 * by the parser, while binary media is copied and hashed as streams.
 */
export async function uploadAssetFromFile(
  input: AssetUploadMetadata & {
    filePath: string;
    byteSize: number;
    sha256?: string;
  },
  skipIndexing = false,
): Promise<LibraryAsset> {
  const file = await stat(input.filePath);
  if (file.size !== input.byteSize) {
    throw new Error(`临时上传文件大小不匹配: ${file.size}/${input.byteSize}`);
  }
  const sha256 = input.sha256 ?? (await hashFile(input.filePath));
  return storeAsset(
    input,
    {
      byteSize: file.size,
      sha256,
      writeTo: (destination) =>
        pipeline(createReadStream(input.filePath), createWriteStream(destination, { flags: "wx" })),
      readBytes: () => readFile(input.filePath),
    },
    skipIndexing,
  );
}

export async function listAssets(resourceId: string, threadId?: string): Promise<LibraryAsset[]> {
  await ensureLibrarySchema();
  const [assetRows, refRows, runsMap] = await withClient(async (client) => {
    const assets = await client.execute({
      sql: `SELECT a.* FROM library_assets a
        WHERE a.resource_id = ?
          AND (? IS NULL OR EXISTS (
            SELECT 1 FROM library_asset_refs r
            WHERE r.asset_id = a.id AND r.resource_id = a.resource_id AND (r.thread_id = '' OR r.thread_id = ?)
          ))
        ORDER BY a.updated_at DESC`,
      args: [resourceId, threadId ?? null, threadId ?? ""],
    });
    const refs = await client.execute({
      sql: "SELECT asset_id, folder_id, thread_id FROM library_asset_refs WHERE resource_id = ?",
      args: [resourceId],
    });
    return [assets.rows, refs.rows, await getLatestLibraryIndexRuns(resourceId)];
  });

  const folderMap = new Map<string, Set<string>>();
  const threadMap = new Map<string, Set<string>>();
  const libraryAssetIds = new Set<string>();
  for (const ref of refRows) {
    const assetId = String(ref.asset_id);
    const folderId = String(ref.folder_id || "");
    const thread = String(ref.thread_id || "");
    if (!folderId && !thread) libraryAssetIds.add(assetId);
    if (folderId) {
      if (!folderMap.has(assetId)) folderMap.set(assetId, new Set());
      folderMap.get(assetId)?.add(folderId);
    }
    if (thread) {
      if (!threadMap.has(assetId)) threadMap.set(assetId, new Set());
      threadMap.get(assetId)?.add(thread);
    }
  }

  return assetRows.map((row) => {
    const asset = rowToAsset(row);
    asset.folderIds = Array.from(folderMap.get(asset.id) ?? []);
    asset.threadIds = Array.from(threadMap.get(asset.id) ?? []);
    asset.hasLibraryReference = libraryAssetIds.has(asset.id);
    const run = runsMap.get(asset.id);
    if (run) {
      asset.indexAttempt = run.attempt;
      asset.indexStage = run.stage;
      asset.indexError = run.error;
      asset.indexStartedAt = run.startedAt;
      asset.indexCompletedAt = run.completedAt;
    }
    return asset;
  });
}

export async function renameAsset(
  resourceId: string,
  id: string,
  filename: string,
): Promise<LibraryAsset | null> {
  await ensureLibrarySchema();
  const normalized = normalizeFilename(filename);
  const mediaType = resolveMediaType(normalized, "");
  const timestamp = now();
  const updated = await withClient(async (client) => {
    await client.execute({
      sql: "UPDATE library_assets SET filename = ?, media_type = ?, updated_at = ? WHERE id = ? AND resource_id = ?",
      args: [normalized, mediaType, timestamp, id, resourceId],
    });
    const result = await client.execute({
      sql: "SELECT * FROM library_assets WHERE id = ? AND resource_id = ? LIMIT 1",
      args: [id, resourceId],
    });
    return result.rows[0];
  });
  return updated ? rowToAsset(updated) : null;
}

export async function readAssetBytes(
  resourceId: string,
  id: string,
): Promise<{ bytes: Uint8Array; asset: LibraryAsset } | null> {
  const asset = await getLibraryAsset(resourceId, id);
  if (!asset) return null;
  const relPath = await withClient(async (client) => {
    const result = await client.execute({
      sql: "SELECT storage_path FROM library_assets WHERE id = ? AND resource_id = ? LIMIT 1",
      args: [id, resourceId],
    });
    return result.rows[0]?.storage_path ? String(result.rows[0].storage_path) : null;
  });
  if (!relPath) return null;
  const absPath = join(getStorageDirectory(), relPath);
  const buffer = await readFile(absPath).catch(() => null);
  if (!buffer) return null;
  return { bytes: new Uint8Array(buffer), asset };
}

async function getLibraryAsset(resourceId: string, id: string): Promise<LibraryAsset | null> {
  await ensureLibrarySchema();
  const row = await withClient(async (client) => {
    const result = await client.execute({
      sql: "SELECT * FROM library_assets WHERE id = ? AND resource_id = ? LIMIT 1",
      args: [id, resourceId],
    });
    return result.rows[0];
  });
  return row ? rowToAsset(row) : null;
}

/** Internal recovery read: ownership is checked by the transfer intent itself. */
export function getLibraryAssetForTransferRecovery(
  resourceId: string,
  id: string,
): Promise<LibraryAsset | null> {
  return getLibraryAsset(resourceId, id);
}

export async function getLibraryAssetTransferDetails(
  resourceId: string,
  id: string,
): Promise<{ asset: LibraryAsset; storagePath: string } | null> {
  await ensureLibrarySchema();
  const row = await withClient(async (client) => {
    const result = await client.execute({
      sql: "SELECT * FROM library_assets WHERE id = ? AND resource_id = ? LIMIT 1",
      args: [id, resourceId],
    });
    return result.rows[0];
  });
  if (!row) return null;
  return { asset: rowToAsset(row), storagePath: String(row.storage_path) };
}

export async function deleteAsset(resourceId: string, id: string): Promise<boolean> {
  await ensureLibrarySchema();
  const storagePath = await withClient(async (client) => {
    const result = await client.execute({
      sql: "SELECT storage_path FROM library_assets WHERE id = ? AND resource_id = ? LIMIT 1",
      args: [id, resourceId],
    });
    return result.rows[0]?.storage_path ? String(result.rows[0].storage_path) : null;
  });
  if (!storagePath) return false;

  await withClient((client) =>
    client.batch([
      {
        sql: "DELETE FROM library_asset_refs WHERE asset_id = ? AND resource_id = ?",
        args: [id, resourceId],
      },
      {
        sql: "DELETE FROM library_chunks WHERE asset_id = ?",
        args: [id],
      },
      {
        sql: "DELETE FROM library_index_runs WHERE asset_id = ? AND resource_id = ?",
        args: [id, resourceId],
      },
      {
        sql: "DELETE FROM library_assets WHERE id = ? AND resource_id = ?",
        args: [id, resourceId],
      },
    ]),
  );
  if (storagePath) {
    await unlink(join(getStorageDirectory(), storagePath)).catch(() => undefined);
  }
  return true;
}

export async function attachAssetReference(
  resourceId: string,
  assetId: string,
  folderId?: string,
  threadId?: string,
  options?: { transferId?: string },
): Promise<void> {
  await ensureLibrarySchema();
  await ensureFolderReference(resourceId, folderId, threadId);
  await withClient(async (client) => {
    const inserted = await client.execute({
      sql: `INSERT OR IGNORE INTO library_asset_refs
        (asset_id, resource_id, folder_id, thread_id, created_at)
        SELECT ?, ?, ?, ?, ?
        WHERE ? = '' OR NOT EXISTS (
          SELECT 1 FROM library_thread_transfers
          WHERE thread_id = ? AND source_resource_id = ?
            AND status IN (${THREAD_TRANSFER_WRITE_LOCK_PLACEHOLDERS})
            AND (? = '' OR id != ?)
        )`,
      args: [
        assetId,
        resourceId,
        folderId ?? "",
        threadId ?? "",
        now(),
        threadId ?? "",
        threadId ?? "",
        resourceId,
        ...THREAD_TRANSFER_WRITE_LOCK_STATUSES,
        options?.transferId ?? "",
        options?.transferId ?? "",
      ],
    });
    if ((inserted.rowsAffected ?? 0) === 1 || !threadId) return;
    const existing = await client.execute({
      sql: `SELECT 1 FROM library_asset_refs
        WHERE asset_id = ? AND resource_id = ? AND folder_id = ? AND thread_id = ? LIMIT 1`,
      args: [assetId, resourceId, folderId ?? "", threadId],
    });
    if (existing.rows.length === 0) throw new Error("会话正在转交，无法添加附件");
  });
}

export type ThreadAssetTransferStatus =
  | "awaiting_confirmation"
  | "prepared"
  | "assets_preparing"
  | "assets_moved"
  | "memory_moved"
  | "messages_rewritten"
  | "committed"
  | "failed"
  | "rejected"
  | "needs_reconciliation";

export type ThreadAssetTransferMode = "moved" | "cloned" | "linked";

export interface ThreadAssetTransferItem {
  sourceAssetId: string;
  targetAssetId: string;
  mode: ThreadAssetTransferMode;
  storagePath: string;
  asset: LibraryAsset;
}

export interface ThreadAssetTransferRecord {
  id: string;
  threadId: string;
  sourceResourceId: string;
  targetResourceId: string;
  initiatedBy: string;
  assetIds: string[];
  assetMappings: Record<
    string,
    { targetAssetId: string; mode: ThreadAssetTransferMode; storagePath?: string }
  >;
  status: ThreadAssetTransferStatus;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface ThreadAssetTransferAuditEvent {
  action: string;
  actorResourceId: string;
  createdAt: string;
  threadTitle?: string;
}

export interface ThreadAssetTransferHistoryRecord extends ThreadAssetTransferRecord {
  threadTitle: string;
  events: ThreadAssetTransferAuditEvent[];
}

export class ThreadAssetTransferRequestConflict extends Error {
  constructor(message = "该会话已有待处理的转交申请") {
    super(message);
    this.name = "ThreadAssetTransferRequestConflict";
  }
}

const PENDING_THREAD_TRANSFER_STATUSES: ThreadAssetTransferStatus[] = [
  ...THREAD_TRANSFER_WRITE_LOCK_STATUSES,
];

function rowToThreadAssetTransfer(row: Record<string, unknown>): ThreadAssetTransferRecord {
  let assetIds: string[] = [];
  try {
    const parsed = JSON.parse(String(row.asset_ids ?? "[]"));
    if (Array.isArray(parsed)) {
      assetIds = parsed.filter((value): value is string => typeof value === "string");
    }
  } catch {
    assetIds = [];
  }
  let assetMappings: ThreadAssetTransferRecord["assetMappings"] = {};
  try {
    const parsed = JSON.parse(String(row.asset_mappings ?? "{}"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [sourceAssetId, value] of Object.entries(parsed)) {
        if (typeof value === "string") {
          assetMappings[sourceAssetId] = { targetAssetId: value, mode: "moved" };
          continue;
        }
        if (!value || typeof value !== "object") continue;
        const targetAssetId = (value as { targetAssetId?: unknown }).targetAssetId;
        const mode = (value as { mode?: unknown }).mode;
        if (
          typeof targetAssetId === "string" &&
          (mode === "moved" || mode === "cloned" || mode === "linked")
        ) {
          const storagePath = (value as { storagePath?: unknown }).storagePath;
          assetMappings[sourceAssetId] = {
            targetAssetId,
            mode,
            ...(typeof storagePath === "string" ? { storagePath } : {}),
          };
        }
      }
    }
  } catch {
    assetMappings = {};
  }
  return {
    id: String(row.id),
    threadId: String(row.thread_id),
    sourceResourceId: String(row.source_resource_id),
    targetResourceId: String(row.target_resource_id),
    initiatedBy: String(row.initiated_by),
    assetIds,
    assetMappings,
    status: String(row.status) as ThreadAssetTransferStatus,
    errorMessage: row.error_message ? String(row.error_message) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    completedAt: row.completed_at ? String(row.completed_at) : null,
  };
}

async function findOpenThreadAssetTransfer(
  threadId: string,
  sourceResourceId: string,
): Promise<ThreadAssetTransferRecord | undefined> {
  return withClient(async (client) => {
    const result = await client.execute({
      sql: `SELECT * FROM library_thread_transfers
        WHERE thread_id = ? AND source_resource_id = ?
          AND status IN ('awaiting_confirmation', 'prepared', 'assets_preparing', 'assets_moved',
            'memory_moved', 'messages_rewritten', 'needs_reconciliation')
        ORDER BY created_at DESC
        LIMIT 1`,
      args: [threadId, sourceResourceId],
    });
    const row = result.rows[0];
    return row ? rowToThreadAssetTransfer(row as Record<string, unknown>) : undefined;
  });
}

/** Create a durable request; no ownership or asset mutation happens before acceptance. */
export async function requestThreadAssetTransfer(input: {
  threadId: string;
  sourceResourceId: string;
  targetResourceId: string;
  initiatedBy: string;
  threadTitle: string;
}): Promise<ThreadAssetTransferRecord> {
  await ensureLibrarySchema();
  const existing = await findOpenThreadAssetTransfer(input.threadId, input.sourceResourceId);
  if (existing) {
    if (
      existing.status === "awaiting_confirmation" &&
      existing.targetResourceId === input.targetResourceId
    ) {
      return existing;
    }
    throw new ThreadAssetTransferRequestConflict();
  }

  const id = nanoid();
  const timestamp = now();
  try {
    await withClient((client) =>
      client.batch([
        {
          sql: `INSERT INTO library_thread_transfers
            (id, thread_id, source_resource_id, target_resource_id, initiated_by,
             asset_ids, asset_mappings, status, error_message, created_at, updated_at, completed_at)
            VALUES (?, ?, ?, ?, ?, '[]', '{}', 'awaiting_confirmation', NULL, ?, ?, NULL)`,
          args: [
            id,
            input.threadId,
            input.sourceResourceId,
            input.targetResourceId,
            input.initiatedBy,
            timestamp,
            timestamp,
          ],
        },
        {
          sql: `INSERT INTO library_thread_transfer_events
            (id, transfer_id, action, actor_resource_id, details, created_at)
            VALUES (?, ?, 'requested', ?, ?, ?)`,
          args: [
            nanoid(),
            id,
            input.initiatedBy,
            JSON.stringify({
              threadId: input.threadId,
              targetResourceId: input.targetResourceId,
              threadTitle: input.threadTitle.slice(0, 200),
            }),
            timestamp,
          ],
        },
      ]),
    );
  } catch (error) {
    // Concurrent clicks can race the partial unique index. Reuse the matching
    // request, but never silently redirect it to another recipient.
    const raced = await findOpenThreadAssetTransfer(input.threadId, input.sourceResourceId);
    if (
      raced?.status === "awaiting_confirmation" &&
      raced.targetResourceId === input.targetResourceId
    ) {
      return raced;
    }
    if (raced) throw new ThreadAssetTransferRequestConflict();
    throw error;
  }

  return {
    id,
    threadId: input.threadId,
    sourceResourceId: input.sourceResourceId,
    targetResourceId: input.targetResourceId,
    initiatedBy: input.initiatedBy,
    assetIds: [],
    assetMappings: {},
    status: "awaiting_confirmation",
    errorMessage: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    completedAt: null,
  };
}

export async function getThreadAssetTransfer(
  transferId: string,
): Promise<ThreadAssetTransferRecord | undefined> {
  await ensureLibrarySchema();
  return withClient(async (client) => {
    const result = await client.execute({
      sql: "SELECT * FROM library_thread_transfers WHERE id = ? LIMIT 1",
      args: [transferId],
    });
    const row = result.rows[0];
    return row ? rowToThreadAssetTransfer(row as Record<string, unknown>) : undefined;
  });
}

/** Atomically accept or reject only the intended recipient's open request. */
export async function decideThreadAssetTransferRequest(
  transferId: string,
  targetResourceId: string,
  decision: "accept" | "reject",
): Promise<boolean> {
  await ensureLibrarySchema();
  const timestamp = now();
  const nextStatus = decision === "accept" ? "prepared" : "rejected";
  const action = decision === "accept" ? "accepted" : "rejected";
  const results = await withClient((client) =>
    client.batch([
      {
        sql: `UPDATE library_thread_transfers SET status = ?, error_message = NULL,
          updated_at = ?, completed_at = ?
          WHERE id = ? AND target_resource_id = ? AND status = 'awaiting_confirmation'
            AND (? = 'rejected' OR NOT EXISTS (
              SELECT 1 FROM library_upload_sessions
              WHERE resource_id = library_thread_transfers.source_resource_id
                AND thread_id = library_thread_transfers.thread_id
                AND expires_at > ?
            ))`,
        args: [
          nextStatus,
          timestamp,
          decision === "reject" ? timestamp : null,
          transferId,
          targetResourceId,
          nextStatus,
          timestamp,
        ],
      },
      {
        sql: `INSERT INTO library_thread_transfer_events
          (id, transfer_id, action, actor_resource_id, details, created_at)
          SELECT ?, ?, ?, ?, '{}', ? WHERE changes() = 1`,
        args: [nanoid(), transferId, action, targetResourceId, timestamp],
      },
    ]),
  );
  return (results[0]?.rowsAffected ?? 0) === 1;
}

/** Return only records involving this authenticated local account, with a safe audit projection. */
export async function listThreadAssetTransfersForResource(
  resourceId: string,
): Promise<ThreadAssetTransferHistoryRecord[]> {
  await ensureLibrarySchema();
  return withClient(async (client) => {
    const result = await client.execute({
      sql: `SELECT * FROM library_thread_transfers
        WHERE source_resource_id = ? OR target_resource_id = ?
        ORDER BY updated_at DESC LIMIT 100`,
      args: [resourceId, resourceId],
    });
    const records = result.rows.map((row) => rowToThreadAssetTransfer(row as Record<string, unknown>));
    if (records.length === 0) return [];

    const placeholders = records.map(() => "?").join(", ");
    const eventResult = await client.execute({
      sql: `SELECT transfer_id, action, actor_resource_id, details, created_at
        FROM library_thread_transfer_events WHERE transfer_id IN (${placeholders})
        ORDER BY created_at ASC`,
      args: records.map((record) => record.id),
    });
    const eventsByTransfer = new Map<string, ThreadAssetTransferAuditEvent[]>();
    for (const row of eventResult.rows) {
      const transferId = String(row.transfer_id ?? "");
      const events = eventsByTransfer.get(transferId) ?? [];
      let threadTitle: string | undefined;
      try {
        const details = JSON.parse(String(row.details ?? "{}")) as { threadTitle?: unknown };
        if (typeof details.threadTitle === "string") threadTitle = details.threadTitle;
      } catch {
        // Historical audit payloads may predate the title field.
      }
      events.push({
        action: String(row.action ?? "unknown"),
        actorResourceId: String(row.actor_resource_id ?? ""),
        createdAt: String(row.created_at ?? ""),
        ...(threadTitle ? { threadTitle } : {}),
      });
      eventsByTransfer.set(transferId, events);
    }

    return records.map((record) => {
      const events = eventsByTransfer.get(record.id) ?? [];
      return {
        ...record,
        threadTitle: events.find((event) => event.threadTitle)?.threadTitle ?? "未命名会话",
        events,
      };
    });
  });
}

/** Persist the cross-store transfer intent before either store is changed. */
export async function beginThreadAssetTransfer(input: {
  threadId: string;
  sourceResourceId: string;
  targetResourceId: string;
  initiatedBy: string;
}): Promise<ThreadAssetTransferRecord> {
  await ensureLibrarySchema();
  const id = nanoid();
  const timestamp = now();
  await withClient((client) =>
    client.batch([
      {
        sql: `INSERT INTO library_thread_transfers
          (id, thread_id, source_resource_id, target_resource_id, initiated_by, asset_ids, asset_mappings, status, error_message, created_at, updated_at, completed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL)`,
        args: [
          id,
          input.threadId,
          input.sourceResourceId,
          input.targetResourceId,
          input.initiatedBy,
          "[]",
          "{}",
          "prepared",
          timestamp,
          timestamp,
        ],
      },
      {
        sql: `INSERT INTO library_thread_transfer_events
          (id, transfer_id, action, actor_resource_id, details, created_at)
          VALUES (?, ?, ?, ?, ?, ?)`,
        args: [
          nanoid(),
          id,
          "prepared",
          input.initiatedBy,
          JSON.stringify({ threadId: input.threadId, targetResourceId: input.targetResourceId }),
          timestamp,
        ],
      },
    ]),
  );
  return {
    id,
    threadId: input.threadId,
    sourceResourceId: input.sourceResourceId,
    targetResourceId: input.targetResourceId,
    initiatedBy: input.initiatedBy,
    assetIds: [],
    assetMappings: {},
    status: "prepared",
    errorMessage: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    completedAt: null,
  };
}

async function updateThreadAssetTransfer(
  transferId: string,
  status: ThreadAssetTransferStatus,
  actorResourceId: string,
  options?: {
    assetIds?: string[];
    assetMappings?: ThreadAssetTransferRecord["assetMappings"];
    errorMessage?: string | null;
  },
): Promise<void> {
  const timestamp = now();
  const completed = status === "committed" || status === "failed" ? timestamp : null;
  await withClient((client) =>
    client.batch([
      {
        sql: `UPDATE library_thread_transfers SET
          status = ?,
          asset_ids = COALESCE(?, asset_ids),
          asset_mappings = COALESCE(?, asset_mappings),
          error_message = ?,
          updated_at = ?,
          completed_at = COALESCE(?, completed_at)
          WHERE id = ?`,
        args: [
          status,
          options?.assetIds ? JSON.stringify(options.assetIds) : null,
          options?.assetMappings ? JSON.stringify(options.assetMappings) : null,
          options?.errorMessage ?? null,
          timestamp,
          completed,
          transferId,
        ],
      },
      {
        sql: `INSERT INTO library_thread_transfer_events
          (id, transfer_id, action, actor_resource_id, details, created_at)
          VALUES (?, ?, ?, ?, ?, ?)`,
        args: [
          nanoid(),
          transferId,
          status,
          actorResourceId,
          JSON.stringify({
            ...(options?.assetIds ? { assetIds: options.assetIds } : {}),
            ...(options?.assetMappings ? { assetMappings: options.assetMappings } : {}),
            ...(options?.errorMessage ? { errorMessage: options.errorMessage } : {}),
          }),
          timestamp,
        ],
      },
    ]),
  );
}

export function markThreadAssetTransferAssetsMoved(
  transferId: string,
  actorResourceId: string,
  items: ThreadAssetTransferItem[],
): Promise<void> {
  const assetMappings = Object.fromEntries(
    items.map((item) => [
      item.sourceAssetId,
      {
        targetAssetId: item.targetAssetId,
        mode: item.mode,
        ...(item.mode === "cloned" ? { storagePath: item.storagePath } : {}),
      },
    ]),
  );
  return updateThreadAssetTransfer(transferId, "assets_moved", actorResourceId, {
    assetIds: items.map((item) => item.targetAssetId),
    assetMappings,
  });
}

/** Persist clone destinations before touching the filesystem so startup can clean partial copies. */
export function markThreadAssetTransferAssetsPreparing(
  transferId: string,
  actorResourceId: string,
  items: ThreadAssetTransferItem[],
): Promise<void> {
  const assetMappings = Object.fromEntries(
    items.map((item) => [
      item.sourceAssetId,
      {
        targetAssetId: item.targetAssetId,
        mode: item.mode,
        ...(item.mode === "cloned" ? { storagePath: item.storagePath } : {}),
      },
    ]),
  );
  return updateThreadAssetTransfer(transferId, "assets_preparing", actorResourceId, {
    assetIds: items.map((item) => item.targetAssetId),
    assetMappings,
  });
}

export function markThreadAssetTransferMemoryMoved(
  transferId: string,
  actorResourceId: string,
): Promise<void> {
  return updateThreadAssetTransfer(transferId, "memory_moved", actorResourceId);
}

export function markThreadAssetTransferMessagesRewritten(
  transferId: string,
  actorResourceId: string,
): Promise<void> {
  return updateThreadAssetTransfer(transferId, "messages_rewritten", actorResourceId);
}

export function commitThreadAssetTransfer(
  transferId: string,
  actorResourceId: string,
): Promise<void> {
  return commitThreadAssetTransferAndFinalizeRefs(transferId, actorResourceId);
}

/**
 * Atomically commit the journal and drop source-side thread references for
 * copied/linked assets. The source's global/folder references remain intact.
 * Keeping this in the same LibSQL batch means a failed commit leaves refs
 * available for either rollback or startup reconciliation.
 */
async function commitThreadAssetTransferAndFinalizeRefs(
  transferId: string,
  actorResourceId: string,
): Promise<void> {
  const transfer = await getThreadAssetTransfer(transferId);
  if (!transfer) throw new Error(`线程转交记录不存在: ${transferId}`);
  const timestamp = now();
  const sourceThreadRefs = Object.entries(transfer.assetMappings)
    .filter(([, mapping]) => mapping.mode !== "moved")
    .map(([sourceAssetId]) => ({
      sql: `DELETE FROM library_asset_refs
        WHERE asset_id = ? AND resource_id = ? AND folder_id = '' AND thread_id = ?
          AND EXISTS (
            SELECT 1 FROM library_thread_transfers
            WHERE id = ? AND status = 'committed'
          )`,
      args: [sourceAssetId, transfer.sourceResourceId, transfer.threadId, transferId],
    }));

  await withClient((client) =>
    client.batch([
      {
        sql: `UPDATE library_thread_transfers SET
          status = 'committed', error_message = NULL, updated_at = ?,
          completed_at = COALESCE(completed_at, ?)
          WHERE id = ? AND status IN (${PENDING_THREAD_TRANSFER_STATUSES.map(() => "?").join(", ")})`,
        args: [timestamp, timestamp, transferId, ...PENDING_THREAD_TRANSFER_STATUSES],
      },
      {
        sql: `INSERT INTO library_thread_transfer_events
          (id, transfer_id, action, actor_resource_id, details, created_at)
          SELECT ?, ?, 'committed', ?, '{}', ? WHERE changes() = 1`,
        args: [nanoid(), transferId, actorResourceId, timestamp],
      },
      ...sourceThreadRefs,
    ]),
  );
}

export function failThreadAssetTransfer(
  transferId: string,
  actorResourceId: string,
  errorMessage: string,
  needsReconciliation = false,
): Promise<void> {
  return updateThreadAssetTransfer(
    transferId,
    needsReconciliation ? "needs_reconciliation" : "failed",
    actorResourceId,
    { errorMessage },
  );
}

export async function listPendingThreadAssetTransfers(
  transferId?: string,
): Promise<ThreadAssetTransferRecord[]> {
  await ensureLibrarySchema();
  const placeholders = PENDING_THREAD_TRANSFER_STATUSES.map(() => "?").join(", ");
  return withClient(async (client) => {
    const result = await client.execute({
      sql: transferId
        ? `SELECT * FROM library_thread_transfers
          WHERE id = ? AND status IN (${placeholders}) ORDER BY created_at ASC`
        : `SELECT * FROM library_thread_transfers
          WHERE status IN (${placeholders}) ORDER BY created_at ASC`,
      args: transferId
        ? [transferId, ...PENDING_THREAD_TRANSFER_STATUSES]
        : PENDING_THREAD_TRANSFER_STATUSES,
    });
    return result.rows.map((row) => rowToThreadAssetTransfer(row));
  });
}

export class ThreadAssetTransferConflict extends Error {
  constructor(public readonly filenames: string[]) {
    super(
      `线程包含无法安全迁移的共享资料库附件: ${filenames.slice(0, 5).join(", ")}${
        filenames.length > 5 ? " 等" : ""
      }`,
    );
    this.name = "ThreadAssetTransferConflict";
  }
}

export class ThreadAssetTransferCleanupPending extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ThreadAssetTransferCleanupPending";
  }
}

function isWithinDirectory(parent: string, candidate: string): boolean {
  const pathFromParent = relative(parent, candidate);
  return (
    pathFromParent !== "" &&
    pathFromParent !== ".." &&
    !pathFromParent.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromParent)
  );
}

/** Remove only unregistered, journaled clone files under the recipient's library root. */
export async function cleanupUnregisteredThreadAssetTransferCopies(
  transfer: ThreadAssetTransferRecord,
): Promise<void> {
  const storageDirectory = resolve(getStorageDirectory());
  for (const [sourceAssetId, mapping] of Object.entries(transfer.assetMappings)) {
    if (mapping.mode !== "cloned" || !mapping.storagePath) continue;
    const assetExists = await withClient(async (client) => {
      const result = await client.execute({
        sql: "SELECT 1 FROM library_assets WHERE id = ? AND resource_id = ? LIMIT 1",
        args: [mapping.targetAssetId, transfer.targetResourceId],
      });
      return result.rows.length > 0;
    });
    if (assetExists) continue;

    const libraryDirectory = resolve(storageDirectory, "library");
    const targetDirectory = resolve(libraryDirectory, transfer.targetResourceId);
    const targetPath = resolve(storageDirectory, mapping.storagePath);
    if (
      !isWithinDirectory(libraryDirectory, targetDirectory) ||
      !isWithinDirectory(targetDirectory, targetPath) ||
      !mapping.storagePath.startsWith(`library${sep}${transfer.targetResourceId}${sep}`)
    ) {
      throw new Error(`转交资产路径超出目标账户目录: ${sourceAssetId}`);
    }

    try {
      const [canonicalLibrary, canonicalTarget, canonicalParent] = await Promise.all([
        realpath(libraryDirectory),
        realpath(targetDirectory),
        realpath(dirname(targetPath)),
      ]);
      if (
        !isWithinDirectory(canonicalLibrary, canonicalTarget) ||
        !isWithinDirectory(canonicalTarget, canonicalParent)
      ) {
        throw new Error(`转交文件路径解析到目标账户之外: ${sourceAssetId}`);
      }
      const entry = await lstat(targetPath);
      if (entry.isDirectory()) throw new Error(`转交临时资产路径是目录: ${sourceAssetId}`);
      await unlink(targetPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
  }
}

/**
 * Transfer a thread's asset references together with its ownership change.
 * Thread-exclusive assets are moved. Global/folder/multi-thread assets are
 * copied (or linked to an identical target asset) so the source user's
 * library remains intact while the target still receives usable attachments.
 */
export async function transferThreadAssetReferences(
  sourceResourceId: string,
  targetResourceId: string,
  threadId: string,
  options?: { transferId?: string },
): Promise<ThreadAssetTransferItem[]> {
  await ensureLibrarySchema();
  const snapshot = await withClient(async (client) => {
    const refs = await client.execute({
      sql: `SELECT a.*, r.folder_id, r.thread_id
        FROM library_assets a
        JOIN library_asset_refs r ON r.asset_id = a.id AND r.resource_id = a.resource_id
        WHERE r.resource_id = ? AND r.thread_id = ?`,
      args: [sourceResourceId, threadId],
    });
    const assetIds = [...new Set(refs.rows.map((row) => String(row.id ?? "")).filter(Boolean))];
    if (assetIds.length === 0) return { assets: [], refs: [], targetAssets: [] };
    const placeholders = assetIds.map(() => "?").join(", ");
    const [allRefs, targetAssets] = await Promise.all([
      client.execute({
        sql: `SELECT asset_id, folder_id, thread_id FROM library_asset_refs
          WHERE resource_id = ? AND asset_id IN (${placeholders})`,
        args: [sourceResourceId, ...assetIds],
      }),
      client.execute({
        sql: `SELECT * FROM library_assets
          WHERE resource_id = ? AND sha256 IN (
            SELECT sha256 FROM library_assets WHERE resource_id = ? AND id IN (${placeholders})
          )`,
        args: [targetResourceId, sourceResourceId, ...assetIds],
      }),
    ]);
    return { assets: refs.rows, refs: allRefs.rows, targetAssets: targetAssets.rows };
  });

  if (snapshot.assets.length === 0) {
    if (options?.transferId) {
      await markThreadAssetTransferAssetsMoved(options.transferId, sourceResourceId, []);
    }
    return [];
  }
  const assetsById = new Map(snapshot.assets.map((row) => [String(row.id), row]));
  const refsByAsset = new Map<string, typeof snapshot.refs>();
  for (const row of snapshot.refs) {
    const assetId = String(row.asset_id);
    const refs = refsByAsset.get(assetId) ?? [];
    refs.push(row);
    refsByAsset.set(assetId, refs);
  }
  const targetBySha = new Map(snapshot.targetAssets.map((row) => [String(row.sha256), row]));
  const transferItems: ThreadAssetTransferItem[] = [];
  const copiedPaths: string[] = [];
  const timestamp = now();

  try {
    for (const [assetId, row] of assetsById) {
      const refs = refsByAsset.get(assetId) ?? [];
      const hasSharedReference = refs.some(
        (ref) => String(ref.folder_id ?? "") !== "" || String(ref.thread_id ?? "") !== threadId,
      );
      const sourceAsset = rowToAsset(row);
      const targetMatch = targetBySha.get(String(row.sha256));

      if (!hasSharedReference && !targetMatch) {
        transferItems.push({
          sourceAssetId: assetId,
          targetAssetId: assetId,
          mode: "moved",
          storagePath: String(row.storage_path),
          asset: {
            ...sourceAsset,
            resourceId: targetResourceId,
            folderIds: [],
            threadIds: [threadId],
            hasLibraryReference: false,
          },
        });
        continue;
      }

      if (targetMatch) {
        const targetAsset = rowToAsset(targetMatch);
        transferItems.push({
          sourceAssetId: assetId,
          targetAssetId: String(targetMatch.id),
          mode: "linked",
          storagePath: String(targetMatch.storage_path),
          asset: {
            ...targetAsset,
            folderIds: [],
            threadIds: [threadId],
            hasLibraryReference: targetAsset.hasLibraryReference,
          },
        });
        continue;
      }

      const targetAssetId = nanoid();
      const storagePath = join(
        "library",
        targetResourceId,
        targetAssetId.slice(0, 2),
        `${targetAssetId}_${String(row.filename)}`,
      );
      const sourcePath = join(getStorageDirectory(), String(row.storage_path));
      const targetPath = join(getStorageDirectory(), storagePath);
      const item: ThreadAssetTransferItem = {
        sourceAssetId: assetId,
        targetAssetId,
        mode: "cloned",
        storagePath,
        asset: {
          ...sourceAsset,
          id: targetAssetId,
          resourceId: targetResourceId,
          folderIds: [],
          threadIds: [threadId],
          hasLibraryReference: false,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      };
      transferItems.push(item);
      if (options?.transferId) {
        await markThreadAssetTransferAssetsPreparing(
          options.transferId,
          sourceResourceId,
          transferItems,
        );
      }
      copiedPaths.push(targetPath);
      await mkdir(
        join(getStorageDirectory(), "library", targetResourceId, targetAssetId.slice(0, 2)),
        {
          recursive: true,
        },
      );
      await copyFile(sourcePath, targetPath);
    }

    const assetMappings = Object.fromEntries(
      transferItems.map((item) => [
        item.sourceAssetId,
        {
          targetAssetId: item.targetAssetId,
          mode: item.mode,
          ...(item.mode === "cloned" ? { storagePath: item.storagePath } : {}),
        },
      ]),
    );
    const targetAssetIds = transferItems.map((item) => item.targetAssetId);
    await withClient((client) =>
      client.batch([
        ...transferItems.flatMap((item) => {
          if (item.mode === "moved") {
            return [
              {
                sql: "UPDATE library_assets SET resource_id = ?, updated_at = ? WHERE id = ? AND resource_id = ?",
                args: [targetResourceId, timestamp, item.sourceAssetId, sourceResourceId],
              },
              {
                sql: `UPDATE library_asset_refs SET resource_id = ?
                  WHERE asset_id = ? AND resource_id = ? AND folder_id = '' AND thread_id = ?`,
                args: [targetResourceId, item.sourceAssetId, sourceResourceId, threadId],
              },
              {
                sql: "UPDATE library_index_runs SET resource_id = ? WHERE asset_id = ? AND resource_id = ?",
                args: [targetResourceId, item.sourceAssetId, sourceResourceId],
              },
            ];
          }
          if (item.mode === "cloned") {
            const source = assetsById.get(item.sourceAssetId);
            if (!source) throw new Error(`源资料库资产不存在: ${item.sourceAssetId}`);
            return [
              {
                sql: `INSERT INTO library_assets
                  (id, resource_id, filename, media_type, byte_size, sha256, storage_path, status, extracted_text, created_at, updated_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                args: [
                  item.targetAssetId,
                  targetResourceId,
                  source.filename,
                  source.media_type,
                  source.byte_size,
                  source.sha256,
                  item.storagePath,
                  source.status,
                  source.extracted_text ?? null,
                  timestamp,
                  timestamp,
                ],
              },
              {
                sql: `INSERT INTO library_asset_refs
                  (asset_id, resource_id, folder_id, thread_id, created_at)
                  VALUES (?, ?, '', ?, ?)`,
                args: [item.targetAssetId, targetResourceId, threadId, timestamp],
              },
            ];
          }
          return [
            {
              sql: `INSERT OR IGNORE INTO library_asset_refs
                (asset_id, resource_id, folder_id, thread_id, created_at)
                VALUES (?, ?, '', ?, ?)`,
              args: [item.targetAssetId, targetResourceId, threadId, timestamp],
            },
          ];
        }),
        ...(options?.transferId
          ? [
              {
                sql: `UPDATE library_thread_transfers SET
                  status = ?, asset_ids = ?, asset_mappings = ?, error_message = NULL, updated_at = ?
                  WHERE id = ?`,
                args: [
                  "assets_moved",
                  JSON.stringify(targetAssetIds),
                  JSON.stringify(assetMappings),
                  timestamp,
                  options.transferId,
                ],
              },
              {
                sql: `INSERT INTO library_thread_transfer_events
                  (id, transfer_id, action, actor_resource_id, details, created_at)
                  VALUES (?, ?, ?, ?, ?, ?)`,
                args: [
                  nanoid(),
                  options.transferId,
                  "assets_moved",
                  sourceResourceId,
                  JSON.stringify({ assetMappings }),
                  timestamp,
                ],
              },
            ]
          : []),
      ]),
    );
  } catch (error) {
    const cleanup = await Promise.allSettled(
      copiedPaths.map((path) =>
        unlink(path).catch((cleanupError) => {
          if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") throw cleanupError;
        }),
      ),
    );
    const failures = cleanup.filter((result) => result.status === "rejected");
    if (failures.length > 0) {
      throw new ThreadAssetTransferCleanupPending(
        `${error instanceof Error ? error.message : String(error)}; ${failures.length} copied asset(s) need cleanup`,
      );
    }
    throw error;
  }

  return transferItems;
}

/** Best-effort compensation when the subsequent Memory ownership update fails. */
export async function rollbackThreadAssetReferences(
  sourceResourceId: string,
  targetResourceId: string,
  threadId: string,
  items: ThreadAssetTransferItem[],
): Promise<void> {
  if (items.length === 0) return;
  const copiedPaths = new Set<string>();
  await withClient(async (client) => {
    const statements = items.flatMap((item) => {
      if (item.mode === "moved") {
        return [
          {
            sql: "UPDATE library_assets SET resource_id = ?, updated_at = ? WHERE id = ? AND resource_id = ?",
            args: [sourceResourceId, now(), item.targetAssetId, targetResourceId],
          },
          {
            sql: `UPDATE library_asset_refs SET resource_id = ?
              WHERE asset_id = ? AND resource_id = ? AND folder_id = '' AND thread_id = ?`,
            args: [sourceResourceId, item.targetAssetId, targetResourceId, threadId],
          },
          {
            sql: "UPDATE library_index_runs SET resource_id = ? WHERE asset_id = ? AND resource_id = ?",
            args: [sourceResourceId, item.targetAssetId, targetResourceId],
          },
        ];
      }
      if (item.mode === "cloned") {
        copiedPaths.add(join(getStorageDirectory(), item.storagePath));
        return [
          {
            sql: "DELETE FROM library_asset_refs WHERE asset_id = ? AND resource_id = ? AND folder_id = '' AND thread_id = ?",
            args: [item.targetAssetId, targetResourceId, threadId],
          },
          { sql: "DELETE FROM library_chunks WHERE asset_id = ?", args: [item.targetAssetId] },
          {
            sql: "DELETE FROM library_index_runs WHERE asset_id = ? AND resource_id = ?",
            args: [item.targetAssetId, targetResourceId],
          },
          {
            sql: "DELETE FROM library_assets WHERE id = ? AND resource_id = ?",
            args: [item.targetAssetId, targetResourceId],
          },
        ];
      }
      return [
        {
          sql: "DELETE FROM library_asset_refs WHERE asset_id = ? AND resource_id = ? AND folder_id = '' AND thread_id = ?",
          args: [item.targetAssetId, targetResourceId, threadId],
        },
      ];
    });
    await client.batch(statements);
  });
  await Promise.all([...copiedPaths].map((path) => unlink(path).catch(() => undefined)));
}

export interface LibraryAttachmentContext {
  asset: LibraryAsset;
  text?: string;
  dataUrl?: string;
  skipped?: "media-too-large";
}

export function getLibraryAssetId(urlOrPath: unknown): string | null {
  const value = urlOrPath instanceof URL ? urlOrPath.toString() : urlOrPath;
  if (typeof value !== "string") return null;
  const match = value.match(/\/work\/library\/assets\/([^/?#]+)\/content/);
  if (match) return decodeURIComponent(match[1]);
  if (/^[a-zA-Z0-9_-]{10,32}$/.test(value)) return value;
  return null;
}

export async function getAssetContext(
  resourceId: string,
  assetId: string,
  options?: { maxMediaBytes?: number },
): Promise<LibraryAttachmentContext | null> {
  await waitForAssetIndexing(resourceId, assetId);
  const asset = await getLibraryAsset(resourceId, assetId);
  if (!asset) return null;
  if (asset.extractedText) return { asset, text: asset.extractedText };
  if (
    asset.mediaType.startsWith("image/") ||
    asset.mediaType.startsWith("audio/") ||
    asset.mediaType.startsWith("video/")
  ) {
    const maxMediaBytes = options?.maxMediaBytes ?? MAX_LIBRARY_INLINE_MEDIA_BYTES;
    if (asset.byteSize > maxMediaBytes) return { asset, skipped: "media-too-large" };
    const result = await readAssetBytes(resourceId, assetId);
    if (!result) return null;
    const { bytes } = result;
    const base64 = Buffer.from(bytes).toString("base64");
    return { asset, dataUrl: `data:${asset.mediaType};base64,${base64}` };
  }
  return { asset };
}
