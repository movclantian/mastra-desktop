import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, unlink } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { nanoid } from "nanoid";
import { getStorageDirectory } from "../storage";
import { uploadAsset } from "./assets";
import { ensureLibrarySchema, now, rowToUploadSession, withClient } from "./db";
import { normalizeFilename, resolveMediaType } from "./extract";
import {
  LIBRARY_UPLOAD_CHUNK_BYTES,
  type LibraryAsset,
  type LibraryUploadSession,
  MAX_LIBRARY_FILE_BYTES,
} from "./types";

/**
 * 大文件分片上传:会话(24h 过期)→ 分片落盘(库外临时目录)→ 校验合并 →
 * 转交 assets.uploadAsset 入库去重。断点续传按 (filename, byteSize, mediaType,
 * folderId, threadId) 匹配既有会话。
 */

const libraryUploadRoot = join(getStorageDirectory(), "library-upload-parts");

export async function getLibraryUploadSession(
  resourceId: string,
  id: string,
): Promise<LibraryUploadSession | null> {
  await ensureLibrarySchema();
  const [sessionResult, chunksResult] = await withClient((client) =>
    Promise.all([
      client.execute({
        sql: "SELECT * FROM library_upload_sessions WHERE id = ? AND resource_id = ? AND expires_at > ? LIMIT 1",
        args: [id, resourceId, now()],
      }),
      client.execute({
        sql: `SELECT chunk_index FROM library_upload_chunks
          WHERE session_id = ? AND EXISTS (
            SELECT 1 FROM library_upload_sessions WHERE id = ? AND resource_id = ? AND expires_at > ?
          ) ORDER BY chunk_index`,
        args: [id, id, resourceId, now()],
      }),
    ]),
  );
  const row = sessionResult.rows[0];
  return row
    ? rowToUploadSession(
        row,
        chunksResult.rows.map((chunk) => Number(chunk.chunk_index)),
      )
    : null;
}

async function cleanupExpiredUploads(): Promise<void> {
  const expired = await withClient((client) =>
    client.execute({
      sql: "SELECT id FROM library_upload_sessions WHERE expires_at <= ?",
      args: [now()],
    }),
  );
  for (const row of expired.rows) {
    const id = String(row.id);
    await withClient((client) =>
      client.batch([
        { sql: "DELETE FROM library_upload_chunks WHERE session_id = ?", args: [id] },
        { sql: "DELETE FROM library_upload_sessions WHERE id = ?", args: [id] },
      ]),
    );
    await rm(join(libraryUploadRoot, id), { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function createLibraryUploadSession(input: {
  resourceId: string;
  filename: string;
  mediaType: string;
  byteSize: number;
  folderId?: string;
  threadId?: string;
  resumeId?: string;
}): Promise<LibraryUploadSession> {
  await ensureLibrarySchema();
  await cleanupExpiredUploads();
  if (
    !Number.isInteger(input.byteSize) ||
    input.byteSize <= 0 ||
    input.byteSize > MAX_LIBRARY_FILE_BYTES
  ) {
    throw new Error(`单个附件不能超过 ${MAX_LIBRARY_FILE_BYTES / 1024 / 1024} MB`);
  }
  const filename = normalizeFilename(input.filename);
  if (input.resumeId) {
    const existing = await getLibraryUploadSession(input.resourceId, input.resumeId);
    if (
      existing &&
      existing.filename === filename &&
      existing.byteSize === input.byteSize &&
      existing.mediaType === resolveMediaType(filename, input.mediaType) &&
      existing.folderId === input.folderId &&
      existing.threadId === input.threadId
    ) {
      return existing;
    }
  }
  const id = nanoid();
  const timestamp = now();
  const chunkSize = LIBRARY_UPLOAD_CHUNK_BYTES;
  const totalChunks = Math.ceil(input.byteSize / chunkSize);
  const mediaType = resolveMediaType(filename, input.mediaType);
  await mkdir(join(libraryUploadRoot, id), { recursive: true });
  await withClient((client) =>
    client.execute({
      sql: `INSERT INTO library_upload_sessions
        (id, resource_id, filename, media_type, byte_size, chunk_size, total_chunks, folder_id, thread_id, created_at, updated_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        id,
        input.resourceId,
        filename,
        mediaType,
        input.byteSize,
        chunkSize,
        totalChunks,
        input.folderId ?? "",
        input.threadId ?? "",
        timestamp,
        timestamp,
        new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      ],
    }),
  );
  return {
    id,
    resourceId: input.resourceId,
    filename,
    mediaType,
    byteSize: input.byteSize,
    chunkSize,
    totalChunks,
    folderId: input.folderId,
    threadId: input.threadId,
    completedChunks: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export async function saveLibraryUploadChunk(input: {
  resourceId: string;
  sessionId: string;
  chunkIndex: number;
  tempPath: string;
  byteSize: number;
  sha256: string;
}): Promise<LibraryUploadSession> {
  const session = await getLibraryUploadSession(input.resourceId, input.sessionId);
  if (!session) {
    await unlink(input.tempPath).catch(() => undefined);
    throw new Error("上传会话不存在或已过期");
  }
  if (
    !Number.isInteger(input.chunkIndex) ||
    input.chunkIndex < 0 ||
    input.chunkIndex >= session.totalChunks
  ) {
    await unlink(input.tempPath).catch(() => undefined);
    throw new Error("分片编号无效");
  }
  const expectedSize = Math.min(
    session.chunkSize,
    session.byteSize - input.chunkIndex * session.chunkSize,
  );
  if (input.byteSize !== expectedSize) {
    await unlink(input.tempPath).catch(() => undefined);
    throw new Error("分片大小与上传会话不匹配");
  }
  const relativePath = join("library-upload-parts", session.id, `${input.chunkIndex}.part`);
  const storagePath = join(getStorageDirectory(), relativePath);
  await unlink(storagePath).catch(() => undefined);
  await rename(input.tempPath, storagePath);
  const timestamp = now();
  await withClient((client) =>
    client.batch([
      {
        sql: `INSERT OR REPLACE INTO library_upload_chunks
          (session_id, chunk_index, byte_size, sha256, storage_path, created_at)
          VALUES (?, ?, ?, ?, ?, ?)`,
        args: [session.id, input.chunkIndex, input.byteSize, input.sha256, relativePath, timestamp],
      },
      {
        sql: "UPDATE library_upload_sessions SET updated_at = ?, expires_at = ? WHERE id = ? AND resource_id = ?",
        args: [
          timestamp,
          new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
          session.id,
          input.resourceId,
        ],
      },
    ]),
  );
  return (await getLibraryUploadSession(input.resourceId, session.id)) ?? session;
}

export async function completeLibraryUploadSession(
  resourceId: string,
  id: string,
): Promise<LibraryAsset> {
  const session = await getLibraryUploadSession(resourceId, id);
  if (!session || session.completedChunks.length !== session.totalChunks) {
    throw new Error("上传分片尚未完成");
  }
  const result = await withClient((client) =>
    client.execute({
      sql: "SELECT * FROM library_upload_chunks WHERE session_id = ? ORDER BY chunk_index",
      args: [id],
    }),
  );
  if (result.rows.length !== session.totalChunks) throw new Error("上传分片不完整");
  const combinedPath = join(libraryUploadRoot, id, "complete.upload");
  const hash = createHash("sha256");
  let byteSize = 0;
  const source = Readable.from(
    (async function* () {
      for (const row of result.rows) {
        for await (const chunk of createReadStream(
          join(getStorageDirectory(), String(row.storage_path)),
        )) {
          yield chunk;
        }
      }
    })(),
  );
  const digest = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      byteSize += chunk.byteLength;
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  await pipeline(source, digest, createWriteStream(combinedPath));
  if (byteSize !== session.byteSize) {
    await unlink(combinedPath).catch(() => undefined);
    throw new Error("合并后的文件大小校验失败");
  }
  let asset: LibraryAsset;
  try {
    asset = await uploadAsset({
      resourceId,
      filename: session.filename,
      mediaType: session.mediaType,
      tempPath: combinedPath,
      byteSize,
      sha256: hash.digest("hex"),
      folderId: session.folderId,
      threadId: session.threadId,
    });
  } finally {
    await unlink(combinedPath).catch(() => undefined);
  }
  await withClient((client) =>
    client.batch([
      { sql: "DELETE FROM library_upload_chunks WHERE session_id = ?", args: [id] },
      {
        sql: "DELETE FROM library_upload_sessions WHERE id = ? AND resource_id = ?",
        args: [id, resourceId],
      },
    ]),
  );
  await rm(join(libraryUploadRoot, id), { recursive: true, force: true }).catch(() => undefined);
  return asset;
}

export async function cancelLibraryUploadSession(resourceId: string, id: string): Promise<boolean> {
  const session = await getLibraryUploadSession(resourceId, id);
  if (!session) return false;
  await withClient((client) =>
    client.batch([
      { sql: "DELETE FROM library_upload_chunks WHERE session_id = ?", args: [id] },
      {
        sql: "DELETE FROM library_upload_sessions WHERE id = ? AND resource_id = ?",
        args: [id, resourceId],
      },
    ]),
  );
  await rm(join(libraryUploadRoot, id), { recursive: true, force: true }).catch(() => undefined);
  return true;
}
