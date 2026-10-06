/**
 * 资产管理层:上传去重(sha256)、入库、目录/线程关联绑定与二进制读取。
 * 表结构见 ./db.ts(docs/en/reference/rag/database-config.mdx)。
 */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, stat, unlink } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { TABLE_THREADS } from "@mastra/core/storage";
import { nanoid } from "nanoid";
import { getStorageDirectory } from "../../storage/database";
import {
  deleteAssetVectors,
  detectMediaType,
  extractFileText,
  isExtractable,
  normalizeFilename,
  queueAssetIndex,
  readBoundedFile,
  waitForAssetIndexing,
} from "../document/indexing";
import {
  type LibraryAsset,
  MAX_LIBRARY_EXTRACT_BYTES,
  MAX_LIBRARY_FILE_BYTES,
  MAX_LIBRARY_INLINE_MEDIA_BYTES,
} from "../types";
import {
  ensureLibrarySchema,
  getLatestLibraryIndexRuns,
  getLibrarySettings,
  now,
  rowToAsset,
  withClient,
  withLibraryAssetLock,
} from "./db";
import { ensureFolderReference } from "./folders";

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
  draftId?: string;
  local?: boolean;
};

export async function uploadAssetFromFile(
  input: AssetUploadMetadata & { filePath: string; byteSize: number; sha256?: string },
): Promise<LibraryAsset> {
  if (input.byteSize <= 0 || input.byteSize > MAX_LIBRARY_FILE_BYTES)
    throw new Error("附件大小必须在 1 字节到 50 MiB 之间");
  const sha256 = input.sha256 ?? (await hashFile(input.filePath, input.byteSize));
  return withLibraryAssetLock(`upload:${input.resourceId}:${sha256}`, () =>
    storeAssetFromFile({ ...input, sha256 }),
  );
}

/** Store the streamed upload; extractable documents are read only for text extraction. */
async function storeAssetFromFile(
  input: AssetUploadMetadata & {
    filePath: string;
    byteSize: number;
    sha256?: string;
  },
): Promise<LibraryAsset> {
  const file = await stat(input.filePath);
  if (file.size !== input.byteSize) {
    throw new Error(`临时上传文件大小不匹配: ${file.size}/${input.byteSize}`);
  }
  const sha256 = input.sha256 ?? (await hashFile(input.filePath, input.byteSize));
  if (input.byteSize === 0) throw new Error("文件内容不能为空");
  if (input.byteSize > MAX_LIBRARY_FILE_BYTES) {
    throw new Error(`单个文件不能超过 ${MAX_LIBRARY_FILE_BYTES / (1024 * 1024)} MB`);
  }
  await ensureLibrarySchema();
  await ensureFolderReference(input.resourceId, input.folderId, input.threadId);
  const normalized = normalizeFilename(input.filename);
  const mediaType = await detectMediaType(input.filePath, normalized);
  const baseDir = getStorageDirectory();

  const existingRow = await withClient(async (client) => {
    const result = await client.execute({
      sql: "SELECT * FROM library_assets WHERE resource_id = ? AND sha256 = ? AND local_path = ? LIMIT 1",
      args: [input.resourceId, sha256, input.local ? input.filePath : ""],
    });
    return result.rows[0];
  });

  if (existingRow) {
    const asset = rowToAsset(existingRow);
    if (input.local)
      await withLibraryAssetLock(asset.id, () =>
        withClient((client) =>
          client.execute({
            sql: "UPDATE library_assets SET local_mtime = ? WHERE id = ? AND resource_id = ?",
            args: [file.mtimeMs, asset.id, input.resourceId],
          }),
        ),
      );
    await attachAssetReference(
      input.resourceId,
      asset.id,
      input.folderId,
      input.threadId,
      input.draftId,
    );
    return asset;
  }

  const id = nanoid();
  const relDir = join("library", input.resourceId, id.slice(0, 2));
  const relPath = join(relDir, `${id}_${normalized}`);
  const absDir = join(baseDir, relDir);
  const absPath = join(baseDir, relPath);
  if (!input.local) {
    await mkdir(absDir, { recursive: true });
    try {
      await pipeline(createReadStream(input.filePath), createWriteStream(absPath, { flags: "wx" }));
    } catch (error) {
      await unlink(absPath).catch(() => undefined);
      throw error;
    }
  }

  let extractable = false;
  let createdAsset: LibraryAsset | undefined;
  try {
    extractable =
      input.byteSize <= MAX_LIBRARY_EXTRACT_BYTES && isExtractable(normalized, mediaType);
    const status: LibraryAsset["status"] = extractable ? "indexing" : "unsupported";
    // Media files stay on disk. Text/PDF/office formats are read once only when
    // the existing extractor needs bytes; this avoids a second in-memory copy
    // for the common image/audio/video upload path.
    const extracted = extractable
      ? await extractFileText(input.filePath, normalized, mediaType)
      : null;
    if (input.local) {
      const current = await stat(input.filePath);
      if (current.size !== file.size || current.mtimeMs !== file.mtimeMs)
        throw new Error("本地文件在处理期间发生变化，请重新添加");
    }
    const timestamp = now();

    await withClient(async (client) => {
      const statements = [
        {
          sql: `INSERT INTO library_assets
          (id, resource_id, filename, media_type, byte_size, sha256, storage_path, local_path, local_mtime, status, extracted_text, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [
            id,
            input.resourceId,
            normalized,
            mediaType,
            input.byteSize,
            sha256,
            input.local ? "" : relPath,
            input.local ? input.filePath : "",
            input.local ? file.mtimeMs : 0,
            status,
            extracted,
            timestamp,
            timestamp,
          ],
        },
        {
          sql: `INSERT INTO library_asset_refs
            (asset_id, resource_id, folder_id, thread_id, draft_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
          args: [
            id,
            input.resourceId,
            input.folderId ?? "",
            input.threadId ?? "",
            input.draftId ?? "",
            timestamp,
          ],
        },
      ];
      await client.batch(statements);
    });

    createdAsset = {
      localPath: input.local ? input.filePath : null,
      id,
      resourceId: input.resourceId,
      folderIds: input.folderId ? [input.folderId] : [],
      threadIds: input.threadId ? [input.threadId] : [],
      hasLibraryReference: !input.draftId && !input.folderId && !input.threadId,
      filename: normalized,
      mediaType,
      byteSize: input.byteSize,
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
  } catch (error) {
    if (!input.local) await unlink(absPath).catch(() => undefined);
    throw error;
  }

  if (!createdAsset) throw new Error("资产入库未生成记录");
  if (extractable) {
    try {
      const settings = await getLibrarySettings(input.resourceId);
      void queueAssetIndex(createdAsset, settings).catch(() => undefined);
    } catch {
      // The asset is already durable; recovery can retry indexing later.
    }
  }
  return createdAsset;
}

async function hashFile(filePath: string, expectedSize: number): Promise<string> {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(filePath)) {
    size += chunk.byteLength;
    if (size > MAX_LIBRARY_FILE_BYTES || size > expectedSize)
      throw new Error("附件读取期间大小发生变化");
    hash.update(chunk);
  }
  if (size !== expectedSize) throw new Error("附件读取期间大小发生变化");
  return hash.digest("hex");
}

export async function listAssets(resourceId: string, threadId?: string): Promise<LibraryAsset[]> {
  await ensureLibrarySchema();
  const [assetRows, refRows, runsMap] = await withClient(async (client) => {
    const assets = await client.execute({
      sql: `SELECT a.* FROM library_assets a
        WHERE a.resource_id = ?
          AND EXISTS (SELECT 1 FROM library_asset_refs r WHERE r.asset_id = a.id AND r.resource_id = a.resource_id AND r.draft_id = '')
          AND (? IS NULL OR EXISTS (
            SELECT 1 FROM library_asset_refs r
            WHERE r.asset_id = a.id AND r.resource_id = a.resource_id AND r.draft_id = '' AND (r.thread_id = '' OR r.thread_id = ?)
          ))
        ORDER BY a.updated_at DESC`,
      args: [resourceId, threadId ?? null, threadId ?? ""],
    });
    const refs = await client.execute({
      sql: "SELECT asset_id, folder_id, thread_id FROM library_asset_refs WHERE resource_id = ? AND draft_id = ''",
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
  const timestamp = now();
  const updated = await withClient(async (client) => {
    await client.execute({
      sql: "UPDATE library_assets SET filename = ?, updated_at = ? WHERE id = ? AND resource_id = ?",
      args: [normalized, timestamp, id, resourceId],
    });
    const result = await client.execute({
      sql: "SELECT * FROM library_assets WHERE id = ? AND resource_id = ? LIMIT 1",
      args: [id, resourceId],
    });
    return result.rows[0];
  });
  return updated ? rowToAsset(updated) : null;
}

export async function getAssetFile(
  resourceId: string,
  id: string,
): Promise<{ asset: LibraryAsset; path: string } | null> {
  await ensureLibrarySchema();
  const result = await withClient((client) =>
    client.execute({
      sql: "SELECT * FROM library_assets WHERE id = ? AND resource_id = ? LIMIT 1",
      args: [id, resourceId],
    }),
  );
  const row = result.rows[0];
  if (!row) return null;
  const path = row.local_path
    ? String(row.local_path)
    : resolve(getStorageDirectory(), String(row.storage_path));
  const details = await stat(path).catch((error: NodeJS.ErrnoException) => {
    if (["ENOENT", "ENOTDIR"].includes(error.code ?? "")) return null;
    throw error;
  });
  if (
    !details?.isFile() ||
    (row.local_path &&
      (details.size !== Number(row.byte_size) || details.mtimeMs !== Number(row.local_mtime)))
  )
    return null;
  return { asset: rowToAsset(row), path };
}

export async function getLibraryAsset(
  resourceId: string,
  id: string,
): Promise<LibraryAsset | null> {
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

export async function deleteAsset(
  resourceId: string,
  id: string,
  onlyUnreferenced = false,
): Promise<boolean> {
  return withLibraryAssetLock(id, async () => {
    await ensureLibrarySchema();
    const result = await withClient((client) =>
      client.execute({
        sql: "SELECT storage_path, local_path FROM library_assets WHERE id = ? AND resource_id = ? LIMIT 1",
        args: [id, resourceId],
      }),
    );
    const row = result.rows[0];
    if (!row) return false;
    if (onlyUnreferenced) {
      const refs = await withClient((client) =>
        client.execute({
          sql: "SELECT 1 FROM library_asset_refs WHERE asset_id = ? AND resource_id = ? LIMIT 1",
          args: [id, resourceId],
        }),
      );
      if (refs.rows.length) return false;
    }

    await deleteAssetVectors(resourceId, id);
    // Keep the SQL record available for retry if removing the file fails.
    if (!row.local_path)
      await unlink(join(getStorageDirectory(), String(row.storage_path))).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
    await withClient((client) =>
      client.batch([
        {
          sql: "DELETE FROM library_asset_refs WHERE asset_id = ? AND resource_id = ?",
          args: [id, resourceId],
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
    return true;
  });
}

export async function attachAssetReference(
  resourceId: string,
  assetId: string,
  folderId?: string,
  threadId?: string,
  draftId?: string,
): Promise<void> {
  await withLibraryAssetLock(assetId, async () => {
    await ensureLibrarySchema();
    await ensureFolderReference(resourceId, folderId, threadId);
    if (!(await getLibraryAsset(resourceId, assetId))) throw new Error("附件已删除");
    await withClient((client) =>
      client.execute({
        sql: `INSERT INTO library_asset_refs (asset_id, resource_id, folder_id, thread_id, draft_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(asset_id, folder_id, thread_id, draft_id) DO UPDATE SET created_at = excluded.created_at`,
        args: [assetId, resourceId, folderId ?? "", threadId ?? "", draftId ?? "", now()],
      }),
    );
  });
}

export async function releaseThreadAssets(resourceId: string, threadId: string): Promise<void> {
  await ensureLibrarySchema();
  const result = await withClient((client) =>
    client.execute({
      sql: "DELETE FROM library_asset_refs WHERE resource_id = ? AND (thread_id = ? OR draft_id = ?) RETURNING asset_id",
      args: [resourceId, threadId, `mastra-work:prompt:${resourceId}:${threadId}`],
    }),
  );
  await withClient((client) =>
    client.execute({
      sql: "DELETE FROM library_folders WHERE resource_id = ? AND thread_id = ?",
      args: [resourceId, threadId],
    }),
  );
  for (const id of new Set(result.rows.map((row) => String(row.asset_id))))
    await deleteAsset(resourceId, id, true);
}

/** Startup GC: expired drafts, unreferenced DB assets, then untracked files in the managed tree. */
export async function cleanupOrphanedLibraryAssets(): Promise<void> {
  await ensureLibrarySchema();
  await withClient(async (client) => {
    const exists = await client.execute({
      sql: "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
      args: [TABLE_THREADS],
    });
    if (exists.rows.length)
      await client.execute(
        `DELETE FROM library_asset_refs WHERE thread_id != '' AND NOT EXISTS (SELECT 1 FROM "${TABLE_THREADS}" t WHERE t.id = library_asset_refs.thread_id AND t.resourceId = library_asset_refs.resource_id)`,
      );
  });
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  await withClient((client) =>
    client.execute({
      sql: "DELETE FROM library_asset_refs WHERE draft_id != '' AND created_at < ?",
      args: [cutoff],
    }),
  );
  const orphaned = await withClient((client) =>
    client.execute(
      `SELECT a.id, a.resource_id FROM library_assets a WHERE NOT EXISTS (SELECT 1 FROM library_asset_refs r WHERE r.asset_id = a.id AND r.resource_id = a.resource_id)`,
    ),
  );
  for (const row of orphaned.rows) await deleteAsset(String(row.resource_id), String(row.id), true);
  const rows = await withClient((client) =>
    client.execute("SELECT storage_path FROM library_assets WHERE local_path = ''"),
  );
  const known = new Set(
    rows.rows.map((row) => resolve(getStorageDirectory(), String(row.storage_path))),
  );
  const root = resolve(getStorageDirectory(), "library");
  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      },
    );
    for (const entry of entries) {
      if (entry.isSymbolicLink() || entry.name === "_chunks") continue;
      const path = resolve(directory, entry.name);
      const within = relative(root, path);
      if (within.startsWith("..") || isAbsolute(within))
        throw new Error("Invalid library cleanup path");
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && !known.has(path)) await unlink(path);
    }
  };
  await walk(root);
}

export interface LibraryAttachmentContext {
  asset: LibraryAsset;
  text?: string;
  dataUrl?: string;
  path: string;
  skipped?: "media-too-large" | "document-too-large" | "unsupported-media";
}

export function getLibraryAssetId(urlOrPath: unknown): string | null {
  const value = urlOrPath instanceof URL ? urlOrPath.toString() : urlOrPath;
  if (typeof value !== "string") return null;
  const match = value.match(/\/work\/library\/assets\/([^/?#]+)\/content/);
  if (match) {
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return null;
    }
  }
  if (/^[a-zA-Z0-9_-]{10,32}$/.test(value)) return value;
  return null;
}

export async function getAssetContext(
  resourceId: string,
  assetId: string,
  options: { maxMediaBytes?: number; vision?: boolean; audio?: boolean } = {},
): Promise<LibraryAttachmentContext | null> {
  await waitForAssetIndexing(resourceId, assetId);
  const file = await getAssetFile(resourceId, assetId);
  if (!file) return null;
  const { asset, path } = file;
  if (asset.extractedText) return { asset, path, text: asset.extractedText };
  if (isExtractable(asset.filename, asset.mediaType) && asset.byteSize > MAX_LIBRARY_EXTRACT_BYTES)
    return { asset, path, skipped: "document-too-large" };
  if (/^(image|audio|video)\//.test(asset.mediaType)) {
    const limit = Math.min(
      options.maxMediaBytes ?? MAX_LIBRARY_INLINE_MEDIA_BYTES,
      MAX_LIBRARY_INLINE_MEDIA_BYTES,
    );
    if (asset.byteSize > limit) return { asset, path, skipped: "media-too-large" };
    const supported = asset.mediaType.startsWith("image/")
      ? options.vision
      : asset.mediaType.startsWith("audio/") && options.audio;
    if (!supported) return { asset, path, skipped: "unsupported-media" };
    const bytes = await readBoundedFile(path, limit);
    return { asset, path, dataUrl: `data:${asset.mediaType};base64,${bytes.toString("base64")}` };
  }
  return { asset, path };
}
