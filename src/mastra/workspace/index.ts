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
  Workspace,
  type WorkspaceToolsConfig,
} from "@mastra/core/workspace";
import { getAppConfig, getStorageDirectory, PROJECT_ROOT, setAppConfig } from "../storage";
import { createWorkspaceChangeHooks, deleteWorkspaceChanges } from "./changes";

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
const MANAGED_SKILLS_DIRECTORY = join(getStorageDirectory() || PROJECT_ROOT, "skills");

/** chat 路由 → Agent 动态 workspace 函数传递线程工作区路径的 RequestContext key */
export const WORKSPACE_PATH_CONTEXT_KEY = "mastra-work:workspace-path";

/** 默认线程工作区根:<存储目录>/workspace/threads(绝对路径,规避 cwd 漂移) */
const DEFAULT_THREADS_ROOT = join(getStorageDirectory() || PROJECT_ROOT, "workspace", "threads");

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
  /** 原生隔离后端:Windows 仅支持 none */
  isolation: "none" | "seatbelt" | "bwrap";
  /** 原生隔离下是否放行网络(默认阻止) */
  allowNetwork: boolean;
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
  nativeReadOnlyPaths: string[];
  nativeReadWritePaths: string[];
  nativeAllowSystemBinaries: boolean;
  nativeSeatbeltProfilePath: string;
  nativeBwrapArgs: string[];
  nativeReadOnly: boolean;
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

const DEFAULT_CONFIG: WorkspaceUserConfig = {
  enabled: true,
  threadsRoot: DEFAULT_THREADS_ROOT,
  readOnly: false,
  allowedPaths: [],
  sandboxEnabled: true,
  sandboxTimeoutMs: 30_000,
  sandboxEnv: {},
  isolation: "none",
  allowNetwork: false,
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
  nativeReadOnlyPaths: [],
  nativeReadWritePaths: [],
  nativeAllowSystemBinaries: true,
  nativeSeatbeltProfilePath: "",
  nativeBwrapArgs: [],
  nativeReadOnly: false,
  tools: { requireReadBeforeWrite: true, maxOutputTokens: 3_000, writeLockTimeoutMs: 30_000 },
  skillsPaths: ["skills"],
  autoIndexPaths: [],
};

/** 读取工作区配置(app_config 表 key="workspace";无记录或损坏时回落默认值) */
export async function getWorkspaceConfig(): Promise<WorkspaceUserConfig> {
  const raw = await getAppConfig(WORKSPACE_CONFIG_KEY);
  if (!raw) return DEFAULT_CONFIG;
  try {
    return normalizeWorkspaceConfig(JSON.parse(raw) as Partial<WorkspaceUserConfig>);
  } catch {
    return DEFAULT_CONFIG;
  }
}

/** 写入工作区配置并实时生效:替换运行时配置、清空实例缓存(下次请求按新配置重建) */
export async function saveWorkspaceConfig(next: WorkspaceUserConfig): Promise<void> {
  const normalized = normalizeWorkspaceConfig(next);
  await setAppConfig(WORKSPACE_CONFIG_KEY, JSON.stringify(normalized, null, 2));
  config = normalized;
  const previous = [...workspaceCache.values()];
  workspaceCache.clear();
  await Promise.allSettled(
    previous.map((workspace) => Promise.resolve().then(() => workspace.destroy())),
  );
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function cleanStrings(value: unknown, limit = 100): string[] {
  return Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean)
        .slice(0, limit)
    : [];
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

function normalizeWorkspaceConfig(input: Partial<WorkspaceUserConfig>): WorkspaceUserConfig {
  const merged = { ...DEFAULT_CONFIG, ...input };
  const rawEnv = merged.sandboxEnv;
  return {
    ...DEFAULT_CONFIG,
    ...merged,
    enabled: merged.enabled !== false,
    threadsRoot:
      typeof merged.threadsRoot === "string"
        ? merged.threadsRoot.trim()
        : DEFAULT_CONFIG.threadsRoot,
    allowedPaths: cleanStrings(merged.allowedPaths),
    readOnly: merged.readOnly === true,
    sandboxEnabled: merged.sandboxEnabled === true,
    sandboxTimeoutMs: Math.round(boundedNumber(merged.sandboxTimeoutMs, 30_000, 1_000, 900_000)),
    sandboxEnv:
      typeof rawEnv === "object" && rawEnv !== null && !Array.isArray(rawEnv)
        ? (Object.fromEntries(
            Object.entries(rawEnv).filter(
              ([key, value]) => key.trim() && typeof value === "string",
            ),
          ) as Record<string, string>)
        : {},
    isolation:
      merged.isolation === "seatbelt" || merged.isolation === "bwrap" ? merged.isolation : "none",
    allowNetwork: merged.allowNetwork === true,
    bm25: merged.bm25 === true,
    bm25K1: boundedNumber(merged.bm25K1, 1.5, 0.1, 5),
    bm25B: boundedNumber(merged.bm25B, 0.75, 0, 1),
    lsp: merged.lsp === true,
    lspDiagnosticTimeoutMs: Math.round(
      boundedNumber(merged.lspDiagnosticTimeoutMs, 5_000, 100, 120_000),
    ),
    lspInitTimeoutMs: Math.round(boundedNumber(merged.lspInitTimeoutMs, 15_000, 500, 300_000)),
    lspMaxOpenClients: Math.round(boundedNumber(merged.lspMaxOpenClients, 8, 1, 100)),
    lspDisableServers: cleanStrings(merged.lspDisableServers),
    lspSearchPaths: cleanStrings(merged.lspSearchPaths),
    nativeReadOnlyPaths: cleanStrings(merged.nativeReadOnlyPaths),
    nativeReadWritePaths: cleanStrings(merged.nativeReadWritePaths),
    nativeAllowSystemBinaries: merged.nativeAllowSystemBinaries !== false,
    nativeSeatbeltProfilePath:
      typeof merged.nativeSeatbeltProfilePath === "string"
        ? merged.nativeSeatbeltProfilePath.trim()
        : "",
    nativeBwrapArgs: cleanStrings(merged.nativeBwrapArgs),
    nativeReadOnly: merged.nativeReadOnly === true,
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
export async function listRecentWorkspaces(): Promise<RecentWorkspace[]> {
  const raw = await getAppConfig(RECENT_WORKSPACES_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as RecentWorkspace[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** 记录一次显式绑定(去重置顶,超限淘汰最旧) */
export async function addRecentWorkspace(path: string): Promise<void> {
  const current = await listRecentWorkspaces();
  const next = [
    { path, lastUsedAt: new Date().toISOString() },
    ...current.filter((item) => item.path !== path),
  ].slice(0, RECENT_WORKSPACES_LIMIT);
  await setAppConfig(RECENT_WORKSPACES_KEY, JSON.stringify(next, null, 2));
}

// 运行时配置为模块级可变状态:顶层 await 在服务启动时从数据库读取(同 memory 模块),
// 保存配置时原地替换 —— 所有读取函数实时反映新值,无需重启。
let config = await getWorkspaceConfig();

/** 工作区总开关(Agent 动态 workspace 函数先查再解析,避免禁用时建目录) */
export function isWorkspaceEnabled(): boolean {
  return config.enabled;
}

/** 线程工作区根目录(隐式绑定的父目录) */
export function getThreadsRoot(): string {
  return config.threadsRoot;
}

/** 线程的隐式工作区目录(仅路径计算;实际创建发生在首条消息绑定时) */
export function implicitThreadWorkspacePath(threadId: string): string {
  return join(config.threadsRoot, threadId);
}

/** 确保目录存在(隐式绑定首次落盘) */
export function ensureDirectory(path: string): void {
  mkdirSync(path, { recursive: true });
}

/** 全局技能目录:上传一次后可被所有线程的 Agent 发现。 */
export function getManagedSkillsDirectory(): string {
  ensureDirectory(MANAGED_SKILLS_DIRECTORY);
  return MANAGED_SKILLS_DIRECTORY;
}

// Workspace 实例按路径缓存:BM25 索引 / LSP 客户端初始化昂贵,
// 同一线程多次请求必须复用同一实例(workspace-class.mdx 单实例语义)。
const workspaceCache = new Map<string, Workspace>();

/**
 * 获取(或创建并缓存)指定目录的 Workspace 实例。
 * Agent 的动态 workspace 函数按 requestContext 里的线程工作区路径调用;
 * 每个实例的 filesystem/sandbox 都 contained 在该目录内。
 */
export function getThreadWorkspace(workspacePath: string): Workspace {
  const cached = workspaceCache.get(workspacePath);
  if (cached) return cached;

  // Windows 无受支持的原生隔离后端(seatbelt=macOS / bwrap=Linux),
  // 用户配置了也强制回落 none,避免 LocalSandbox 启动失败(按创建时配置计算)。
  const effectiveIsolation = process.platform === "win32" ? ("none" as const) : config.isolation;

  const filesystem = new LocalFilesystem({
    basePath: workspacePath,
    ...(config.allowedPaths.length ? { allowedPaths: config.allowedPaths } : {}),
    ...(config.readOnly ? { readOnly: true } : {}),
  });
  const workspace = new Workspace({
    id: `mastra-work:${workspacePath}`,
    name: "MastraWork Workspace",
    filesystem,
    ...(config.sandboxEnabled
      ? {
          sandbox: new LocalSandbox({
            workingDirectory: workspacePath,
            timeout: config.sandboxTimeoutMs,
            env: config.sandboxEnv,
            ...(effectiveIsolation !== "none"
              ? {
                  isolation: effectiveIsolation,
                  nativeSandbox: {
                    allowNetwork: config.allowNetwork,
                    readOnlyPaths: config.nativeReadOnlyPaths,
                    readWritePaths: config.nativeReadWritePaths,
                    allowSystemBinaries: config.nativeAllowSystemBinaries,
                    ...(config.nativeSeatbeltProfilePath
                      ? { seatbeltProfilePath: config.nativeSeatbeltProfilePath }
                      : {}),
                    ...(config.nativeBwrapArgs.length ? { bwrapArgs: config.nativeBwrapArgs } : {}),
                    readOnly: config.nativeReadOnly,
                  },
                }
              : {}),
          }),
        }
      : {}),
    ...(config.bm25 ? { bm25: { k1: config.bm25K1, b: config.bm25B } } : {}),
    ...(config.lsp
      ? {
          lsp: {
            root: workspacePath,
            diagnosticTimeout: config.lspDiagnosticTimeoutMs,
            initTimeout: config.lspInitTimeoutMs,
            maxOpenClients: config.lspMaxOpenClients,
            disableServers: config.lspDisableServers,
            binaryOverrides: config.lspBinaryOverrides,
            searchPaths: config.lspSearchPaths,
          },
        }
      : {}),
    ...(Object.keys(config.tools).length
      ? {
          tools: {
            ...(config.tools as WorkspaceToolsConfig),
            hooks: createWorkspaceChangeHooks(filesystem),
          } as WorkspaceToolsConfig,
        }
      : { tools: { hooks: createWorkspaceChangeHooks(filesystem) } as WorkspaceToolsConfig }),
    ...(config.skillsPaths.length ? { skills: config.skillsPaths } : {}),
    ...(config.autoIndexPaths.length ? { autoIndexPaths: config.autoIndexPaths } : {}),
  });
  workspaceCache.set(workspacePath, workspace);
  return workspace;
}

/**
 * 线程删除时清理物理工作区与内存实例:
 * - 隐式工作区(<threadsRoot>/<threadId>/):物理删除磁盘目录与文件
 * - 显式绑定工作区:保护用户外部物理项目目录不被删除,仅释放并销毁内存中的 Workspace 实例与子进程
 */
export async function deleteThreadWorkspace(threadId: string, metadata?: unknown): Promise<void> {
  const meta = metadata as { workspacePath?: string; workspaceExplicit?: boolean } | undefined;
  const implicitPath = implicitThreadWorkspacePath(threadId);

  // 1. 销毁并清除隐式工作区的 Workspace 实例及物理目录
  const implicitCached = workspaceCache.get(implicitPath);
  if (implicitCached) {
    workspaceCache.delete(implicitPath);
    await Promise.resolve()
      .then(() => implicitCached.destroy())
      .catch(() => undefined);
  }
  await rm(implicitPath, { recursive: true, force: true }).catch(() => undefined);

  // 2. 若 metadata 指向了自定义路径:
  if (meta?.workspacePath) {
    const explicitCached = workspaceCache.get(meta.workspacePath);
    if (explicitCached) {
      workspaceCache.delete(meta.workspacePath);
      await Promise.resolve()
        .then(() => explicitCached.destroy())
        .catch(() => undefined);
    }
    // 如果该路径非用户外部显式选中的项目(例如位于 threadsRoot 内部),亦物理清理
    if (
      !meta.workspaceExplicit &&
      resolve(meta.workspacePath).startsWith(resolve(config.threadsRoot))
    ) {
      await rm(meta.workspacePath, { recursive: true, force: true }).catch(() => undefined);
    }
  }
  await deleteWorkspaceChanges(threadId);
}
