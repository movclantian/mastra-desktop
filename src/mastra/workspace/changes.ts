import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { BackgroundProcessConfig } from "@mastra/core/workspace";
import {
  type ContentObjectMetadata,
  contentObjectReference,
  createContentObjectWriter,
  deleteContentObject,
  putContentObject,
  readContentObject,
} from "../storage/content-objects";
import {
  AUTHENTICATED_USER_ID_CONTEXT_KEY,
  atomicWrite,
  getStorageDirectory,
} from "../storage/database";

export interface WorkspaceFilesystem {
  readFile(path: string, options?: { encoding?: string }): Promise<string | Buffer>;
}

type WorkspaceContent = string | Buffer;

export interface WorkspaceToolHooks {
  beforeToolCall?: (params: {
    toolName?: string;
    workspaceToolName: string;
    input: unknown;
    context: unknown;
  }) => Promise<unknown>;
  afterToolCall?: (params: {
    toolName?: string;
    workspaceToolName: string;
    context: unknown;
    input?: unknown;
    output?: unknown;
    error?: unknown;
  }) => Promise<unknown>;
}

interface OutputWriter {
  custom?: (chunk: unknown) => Promise<unknown> | unknown;
}

interface PendingOutput {
  sink: Awaited<ReturnType<typeof createContentObjectWriter>>;
  command: string;
  background: boolean;
  exitCode: number | null;
  stdout: { lines: number; bytes: number };
  stderr: { lines: number; bytes: number };
  emit?: OutputWriter["custom"];
  restore?: () => void;
}

function outputContextRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function outputWriter(value: unknown): OutputWriter | undefined {
  const writer = outputContextRecord(value)?.writer;
  return outputContextRecord(writer) as OutputWriter | undefined;
}

function outputCallId(context: unknown): string | undefined {
  const record = outputContextRecord(context);
  const agent = outputContextRecord(record?.agent);
  const value = agent?.toolCallId ?? record?.toolCallId;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function outputInputCommand(input: unknown): string {
  const value = outputContextRecord(input)?.command;
  return typeof value === "string" ? value : "workspace command";
}

function outputRequestValue(context: unknown, key: string): string | undefined {
  return normalizeContextValue(context, key);
}

function outputThreadId(context: unknown): string | undefined {
  const requestThread = outputRequestValue(context, WORKSPACE_THREAD_ID_CONTEXT_KEY);
  if (requestThread) return requestThread;
  const record = outputContextRecord(context);
  const agent = outputContextRecord(record?.agent);
  const value = agent?.threadId ?? record?.threadId;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Native process callbacks own lifecycle; only file sinks are retained for archiving. */
export function createWorkspaceOutputArchiveHooks(): {
  hooks: WorkspaceToolHooks;
  backgroundProcesses: BackgroundProcessConfig;
} {
  const pending = new Map<string, PendingOutput>();
  const append = (record: PendingOutput, channel: "stdout" | "stderr", text: string) => {
    if (!text) return;
    const stats = record[channel];
    if (!stats.bytes) stats.lines++;
    for (const char of text) if (char === "\n") stats.lines++;
    stats.bytes += Buffer.byteLength(text, "utf8");
    record.sink.append(`[${channel}] ${text}`);
  };
  const finish = async (callId: string, exitCode: number | null, error?: unknown) => {
    const record = pending.get(callId);
    if (!record) return;
    pending.delete(callId);
    record.restore?.();
    if (error) append(record, "stderr", String(error));
    record.sink.append(`\nExit code: ${exitCode ?? "unknown"}\n`);
    const metadata = await record.sink.finish();
    await record.emit?.({
      type: "data-workspace-log",
      id: metadata.objectId,
      data: {
        ...contentObjectReference(metadata),
        characterCount: metadata.characterCount ?? 0,
        lineCount: metadata.lineCount ?? 0,
        exitCode,
        stdout: record.stdout,
        stderr: record.stderr,
        source: record.command,
      },
    });
  };
  return {
    hooks: {
      beforeToolCall: async ({ workspaceToolName, input, context }) => {
        if (workspaceToolName !== "mastra_workspace_execute_command") return;
        const userId =
          outputRequestValue(context, WORKSPACE_RESOURCE_ID_CONTEXT_KEY) ??
          outputRequestValue(context, AUTHENTICATED_USER_ID_CONTEXT_KEY);
        const threadId = outputThreadId(context);
        const callId = outputCallId(context);
        if (!userId || !threadId || !callId) return;
        const command = outputInputCommand(input);
        const record: PendingOutput = {
          sink: await createContentObjectWriter({
            userId,
            threadId,
            kind: "log",
            contentType: "text/plain; charset=utf-8",
            source: command,
          }),
          command,
          background: outputContextRecord(input)?.background === true,
          exitCode: null,
          stdout: { lines: 0, bytes: 0 },
          stderr: { lines: 0, bytes: 0 },
        };
        const original = outputWriter(context);
        record.emit = original?.custom?.bind(original);
        const ctx = outputContextRecord(context);
        // Foreground commands emit structured stdout/stderr/exit events through the official writer.
        if (!record.background && ctx) {
          const proxy = Object.create(original ?? null) as OutputWriter;
          proxy.custom = async (chunk) => {
            const item = outputContextRecord(chunk);
            const data = outputContextRecord(item?.data);
            if (item?.type === "data-sandbox-exit" && typeof data?.exitCode === "number")
              record.exitCode = data.exitCode;
            if (typeof data?.output === "string") {
              if (item?.type === "data-sandbox-stdout") append(record, "stdout", data.output);
              if (item?.type === "data-sandbox-stderr") append(record, "stderr", data.output);
            }
            return record.emit?.(chunk);
          };
          ctx.writer = proxy;
          record.restore = () => {
            if (ctx.writer === proxy) ctx.writer = original;
          };
        }
        pending.set(callId, record);
      },
      afterToolCall: async ({ workspaceToolName, context, error }) => {
        if (workspaceToolName !== "mastra_workspace_execute_command") return;
        const callId = outputCallId(context);
        const record = callId ? pending.get(callId) : undefined;
        if (callId && record && (!record.background || error)) {
          await finish(callId, record.exitCode, error).catch((archiveError) =>
            console.error("[workspace-log] archive failed", archiveError),
          );
        }
      },
    },
    backgroundProcesses: {
      onStdout: (data, meta) => {
        const record = pending.get(meta.toolCallId ?? "");
        if (record) append(record, "stdout", data);
      },
      onStderr: (data, meta) => {
        const record = pending.get(meta.toolCallId ?? "");
        if (record) append(record, "stderr", data);
      },
      onExit: async (meta) => {
        if (meta.toolCallId)
          await finish(meta.toolCallId, meta.exitCode).catch((error) =>
            console.error("[workspace-log] archive failed", error),
          );
      },
    },
  };
}

export const WORKSPACE_THREAD_ID_CONTEXT_KEY = "mastra-work:workspace-thread-id";
export const WORKSPACE_RESOURCE_ID_CONTEXT_KEY = "mastra-work:workspace-resource-id";

const CHANGE_DIRECTORY = join(getStorageDirectory(), "users");

export type WorkspaceChangeKind = "created" | "modified" | "deleted";

export interface WorkspaceChangeSnapshot {
  objectId: string;
  sha256: string;
  byteSize: number;
  contentType: string;
  encoding: ContentObjectMetadata["encoding"];
}

export interface WorkspaceFileChange {
  id: string;
  path: string;
  kind: WorkspaceChangeKind;
  before: WorkspaceChangeSnapshot | null;
  after: WorkspaceChangeSnapshot | null;
  toolName: string;
  toolCallId?: string;
  createdAt: string;
}

const writeQueues = new Map<string, Promise<void>>();

function pathSegment(value: string, name: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "." || trimmed === ".." || trimmed.includes("\0")) {
    throw new Error(`${name} is invalid`);
  }
  return encodeURIComponent(trimmed);
}

function currentUserId(explicit?: string): string {
  const candidate = explicit?.trim();
  if (!candidate) throw new Error("Authenticated user is required");
  return candidate;
}

function changesPath(threadId: string, userId?: string): string {
  const owner = currentUserId(userId);
  return join(
    CHANGE_DIRECTORY,
    pathSegment(owner, "userId"),
    "threads",
    pathSegment(threadId, "threadId"),
    "changes.json",
  );
}

function normalizePath(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return value.trim().replaceAll("\\", "/");
}

function normalizeContextValue(context: unknown, key: string): string | undefined {
  const requestContext = (context as { requestContext?: unknown } | undefined)?.requestContext;
  if (requestContext && typeof (requestContext as { get?: unknown }).get === "function") {
    const value = (requestContext as { get: (name: string) => unknown }).get(key);
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  }
  if (requestContext && typeof requestContext === "object") {
    const value = (requestContext as Record<string, unknown>)[key];
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  }
  return undefined;
}

function toolCallId(context: unknown): string | undefined {
  const value = (context as { agent?: { toolCallId?: unknown } } | undefined)?.agent?.toolCallId;
  return typeof value === "string" && value ? value : undefined;
}

function snapshotReference(metadata: ContentObjectMetadata): WorkspaceChangeSnapshot {
  return contentObjectReference(metadata);
}

function isSnapshot(value: unknown): value is WorkspaceChangeSnapshot {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Partial<WorkspaceChangeSnapshot>;
  return (
    typeof item.objectId === "string" &&
    typeof item.sha256 === "string" &&
    Number.isSafeInteger(item.byteSize) &&
    typeof item.contentType === "string" &&
    typeof item.encoding === "string"
  );
}

function isChange(value: unknown): value is WorkspaceFileChange {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Partial<WorkspaceFileChange>;
  return (
    typeof item.id === "string" &&
    typeof item.path === "string" &&
    (item.kind === "created" || item.kind === "modified" || item.kind === "deleted") &&
    (item.before === null || isSnapshot(item.before)) &&
    (item.after === null || isSnapshot(item.after)) &&
    typeof item.toolName === "string" &&
    typeof item.createdAt === "string"
  );
}

async function readChanges(threadId: string, userId?: string): Promise<WorkspaceFileChange[]> {
  const path = changesPath(threadId, userId);
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter(isChange) : [];
  } catch {
    return [];
  }
}

export async function listWorkspaceChanges(
  threadId: string,
  userId?: string,
  options: { offset?: number; limit?: number } = {},
): Promise<WorkspaceFileChange[]> {
  const changes = await readChanges(threadId, userId);
  const offset = Math.max(0, Math.trunc(options.offset ?? 0));
  const limit = options.limit === undefined ? undefined : Math.max(0, Math.trunc(options.limit));
  return limit === undefined ? changes : changes.slice(offset, offset + limit);
}

export async function deleteWorkspaceChanges(threadId: string, userId?: string): Promise<void> {
  const changes = await readChanges(threadId, userId);
  const owner = currentUserId(userId);
  for (const change of changes) {
    for (const [side, snapshot] of [
      ["before", change.before],
      ["after", change.after],
    ] as const) {
      if (snapshot) {
        await deleteContentObject(snapshot.objectId, {
          userId: owner,
          threadId,
          kind: side === "before" ? "change-before" : "change-after",
        }).catch(() => undefined);
      }
    }
  }
  await rm(changesPath(threadId, owner), { force: true }).catch(() => undefined);
}

export async function readWorkspaceChangeContent(input: {
  threadId: string;
  changeId: string;
  side: "before" | "after";
  userId?: string;
}): Promise<{ metadata: WorkspaceChangeSnapshot; content: string; binary: boolean } | null> {
  const owner = currentUserId(input.userId);
  const change = (await readChanges(input.threadId, owner)).find(
    (item) => item.id === input.changeId,
  );
  if (!change) return null;
  const snapshot = change[input.side];
  if (!snapshot) return null;
  const kind = input.side === "before" ? "change-before" : "change-after";
  const content = await readContentObject(snapshot.objectId, {
    userId: owner,
    threadId: input.threadId,
    kind,
  });
  if (!content) return null;
  if (snapshot.encoding === "binary") {
    return { metadata: snapshot, content: "", binary: true };
  }
  return {
    metadata: snapshot,
    content: content.toString(snapshot.encoding),
    binary: false,
  };
}

async function readSnapshotContent(
  filesystem: WorkspaceFilesystem,
  path: string,
): Promise<WorkspaceContent | null> {
  try {
    const content = await filesystem.readFile(path);
    if (typeof content === "string") return content;
    const buffer = Buffer.from(content);
    if (buffer.includes(0)) return buffer;
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    } catch {
      return buffer;
    }
  } catch {
    return null;
  }
}

function sameContent(left: WorkspaceContent | null, right: WorkspaceContent | null): boolean {
  if (Buffer.isBuffer(left) && Buffer.isBuffer(right)) return left.equals(right);
  return left === right;
}

async function saveSnapshot(
  value: WorkspaceContent | null,
  input: { userId: string; threadId: string; side: "before" | "after"; path: string },
): Promise<WorkspaceChangeSnapshot | null> {
  if (value === null) return null;
  const metadata = await putContentObject(value, {
    userId: input.userId,
    threadId: input.threadId,
    kind: input.side === "before" ? "change-before" : "change-after",
    contentType: Buffer.isBuffer(value) ? "application/octet-stream" : "text/plain; charset=utf-8",
    encoding: Buffer.isBuffer(value) ? "binary" : "utf8",
    source: input.path,
  });
  return snapshotReference(metadata);
}

export async function recordWorkspaceChange(input: {
  threadId: string;
  path: string;
  before: WorkspaceContent | null;
  after: WorkspaceContent | null;
  toolName: string;
  toolCallId?: string;
  userId?: string;
}): Promise<void> {
  if (!input.path || sameContent(input.before, input.after)) return;
  const userId = currentUserId(input.userId);
  const queueKey = `${userId}:${input.threadId}`;
  const previous = writeQueues.get(queueKey) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      const changes = await readChanges(input.threadId, userId);
      const kind: WorkspaceChangeKind =
        input.before === null ? "created" : input.after === null ? "deleted" : "modified";
      const [before, after] = await Promise.all([
        saveSnapshot(input.before, {
          userId,
          threadId: input.threadId,
          side: "before",
          path: input.path,
        }),
        saveSnapshot(input.after, {
          userId,
          threadId: input.threadId,
          side: "after",
          path: input.path,
        }),
      ]);
      changes.push({
        id: randomUUID(),
        path: input.path,
        kind,
        before,
        after,
        toolName: input.toolName,
        ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
        createdAt: new Date().toISOString(),
      });
      await mkdir(join(CHANGE_DIRECTORY, pathSegment(userId, "userId"), "threads"), {
        recursive: true,
      });
      await atomicWrite(changesPath(input.threadId, userId), JSON.stringify(changes));
    });
  writeQueues.set(queueKey, next);
  await next;
  if (writeQueues.get(queueKey) === next) writeQueues.delete(queueKey);
}

function isFileMutation(toolName: string): boolean {
  return /(?:write_file|edit_file|delete(?:_file)?|mkdir|ast_edit)$/.test(toolName);
}

interface PendingWorkspaceChange {
  userId: string;
  threadId: string;
  path: string;
  before: WorkspaceContent | null;
  toolName: string;
  toolCallId?: string;
}

export function createWorkspaceChangeHooks(filesystem: WorkspaceFilesystem): WorkspaceToolHooks {
  const pending = new Map<string, PendingWorkspaceChange>();
  return {
    beforeToolCall: async ({ workspaceToolName, input, context }) => {
      if (!isFileMutation(workspaceToolName)) return;
      const threadId = normalizeContextValue(context, WORKSPACE_THREAD_ID_CONTEXT_KEY);
      const userId = normalizeContextValue(context, WORKSPACE_RESOURCE_ID_CONTEXT_KEY);
      if (!threadId || !userId || typeof input !== "object" || input === null) return;
      const path = normalizePath((input as { path?: unknown }).path);
      if (!path) return;
      const id = toolCallId(context) ?? `${threadId}:${path}`;
      pending.set(id, {
        userId,
        threadId,
        path,
        before: await readSnapshotContent(filesystem, path),
        toolName: workspaceToolName,
        toolCallId: toolCallId(context),
      });
    },
    afterToolCall: async ({ workspaceToolName, context, input, error }) => {
      if (!isFileMutation(workspaceToolName)) return;
      const threadId = normalizeContextValue(context, WORKSPACE_THREAD_ID_CONTEXT_KEY);
      const path =
        typeof input === "object" && input !== null
          ? normalizePath((input as { path?: unknown }).path)
          : undefined;
      const id = toolCallId(context) ?? (threadId && path ? `${threadId}:${path}` : undefined);
      if (!id) return;
      const previous = pending.get(id);
      pending.delete(id);
      if (!previous || error) return;
      const after =
        workspaceToolName.endsWith("delete") || workspaceToolName.endsWith("delete_file")
          ? null
          : await readSnapshotContent(filesystem, previous.path);
      await recordWorkspaceChange({ ...previous, after }).catch(() => undefined);
    },
  };
}
