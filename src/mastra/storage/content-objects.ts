import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeSync } from "node:fs";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { atomicWrite, getStorageDirectory, userIdFromContext } from "./database";

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
}

export interface PutContentObjectOptions {
  userId?: string;
  threadId?: string;
  kind: ContentObjectKind;
  contentType: string;
  encoding?: ContentEncoding;
  source?: string;
}

interface ContentObjectLocation {
  userId: string;
  threadId?: string;
  kind: ContentObjectKind;
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
  };
}

/** Directories that the official Workspace filesystem may read. */
export function getContentObjectAccessPaths(userId?: string, threadId?: string): string[] {
  const root = contentRoot(userIdFor(userId));
  const paths = [join(root, "web"), join(root, "attachment")];
  if (threadId?.trim()) {
    paths.push(join(root, "threads", pathSegment(threadId, "threadId")));
  }
  // LocalFilesystem enumerates allowed paths directly. On a fresh user/thread
  // scope, an unused content kind has no object directory yet; make that an
  // empty, valid scope instead of surfacing ENOENT to the Agent.
  for (const path of paths) mkdirSync(path, { recursive: true });
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

/** A bounded-memory log sink. Synchronous chunk writes apply backpressure to void callbacks. */
export async function createContentObjectWriter(options: PutContentObjectOptions) {
  const userId = userIdFor(options.userId);
  const id = randomUUID();
  const path = objectPath(userId, id, options.kind, options.threadId);
  await mkdir(objectDirectory(contentRoot(userId), options.kind, options.threadId), {
    recursive: true,
  });
  const file = await open(path, "wx");
  const hash = createHash("sha256");
  let byteSize = 0;
  let characterCount = 0;
  let newlines = 0;
  let failure: unknown;
  const createdAt = new Date().toISOString();
  return {
    append(text: string) {
      if (failure) return;
      const bytes = Buffer.from(text, "utf8");
      try {
        let offset = 0;
        while (offset < bytes.length) {
          const written = writeSync(file.fd, bytes, offset, bytes.length - offset);
          if (!written) throw new Error("Content archive write made no progress");
          offset += written;
        }
        hash.update(bytes);
        byteSize += bytes.byteLength;
        for (const char of text) {
          characterCount++;
          if (char === "\n") newlines++;
        }
      } catch (error) {
        failure = error;
      }
    },
    async finish(): Promise<ContentObjectMetadata> {
      await file.close();
      if (failure) {
        await rm(path, { force: true });
        throw failure;
      }
      return {
        objectId: id,
        userId,
        threadId: options.threadId,
        kind: options.kind,
        contentType: options.contentType,
        encoding: "utf8",
        source: options.source,
        storagePath: path.slice(contentRoot(userId).length + 1).replaceAll("\\", "/"),
        createdAt,
        byteSize,
        characterCount,
        lineCount: byteSize ? newlines + 1 : 0,
        sha256: hash.digest("hex"),
      };
    },
  };
}

/** Read archive bytes once; snapshot metadata belongs to the stored change record. */
export async function readContentObject(
  id: string,
  options: ContentObjectLocation,
): Promise<Buffer | null> {
  try {
    return await readFile(
      objectPath(userIdFor(options.userId), id, options.kind, options.threadId),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function deleteContentObject(
  id: string,
  options: ContentObjectLocation,
): Promise<void> {
  await rm(objectPath(userIdFor(options.userId), id, options.kind, options.threadId), {
    force: true,
  });
}

export function contentObjectReference(metadata: ContentObjectMetadata): {
  objectId: string;
  sha256: string;
  byteSize: number;
  contentType: string;
  encoding: ContentEncoding;
  storagePath: string;
  workspacePath: string;
  /** 取回路由 /work/contents/:objectId 需要的定位字段 */
  kind: string;
  threadId?: string;
} {
  return {
    objectId: metadata.objectId,
    sha256: metadata.sha256,
    byteSize: metadata.byteSize,
    contentType: metadata.contentType,
    encoding: metadata.encoding,
    storagePath: metadata.storagePath,
    workspacePath: join(contentRoot(metadata.userId), metadata.storagePath),
    kind: metadata.kind,
    ...(metadata.threadId ? { threadId: metadata.threadId } : {}),
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
  const userId = userIdFromContext(context.requestContext);
  if (!userId) throw new Error("Authenticated user is required");
  return putContentObject(text, {
    userId,
    kind: options.kind,
    contentType: options.contentType ?? "text/plain; charset=utf-8",
    encoding: "utf8",
    source: options.source,
  });
}
