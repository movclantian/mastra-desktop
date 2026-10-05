/**
 * 每线程工作区模块:Harness session 概念的目录侧实现。
 * - 每条线程会话绑定一个工作目录(Harness session 的 workspace)
 * - 显式绑定:用户在 promptInput 选择器中选定本地目录(发送首条消息后锁定)
 * - 隐式绑定:未选择时默认 <threadsRoot>/<threadId>/(线程专属默认工作区,
 *   用户同样可以浏览和编辑)
 * - Workspace 实例按路径缓存(BM25 索引等初始化昂贵,不可每请求重建)
 * 设置面板「工作区」标签页写入数据库 app_config 表(key = "workspace"),保存后实时生效。
 * 官方文档:
 * - docs/en/reference/workspace/workspace-class.mdx(workspace 可为函数,按 requestContext 动态解析)
 * - docs/en/reference/workspace/local-filesystem.mdx(basePath/contained/allowedPaths/readOnly)
 * - docs/en/reference/workspace/local-sandbox.mdx(workingDirectory/env/timeout/isolation)
 * - docs/en/docs/sandbox/search.mdx(bm25/autoIndexPaths)、lsp.mdx、skills.mdx(skills 目录)
 */
import { mkdirSync } from "node:fs";
import { readdir, readFile, rm, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { Session } from "@mastra/core/agent-controller";
import type { Mastra } from "@mastra/core/mastra";
import { validateSkillContent } from "@mastra/core/skills";
import {
  LocalFilesystem,
  LocalSandbox,
  LocalSkillSource,
  type ToolConfigWithArgsContext,
  Workspace,
  type WorkspaceToolConfig,
  type WorkspaceToolsConfig,
} from "@mastra/core/workspace";
import matter from "gray-matter";
import { z } from "zod";
import { getContentObjectAccessPaths } from "../storage/content-objects";
import {
  clampInt,
  clampNumber,
  cleanStrings,
  DEFAULT_MASTRA_DATA_DIRECTORY,
  getAppConfig,
  getStorageDirectory,
  setAppConfig,
  stringRecord,
  userIdFromContext,
} from "../storage/database";
import {
  createWorkspaceChangeHooks,
  createWorkspaceOutputArchiveHooks,
  deleteWorkspaceChanges,
} from "./changes";

export {
  WORKSPACE_RESOURCE_ID_CONTEXT_KEY,
  WORKSPACE_THREAD_ID_CONTEXT_KEY,
} from "./changes";

// LSP 可选依赖显式导入:@mastra/core 的 LSP 客户端用 createRequire 动态
// require 这两个包(见 node_modules/@mastra/core/dist/workspace-*.js 的
// loadLSPDependencies);此处静态导入保证它们被安装且位于解析路径上,
// 避免警告 "lsp: true requires vscode-jsonrpc ..." 且 LSP 诊断静默失效。
import "vscode-jsonrpc/node";
import "vscode-languageserver-protocol";

const WORKSPACE_CONFIG_KEY = "workspace";
const RECENT_WORKSPACES_KEY = "recent-workspaces";
const RECENT_WORKSPACES_LIMIT = 12;
const MANAGED_SKILLS_DIRECTORY = join(
  getStorageDirectory() || DEFAULT_MASTRA_DATA_DIRECTORY,
  "skills",
);

/** chat 路由 → Agent 动态 workspace 函数传递线程工作区路径的 RequestContext key */
export const WORKSPACE_PATH_CONTEXT_KEY = "mastra-work:workspace-path";

/** 默认线程工作区根:<存储目录>/workspace/threads(绝对路径,规避 cwd 漂移) */
const DEFAULT_THREADS_ROOT = join(
  getStorageDirectory() || DEFAULT_MASTRA_DATA_DIRECTORY,
  "workspace",
  "threads",
);

function scopeKey(resourceId?: string): string {
  return resourceId?.trim() || "__system__";
}

function scopePathSegment(resourceId?: string): string {
  const scope = resourceId?.trim();
  if (!scope) return "system";
  const trimmed = scope.trim();
  if (!trimmed || trimmed === "." || trimmed === ".." || trimmed.includes("\0")) {
    throw new Error("resource scope is invalid");
  }
  return encodeURIComponent(trimmed);
}

function defaultThreadsRoot(resourceId?: string): string {
  return resourceId
    ? join(DEFAULT_THREADS_ROOT, "users", scopePathSegment(resourceId))
    : DEFAULT_THREADS_ROOT;
}

const workspaceToolRuleSchema = z.object({
  enabled: z.boolean().optional(),
  requireApproval: z.boolean().optional(),
  requireReadBeforeWrite: z.boolean().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  name: z.string().trim().min(1).max(80).optional(),
  mediaTypes: z.union([z.array(z.string()).max(20), z.literal(false)]).optional(),
  maxMediaBytes: z
    .number()
    .int()
    .positive()
    .max(100 * 1024 * 1024)
    .optional(),
});
const workspaceToolsSchema = z
  .object({
    requireApproval: z.boolean().optional(),
    requireReadBeforeWrite: z.boolean().optional(),
    maxOutputTokens: z.number().int().positive().optional(),
    writeLockTimeoutMs: z.number().int().positive().optional(),
  })
  .catchall(z.union([z.boolean(), z.number(), workspaceToolRuleSchema]).optional());

export const workspaceConfigSchema = z.object({
  threadsRoot: z.string(),
  readOnly: z.boolean(),
  allowedPaths: z.array(z.string()),
  sandboxEnabled: z.boolean(),
  sandboxTimeoutMs: z.number(),
  sandboxEnv: z.record(z.string(), z.string()),
  bm25: z.boolean(),
  bm25K1: z.number(),
  bm25B: z.number(),
  lsp: z.boolean(),
  lspDiagnosticTimeoutMs: z.number(),
  lspInitTimeoutMs: z.number(),
  lspMaxOpenClients: z.number(),
  lspDisableServers: z.array(z.string()),
  lspBinaryOverrides: z.record(z.string(), z.string()),
  lspSearchPaths: z.array(z.string()),
  tools: workspaceToolsSchema,
  skillsPaths: z.array(z.string()),
  autoIndexPaths: z.array(z.string()),
});
export type WorkspaceUserConfig = z.infer<typeof workspaceConfigSchema>;

const PERMISSION_RULES_CONTEXT_KEY = "mastra-work:permission-rules";
/** Scheduler worker -> agent context marker for unattended threaded runs. */
export const SCHEDULE_RUN_CONTEXT_KEY = "mastra-work:scheduled-run";
const PERMISSION_CATEGORIES = ["read", "edit", "execute", "mcp", "other"] as const;

/**
 * The agent-level approval callback cannot override a Workspace tool's own
 * `requireApproval: true` flag.  Workspace supports dynamic approval values,
 * so the cached instance can still honor the current request's allow-all
 * policy without baking one session's permissions into the cache.
 */
function isSessionFullyAllowed(requestContext: Record<string, unknown>): boolean {
  const value = requestContext[PERMISSION_RULES_CONTEXT_KEY];
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const rules = value as {
    categories?: Record<string, unknown>;
    tools?: Record<string, unknown>;
  };
  return (
    PERMISSION_CATEGORIES.every((category) => rules.categories?.[category] === "allow") &&
    Object.values(rules.tools ?? {}).every((policy) => policy === "allow")
  );
}

function wrapWorkspaceApproval(
  value: WorkspaceToolConfig["requireApproval"],
): WorkspaceToolConfig["requireApproval"] {
  if (value === undefined) return undefined;
  return async (context: ToolConfigWithArgsContext) => {
    if (isSessionFullyAllowed(context.requestContext)) return false;
    return typeof value === "function" ? value(context) : value;
  };
}

function getWorkspaceToolsConfig(resourceId?: string): WorkspaceToolsConfig {
  const source = getRuntime(resourceId).config.tools as WorkspaceToolsConfig;
  const output = { ...source } as Record<string, unknown>;
  if (source.requireApproval !== undefined) {
    output.requireApproval = wrapWorkspaceApproval(source.requireApproval);
  }
  for (const [toolName, rawRule] of Object.entries(source)) {
    if (typeof rawRule !== "object" || rawRule === null || Array.isArray(rawRule)) continue;
    const rule = rawRule as WorkspaceToolConfig;
    if (rule.requireApproval === undefined) continue;
    output[toolName] = {
      ...rule,
      requireApproval: wrapWorkspaceApproval(rule.requireApproval),
    } satisfies WorkspaceToolConfig;
  }
  return output as WorkspaceToolsConfig;
}

const DEFAULT_CONFIG: WorkspaceUserConfig = {
  threadsRoot: DEFAULT_THREADS_ROOT,
  readOnly: false,
  allowedPaths: [],
  sandboxEnabled: true,
  sandboxTimeoutMs: 30_000,
  sandboxEnv: {},
  bm25: true,
  bm25K1: 1.5,
  bm25B: 0.75,
  lsp: false,
  lspDiagnosticTimeoutMs: 5_000,
  lspInitTimeoutMs: 15_000,
  lspMaxOpenClients: 8,
  lspDisableServers: [],
  lspBinaryOverrides: {},
  lspSearchPaths: [],
  tools: {
    requireReadBeforeWrite: true,
    maxOutputTokens: 3_000,
    writeLockTimeoutMs: 30_000,
  },
  skillsPaths: ["skills"],
  autoIndexPaths: [],
};

function defaultWorkspaceConfig(resourceId?: string): WorkspaceUserConfig {
  return { ...DEFAULT_CONFIG, threadsRoot: defaultThreadsRoot(resourceId) };
}

/** Load each resource's workspace settings only when its workspace is first needed. */
export async function getWorkspaceConfig(resourceId?: string): Promise<WorkspaceUserConfig> {
  const runtime = getRuntime(resourceId);
  if (!runtime.loaded) {
    runtime.loading ??= (async () => {
      const raw = await getAppConfig(WORKSPACE_CONFIG_KEY, resourceId);
      runtime.config = raw
        ? normalizeWorkspaceConfig(JSON.parse(raw) as Partial<WorkspaceUserConfig>, resourceId)
        : defaultWorkspaceConfig(resourceId);
      runtime.loaded = true;
    })().finally(() => {
      runtime.loading = undefined;
    });
    await runtime.loading;
  }
  return runtime.config;
}

/** New settings replace idle instances; an active run keeps its original workspace. */
export async function saveWorkspaceConfig(
  next: WorkspaceUserConfig,
  resourceId?: string,
): Promise<void> {
  await getWorkspaceConfig(resourceId);
  const normalized = normalizeWorkspaceConfig(next, resourceId);
  const runtime = getRuntime(resourceId);
  await withWorkspaceRuntime(runtime, async () => {
    await setAppConfig(WORKSPACE_CONFIG_KEY, JSON.stringify(normalized, null, 2), resourceId);
    runtime.config = normalized;
    runtime.version += 1;
    await pruneWorkspaces(runtime);
  });
}

function normalizeWorkspaceConfig(
  input: Partial<WorkspaceUserConfig>,
  resourceId?: string,
): WorkspaceUserConfig {
  const defaults = defaultWorkspaceConfig(resourceId);
  const merged = { ...defaults, ...input };
  return {
    ...defaults,
    threadsRoot:
      typeof merged.threadsRoot === "string" ? merged.threadsRoot.trim() : defaults.threadsRoot,
    allowedPaths: cleanStrings(merged.allowedPaths),
    readOnly: merged.readOnly === true,
    sandboxEnabled: merged.sandboxEnabled === true,
    sandboxTimeoutMs: clampInt(merged.sandboxTimeoutMs, 30_000, 1_000, 900_000),
    sandboxEnv: stringRecord(merged.sandboxEnv),
    bm25: merged.bm25 === true,
    bm25K1: clampNumber(merged.bm25K1, 1.5, 0.1, 5),
    bm25B: clampNumber(merged.bm25B, 0.75, 0, 1),
    lsp: merged.lsp === true,
    lspDiagnosticTimeoutMs: clampInt(merged.lspDiagnosticTimeoutMs, 5_000, 100, 120_000),
    lspInitTimeoutMs: clampInt(merged.lspInitTimeoutMs, 15_000, 500, 300_000),
    lspMaxOpenClients: clampInt(merged.lspMaxOpenClients, 8, 1, 100),
    lspDisableServers: cleanStrings(merged.lspDisableServers),
    lspSearchPaths: cleanStrings(merged.lspSearchPaths),
    lspBinaryOverrides:
      typeof merged.lspBinaryOverrides === "object" && merged.lspBinaryOverrides !== null
        ? (Object.fromEntries(
            Object.entries(merged.lspBinaryOverrides).filter(
              ([key, value]) => key.trim() && typeof value === "string" && value.trim(),
            ),
          ) as Record<string, string>)
        : {},
    tools: workspaceToolsSchema.parse(merged.tools),
    skillsPaths: cleanStrings(merged.skillsPaths),
    autoIndexPaths: cleanStrings(merged.autoIndexPaths),
  };
}

export interface RecentWorkspace {
  /** 显式绑定过的本地目录(绝对路径) */
  path: string;
  /** 最近一次绑定时间(ISO 字符串) */
  lastUsedAt: string;
}

/** 近期绑定工作区(promptInput 选择器下拉列表数据源) */
export async function listRecentWorkspaces(resourceId?: string): Promise<RecentWorkspace[]> {
  const raw = await getAppConfig(RECENT_WORKSPACES_KEY, resourceId);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as RecentWorkspace[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** 记录一次显式绑定(去重置顶,超限淘汰最旧) */
export async function addRecentWorkspace(path: string, resourceId?: string): Promise<void> {
  const current = await listRecentWorkspaces(resourceId);
  const next = [
    { path, lastUsedAt: new Date().toISOString() },
    ...current.filter((item) => item.path !== path),
  ].slice(0, RECENT_WORKSPACES_LIMIT);
  await setAppConfig(RECENT_WORKSPACES_KEY, JSON.stringify(next, null, 2), resourceId);
}

interface WorkspaceEntry {
  workspace: Workspace;
  threadId?: string;
  resourceId?: string;
  version: number;
}

interface WorkspaceRuntime {
  config: WorkspaceUserConfig;
  loaded: boolean;
  loading?: Promise<void>;
  version: number;
  pending: Promise<unknown>;
  cache: Map<string, WorkspaceEntry>;
}

// Active runs and background processes may temporarily exceed the idle cache target.
const WORKSPACE_CACHE_LIMIT = 32;
const runtimeByScope = new Map<string, WorkspaceRuntime>();
const workspaceCleanups = new WeakMap<Workspace, Set<() => void>>();
let workspaceMastra: Mastra | undefined;
let workspaceCleanupStopped = false;
const workspaceSessions = new Map<Session, () => void>();

export function onWorkspaceDestroy(workspace: Workspace, cleanup: () => void): void {
  let cleanups = workspaceCleanups.get(workspace);
  if (!cleanups) {
    cleanups = new Set();
    workspaceCleanups.set(workspace, cleanups);
  }
  cleanups.add(cleanup);
}

function hasWorkspaceRun(entry: WorkspaceEntry): boolean {
  if (!workspaceMastra || !entry.threadId) return true;
  return (
    Object.values(workspaceMastra.listAgents()).some((agent) =>
      agent
        .listActiveThreadRuns()
        .some((run) => run.resourceId === entry.resourceId && run.threadId === entry.threadId),
    ) ||
    [...workspaceSessions.keys()].some(
      (session) =>
        session.identity.getResourceId() === entry.resourceId &&
        session.thread.getId() === entry.threadId &&
        session.run.isRunning(),
    )
  );
}

async function workspaceIsBusy(entry: WorkspaceEntry): Promise<boolean> {
  if (hasWorkspaceRun(entry)) return true;
  const tasks = await workspaceMastra?.backgroundTaskManager?.listTasks({
    resourceId: entry.resourceId,
    threadId: entry.threadId,
    status: ["pending", "running", "suspended"],
    perPage: 1,
  });
  if (tasks?.total || hasWorkspaceRun(entry)) return true;
  // LSP servers are workspace-owned services, not user background commands.
  await entry.workspace.lsp?.shutdownAll();
  const processes = await entry.workspace.sandbox?.processes?.list();
  return hasWorkspaceRun(entry) || Boolean(processes?.some((process) => process.running));
}

async function destroyWorkspace(runtime: WorkspaceRuntime, key: string, entry: WorkspaceEntry) {
  if (!(await workspaceMastra?.removeWorkspace(entry.workspace.id, { destroy: true }))) {
    await entry.workspace.destroy();
  }
  for (const cleanup of workspaceCleanups.get(entry.workspace) ?? []) cleanup();
  workspaceCleanups.delete(entry.workspace);
  runtime.cache.delete(key);
}

async function pruneWorkspaces(runtime: WorkspaceRuntime, retainedKey?: string): Promise<void> {
  for (const [key, entry] of runtime.cache) {
    if (key === retainedKey) continue;
    if (["error", "destroying", "destroyed"].includes(entry.workspace.status)) {
      await destroyWorkspace(runtime, key, entry);
      continue;
    }
    if (entry.version === runtime.version && runtime.cache.size <= WORKSPACE_CACHE_LIMIT) continue;
    if (await workspaceIsBusy(entry)) continue;
    await destroyWorkspace(runtime, key, entry);
  }
}

/** Retire workspace-bound processors with the workspace after its current run completes. */
export async function invalidateWorkspaceInstances(resourceId?: string): Promise<void> {
  const runtime = getRuntime(resourceId);
  await withWorkspaceRuntime(runtime, async () => {
    runtime.version += 1;
    await pruneWorkspaces(runtime);
  });
}

/** Native finish callbacks run before their final run-state cleanup. */
export function scheduleIdleWorkspaceCleanup(): void {
  if (workspaceCleanupStopped) return;
  setImmediate(() => {
    if (workspaceCleanupStopped) return;
    void pruneIdleWorkspaces().catch((error) =>
      workspaceMastra?.getLogger().warn("Workspace cleanup failed", { error }),
    );
  }).unref();
}

/** Prevent deferred cleanup queries after shutdown closes the shared storage. */
export async function stopWorkspaceCleanup(): Promise<void> {
  workspaceCleanupStopped = true;
  await Promise.all([...runtimeByScope.values()].map((runtime) => runtime.pending));
}

async function withWorkspaceRuntime<T>(
  runtime: WorkspaceRuntime,
  operation: () => Promise<T>,
): Promise<T> {
  const pending = runtime.pending.catch(() => undefined).then(operation);
  runtime.pending = pending;
  return pending;
}

/** Release excess idle workspaces when native session runs end, without dropping session state. */
export function registerWorkspaceLifecycle(mastra: Mastra): void {
  workspaceMastra = mastra;
  for (const controller of Object.values(mastra.listAgentControllers())) {
    controller.onSessionCreated((session) => {
      const unsubscribe = session.subscribe((event) => {
        if (event.type === "agent_end") scheduleIdleWorkspaceCleanup();
      });
      workspaceSessions.set(session, unsubscribe);
    });
    controller.onSessionDeleted((session) => {
      workspaceSessions.get(session)?.();
      workspaceSessions.delete(session);
      scheduleIdleWorkspaceCleanup();
    });
  }
}

export async function pruneIdleWorkspaces(): Promise<void> {
  await Promise.all(
    [...runtimeByScope.values()].map((runtime) =>
      withWorkspaceRuntime(runtime, () => pruneWorkspaces(runtime)),
    ),
  );
}

function getRuntime(resourceId?: string): WorkspaceRuntime {
  const key = scopeKey(resourceId);
  let runtime = runtimeByScope.get(key);
  if (!runtime) {
    runtime = {
      config: defaultWorkspaceConfig(resourceId),
      loaded: false,
      version: 0,
      pending: Promise.resolve(),
      cache: new Map(),
    };
    runtimeByScope.set(key, runtime);
  }
  return runtime;
}

/** 线程工作区根目录(隐式绑定的父目录) */
export async function getThreadsRoot(resourceId?: string): Promise<string> {
  return (await getWorkspaceConfig(resourceId)).threadsRoot;
}

/** 线程的隐式工作区目录(仅路径计算;实际创建发生在首条消息绑定时) */
export async function implicitThreadWorkspacePath(
  threadId: string,
  resourceId?: string,
): Promise<string> {
  return join(await getThreadsRoot(resourceId), threadId);
}

/** 确保目录存在(隐式绑定首次落盘) */
export function ensureDirectory(path: string): void {
  mkdirSync(path, { recursive: true });
}

/** 全局技能目录:上传一次后可被所有线程的 Agent 发现。 */
export function getManagedSkillsDirectory(resourceId?: string): string {
  const directory = resourceId
    ? join(MANAGED_SKILLS_DIRECTORY, "users", scopePathSegment(resourceId))
    : MANAGED_SKILLS_DIRECTORY;
  ensureDirectory(directory);
  return directory;
}

/** Return enabled managed skill directories for a request-scoped Workspace. */
export async function getManagedSkillPaths(resourceId?: string): Promise<string[]> {
  const root = getManagedSkillsDirectory(resourceId);
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const paths: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const directory = join(root, entry.name);
    try {
      const skillFile = join(directory, "SKILL.md");
      if ((await stat(skillFile)).size > 1024 * 1024) continue;
      const content = await readFile(skillFile, "utf8");
      if (
        validateSkillContent({ content, directoryName: entry.name }).valid &&
        matter(content, {}).data.enabled !== false
      )
        paths.push(directory);
    } catch {
      // Ignore missing or unreadable skills when resolving an agent's workspace.
    }
  }
  return paths;
}

// Workspace 实例按路径缓存:BM25 索引 / LSP 客户端初始化昂贵,
// 同一线程多次请求必须复用同一实例(workspace-class.mdx 单实例语义)。
/**
 * 获取(或创建并缓存)指定目录的 Workspace 实例。
 * Agent 的动态 workspace 函数按 requestContext 里的线程工作区路径调用;
 * 每个实例的 filesystem/sandbox 都 contained 在该目录内。
 */
export async function getThreadWorkspace(
  workspacePath: string,
  threadId?: string,
  resourceId?: string,
): Promise<Workspace> {
  await getWorkspaceConfig(resourceId);
  const runtime = getRuntime(resourceId);
  return withWorkspaceRuntime(runtime, async () => {
    const config = runtime.config;
    const cacheKey = JSON.stringify([workspacePath, threadId, resourceId]);
    const cached = runtime.cache.get(cacheKey);
    if (cached) {
      if (
        ["error", "destroying", "destroyed"].includes(cached.workspace.status) ||
        (cached.version !== runtime.version && !(await workspaceIsBusy(cached)))
      ) {
        await destroyWorkspace(runtime, cacheKey, cached);
      } else {
        runtime.cache.delete(cacheKey);
        runtime.cache.set(cacheKey, cached);
        await pruneWorkspaces(runtime, cacheKey);
        return cached.workspace;
      }
    }

    const managedSkillsDirectory = getManagedSkillsDirectory(resourceId);
    const allowedPaths = [
      ...config.allowedPaths,
      ...(resourceId ? getContentObjectAccessPaths(resourceId, threadId) : []),
      managedSkillsDirectory,
    ];
    const filesystem = new LocalFilesystem({
      basePath: workspacePath,
      ...(allowedPaths.length ? { allowedPaths } : {}),
      ...(config.readOnly ? { readOnly: true } : {}),
    });
    const changeHooks = createWorkspaceChangeHooks(filesystem);
    const outputArchive = createWorkspaceOutputArchiveHooks();
    // Keep Mastra's auto-injected tools; these hooks only observe and archive output.
    const workspaceTools = getWorkspaceToolsConfig(resourceId);
    const executeConfig = workspaceTools.mastra_workspace_execute_command;
    workspaceTools.mastra_workspace_execute_command = {
      ...(typeof executeConfig === "object" && executeConfig !== null ? executeConfig : {}),
      backgroundProcesses: {
        ...outputArchive.backgroundProcesses,
        onExit: async (meta) => {
          await outputArchive.backgroundProcesses.onExit?.(meta);
          scheduleIdleWorkspaceCleanup();
        },
      },
    };
    workspaceTools.hooks = {
      beforeToolCall: async (params) => {
        await changeHooks.beforeToolCall?.(params);
        await outputArchive.hooks.beforeToolCall?.(params);
      },
      afterToolCall: async (params) => {
        await changeHooks.afterToolCall?.(params);
        await outputArchive.hooks.afterToolCall?.(params);
      },
    };
    const sandbox = config.sandboxEnabled
      ? new LocalSandbox({
          workingDirectory: workspacePath,
          timeout: config.sandboxTimeoutMs,
          env: config.sandboxEnv,
        })
      : undefined;
    const bm25 = config.bm25 ? { k1: config.bm25K1, b: config.bm25B } : undefined;
    const lsp = config.lsp
      ? {
          root: workspacePath,
          diagnosticTimeout: config.lspDiagnosticTimeoutMs,
          initTimeout: config.lspInitTimeoutMs,
          maxOpenClients: config.lspMaxOpenClients,
          disableServers: config.lspDisableServers,
          binaryOverrides: config.lspBinaryOverrides,
          searchPaths: config.lspSearchPaths,
        }
      : undefined;
    const workspaceConfig: ConstructorParameters<typeof Workspace>[0] = {
      id: `mastra-work:${cacheKey}`,
      name: "MastraWork Workspace",
      filesystem,
      ...(sandbox ? { sandbox } : {}),
      ...(bm25 ? { bm25 } : {}),
      ...(lsp ? { lsp } : {}),
      tools: workspaceTools,
      skillSource: new LocalSkillSource({ basePath: workspacePath }),
      skills: async ({ requestContext }) => {
        const scopedResourceId = resourceId ?? userIdFromContext(requestContext);
        return [...config.skillsPaths, ...(await getManagedSkillPaths(scopedResourceId))];
      },
      ...(config.autoIndexPaths.length ? { autoIndexPaths: config.autoIndexPaths } : {}),
    };
    const workspace = new Workspace(workspaceConfig) as Workspace;
    runtime.cache.set(cacheKey, {
      workspace,
      threadId,
      resourceId,
      version: runtime.version,
    });
    await pruneWorkspaces(runtime, cacheKey);
    return workspace;
  });
}

/**
 * 线程删除时清理物理工作区与内存实例:
 * - 隐式工作区(<threadsRoot>/<threadId>/):物理删除磁盘目录与文件
 * - 显式绑定工作区:保护用户外部物理项目目录不被删除,仅释放并销毁内存中的 Workspace 实例与子进程
 */
export async function deleteThreadWorkspace(
  threadId: string,
  metadata: unknown,
  resourceId: string,
): Promise<void> {
  const meta = metadata as { workspacePath?: string; workspaceExplicit?: boolean } | undefined;
  await getWorkspaceConfig(resourceId);
  const implicitPath = await implicitThreadWorkspacePath(threadId, resourceId);
  const runtime = getRuntime(resourceId);
  await withWorkspaceRuntime(runtime, async () => {
    for (const [key, entry] of runtime.cache) {
      if (entry.threadId !== threadId || entry.resourceId !== resourceId) continue;
      if (hasWorkspaceRun(entry))
        throw new Error("Cannot delete a workspace while its thread is running");
      await destroyWorkspace(runtime, key, entry);
    }
    await rm(implicitPath, { recursive: true, force: true });
    if (meta?.workspacePath && !meta.workspaceExplicit) {
      const root = resolve(runtime.config.threadsRoot);
      const path = resolve(meta.workspacePath);
      if (path.startsWith(`${root}${sep}`)) await rm(path, { recursive: true, force: true });
    }
  });
  await deleteWorkspaceChanges(threadId, resourceId);
}
