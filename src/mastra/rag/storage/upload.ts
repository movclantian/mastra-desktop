/**
 * 分片断点续传:会话创建、分块上传、合并入库与过期清理。
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { nanoid } from "nanoid";
import { getStorageDirectory } from "../../storage";
import { normalizeFilename, resolveMediaType } from "../document/extract";
import {
  type LibraryAsset,
  type LibraryUploadSession,
  MAX_LIBRARY_FILE_BYTES,
  MAX_LIBRARY_UPLOAD_CHUNK_BYTES,
  MIN_LIBRARY_UPLOAD_CHUNK_BYTES,
} from "../types";
import { uploadAsset } from "./assets";
import { ensureLibrarySchema, now, rowToUploadSession, withClient } from "./db";

/**
 * 分片断点续传服务:
 * 会话创建、块上传、分片合并与清理。
 */

function sanitizeChunkSize(chunkSize?: number): number {
  if (!chunkSize || Number.isNaN(chunkSize)) return MAX_LIBRARY_UPLOAD_CHUNK_BYTES;
  return Math.min(
    MAX_LIBRARY_UPLOAD_CHUNK_BYTES,
    Math.max(MIN_LIBRARY_UPLOAD_CHUNK_BYTES, Math.floor(chunkSize)),
  );
}

function uploadSessionDirectory(sessionId: string): string {
  return join(getStorageDirectory(), "library", "_chunks", sessionId);
}

function uploadChunkPath(sessionId: string, chunkIndex: number): string {
  return join(uploadSessionDirectory(sessionId), `${chunkIndex}.part`);
}

export async function createLibraryUploadSession(input: {
  resourceId: string;
  filename: string;
  byteSize: number;
  chunkSize?: number;
  mediaType?: string;
  folderId?: string;
  threadId?: string;
}): Promise<LibraryUploadSession> {
  if (!input.byteSize || input.byteSize <= 0) throw new Error("文件大小必须大于 0 字节");
  if (input.byteSize > MAX_LIBRARY_FILE_BYTES) throw new Error("单个文件大小不能超过 100 MB");

  await ensureLibrarySchema();
  const id = nanoid();
  const filename = normalizeFilename(input.filename);
  const mediaType = resolveMediaType(filename, input.mediaType || "");
  const chunkSize = sanitizeChunkSize(input.chunkSize);
  const totalChunks = Math.ceil(input.byteSize / chunkSize);
  const createdAt = now();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

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
        createdAt,
        createdAt,
        expiresAt,
      ],
    }),
  );

  await mkdir(uploadSessionDirectory(id), { recursive: true });
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
    createdAt,
    updatedAt: createdAt,
  };
}

export async function getLibraryUploadSession(
  resourceId: string,
  sessionId: string,
): Promise<LibraryUploadSession | null> {
  await ensureLibrarySchema();
  const [sessionRow, chunkRows] = await withClient(async (client) => {
    const session = await client.execute({
      sql: "SELECT * FROM library_upload_sessions WHERE id = ? AND resource_id = ? LIMIT 1",
      args: [sessionId, resourceId],
    });
    const chunks = await client.execute({
      sql: "SELECT chunk_index FROM library_upload_chunks WHERE session_id = ? ORDER BY chunk_index ASC",
      args: [sessionId],
    });
    return [session.rows[0], chunks.rows];
  });
  if (!sessionRow) return null;
  const completed = chunkRows.map((r) => Number(r.chunk_index));
  return rowToUploadSession(sessionRow, completed);
}

export async function saveLibraryUploadChunk(input: {
  resourceId: string;
  sessionId: string;
  chunkIndex: number;
  bytes: Uint8Array;
  expectedSha256?: string;
}): Promise<LibraryUploadSession> {
  const session = await getLibraryUploadSession(input.resourceId, input.sessionId);
  if (!session) throw new Error("上传会话不存在或已过期");
  if (input.chunkIndex < 0 || input.chunkIndex >= session.totalChunks) {
    throw new Error(`分片序号超出范围: 0..${session.totalChunks - 1}`);
  }

  const sha256 = createHash("sha256").update(input.bytes).digest("hex");
  if (input.expectedSha256 && input.expectedSha256.toLowerCase() !== sha256) {
    throw new Error("分片校验和不匹配");
  }

  const chunkPath = uploadChunkPath(session.id, input.chunkIndex);
  await mkdir(uploadSessionDirectory(session.id), { recursive: true });
  await writeFile(chunkPath, input.bytes);

  const timestamp = now();
  await withClient((client) =>
    client.batch([
      {
        sql: `INSERT INTO library_upload_chunks (session_id, chunk_index, byte_size, sha256, storage_path, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(session_id, chunk_index) DO UPDATE SET
            byte_size = excluded.byte_size,
            sha256 = excluded.sha256,
            storage_path = excluded.storage_path,
            created_at = excluded.created_at`,
        args: [session.id, input.chunkIndex, input.bytes.byteLength, sha256, chunkPath, timestamp],
      },
      {
        sql: "UPDATE library_upload_sessions SET updated_at = ? WHERE id = ?",
        args: [timestamp, session.id],
      },
    ]),
  );

  const updated = await getLibraryUploadSession(input.resourceId, input.sessionId);
  if (!updated) throw new Error("更新上传会话失败");
  return updated;
}

export async function completeLibraryUploadSession(
  resourceId: string,
  sessionId: string,
): Promise<LibraryAsset> {
  const session = await getLibraryUploadSession(resourceId, sessionId);
  if (!session) throw new Error("上传会话不存在或已过期");
  if (session.completedChunks.length !== session.totalChunks) {
    throw new Error(
      `分片尚未全部上传: 已完成 ${session.completedChunks.length}/${session.totalChunks}`,
    );
  }

  const parts: Uint8Array[] = [];
  let totalBytes = 0;
  for (let index = 0; index < session.totalChunks; index++) {
    const chunkPath = uploadChunkPath(session.id, index);
    const chunkBuffer = await readFile(chunkPath).catch(() => null);
    if (!chunkBuffer) throw new Error(`分片 ${index} 读取失败，请重试`);
    parts.push(new Uint8Array(chunkBuffer));
    totalBytes += chunkBuffer.byteLength;
  }

  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const part of parts) {
    merged.set(part, offset);
    offset += part.byteLength;
  }

  const asset = await uploadAsset({
    resourceId: session.resourceId,
    filename: session.filename,
    bytes: merged,
    mediaType: session.mediaType,
    folderId: session.folderId,
    threadId: session.threadId,
  });

  await withClient((client) =>
    client.batch([
      {
        sql: "DELETE FROM library_upload_chunks WHERE session_id = ?",
        args: [session.id],
      },
      {
        sql: "DELETE FROM library_upload_sessions WHERE id = ?",
        args: [session.id],
      },
    ]),
  );
  await rm(uploadSessionDirectory(session.id), { recursive: true, force: true }).catch(
    () => undefined,
  );

  return asset;
}

export async function cancelLibraryUploadSession(
  resourceId: string,
  sessionId: string,
): Promise<boolean> {
  await ensureLibrarySchema();
  const session = await getLibraryUploadSession(resourceId, sessionId);
  if (!session) return false;
  await withClient((client) =>
    client.batch([
      {
        sql: "DELETE FROM library_upload_chunks WHERE session_id = ?",
        args: [sessionId],
      },
      {
        sql: "DELETE FROM library_upload_sessions WHERE id = ? AND resource_id = ?",
        args: [sessionId, resourceId],
      },
    ]),
  );
  await rm(uploadSessionDirectory(sessionId), { recursive: true, force: true }).catch(
    () => undefined,
  );
  return true;
}
