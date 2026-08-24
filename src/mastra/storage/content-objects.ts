/**
 * 用户隔离的外部内容对象存储。
 *
 * 这个存储只负责保存完整内容和可验证的元数据，不负责决定内容如何进入
 * Agent 上下文。网页正文、命令日志、文件快照和附件都可以复用同一套能力。
 *
 * 每个对象都有一个随机 objectId，内容本身用 SHA-256 命名。这样相同内容
 * 可以去重，同时不同来源仍然可以拥有各自的来源、线程和过期元数据。
 */
import { createHash, randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import {
  access,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { getResourceScope, getStorageDirectory } from "./index";

export const CONTENT_OBJECT_MAX_BYTES = 100 * 1024 * 1024;
export const CONTENT_USER_MAX_BYTES = 2 * 1024 * 1024 * 1024;
export const CONTENT_DEFAULT_CHUNK_BYTES = 64 * 1024;
export const CONTENT_OBJECT_GRACE_PERIOD_MS = 60 * 60 * 1000;

export type ContentEncoding = BufferEncoding | "binary";

export type ContentObjectKind =
  | "web"
  | "log"
  | "change-before"
  | "change-after"
  | "attachment"
  | (string & {});

export interface ContentObjectMetadata {
  objectId: string;
  userId: string;
  threadId?: string;
  kind: ContentObjectKind;
  contentType: string;
  byteSize: number;
  characterCount?: number;
  lineCount?: number;
  sha256: string;
  encoding: ContentEncoding;
  source?: string;
  storagePath: string;
  createdAt: string;
  expiresAt?: string;
  chunkSize: number;
  chunkCount: number;
}

export interface PutContentObjectOptions {
  userId?: string;
  threadId?: string;
  kind: ContentObjectKind;
  contentType: string;
  encoding?: ContentEncoding;
  source?: string;
  expiresAt?: Date | string;
  ttlMs?: number;
  chunkSize?: number;
}

export interface ReadContentObjectOptions {
  userId?: string;
  threadId?: string;
  kind?: ContentObjectKind;
  offset?: number;
  limit?: number;
}

export interface ReadContentObjectResult {
  metadata: ContentObjectMetadata;
  offset: number;
  limit: number;
  content: Buffer;
}

export interface ContentUsage {
  objectCount: number;
  byteSize: number;
}

interface ContentObjectRecord {
  metadata: ContentObjectMetadata;
}

function contentRoot(userId: string): string {
  return join(getStorageDirectory(), "users", pathSegment(userId, "userId"));
}

/**
 * Roots that the current thread's official Workspace file tools may access.
 * Thread objects are deliberately limited to the active thread; user-level
 * web and attachment objects remain readable across the user's threads.
 */
export function getContentObjectAccessPaths(userId?: string, threadId?: string): string[] {
  const root = contentRoot(requireUserId(userId));
  const paths = [join(root, "web"), join(root, "attachment")];
  if (typeof threadId === "string" && threadId.trim()) {
    paths.push(join(root, "threads", pathSegment(threadId, "threadId")));
  }
  return paths;
}

function pathSegment(value: string, name: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "." || trimmed === ".." || trimmed.includes("\0")) {
    throw new Error(`${name} is invalid`);
  }
  const encoded = encodeURIComponent(trimmed);
  if (encoded.length > 240) throw new Error(`${name} is too long`);
  return encoded;
}

function requireUserId(userId?: string): string {
  const scopedUserId = getResourceScope();
  const explicitUserId = typeof userId === "string" ? userId.trim() : undefined;
  if (scopedUserId && explicitUserId && explicitUserId !== scopedUserId) {
    throw new Error("Content object user does not match the authenticated user");
  }
  const value = scopedUserId || explicitUserId;
  if (!value) throw new Error("Authenticated user is required");
  return value;
}

function requireObjectId(objectId: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(objectId)) throw new Error("Content object id is invalid");
  return objectId;
}

function requireSha256(value: string): string {
  if (!/^[0-9a-f]{64}$/i.test(value)) throw new Error("Content hash is invalid");
  return value.toLowerCase();
}

function kindSegment(kind: ContentObjectKind): string {
  return pathSegment(kind, "kind");
}

function objectDirectory(root: string, kind: ContentObjectKind, threadId?: string): string {
  return threadId
    ? join(root, "threads", pathSegment(threadId, "threadId"), kindSegment(kind))
    : join(root, kindSegment(kind));
}

function metadataDirectory(root: string): string {
  return join(root, "objects");
}

function metadataPath(root: string, objectId: string): string {
  return join(metadataDirectory(root), `${requireObjectId(objectId)}.json`);
}

function storageRelativePath(root: string, filePath: string): string {
  const value = relative(root, filePath).replaceAll("\\", "/");
  if (!value || value.startsWith("../") || value === ".." || value.includes("\0")) {
    throw new Error("Content object path escapes user storage");
  }
  return value;
}

function resolveStoragePath(root: string, storagePath: string): string {
  if (!storagePath || storagePath.includes("\0")) throw new Error("Content object path is invalid");
  const target = resolve(root, storagePath);
  const relativePath = storageRelativePath(root, target);
  if (relativePath !== storagePath.replaceAll("\\", "/")) {
    throw new Error("Content object path is invalid");
  }
  return target;
}

function normalizeChunkSize(value: number | undefined): number {
  if (value === undefined) return CONTENT_DEFAULT_CHUNK_BYTES;
  if (!Number.isInteger(value) || value < 4 * 1024 || value > 4 * 1024 * 1024) {
    throw new Error("chunkSize must be between 4096 and 4194304 bytes");
  }
  return value;
}

function normalizeExpiry(options: PutContentObjectOptions): string | undefined {
  if (options.expiresAt !== undefined && options.ttlMs !== undefined) {
    throw new Error("expiresAt and ttlMs cannot both be set");
  }
  if (options.expiresAt !== undefined) {
    const value =
      options.expiresAt instanceof Date ? options.expiresAt : new Date(options.expiresAt);
    if (Number.isNaN(value.valueOf())) throw new Error("expiresAt is invalid");
    return value.toISOString();
  }
  if (options.ttlMs === undefined) return undefined;
  if (!Number.isFinite(options.ttlMs) || options.ttlMs <= 0) throw new Error("ttlMs is invalid");
  return new Date(Date.now() + options.ttlMs).toISOString();
}

function contentBytes(value: string | Uint8Array, encoding: ContentEncoding): Buffer {
  return typeof value === "string"
    ? Buffer.from(value, encoding === "binary" ? "utf8" : encoding)
    : Buffer.from(value);
}

function contentStats(
  bytes: Buffer,
  encoding: ContentEncoding,
): Pick<ContentObjectMetadata, "characterCount" | "lineCount"> {
  if (encoding === "binary") return {};
  const text = bytes.toString(encoding);
  return {
    characterCount: [...text].length,
    lineCount: text.length === 0 ? 0 : text.split("\n").length,
  };
}

async function atomicWrite(filePath: string, data: string | Uint8Array): Promise<void> {
  const directory = dirname(filePath);
  await mkdir(directory, { recursive: true });
  const temporaryPath = join(directory, `.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, data, { flag: "wx" });
    try {
      await rename(temporaryPath, filePath);
    } catch (error) {
      try {
        await access(filePath);
        await rm(temporaryPath, { force: true });
      } catch {
        throw error;
      }
    }
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function listMetadataPaths(root: string): Promise<string[]> {
  const directory = metadataDirectory(root);
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => join(directory, entry.name));
}

async function listBlobPaths(directory: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const paths: string[] = [];
  for (const entry of entries) {
    if (entry.name === "objects" || entry.name.startsWith(".")) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      paths.push(...(await listBlobPaths(path)));
    } else if (entry.isFile() && !entry.name.endsWith(".json")) {
      paths.push(path);
    }
  }
  return paths;
}

async function readRecord(userId: string, objectId: string): Promise<ContentObjectRecord | null> {
  const root = contentRoot(userId);
  const path = metadataPath(root, objectId);
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as ContentObjectMetadata;
    if (parsed.objectId !== objectId || parsed.userId !== userId) return null;
    requireSha256(parsed.sha256);
    const blobPath = resolveStoragePath(root, parsed.storagePath);
    if (
      blobPath.endsWith(".json") ||
      basename(blobPath).toLowerCase() !== parsed.sha256.toLowerCase()
    ) {
      return null;
    }
    const canonicalBlobPath = await realpath(blobPath);
    if (storageRelativePath(root, canonicalBlobPath) !== parsed.storagePath.replaceAll("\\", "/")) {
      return null;
    }
    if (!Number.isSafeInteger(parsed.byteSize) || parsed.byteSize < 0) return null;
    return { metadata: parsed };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function assertUserQuota(
  userId: string,
  incomingBytes: number,
  alreadyStored: boolean,
): Promise<void> {
  const usage = await getContentUsage(userId);
  if (usage.byteSize + (alreadyStored ? 0 : incomingBytes) > CONTENT_USER_MAX_BYTES) {
    throw new Error("Content storage quota exceeded for the current user");
  }
}

export async function putContentObject(
  value: string | Uint8Array,
  options: PutContentObjectOptions,
): Promise<ContentObjectMetadata> {
  const userId = requireUserId(options.userId);
  const kind = typeof options.kind === "string" ? options.kind.trim() : "";
  if (!kind) throw new Error("kind is required");
  const threadId =
    typeof options.threadId === "string" ? options.threadId.trim() || undefined : undefined;
  const contentType =
    typeof options.contentType === "string" && options.contentType.trim()
      ? options.contentType.trim()
      : "application/octet-stream";
  const encoding = options.encoding ?? (typeof value === "string" ? "utf8" : "binary");
  const bytes = contentBytes(value, encoding);
  if (bytes.byteLength > CONTENT_OBJECT_MAX_BYTES) {
    throw new Error(`Content object exceeds ${CONTENT_OBJECT_MAX_BYTES} bytes`);
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const root = contentRoot(userId);
  const directory = objectDirectory(root, kind, threadId);
  const blobPath = join(directory, sha256);
  let alreadyStored = false;
  try {
    alreadyStored = (await stat(blobPath)).isFile();
  } catch {
    alreadyStored = false;
  }
  try {
    await assertUserQuota(userId, bytes.byteLength, alreadyStored);
  } catch (error) {
    await pruneContentObjects(userId).catch(() => undefined);
    await assertUserQuota(userId, bytes.byteLength, alreadyStored).catch(() => {
      throw error;
    });
  }
  const objectId = randomUUID();
  const chunkSize = normalizeChunkSize(options.chunkSize);
  const expiresAt = normalizeExpiry(options);
  const metadata: ContentObjectMetadata = {
    objectId,
    userId,
    ...(threadId ? { threadId } : {}),
    kind,
    contentType,
    byteSize: bytes.byteLength,
    ...contentStats(bytes, encoding),
    sha256,
    encoding,
    ...(options.source?.trim() ? { source: options.source.trim() } : {}),
    storagePath: storageRelativePath(root, blobPath),
    createdAt: new Date().toISOString(),
    ...(expiresAt ? { expiresAt } : {}),
    chunkSize,
    chunkCount: Math.max(1, Math.ceil(bytes.byteLength / chunkSize)),
  };

  if (!alreadyStored) await atomicWrite(blobPath, bytes);
  await atomicWrite(metadataPath(root, objectId), JSON.stringify(metadata, null, 2));
  return metadata;
}

export async function getContentObjectMetadata(
  objectId: string,
  options: Omit<ReadContentObjectOptions, "offset" | "limit"> = {},
): Promise<ContentObjectMetadata | null> {
  const userId = requireUserId(options.userId);
  const record = await readRecord(userId, objectId);
  if (!record) return null;
  if (record.metadata.threadId !== undefined && record.metadata.threadId !== options.threadId) {
    return null;
  }
  if (options.kind !== undefined && record.metadata.kind !== options.kind) return null;
  if (record.metadata.expiresAt && Date.parse(record.metadata.expiresAt) <= Date.now()) return null;
  return record.metadata;
}

export async function readContentObject(
  objectId: string,
  options: ReadContentObjectOptions = {},
): Promise<ReadContentObjectResult | null> {
  const userId = requireUserId(options.userId);
  const record = await readRecord(userId, objectId);
  if (!record) return null;
  if (record.metadata.threadId !== undefined && record.metadata.threadId !== options.threadId) {
    return null;
  }
  if (options.kind !== undefined && record.metadata.kind !== options.kind) return null;
  if (record.metadata.expiresAt && Date.parse(record.metadata.expiresAt) <= Date.now()) return null;

  const blobPath = resolveStoragePath(contentRoot(userId), record.metadata.storagePath);
  const offset = options.offset ?? 0;
  const limit = options.limit ?? record.metadata.byteSize - offset;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > record.metadata.byteSize) {
    throw new Error("offset is invalid");
  }
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error("limit is invalid");
  const end = Math.min(record.metadata.byteSize, offset + limit);
  const content = Buffer.alloc(end - offset);
  const file = await open(blobPath, "r");
  try {
    const info = await file.stat();
    if (info.size < end) throw new Error("Content object is incomplete");
    let position = 0;
    while (position < content.byteLength) {
      const result = await file.read(
        content,
        position,
        content.byteLength - position,
        offset + position,
      );
      if (result.bytesRead === 0) break;
      position += result.bytesRead;
    }
  } finally {
    await file.close();
  }
  return {
    metadata: record.metadata,
    offset,
    limit: end - offset,
    content,
  };
}

export async function deleteContentObject(
  objectId: string,
  options: Omit<ReadContentObjectOptions, "offset" | "limit"> = {},
): Promise<boolean> {
  const userId = requireUserId(options.userId);
  const record = await readRecord(userId, objectId);
  if (!record) return false;
  if (record.metadata.threadId !== undefined && record.metadata.threadId !== options.threadId) {
    return false;
  }
  if (options.kind !== undefined && record.metadata.kind !== options.kind) return false;

  const root = contentRoot(userId);
  await rm(metadataPath(root, objectId), { force: true }).catch(() => undefined);
  const remainingPaths = await listMetadataPaths(root);
  let stillReferenced = false;
  for (const path of remainingPaths) {
    try {
      const metadata = JSON.parse(await readFile(path, "utf8")) as ContentObjectMetadata;
      if (metadata.storagePath === record.metadata.storagePath) {
        stillReferenced = true;
        break;
      }
    } catch {
      // 损坏清单不会阻止当前对象删除，后续清理会处理它。
    }
  }
  if (!stillReferenced) {
    const blobPath = resolveStoragePath(root, record.metadata.storagePath);
    await rm(blobPath, { force: true }).catch(() => undefined);
  }
  return true;
}

export function contentObjectReference(metadata: ContentObjectMetadata): {
  objectId: string;
  sha256: string;
  byteSize: number;
  contentType: string;
  encoding: ContentEncoding;
  chunkSize: number;
  chunkCount: number;
  storagePath: string;
  workspacePath: string;
} {
  const root = contentRoot(requireUserId(metadata.userId));
  return {
    objectId: metadata.objectId,
    sha256: metadata.sha256,
    byteSize: metadata.byteSize,
    contentType: metadata.contentType,
    encoding: metadata.encoding,
    chunkSize: metadata.chunkSize,
    chunkCount: metadata.chunkCount,
    storagePath: metadata.storagePath,
    workspacePath: resolveStoragePath(root, metadata.storagePath),
  };
}

export async function getContentUsage(userId?: string): Promise<ContentUsage> {
  const resolvedUserId = requireUserId(userId);
  const paths = await listMetadataPaths(contentRoot(resolvedUserId));
  let byteSize = 0;
  let objectCount = 0;
  const countedStoragePaths = new Set<string>();
  for (const path of paths) {
    try {
      const metadata = JSON.parse(await readFile(path, "utf8")) as ContentObjectMetadata;
      if (metadata.userId !== resolvedUserId || !Number.isFinite(metadata.byteSize)) continue;
      objectCount += 1;
      if (!countedStoragePaths.has(metadata.storagePath)) {
        countedStoragePaths.add(metadata.storagePath);
        byteSize += metadata.byteSize;
      }
    } catch {
      // 损坏的清单由清理流程处理，不影响其他对象的配额统计。
    }
  }
  return { objectCount, byteSize };
}

export async function pruneContentObjects(
  userId?: string,
  now = Date.now(),
): Promise<{ expired: number; orphaned: number; bytes: number }> {
  const resolvedUserId = requireUserId(userId);
  const root = contentRoot(resolvedUserId);
  const records = await Promise.all(
    (await listMetadataPaths(root)).map(async (path) => {
      try {
        return JSON.parse(await readFile(path, "utf8")) as ContentObjectMetadata;
      } catch {
        return null;
      }
    }),
  );
  const references = new Map<string, number>();
  for (const record of records) {
    if (!record) continue;
    references.set(record.storagePath, (references.get(record.storagePath) ?? 0) + 1);
  }
  let expired = 0;
  let orphaned = 0;
  let bytes = 0;
  for (const record of records) {
    if (!record) continue;
    if (!record.expiresAt || Date.parse(record.expiresAt) > now) continue;
    let blobPath: string | undefined;
    try {
      blobPath = resolveStoragePath(root, record.storagePath);
    } catch {
      await rm(metadataPath(root, record.objectId), { force: true }).catch(() => undefined);
      expired += 1;
      continue;
    }
    if (!blobPath) continue;
    const remainingReferences = (references.get(record.storagePath) ?? 1) - 1;
    if (remainingReferences <= 0) {
      bytes += record.byteSize;
      await rm(blobPath, { force: true }).catch(() => undefined);
      references.delete(record.storagePath);
    } else {
      references.set(record.storagePath, remainingReferences);
    }
    await rm(metadataPath(root, record.objectId), { force: true }).catch(() => undefined);
    expired += 1;
  }

  const graceCutoff = now - CONTENT_OBJECT_GRACE_PERIOD_MS;
  for (const path of await listBlobPaths(root)) {
    const relativePath = storageRelativePath(root, path);
    if (references.has(relativePath)) continue;
    try {
      const info = await stat(path);
      if (info.mtimeMs > graceCutoff) continue;
      bytes += info.size;
      await rm(path, { force: true });
      orphaned += 1;
    } catch {
      // 清理是尽力而为，下一轮继续处理失败对象。
    }
  }
  return { expired, orphaned, bytes };
}
