import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BackgroundProcessConfig } from "@mastra/core/workspace";
import {
  type ContentObjectMetadata,
  contentObjectReference,
  deleteContentObject,
  getContentObjectMetadata,
  getResourceScope,
  getStorageDirectory,
  putContentObject,
  readContentObject,
} from "../storage";

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
  userId: string;
  threadId: string;
  command: string;
  pid?: string;
  stdout: string;
  stderr: string;
  emit?: (chunk: unknown) => Promise<unknown> | unknown;
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

function outputStats(value: string) {
  return {
    lines: value ? value.split(/\r?\n/).length : 0,
    bytes: Buffer.byteLength(value, "utf8"),
  };
}

function outputText(stdout: string, stderr: string, exitCode: number | null): string {
  return [
    stdout ? `stdout:\n${stdout}` : "",
    stderr ? `stderr:\n${stderr}` : "",
    exitCode === null ? "Process still running" : `Exit code: ${exitCode}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Enhances the official Workspace command tools without replacing them.
 * Foreground output is observed through the official writer events; background
 * output is observed through execute_command's backgroundProcesses callbacks.
 */
export function createWorkspaceOutputArchiveHooks(): {
  hooks: WorkspaceToolHooks;
  backgroundProcesses: BackgroundProcessConfig;
} {
  const pending = new Map<string, PendingOutput>();
  const pendingBackground = new Map<string, PendingOutput>();
  const backgroundByPid = new Map<string, PendingOutput>();
  const pendingContexts = new WeakMap<object, string>();

  const archive = async (
    record: PendingOutput,
    stdout: string,
    stderr: string,
    exitCode: number | null,
  ) => {
    const metadata = await putContentObject(outputText(stdout, stderr, exitCode), {
      userId: record.userId,
      threadId: record.threadId,
      kind: "log",
      contentType: "text/plain; charset=utf-8",
      encoding: "utf8",
      source: record.command,
      ttlMs: 30 * 24 * 60 * 60 * 1000,
    });
    const payload = {
      objectId: metadata.objectId,
      sha256: metadata.sha256,
      byteSize: metadata.byteSize,
      contentType: metadata.contentType,
      encoding: metadata.encoding,
      chunkSize: metadata.chunkSize,
      chunkCount: metadata.chunkCount,
      storagePath: metadata.storagePath,
      workspacePath: contentObjectReference(metadata).workspacePath,
      characterCount: metadata.characterCount ?? 0,
      lineCount: metadata.lineCount ?? 0,
      exitCode,
      stdout: outputStats(stdout),
      stderr: outputStats(stderr),
      source: record.command,
    };
    await record.emit?.({ type: "data-workspace-log", id: metadata.objectId, data: payload });
  };

  const captureWriter = (context: unknown, record: PendingOutput) => {
    const contextRecord = outputContextRecord(context);
    const original = outputWriter(context);
    if (!contextRecord || !original?.custom) return;
    const originalCustom = original.custom.bind(original);
    const proxy = Object.create(original) as OutputWriter;
    proxy.custom = async (chunk: unknown) => {
      const item = outputContextRecord(chunk);
      const data = outputContextRecord(item?.data);
      const output = data?.output;
      if (typeof output === "string") {
        if (item?.type === "data-sandbox-stdout") record.stdout += output;
        if (item?.type === "data-sandbox-stderr") record.stderr += output;
      }
      return originalCustom(chunk);
    };
    contextRecord.writer = proxy;
    record.emit = proxy.custom;
  };

  return {
    hooks: {
      beforeToolCall: async ({ workspaceToolName, input, context }) => {
        if (
          workspaceToolName !== "mastra_workspace_execute_command" &&
          workspaceToolName !== "mastra_workspace_get_process_output"
        )
          return;
        const userId =
          outputRequestValue(context, WORKSPACE_RESOURCE_ID_CONTEXT_KEY) ?? getResourceScope();
        const threadId = outputThreadId(context);
        if (!userId || !threadId) return;
        const callId = outputCallId(context) ?? `${threadId}:${Date.now()}:${Math.random()}`;
        const record: PendingOutput = {
          userId,
          threadId,
          command:
            workspaceToolName === "mastra_workspace_execute_command"
              ? outputInputCommand(input)
              : `get_process_output:${String(outputContextRecord(input)?.pid ?? "unknown")}`,
          stdout: "",
          stderr: "",
        };
        captureWriter(context, record);
        const contextRecord = outputContextRecord(context);
        if (contextRecord) pendingContexts.set(contextRecord, callId);
        if (
          workspaceToolName === "mastra_workspace_execute_command" &&
          outputContextRecord(input)?.background
        ) {
          pendingBackground.set(callId, record);
        } else {
          pending.set(callId, record);
        }
      },
      afterToolCall: async ({ workspaceToolName, context, input, output, error }) => {
        if (
          workspaceToolName !== "mastra_workspace_execute_command" &&
          workspaceToolName !== "mastra_workspace_get_process_output"
        )
          return;
        const contextRecord = outputContextRecord(context);
        const callId =
          outputCallId(context) ?? (contextRecord ? pendingContexts.get(contextRecord) : undefined);
        if (!callId) return;
        const record = pending.get(callId);
        if (!record) return;
        pending.delete(callId);
        if (contextRecord) pendingContexts.delete(contextRecord);
        const resultText = typeof output === "string" ? output : "";
        const exitMatch = resultText.match(/Exit code:\s*(-?\d+)/i);
        const exitCode = exitMatch ? Number(exitMatch[1]) : error ? -1 : 0;
        let stdout = record.stdout;
        let stderr = record.stderr;
        if (workspaceToolName === "mastra_workspace_get_process_output") {
          const pid = outputContextRecord(input)?.pid;
          const background = typeof pid === "string" ? backgroundByPid.get(pid) : undefined;
          if (
            background &&
            background.userId === record.userId &&
            background.threadId === record.threadId
          ) {
            stdout = background.stdout || stdout;
            stderr = background.stderr || stderr;
            record.command = background.command;
          }
        } else if (!stdout && !error && resultText && resultText !== "(no output)") {
          stdout = resultText;
        }
        await archive(record, stdout, stderr || (error ? String(error) : ""), exitCode).catch(
          () => undefined,
        );
      },
    },
    backgroundProcesses: {
      onStdout: (data, meta) => {
        const record = pendingBackground.get(meta.toolCallId ?? "");
        if (record) {
          record.pid = meta.pid;
          backgroundByPid.set(meta.pid, record);
          record.stdout += data;
        }
      },
      onStderr: (data, meta) => {
        const record = pendingBackground.get(meta.toolCallId ?? "");
        if (record) {
          record.pid = meta.pid;
          backgroundByPid.set(meta.pid, record);
          record.stderr += data;
        }
      },
      onExit: (meta) => {
        const record = pendingBackground.get(meta.toolCallId ?? "");
        if (!record) return;
        pendingBackground.delete(meta.toolCallId ?? "");
        record.pid = meta.pid;
        backgroundByPid.delete(meta.pid);
        void archive(
          record,
          record.stdout || meta.stdout,
          record.stderr || meta.stderr,
          meta.exitCode,
        ).catch(() => undefined);
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
  chunkSize: number;
  chunkCount: number;
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
  const scoped = getResourceScope();
  const candidate = explicit?.trim();
  if (scoped && candidate && candidate !== scoped) {
    throw new Error("Workspace change user does not match the authenticated user");
  }
  const userId = scoped || candidate;
  if (!userId) throw new Error("Authenticated user is required");
  return userId;
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
    typeof item.encoding === "string" &&
    Number.isSafeInteger(item.chunkSize) &&
    Number.isSafeInteger(item.chunkCount)
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
}): Promise<{ metadata: ContentObjectMetadata; content: string; binary: boolean } | null> {
  const owner = currentUserId(input.userId);
  const change = (await readChanges(input.threadId, owner)).find(
    (item) => item.id === input.changeId,
  );
  if (!change) return null;
  const snapshot = change[input.side];
  if (!snapshot) return null;
  const kind = input.side === "before" ? "change-before" : "change-after";
  const metadata = await getContentObjectMetadata(snapshot.objectId, {
    userId: owner,
    threadId: input.threadId,
    kind,
  });
  if (!metadata) return null;
  const result = await readContentObject(snapshot.objectId, {
    userId: owner,
    threadId: input.threadId,
    kind,
  });
  if (!result) return null;
  if (metadata.encoding === "binary") return { metadata, content: "", binary: true };
  return { metadata, content: result.content.toString(metadata.encoding), binary: false };
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
      const targetPath = changesPath(input.threadId, userId);
      const temporaryPath = `${targetPath}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporaryPath, JSON.stringify(changes), "utf8");
        try {
          await rename(temporaryPath, targetPath);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== "EEXIST" && code !== "EPERM") throw error;
          await rm(targetPath, { force: true });
          await rename(temporaryPath, targetPath);
        }
      } finally {
        await rm(temporaryPath, { force: true }).catch(() => undefined);
      }
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
