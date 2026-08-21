/**
 * 资产管理层:上传去重(sha256)、入库、目录/线程关联绑定与二进制读取。
 * 表结构见 ./db.ts(docs/en/reference/rag/database-config.mdx)。
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { nanoid } from "nanoid";
import { getStorageDirectory } from "../../storage";
import {
  extractText,
  isExtractable,
  normalizeFilename,
  resolveMediaType,
} from "../document/extract";
import { reindexAsset, waitForAssetIndexing } from "../document/indexing";
import { getLibrarySettings } from "../settings";
import { type LibraryAsset, MAX_LIBRARY_FILE_BYTES } from "../types";
import { ensureLibrarySchema, getLatestLibraryIndexRuns, now, rowToAsset, withClient } from "./db";

/**
 * 资产管理层:
 * 上传、入库、关联绑定与读取二进制。
 */

export async function uploadAsset(
  input: {
    resourceId: string;
    filename: string;
    bytes: Uint8Array;
    mediaType?: string;
    folderId?: string;
    threadId?: string;
  },
  skipIndexing = false,
): Promise<LibraryAsset> {
  if (input.bytes.byteLength === 0) throw new Error("文件内容不能为空");
  if (input.bytes.byteLength > MAX_LIBRARY_FILE_BYTES) throw new Error("单个文件不能超过 100 MB");

  await ensureLibrarySchema();
  const normalized = normalizeFilename(input.filename);
  const mediaType = resolveMediaType(normalized, input.mediaType || "");
  const sha256 = createHash("sha256").update(input.bytes).digest("hex");
  const baseDir = getStorageDirectory();

  const existingRow = await withClient(async (client) => {
    const result = await client.execute({
      sql: "SELECT * FROM library_assets WHERE resource_id = ? AND sha256 = ? LIMIT 1",
      args: [input.resourceId, sha256],
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
  await writeFile(absPath, input.bytes);

  const extractable = isExtractable(normalized, mediaType);
  const status: LibraryAsset["status"] = extractable
    ? skipIndexing
      ? "ready"
      : "indexing"
    : "unsupported";
  const extracted = extractable ? await extractText(input.bytes, normalized, mediaType) : null;
  const timestamp = now();

  await withClient(async (client) => {
    await client.batch([
      {
        sql: `INSERT INTO library_assets
          (id, resource_id, filename, media_type, byte_size, sha256, storage_path, status, extracted_text, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          id,
          input.resourceId,
          normalized,
          mediaType,
          input.bytes.byteLength,
          sha256,
          relPath,
          status,
          extracted,
          timestamp,
          timestamp,
        ],
      },
      {
        sql: `INSERT INTO library_asset_refs
          (asset_id, resource_id, folder_id, thread_id, created_at)
          VALUES (?, ?, ?, ?, ?)`,
        args: [id, input.resourceId, input.folderId ?? "", input.threadId ?? "", timestamp],
      },
    ]);
  });

  const createdAsset: LibraryAsset = {
    id,
    resourceId: input.resourceId,
    folderIds: input.folderId ? [input.folderId] : [],
    threadIds: input.threadId ? [input.threadId] : [],
    filename: normalized,
    mediaType,
    byteSize: input.bytes.byteLength,
    sha256,
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

  if (extractable && !skipIndexing) {
    const settings = await getLibrarySettings();
    void reindexAsset(input.resourceId, id, settings).catch(() => undefined);
  }
  return createdAsset;
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
  for (const ref of refRows) {
    const assetId = String(ref.asset_id);
    const folderId = String(ref.folder_id || "");
    const thread = String(ref.thread_id || "");
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
  await ensureLibrarySchema();
  const row = await withClient(async (client) => {
    const result = await client.execute({
      sql: "SELECT * FROM library_assets WHERE id = ? AND resource_id = ? LIMIT 1",
      args: [id, resourceId],
    });
    return result.rows[0];
  });
  if (!row) return null;
  const asset = rowToAsset(row);
  const relPath = String(row.storage_path || "");
  const absPath = join(getStorageDirectory(), relPath);
  const buffer = await readFile(absPath).catch(() => null);
  if (!buffer) return null;
  return { bytes: new Uint8Array(buffer), asset };
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
): Promise<void> {
  await ensureLibrarySchema();
  await withClient((client) =>
    client.execute({
      sql: `INSERT OR IGNORE INTO library_asset_refs (asset_id, resource_id, folder_id, thread_id, created_at)
        VALUES (?, ?, ?, ?, ?)`,
      args: [assetId, resourceId, folderId ?? "", threadId ?? "", now()],
    }),
  );
}

export interface LibraryAttachmentContext {
  asset: LibraryAsset;
  text?: string;
  dataUrl?: string;
}

export function getLibraryAssetId(urlOrPath: unknown): string | null {
  if (typeof urlOrPath !== "string") return null;
  const match = urlOrPath.match(/\/work\/library\/assets\/([^/?#]+)\/content/);
  if (match) return decodeURIComponent(match[1]);
  if (/^[a-zA-Z0-9_-]{10,32}$/.test(urlOrPath)) return urlOrPath;
  return null;
}

export async function getAssetContext(
  resourceId: string,
  assetId: string,
): Promise<LibraryAttachmentContext | null> {
  await waitForAssetIndexing(resourceId, assetId);
  const result = await readAssetBytes(resourceId, assetId);
  if (!result) return null;
  const { bytes, asset } = result;
  if (asset.extractedText) return { asset, text: asset.extractedText };
  if (
    asset.mediaType.startsWith("image/") ||
    asset.mediaType.startsWith("audio/") ||
    asset.mediaType.startsWith("video/")
  ) {
    const base64 = Buffer.from(bytes).toString("base64");
    return { asset, dataUrl: `data:${asset.mediaType};base64,${base64}` };
  }
  return { asset };
}
