import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getStorageDirectory, PROJECT_ROOT } from "../storage";

export interface WorkspaceFilesystem {
  readFile(path: string, options?: { encoding?: string }): Promise<string | Buffer>;
}

export interface WorkspaceToolHooks {
  beforeToolCall?: (params: {
    workspaceToolName: string;
    input: unknown;
    context: unknown;
  }) => Promise<unknown>;
  afterToolCall?: (params: {
    workspaceToolName: string;
    context: unknown;
    input?: unknown;
    error?: unknown;
  }) => Promise<unknown>;
}

export const WORKSPACE_THREAD_ID_CONTEXT_KEY = "mastra-work:workspace-thread-id";
export const WORKSPACE_RESOURCE_ID_CONTEXT_KEY = "mastra-work:workspace-resource-id";

const CHANGE_DIRECTORY = join(getStorageDirectory() || PROJECT_ROOT, "workspace", "changes");
const MAX_CHANGE_COUNT = 200;
const MAX_SNAPSHOT_BYTES = 512 * 1024;

export type WorkspaceChangeKind = "created" | "modified" | "deleted";

export interface WorkspaceFileChange {
  id: string;
  path: string;
  kind: WorkspaceChangeKind;
  before: string | null;
  after: string | null;
  toolName: string;
  toolCallId?: string;
  createdAt: string;
}

const writeQueues = new Map<string, Promise<void>>();

function changesPath(threadId: string): string {
  return join(CHANGE_DIRECTORY, `${encodeURIComponent(threadId)}.json`);
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

function trimSnapshot(value: string | null): string | null {
  if (value === null || Buffer.byteLength(value, "utf8") <= MAX_SNAPSHOT_BYTES) return value;
  const half = Math.floor(MAX_SNAPSHOT_BYTES / 2);
  const head = value.slice(0, half);
  const tail = value.slice(-half);
  return `${head}\n\n... [内容过长，已截断] ...\n\n${tail}`;
}

async function readText(filesystem: WorkspaceFilesystem, path: string): Promise<string | null> {
  try {
    const content = await filesystem.readFile(path, { encoding: "utf-8" });
    return typeof content === "string" ? content : null;
  } catch {
    return null;
  }
}

async function readChanges(threadId: string): Promise<WorkspaceFileChange[]> {
  try {
    const raw = await readFile(changesPath(threadId), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is WorkspaceFileChange => {
      if (typeof item !== "object" || item === null) return false;
      const value = item as Partial<WorkspaceFileChange>;
      return (
        typeof value.id === "string" &&
        typeof value.path === "string" &&
        (value.kind === "created" || value.kind === "modified" || value.kind === "deleted") &&
        (typeof value.before === "string" || value.before === null) &&
        (typeof value.after === "string" || value.after === null) &&
        typeof value.toolName === "string" &&
        typeof value.createdAt === "string"
      );
    });
  } catch {
    return [];
  }
}

export async function listWorkspaceChanges(threadId: string): Promise<WorkspaceFileChange[]> {
  return readChanges(threadId);
}

export async function deleteWorkspaceChanges(threadId: string): Promise<void> {
  await rm(changesPath(threadId), { force: true }).catch(() => undefined);
}

export async function recordWorkspaceChange(input: {
  threadId: string;
  path: string;
  before: string | null;
  after: string | null;
  toolName: string;
  toolCallId?: string;
}): Promise<void> {
  if (!input.path || input.before === input.after) return;
  const previous = writeQueues.get(input.threadId) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      const changes = await readChanges(input.threadId);
      const kind: WorkspaceChangeKind =
        input.before === null ? "created" : input.after === null ? "deleted" : "modified";
      changes.push({
        id: randomUUID(),
        path: input.path,
        kind,
        before: trimSnapshot(input.before),
        after: trimSnapshot(input.after),
        toolName: input.toolName,
        ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
        createdAt: new Date().toISOString(),
      });
      await mkdir(CHANGE_DIRECTORY, { recursive: true });
      await writeFile(
        changesPath(input.threadId),
        JSON.stringify(changes.slice(-MAX_CHANGE_COUNT)),
        "utf8",
      );
    });
  writeQueues.set(input.threadId, next);
  await next;
  if (writeQueues.get(input.threadId) === next) writeQueues.delete(input.threadId);
}

function isFileMutation(toolName: string): boolean {
  return /(?:write_file|edit_file|delete(?:_file)?|mkdir|ast_edit)$/.test(toolName);
}

interface PendingWorkspaceChange {
  threadId: string;
  path: string;
  before: string | null;
  toolName: string;
  toolCallId?: string;
}

export function createWorkspaceChangeHooks(filesystem: WorkspaceFilesystem): WorkspaceToolHooks {
  const pending = new Map<string, PendingWorkspaceChange>();
  return {
    beforeToolCall: async ({
      workspaceToolName,
      input,
      context,
    }: {
      workspaceToolName: string;
      input: unknown;
      context: unknown;
    }) => {
      if (!isFileMutation(workspaceToolName)) return;
      const threadId = normalizeContextValue(context, WORKSPACE_THREAD_ID_CONTEXT_KEY);
      if (!threadId || typeof input !== "object" || input === null) return;
      const path = normalizePath((input as { path?: unknown }).path);
      if (!path) return;
      const id = toolCallId(context) ?? `${threadId}:${path}`;
      pending.set(id, {
        threadId,
        path,
        before: await readText(filesystem, path),
        toolName: workspaceToolName,
        toolCallId: toolCallId(context),
      });
      return undefined;
    },
    afterToolCall: async ({
      workspaceToolName,
      context,
      input,
      error,
    }: {
      workspaceToolName: string;
      context: unknown;
      input?: unknown;
      error?: unknown;
    }) => {
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
      if (!previous) return;
      if (error) return;
      const after =
        workspaceToolName.endsWith("delete") || workspaceToolName.endsWith("delete_file")
          ? null
          : await readText(filesystem, previous.path);
      await recordWorkspaceChange({ ...previous, after }).catch(() => undefined);
    },
  };
}
