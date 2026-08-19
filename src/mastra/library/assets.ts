import { mkdir, readFile, rename, unlink } from "node:fs/promises";
import { extname, join } from "node:path";
import { nanoid } from "nanoid";
import { getStorageDirectory } from "../storage";
import { ensureLibrarySchema, getLatestLibraryIndexRuns, now, rowToAsset, withClient } from "./db";
import { isExtractable, normalizeFilename, resolveMediaType } from "./extract";
import { getVector, queueAssetIndex, reindexAsset, waitForAssetIndexing } from "./indexing";
import { getLibrarySettings } from "./settings";
import { type LibraryAsset, MAX_LIBRARY_FILE_BYTES } from "./types";

/**
 * 资料库资产管理:上传入库(去重 + 后台抽取/索引)、列表、重命名、读取、
 * 删除,以及供 Agent 输入处理器使用的附件上下文解析。
 */

const libraryRoot = join(getStorageDirectory(), "library-files");

interface UploadInput {
  resourceId: string;
  filename: string;
  mediaType: string;
  tempPath: string;
  byteSize: number;
  sha256: string;
  folderId?: string;
  threadId?: string;
}

export async function uploadAsset(input: UploadInput): Promise<LibraryAsset> {
  await ensureLibrarySchema();
  if (input.byteSize > MAX_LIBRARY_FILE_BYTES) {
    throw new Error(`单个附件不能超过 ${MAX_LIBRARY_FILE_BYTES / 1024 / 1024} MB`);
  }
  const filename = normalizeFilename(input.filename);
  const mediaType = resolveMediaType(filename, input.mediaType);
  const sha256 = input.sha256;
  const existing = await withClient(async (client) =>
    client.execute({
      sql: "SELECT * FROM library_assets WHERE resource_id = ? AND sha256 = ? LIMIT 1",
      args: [input.resourceId, sha256],
    }),
  );
  const existingRow = existing.rows[0];
  if (existingRow) {
    await unlink(input.tempPath).catch(() => undefined);
    await attachAssetReference(
      input.resourceId,
      String(existingRow.id),
      input.folderId,
      input.threadId,
    );
    return {
      ...rowToAsset(existingRow),
      folderIds: input.folderId ? [input.folderId] : [],
      threadIds: input.threadId ? [input.threadId] : [],
    };
  }

  await mkdir(libraryRoot, { recursive: true });
  const id = nanoid();
  const storagePath = join("library-files", `${id}${extname(filename).toLowerCase()}`);
  const absoluteStoragePath = join(getStorageDirectory(), storagePath);
  await rename(input.tempPath, absoluteStoragePath);
  const timestamp = now();
  const extractedText: string | null = null;
  const status: LibraryAsset["status"] = isExtractable(filename, mediaType)
    ? "indexing"
    : "unsupported";
  try {
    await withClient(async (client) =>
      client.execute({
        sql: `INSERT INTO library_assets
      (id, resource_id, filename, media_type, byte_size, sha256, storage_path, status, extracted_text, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          id,
          input.resourceId,
          filename,
          mediaType,
          input.byteSize,
          sha256,
          storagePath,
          status,
          extractedText,
          timestamp,
          timestamp,
        ],
      }),
    );
  } catch (error) {
    await unlink(absoluteStoragePath).catch(() => undefined);
    throw error;
  }
  const asset = {
    id,
    resourceId: input.resourceId,
    folderIds: input.folderId ? [input.folderId] : [],
    threadIds: input.threadId ? [input.threadId] : [],
    filename,
    mediaType,
    byteSize: input.byteSize,
    sha256,
    status,
    extractedText,
    indexAttempt: 0,
    indexStage: status === "indexing" ? "extract" : null,
    indexError: null,
    indexStartedAt: null,
    indexCompletedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  } satisfies LibraryAsset;
  await attachAssetReference(input.resourceId, id, input.folderId, input.threadId);
  if (status === "indexing") {
    void (async () => {
      try {
        await reindexAsset(asset.resourceId, asset.id, await getLibrarySettings());
      } catch {
        // reindexAsset 已持久化失败阶段与错误信息。
      }
    })();
  }
  return asset;
}

async function attachAssetReference(
  resourceId: string,
  assetId: string,
  folderId?: string,
  threadId?: string,
): Promise<void> {
  const timestamp = now();
  await withClient((client) =>
    client.batch([
      {
        sql: `INSERT OR IGNORE INTO library_asset_refs
          (asset_id, resource_id, folder_id, thread_id, created_at) VALUES (?, ?, ?, ?, ?)`,
        args: [assetId, resourceId, folderId ?? "", threadId ?? "", timestamp],
      },
      {
        sql: "UPDATE library_assets SET updated_at = ? WHERE id = ? AND resource_id = ?",
        args: [timestamp, assetId, resourceId],
      },
    ]),
  );
}

export async function listAssets(
  resourceId: string,
  folderId?: string,
  threadId?: string,
): Promise<LibraryAsset[]> {
  await ensureLibrarySchema();
  const [result, referenceResult] = await withClient((client) =>
    Promise.all([
      client.execute({
        sql: `SELECT a.* FROM library_assets a
        WHERE a.resource_id = ?
          AND (? IS NULL OR EXISTS (SELECT 1 FROM library_asset_refs r WHERE r.asset_id = a.id AND r.resource_id = ? AND r.folder_id = ?))
          AND (? IS NULL OR EXISTS (SELECT 1 FROM library_asset_refs r WHERE r.asset_id = a.id AND r.resource_id = ? AND (r.thread_id = '' OR r.thread_id = ?)))
        ORDER BY a.updated_at DESC`,
        args: [
          resourceId,
          folderId ?? null,
          resourceId,
          folderId ?? "",
          threadId ?? null,
          resourceId,
          threadId ?? "",
        ],
      }),
      client.execute({
        sql: "SELECT asset_id, folder_id, thread_id FROM library_asset_refs WHERE resource_id = ? ORDER BY created_at DESC",
        args: [resourceId],
      }),
    ]),
  );
  const references = new Map<string, { folderIds: string[]; threadIds: string[] }>();
  const indexRuns = await getLatestLibraryIndexRuns(resourceId);
  for (const row of referenceResult.rows) {
    const assetId = String(row.asset_id);
    const value = references.get(assetId) ?? { folderIds: [], threadIds: [] };
    const referenceFolderId = String(row.folder_id || "");
    const referenceThreadId = String(row.thread_id || "");
    if (referenceFolderId && !value.folderIds.includes(referenceFolderId)) {
      value.folderIds.push(referenceFolderId);
    }
    if (referenceThreadId && !value.threadIds.includes(referenceThreadId)) {
      value.threadIds.push(referenceThreadId);
    }
    references.set(assetId, value);
  }
  return result.rows.map((row) => {
    const asset = rowToAsset(row);
    const value = references.get(asset.id) ?? { folderIds: [], threadIds: [] };
    const indexRun = indexRuns.get(asset.id);
    return {
      ...asset,
      folderIds: value.folderIds,
      threadIds: value.threadIds,
      ...(indexRun
        ? {
            indexAttempt: indexRun.attempt,
            indexStage: indexRun.stage,
            indexError: indexRun.error,
            indexStartedAt: indexRun.startedAt,
            indexCompletedAt: indexRun.completedAt,
          }
        : {}),
    };
  });
}

export async function renameAsset(
  resourceId: string,
  id: string,
  filename: string,
): Promise<LibraryAsset | null> {
  await ensureLibrarySchema();
  const normalized = normalizeFilename(filename);
  const existing = await withClient((client) =>
    client.execute({
      sql: "SELECT * FROM library_assets WHERE id = ? AND resource_id = ? LIMIT 1",
      args: [id, resourceId],
    }),
  );
  const existingAsset = existing.rows[0] ? rowToAsset(existing.rows[0]) : null;
  if (!existingAsset) return null;
  if (existingAsset.filename === normalized) return existingAsset;
  const timestamp = now();
  const updated = await withClient((client) =>
    client.execute({
      sql: "UPDATE library_assets SET filename = ?, updated_at = ? WHERE id = ? AND resource_id = ?",
      args: [normalized, timestamp, id, resourceId],
    }),
  );
  if (updated.rowsAffected === 0) return null;
  const result = await withClient((client) =>
    client.execute({
      sql: "SELECT * FROM library_assets WHERE id = ? AND resource_id = ? LIMIT 1",
      args: [id, resourceId],
    }),
  );
  const asset = result.rows[0] ? rowToAsset(result.rows[0]) : null;
  if (!asset?.extractedText?.trim()) return asset;

  // 文件名也会写入向量 metadata。等待已有索引任务完成后再按新 metadata
  // 重建,避免旧任务在重命名后把旧文件名写回索引。
  await waitForAssetIndexing(id);
  await withClient((client) =>
    client.execute({
      sql: "UPDATE library_assets SET status = ?, updated_at = ? WHERE id = ? AND resource_id = ?",
      args: ["indexing", now(), id, resourceId],
    }),
  );
  try {
    await queueAssetIndex(
      { ...asset, status: "indexing" },
      asset.extractedText,
      await getLibrarySettings(),
    );
  } catch {
    // queueAssetIndex 已记录失败阶段与具体原因。
  }
  const refreshed = await withClient((client) =>
    client.execute({
      sql: "SELECT * FROM library_assets WHERE id = ? AND resource_id = ? LIMIT 1",
      args: [id, resourceId],
    }),
  );
  return refreshed.rows[0] ? rowToAsset(refreshed.rows[0]) : asset;
}

export async function readAssetBytes(
  resourceId: string,
  id: string,
): Promise<{ asset: LibraryAsset; bytes: Uint8Array } | null> {
  await ensureLibrarySchema();
  const result = await withClient((client) =>
    client.execute({
      sql: "SELECT * FROM library_assets WHERE id = ? AND resource_id = ? LIMIT 1",
      args: [id, resourceId],
    }),
  );
  const row = result.rows[0];
  if (!row) return null;
  const asset = rowToAsset(row);
  return {
    asset,
    bytes: new Uint8Array(await readFile(join(getStorageDirectory(), String(row.storage_path)))),
  };
}

export async function deleteAsset(resourceId: string, id: string): Promise<boolean> {
  await ensureLibrarySchema();
  const result = await withClient((client) =>
    client.execute({
      sql: "SELECT storage_path FROM library_assets WHERE id = ? AND resource_id = ? LIMIT 1",
      args: [id, resourceId],
    }),
  );
  const row = result.rows[0];
  if (!row) return false;
  await waitForAssetIndexing(id);
  await withClient(async (client) => {
    await client.batch([
      {
        sql: "DELETE FROM library_asset_refs WHERE asset_id = ? AND resource_id = ?",
        args: [id, resourceId],
      },
      { sql: "DELETE FROM library_chunks WHERE asset_id = ?", args: [id] },
      {
        sql: "DELETE FROM library_index_runs WHERE asset_id = ? AND resource_id = ?",
        args: [id, resourceId],
      },
      {
        sql: "DELETE FROM library_assets WHERE id = ? AND resource_id = ?",
        args: [id, resourceId],
      },
    ]);
  });
  try {
    const vector = await getVector();
    const indexes = await vector.listIndexes();
    for (const indexName of indexes.filter((name) => name.startsWith("library_vectors_"))) {
      await vector.deleteVectors({ indexName, filter: { assetId: id } }).catch(() => undefined);
    }
  } catch {
    // 文件删除不能被向量索引的暂时不可用阻断。
  }
  await unlink(join(getStorageDirectory(), String(row.storage_path))).catch(() => undefined);
  return true;
}

export async function getAssetContext(
  resourceId: string,
  id: string,
): Promise<{ asset: LibraryAsset; dataUrl?: string; text?: string } | null> {
  const result = await readAssetBytes(resourceId, id);
  if (!result) return null;
  const { asset, bytes } = result;
  if (asset.extractedText?.trim()) return { asset, text: asset.extractedText };
  if (asset.status === "error" || asset.status === "unsupported") return { asset };
  if (isExtractable(asset.filename, asset.mediaType)) {
    try {
      await reindexAsset(resourceId, asset.id, await getLibrarySettings());
      const refreshed = await readAssetBytes(resourceId, asset.id);
      const text = refreshed?.asset.extractedText;
      if (refreshed && text?.trim()) {
        return { asset: refreshed.asset, text };
      }
    } catch {
      const failed = await readAssetBytes(resourceId, asset.id);
      return failed ? { asset: failed.asset } : { asset };
    }
  }
  if (asset.mediaType.startsWith("image/") || asset.mediaType.startsWith("audio/")) {
    return {
      asset,
      dataUrl: `data:${asset.mediaType};base64,${Buffer.from(bytes).toString("base64")}`,
    };
  }
  return { asset };
}

/**
 * Stable library URLs are the persisted AI SDK file reference. The input
 * processor resolves that reference only at the provider boundary.
 */
export function getLibraryAssetId(value: unknown): string | undefined {
  const url = value instanceof URL ? value.href : typeof value === "string" ? value : undefined;
  const encoded = url ? /\/work\/library\/assets\/([^/]+)\/content/.exec(url)?.[1] : undefined;
  return encoded ? decodeURIComponent(encoded) : undefined;
}
