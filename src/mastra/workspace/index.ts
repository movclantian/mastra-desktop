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
import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  LocalFilesystem,
  LocalSandbox,
  type ToolConfigWithArgsContext,
  Workspace,
  type WorkspaceToolConfig,
  type WorkspaceToolsConfig,
} from "@mastra/core/workspace";
import { clampInt, clampNumber, cleanStrings, stringRecord } from "../config/normalize";
import {
  DEFAULT_MASTRA_DATA_DIRECTORY,
  getAppConfig,
  getStorageDirectory,
  setAppConfig,
} from "../storage";
import { getContentObjectAccessPaths } from "../storage/content-objects";
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

export interface WorkspaceUserConfig {
  /** 工作区总开关:关闭时不向 Agent 注入任何 workspace 工具 */
  enabled: boolean;
  /** 线程工作区根目录:隐式绑定线程的目录为 <threadsRoot>/<threadId>/ */
  threadsRoot: string;
  /** 只读文件系统(禁用写入/编辑/删除/建目录工具) */
  readOnly: boolean;
  /** 工作区之外允许访问的额外目录(绝对路径,附加到每个线程实例) */
  allowedPaths: string[];
  /** 本地沙箱(execute_command 等命令执行工具)开关 */
  sandboxEnabled: boolean;
  /** 沙箱命令超时(毫秒) */
  sandboxTimeoutMs: number;
  /** 沙箱环境变量(默认仅 PATH,避免泄漏宿主密钥) */
  sandboxEnv: Record<string, string>;
  /** BM25 关键词搜索(skills 内容亦自动索引) */
  bm25: boolean;
  bm25K1: number;
  bm25B: number;
  /** LSP 语义代码检查(需本机可用语言服务器,Windows 需自行安装) */
  lsp: boolean;
  lspDiagnosticTimeoutMs: number;
  lspInitTimeoutMs: number;
  lspMaxOpenClients: number;
  lspDisableServers: string[];
  lspBinaryOverrides: Record<string, string>;
  lspSearchPaths: string[];
  tools: WorkspaceToolsUserConfig;
  /** Skills 目录(相对每个工作区,含 SKILL.md 的文件夹的父目录) */
  skillsPaths: string[];
  /** 初始化时自动索引的路径/glob(相对每个工作区) */
  autoIndexPaths: string[];
}

interface WorkspaceToolRule {
  enabled?: boolean;
  requireApproval?: boolean;
  requireReadBeforeWrite?: boolean;
  maxOutputTokens?: number;
  name?: string;
  mediaTypes?: string[] | false;
  maxMediaBytes?: number;
}

interface WorkspaceToolsUserConfig {
  enabled?: boolean;
  requireApproval?: boolean;
  requireReadBeforeWrite?: boolean;
  maxOutputTokens?: number;
  writeLockTimeoutMs?: number;
  [toolName: string]: boolean | number | WorkspaceToolRule | undefined;
}

const PERMISSION_RULES_CONTEXT_KEY = "mastra-work:permission-rules";
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
  enabled: true,
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

/** 读取工作区配置(app_config 表 key="workspace";无记录或损坏时回落默认值) */
export async function getWorkspaceConfig(resourceId?: string): Promise<WorkspaceUserConfig> {
  const raw = await getAppConfig(WORKSPACE_CONFIG_KEY, resourceId);
  if (!raw) {
    const next = defaultWorkspaceConfig(resourceId);
    getRuntime(resourceId).config = next;
    return next;
  }
  try {
    const next = normalizeWorkspaceConfig(
      JSON.parse(raw) as Partial<WorkspaceUserConfig>,
      resourceId,
    );
    getRuntime(resourceId).config = next;
    return next;
  } catch {
    const next = defaultWorkspaceConfig(resourceId);
    getRuntime(resourceId).config = next;
    return next;
  }
}

/** 写入工作区配置并实时生效:替换运行时配置、清空实例缓存(下次请求按新配置重建) */
export async function saveWorkspaceConfig(
  next: WorkspaceUserConfig,
  resourceId?: string,
): Promise<void> {
  const normalized = normalizeWorkspaceConfig(next, resourceId);
  await setAppConfig(WORKSPACE_CONFIG_KEY, JSON.stringify(normalized, null, 2), resourceId);
  const runtime = getRuntime(resourceId);
  runtime.config = normalized;
  const previous = [...runtime.cache.values()];
  runtime.cache.clear();
  await Promise.allSettled(previous.map(async (workspace) => workspace.destroy()));
}

function normalizeWorkspaceTools(value: unknown): WorkspaceToolsUserConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return DEFAULT_CONFIG.tools;
  const output: WorkspaceToolsUserConfig = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (["enabled", "requireApproval", "requireReadBeforeWrite"].includes(key)) {
      if (typeof raw === "boolean") output[key] = raw;
      continue;
    }
    if (["maxOutputTokens", "writeLockTimeoutMs"].includes(key)) {
      if (typeof raw === "number" && Number.isFinite(raw))
        output[key] = Math.round(Math.max(1, raw));
      continue;
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
    const source = raw as Record<string, unknown>;
    const rule: WorkspaceToolRule = {};
    if (typeof source.enabled === "boolean") rule.enabled = source.enabled;
    if (typeof source.requireApproval === "boolean") rule.requireApproval = source.requireApproval;
    if (typeof source.requireReadBeforeWrite === "boolean")
      rule.requireReadBeforeWrite = source.requireReadBeforeWrite;
    if (typeof source.maxOutputTokens === "number" && Number.isFinite(source.maxOutputTokens)) {
      rule.maxOutputTokens = Math.round(Math.max(1, source.maxOutputTokens));
    }
    if (typeof source.name === "string" && source.name.trim())
      rule.name = source.name.trim().slice(0, 80);
    if (source.mediaTypes === false) rule.mediaTypes = false;
    if (Array.isArray(source.mediaTypes)) rule.mediaTypes = cleanStrings(source.mediaTypes, 20);
    if (typeof source.maxMediaBytes === "number" && Number.isFinite(source.maxMediaBytes)) {
      rule.maxMediaBytes = Math.round(
        Math.min(100 * 1024 * 1024, Math.max(1, source.maxMediaBytes)),
      );
    }
    output[key] = rule;
  }
  return output;
}

function normalizeWorkspaceConfig(
  input: Partial<WorkspaceUserConfig>,
  resourceId?: string,
): WorkspaceUserConfig {
  const defaults = defaultWorkspaceConfig(resourceId);
  const merged = { ...defaults, ...input };
  return {
    ...defaults,
    enabled: merged.enabled !== false,
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
    tools: normalizeWorkspaceTools(merged.tools),
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

interface WorkspaceRuntime {
  config: WorkspaceUserConfig;
  cache: Map<string, Workspace>;
}

function cachedWorkspacesForPath(runtime: WorkspaceRuntime, workspacePath: string) {
  return [...runtime.cache.entries()].filter(
    ([key]) => key === workspacePath || key.startsWith(`${workspacePath}\u0000`),
  );
}

const runtimeByScope = new Map<string, WorkspaceRuntime>();

function getRuntime(resourceId?: string): WorkspaceRuntime {
  const key = scopeKey(resourceId);
  let runtime = runtimeByScope.get(key);
  if (!runtime) {
    runtime = { config: defaultWorkspaceConfig(resourceId), cache: new Map() };
    runtimeByScope.set(key, runtime);
  }
  return runtime;
}

/** 工作区总开关(Agent 动态 workspace 函数先查再解析,避免禁用时建目录) */
export function isWorkspaceEnabled(resourceId?: string): boolean {
  return getRuntime(resourceId).config.enabled;
}

/** 线程工作区根目录(隐式绑定的父目录) */
export function getThreadsRoot(resourceId?: string): string {
  return getRuntime(resourceId).config.threadsRoot;
}

/** 线程的隐式工作区目录(仅路径计算;实际创建发生在首条消息绑定时) */
export function implicitThreadWorkspacePath(threadId: string, resourceId?: string): string {
  return join(getThreadsRoot(resourceId), threadId);
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

// Workspace 实例按路径缓存:BM25 索引 / LSP 客户端初始化昂贵,
// 同一线程多次请求必须复用同一实例(workspace-class.mdx 单实例语义)。
/**
 * 获取(或创建并缓存)指定目录的 Workspace 实例。
 * Agent 的动态 workspace 函数按 requestContext 里的线程工作区路径调用;
 * 每个实例的 filesystem/sandbox 都 contained 在该目录内。
 */
export function getThreadWorkspace(
  workspacePath: string,
  threadId?: string,
  resourceId?: string,
): Workspace {
  const runtime = getRuntime(resourceId);
  const config = runtime.config;
  const cacheKey = [workspacePath, threadId, resourceId].filter(Boolean).join("\u0000");
  const cached = runtime.cache.get(cacheKey);
  if (cached) return cached;

  const allowedPaths = [
    ...config.allowedPaths,
    ...(resourceId ? getContentObjectAccessPaths(resourceId, threadId) : []),
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
    backgroundProcesses: outputArchive.backgroundProcesses,
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
    id: `mastra-work:${workspacePath}${threadId ? `:${threadId}` : ""}`,
    name: "MastraWork Workspace",
    filesystem,
    ...(sandbox ? { sandbox } : {}),
    ...(bm25 ? { bm25 } : {}),
    ...(lsp ? { lsp } : {}),
    tools: workspaceTools,
    ...(config.skillsPaths.length ? { skills: config.skillsPaths } : {}),
    ...(config.autoIndexPaths.length ? { autoIndexPaths: config.autoIndexPaths } : {}),
  };
  const workspace = new Workspace(workspaceConfig) as Workspace;
  runtime.cache.set(cacheKey, workspace);
  return workspace;
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
  const implicitPath = implicitThreadWorkspacePath(threadId, resourceId);
  const runtime = getRuntime(resourceId);

  // 1. 销毁并清除隐式工作区的 Workspace 实例及物理目录
  for (const [cacheKey, workspace] of cachedWorkspacesForPath(runtime, implicitPath)) {
    runtime.cache.delete(cacheKey);
    await workspace.destroy().catch(() => undefined);
  }
  await rm(implicitPath, { recursive: true, force: true }).catch(() => undefined);

  // 2. 若 metadata 指向了自定义路径:
  if (meta?.workspacePath) {
    for (const [cacheKey, workspace] of cachedWorkspacesForPath(runtime, meta.workspacePath)) {
      runtime.cache.delete(cacheKey);
      await workspace.destroy().catch(() => undefined);
    }
    // 如果该路径非用户外部显式选中的项目(例如位于 threadsRoot 内部),亦物理清理
    if (
      !meta.workspaceExplicit &&
      resolve(meta.workspacePath).startsWith(resolve(runtime.config.threadsRoot))
    ) {
      await rm(meta.workspacePath, { recursive: true, force: true }).catch(() => undefined);
    }
  }
  await deleteWorkspaceChanges(threadId, resourceId);
}
