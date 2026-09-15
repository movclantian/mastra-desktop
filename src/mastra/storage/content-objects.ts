import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { atomicWrite, getStorageDirectory, resourceIdFromContext } from "./index";

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

function pathSegment(value: string, name: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "." || trimmed === ".." || trimmed.includes("\0")) {
    throw new Error(`${name} is invalid`);
  }
  return encodeURIComponent(trimmed);
}

function userIdFor(userId?: string): string {
  const explicit = userId?.trim();
  if (!explicit) throw new Error("Authenticated user is required");
  return explicit;
}

function objectId(value: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(value)) throw new Error("Content object id is invalid");
  return value;
}

function contentRoot(userId: string): string {
  return join(getStorageDirectory(), "users", pathSegment(userId, "userId"));
}

function objectDirectory(root: string, kind: ContentObjectKind, threadId?: string): string {
  const directory = threadId ? join(root, "threads", pathSegment(threadId, "threadId")) : root;
  return join(directory, pathSegment(kind, "kind"));
}

function objectPath(
  userId: string,
  objectIdValue: string,
  kind: ContentObjectKind,
  threadId?: string,
) {
  return join(objectDirectory(contentRoot(userId), kind, threadId), objectId(objectIdValue));
}

function contentBytes(value: string | Uint8Array, encoding: ContentEncoding): Buffer {
  if (typeof value !== "string") return Buffer.from(value);
  return Buffer.from(value, encoding === "binary" ? "utf8" : encoding);
}

function metadataFromBytes(
  bytes: Buffer,
  options: {
    objectId: string;
    userId: string;
    threadId?: string;
    kind: ContentObjectKind;
    contentType: string;
    encoding: ContentEncoding;
    source?: string;
    storagePath: string;
    createdAt: string;
  },
): ContentObjectMetadata {
  const text = options.encoding === "binary" ? undefined : bytes.toString(options.encoding);
  return {
    ...options,
    byteSize: bytes.byteLength,
    ...(text === undefined
      ? {}
      : { characterCount: [...text].length, lineCount: text ? text.split("\n").length : 0 }),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    chunkSize: bytes.byteLength || 1,
    chunkCount: 1,
  };
}

/** Directories that the official Workspace filesystem may read. */
export function getContentObjectAccessPaths(userId?: string, threadId?: string): string[] {
  const root = contentRoot(userIdFor(userId));
  const paths = [join(root, "web"), join(root, "attachment")];
  if (threadId?.trim()) {
    paths.push(join(root, "threads", pathSegment(threadId, "threadId")));
  }
  return paths;
}

export async function putContentObject(
  value: string | Uint8Array,
  options: PutContentObjectOptions,
): Promise<ContentObjectMetadata> {
  const userId = userIdFor(options.userId);
  const kind = options.kind.trim();
  if (!kind) throw new Error("kind is required");
  const threadId = options.threadId?.trim() || undefined;
  const encoding = options.encoding ?? (typeof value === "string" ? "utf8" : "binary");
  const bytes = contentBytes(value, encoding);
  const id = randomUUID();
  const root = contentRoot(userId);
  const path = objectPath(userId, id, kind, threadId);
  await mkdir(objectDirectory(root, kind, threadId), { recursive: true });
  await atomicWrite(path, bytes);
  return metadataFromBytes(bytes, {
    objectId: id,
    userId,
    ...(threadId ? { threadId } : {}),
    kind,
    contentType: options.contentType?.trim() || "application/octet-stream",
    encoding,
    ...(options.source?.trim() ? { source: options.source.trim() } : {}),
    storagePath: path.slice(root.length + 1).replaceAll("\\", "/"),
    createdAt: new Date().toISOString(),
  });
}

function metadataForPath(
  bytes: Buffer,
  userId: string,
  id: string,
  kind: ContentObjectKind,
  threadId: string | undefined,
  storagePath: string,
): ContentObjectMetadata {
  return metadataFromBytes(bytes, {
    objectId: id,
    userId,
    ...(threadId ? { threadId } : {}),
    kind,
    contentType: "application/octet-stream",
    encoding: "binary",
    storagePath,
    createdAt: new Date(0).toISOString(),
  });
}

export async function getContentObjectMetadata(
  id: string,
  options: Omit<ReadContentObjectOptions, "offset" | "limit"> = {},
): Promise<ContentObjectMetadata | null> {
  const userId = userIdFor(options.userId);
  if (!options.kind) return null;
  const root = contentRoot(userId);
  const path = objectPath(userId, id, options.kind, options.threadId);
  try {
    const bytes = await readFile(path);
    return metadataForPath(
      bytes,
      userId,
      objectId(id),
      options.kind,
      options.threadId,
      path.slice(root.length + 1),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function readContentObject(
  id: string,
  options: ReadContentObjectOptions = {},
): Promise<ReadContentObjectResult | null> {
  const metadata = await getContentObjectMetadata(id, options);
  if (!metadata) return null;
  const bytes = await readFile(join(contentRoot(metadata.userId), metadata.storagePath));
  const offset = options.offset ?? 0;
  const limit = options.limit ?? bytes.byteLength - offset;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > bytes.byteLength) {
    throw new Error("offset is invalid");
  }
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error("limit is invalid");
  const content = bytes.subarray(offset, Math.min(bytes.byteLength, offset + limit));
  return { metadata, offset, limit: content.byteLength, content };
}

export async function deleteContentObject(
  id: string,
  options: Omit<ReadContentObjectOptions, "offset" | "limit"> = {},
): Promise<boolean> {
  const metadata = await getContentObjectMetadata(id, options);
  if (!metadata) return false;
  await rm(join(contentRoot(metadata.userId), metadata.storagePath), { force: true });
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
  return {
    objectId: metadata.objectId,
    sha256: metadata.sha256,
    byteSize: metadata.byteSize,
    contentType: metadata.contentType,
    encoding: metadata.encoding,
    chunkSize: metadata.chunkSize,
    chunkCount: metadata.chunkCount,
    storagePath: metadata.storagePath,
    workspacePath: join(contentRoot(metadata.userId), metadata.storagePath),
  };
}

export function contentSummary(text: string, edgeCharacters = 1_200): string {
  if (text.length <= edgeCharacters * 2) return text;
  return `${text.slice(0, edgeCharacters)}\n...[摘要省略 ${text.length - edgeCharacters * 2} 字符]...\n${text.slice(-edgeCharacters)}`;
}

export function contentReferenceText(metadata: ContentObjectMetadata, label = "完整内容") {
  const reference = contentObjectReference(metadata);
  return `${label}已保存到当前用户内容对象。字符数：${metadata.characterCount ?? "未知"}，字节数：${metadata.byteSize}，SHA-256：${metadata.sha256}，内容引用：${reference.objectId}。请使用官方 mastra_workspace_read_file(path="${reference.workspacePath}", offset, limit) 按行分段读取，或使用官方 mastra_workspace_grep(pattern, path="${reference.workspacePath}") 按关键字/正则检索。`;
}

export async function archiveTextContent(
  text: string,
  context: { requestContext?: { get?: (key: string) => unknown } },
  options: { kind: "web"; source?: string; contentType?: string },
) {
  const userId = resourceIdFromContext(context.requestContext);
  if (!userId) throw new Error("Authenticated user is required");
  return putContentObject(text, {
    userId,
    kind: options.kind,
    contentType: options.contentType ?? "text/plain; charset=utf-8",
    encoding: "utf8",
    source: options.source,
  });
}
