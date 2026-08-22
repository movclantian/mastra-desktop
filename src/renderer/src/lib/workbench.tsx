/**
 * 工作台全局状态(React Context):线程 / 用户 / 模型选择 / 检索引擎 /
 * 终端与浏览器请求队列 / 面板可见性。与服务端的契约见各路由文件
 * (src/mastra/server/routes/)。联网检索常量与 src/mastra/tools/web-search.ts 一一对应。
 */
import type { FileUIPart } from "ai";
import { nanoid } from "nanoid";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  type CatalogProvider,
  loadModelCatalog,
  MASTRA_SERVER_URL,
  type ProviderConfig,
  type ReasoningEffort,
} from "./providers";
import {
  DEFAULT_MODE_ID,
  DEFAULT_PERMISSION_RULES,
  type PermissionRules,
  parseModeId,
  parsePermissionRules,
  type WorkModeId,
} from "./session-policy";

/**
 * 多用户体系工作台状态:
 * - user(resourceId):一切数据的隔离边界 —— 线程、供应商配置、工作区均按用户隔离
 * - thread:与 Agent 的会话线程(Mastra Memory thread),每条线程绑定一个工作区目录
 *   (Harness session 概念):显式绑定(用户选定目录,sidebar 展示文件树并按目录分组)
 *   或隐式绑定(<threadsRoot>/<threadId>/,仅 Agent 工作目录)
 */

export interface WorkUser {
  id: string;
  name: string;
  email: string;
}

export interface ThreadMetadata {
  /** 线程绑定的工作区目录(绝对路径,首条消息时由服务端锁定) */
  workspacePath?: string;
  /** true = 用户显式选定的目录(可浏览文件树);false/缺省 = 隐式默认目录 */
  workspaceExplicit?: boolean;
  /** 会话模式(plan/build/review);缺省视为默认模式 */
  modeId?: string;
  /** 工具审批规则(官方 PermissionRules 形状);缺省视为默认规则。读取时仍过 parsePermissionRules */
  permissionRules?: PermissionRules;
  /** 线程内每种模式各自最近使用的模型形态。 */
  modelSelectionByMode?: Record<
    string,
    {
      providerId: string;
      modelId: string;
      modelName: string;
      reasoningEffort: string;
    }
  >;
  subagentModels?: Record<string, string>;
  pinned?: boolean;
  archivedAt?: string | null;
  draft?: boolean;
  /** 手动压缩上下文完成时间(真压缩:折叠消息已删除并替换为摘要消息) */
  compactedAt?: string | null;
  /** 最近一次压缩详情(服务端 summarize 路由写入,Marker 点击回看) */
  compaction?: {
    summary: string;
    extracted?: Record<string, unknown>;
    extractionFailures?: Array<{ slug: string; error: string }>;
    inputTokens?: number;
    outputTokens?: number;
    estimatedContextTokens?: number;
    deletedMessages?: number;
    compactedAt: string;
  };
  contextUsage?: Record<string, unknown>;
}

/** GET /work/workspace/recent:近期显式绑定的工作区目录 */
export interface RecentWorkspace {
  path: string;
  lastUsedAt: string;
}

/** GET /work/threads/:id/tree:文件树单层条目 */
export interface TreeEntry {
  hidden?: boolean;
  name: string;
  path: string;
  type: "file" | "dir";
}

/** 取路径最后一段作为目录显示名(POSIX/Windows 通用) */
export function dirName(path: string): string {
  const trimmed = path.replaceAll("\\", "/").replace(/\/+$/, "");
  const name = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  return name || trimmed || path;
}

export interface WorkThread {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  metadata: ThreadMetadata;
}

export interface ModelSelection {
  providerId: string;
  modelId: string;
  modelName: string;
  reasoningEffort: ReasoningEffort | "off";
}

/** Memory.recall 跨线程检索结果(GET /work/memory/search) */
export interface MessageSearchHit {
  threadId: string;
  threadTitle: string;
  messageId: string;
  role: string;
  text: string;
  createdAt: string;
  semantic: boolean;
}

/** 搜索结果跳转请求:切换线程并滚动到具体气泡 */
export interface PendingJump {
  threadId: string;
  messageId: string;
}

/** 右侧面板可承载的模块类型。browser 页面由服务端浏览器状态派生,其余是前端实例。 */
export type PanelTabKind = "files" | "terminal" | "browser";

/**
 * 前端拥有的右侧标签实例(文件树 / 终端各可多开)。
 * 浏览器页面标签不在这里 —— 它们直接映射服务端的 state.tabs,按 index 寻址。
 */
export interface LocalPanelTab {
  id: string;
  kind: "files" | "terminal";
  title: string;
}

/** 当前激活的右侧标签。浏览器用 index 而非 id:Mastra 的 tabs API 只按下标寻址。 */
export type ActivePanelTab =
  | { kind: "files" | "terminal"; id: string }
  | { kind: "browser"; index: number };

export interface TerminalRequest {
  id: number;
  command?: string;
  filePath?: string;
}

/** 全局链接路由写入的导航请求，由右侧线程浏览器消费。 */
export interface BrowserRequest {
  id: number;
  threadId: string | null;
  url: string;
  newTab?: boolean;
}

// ---- 联网检索(常量与服务端 src/mastra/tools/web-search.ts 一一对应) ----

export const SEARCH_ENGINES = ["provider", "tavily", "firecrawl", "anysearch"] as const;
export type SearchEngine = (typeof SEARCH_ENGINES)[number];

export const SEARCH_DEPTHS = ["fast", "balanced", "deep"] as const;
export type SearchDepth = (typeof SEARCH_DEPTHS)[number];

/** promptInput 搜索菜单的选择,null = 关闭联网检索 */
export interface SearchSelection {
  engine: SearchEngine;
  depth: SearchDepth;
}

/** GET/POST /work/tools 的载荷(API Key 存服务端 app_config 表) */
export interface ToolsConfig {
  tavily: { apiKey: string };
  firecrawl: { apiKey: string; apiUrl: string };
  anysearch: { apiKey: string };
}

export const SEARCH_ENGINE_META: Record<
  SearchEngine,
  { label: string; description: string /** 是否必须配置 API Key 才能调用 */; requiresKey: boolean }
> = {
  provider: {
    label: "模型原生检索",
    description: "用模型自带的检索能力,零配置;仅 OpenAI / Anthropic / Google / xAI 模型可用",
    requiresKey: false,
  },
  tavily: {
    label: "Tavily",
    description: "为 LLM 优化的检索 API,答案摘要与引用质量最稳",
    requiresKey: true,
  },
  firecrawl: {
    label: "Firecrawl",
    description: "检索 + 整页抓取,适合需要读全文的场景",
    requiresKey: true,
  },
  anysearch: {
    label: "AnySearch",
    description: "未填 Key 时按匿名额度调用",
    requiresKey: false,
  },
};

export const SEARCH_DEPTH_META: Record<SearchDepth, { label: string; description: string }> = {
  fast: { label: "快速", description: "3 条结果,仅读摘要" },
  balanced: { label: "均衡", description: "6 条结果,标准检索深度" },
  deep: { label: "深度", description: "10 条结果,并抓取重点页面全文" },
};

/**
 * provider 原生检索(webSearchTool)支持的模型家族。与服务端
 * src/mastra/tools/web-search.ts 的 PROVIDER_SEARCH_FAMILIES 保持一致。
 * 自定义网关一律不支持:对端未必实现 provider 原生检索工具。
 */
const PROVIDER_SEARCH_FAMILIES = ["openai", "anthropic", "google", "gemini", "xai"];

function isProviderSearchSupported(provider: ProviderConfig | undefined): boolean {
  if (!provider || provider.baseUrl || !provider.registryId) return false;
  return PROVIDER_SEARCH_FAMILIES.includes(provider.registryId);
}

/**
 * 该引擎当前是否可直接调用。
 * - provider:看当前选定模型的家族(不需要 Key)
 * - AnySearch:支持匿名,恒可用
 * - Tavily / Firecrawl:看 Key
 */
export function isSearchEngineReady(
  engine: SearchEngine,
  config: ToolsConfig | null,
  activeProvider?: ProviderConfig,
): boolean {
  if (engine === "provider") return isProviderSearchSupported(activeProvider);
  if (!SEARCH_ENGINE_META[engine].requiresKey) return true;
  if (!config) return false;
  return Boolean(engine === "tavily" ? config.tavily.apiKey : config.firecrawl.apiKey);
}

const SEARCH_SELECTION_KEY = "mastra-work:search-selection";
const ACTIVE_THREAD_KEY = "mastra-work:active-thread";
/**
 * 模式与审批规则的**新线程默认值**。真相在 thread.metadata(服务端),
 * 这两个 key 只承担「下一条新线程用什么」——与服务端线程 metadata
 * 「Session 持有当前模式、thread settings 持久化」的分工一致。
 */
const MODE_KEY = "mastra-work:mode";
const PERMISSION_RULES_KEY = "mastra-work:permission-rules";

function readJson<T>(key: string, fallback: T): T {
  const raw = localStorage.getItem(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** 单个终端会话向 workbench 注册表登记的信息 */
export interface TerminalSessionInfo {
  title: string;
  status: "connecting" | "ready" | "exited" | "error";
  lastCommand?: string;
  lastExitCode?: number;
  /** 命令结束的时刻,用于在多个会话里挑出「最近结束的那条命令」 */
  settledAt?: number;
}

/** 右侧面板的初始标签。用固定 id 而非 nanoid,让初始激活项能与它同步声明。 */
const INITIAL_FILES_TAB: LocalPanelTab = {
  id: "panel-tab-files-initial",
  kind: "files",
  title: "文件",
};

const DEFAULT_USER: WorkUser = {
  id: "user-local",
  name: "Local User",
  email: "local@mastra-work.app",
};

interface WorkbenchValue {
  // 用户(单机应用,恒为本地常量)
  user: WorkUser;
  // 线程(每线程绑定工作区目录,见 ThreadMetadata.workspacePath)
  threads: WorkThread[];
  threadsLoading: boolean;
  refreshThreads: () => Promise<void>;
  createThread: (title?: string) => Promise<WorkThread | null>;
  renameThread: (threadId: string, title: string) => Promise<void>;
  deleteThread: (threadId: string) => Promise<void>;
  pinThread: (threadId: string, pinned: boolean) => Promise<void>;
  archiveThread: (threadId: string, archived: boolean) => Promise<void>;
  cloneThread: (
    threadId: string,
    selection?: number | { messageLimit?: number; messageIds?: string[] },
  ) => Promise<WorkThread | null>;
  searchMessages: (query: string) => Promise<MessageSearchHit[]>;
  // 近期显式绑定的工作区目录(promptInput 选择器数据源)
  recentWorkspaces: RecentWorkspace[];
  refreshRecentWorkspaces: () => Promise<void>;
  // 线程工作区文件树(仅显式绑定线程;单层按需拉取)
  fetchTreeEntries: (threadId: string, path?: string) => Promise<TreeEntry[]>;
  activeThreadId: string | null;
  setActiveThreadId: (id: string | null) => void;
  // 搜索结果跳转(chat-panel 消费后清除)
  pendingJump: PendingJump | null;
  setPendingJump: (jump: PendingJump | null) => void;
  // 供应商(BYOK)
  providers: ProviderConfig[];
  setProviders: (providers: ProviderConfig[]) => void;
  // models.dev 目录
  catalog: CatalogProvider[];
  /** 模型目录加载状态:用于区分尚未读取、读取成功但没有匹配、读取失败 */
  catalogStatus: "loading" | "ready" | "error";
  // 模型选择
  modelSelection: ModelSelection | null;
  setModelSelection: (selection: ModelSelection | null) => void;
  // 会话模式(plan/build/review;真相在 thread.metadata.modeId)
  modeId: WorkModeId;
  setModeId: (modeId: WorkModeId) => Promise<void>;
  // 工具审批规则(官方 PermissionRules;真相在 thread.metadata.permissionRules)
  permissionRules: PermissionRules;
  setPermissionRules: (rules: PermissionRules) => Promise<void>;
  /** 重新采纳当前线程的会话设置(服务端单方面改过模式时用,如计划获批后的模式跃迁) */
  refreshThreadSettings: () => Promise<void>;
  // 联网检索(promptInput 搜索菜单;null = 关闭)
  searchSelection: SearchSelection | null;
  setSearchSelection: (selection: SearchSelection | null) => void;
  /** 三个引擎的 API Key 配置(设置面板「工具」标签写入),null = 尚未取到 */
  toolsConfig: ToolsConfig | null;
  refreshToolsConfig: () => Promise<void>;
  // 设置弹窗
  settingsOpen: boolean;
  setSettingsOpen: (open: boolean) => void;
  /** Agent 是否有任务进行中(流式生成/等待响应);chat panel 同步,设置页消费 */
  agentBusy: boolean;
  setAgentBusy: (busy: boolean) => void;
  libraryOpen: boolean;
  setLibraryOpen: (open: boolean) => void;
  skillOpen: boolean;
  setSkillOpen: (open: boolean) => void;
  pendingLibraryFiles: Array<FileUIPart & { byteSize?: number }>;
  queueLibraryFiles: (files: Array<FileUIPart & { byteSize?: number }>) => void;
  clearPendingLibraryFiles: () => void;
  // 线程级工作面板(Minke right/bottom tabs 对应的应用状态)
  workspacePanelOpen: boolean;
  setWorkspacePanelOpen: (open: boolean) => void;
  /** 右侧面板里前端拥有的标签实例(文件树 / 终端);浏览器页面由面板自己派生渲染 */
  panelTabs: LocalPanelTab[];
  activePanelTab: ActivePanelTab;
  activatePanelTab: (tab: ActivePanelTab) => void;
  /** 新建一个本地标签并激活它,返回新标签 id */
  addPanelTab: (kind: "files" | "terminal") => string;
  closePanelTab: (id: string) => void;
  /** 打开面板并聚焦该类型的第一个标签(browser 聚焦当前活动页) */
  openWorkspacePanel: (kind?: PanelTabKind) => void;
  terminalPanelOpen: boolean;
  setTerminalPanelOpen: (open: boolean) => void;
  /**
   * 终端会话登记。底部面板与右侧终端标签的会话都往这里登记,由 workbench 聚合成
   * 一份 terminal state lane —— 否则模型只能看到其中一个面板里的终端。传 null 撤销。
   */
  reportTerminalSession: (id: string, info: TerminalSessionInfo | null) => void;
  terminalRequest: TerminalRequest | null;
  requestTerminalCommand: (request: Omit<TerminalRequest, "id">) => void;
  /** 打开当前线程的右侧浏览器并导航。普通网页链接均经此入口。 */
  browserRequest: BrowserRequest | null;
  openBrowserUrl: (url: string) => void;
}

// ---------------------------------------------------------------------------
// 工作台状态上报(state lane 的生产者)
//
// 面板状态只活在渲染进程,模型看不到。这里把它 PUT 给 Mastra 服务端的内存镜像,
// 由 src/mastra/agents/processors 的三条 state lane 在模型真要推理时注入为
// <state type="editor|terminal|workbench">。所以上报本身不会唤醒空闲的 agent,
// 也不写进对话历史。
//
// debounce 是必须的:编辑器每敲一个字都会翻转 dirty,而 lane 侧还会按 cacheKey
// 二次去重 —— 高频上报纯属浪费。按 lane 分桶,不同面板的上报互不取消。
// ---------------------------------------------------------------------------

export interface WorkbenchStatePatch {
  editor?: {
    workspacePath?: string;
    openPath?: string;
    dirty?: boolean;
    selectedPath?: string;
  };
  terminal?: {
    open: boolean;
    sessionCount: number;
    activeTitle?: string;
    activeStatus?: "connecting" | "ready" | "exited" | "error";
    lastCommand?: string;
    lastExitCode?: number;
  };
  workbench?: {
    workspacePanelOpen: boolean;
    workspacePanelTab?: string;
    terminalPanelOpen: boolean;
    libraryOpen: boolean;
  };
}

const WORKBENCH_STATE_REPORT_DELAY = 400;
const pendingStateReports = new Map<string, ReturnType<typeof setTimeout>>();

export function reportWorkbenchState(
  threadId: string | null,
  resourceId: string,
  patch: WorkbenchStatePatch,
): void {
  if (!threadId) return;
  const key = `${threadId}:${Object.keys(patch).join(",")}`;
  const pending = pendingStateReports.get(key);
  if (pending) clearTimeout(pending);
  pendingStateReports.set(
    key,
    setTimeout(() => {
      pendingStateReports.delete(key);
      void fetch(
        `${MASTRA_SERVER_URL}/work/sessions/workbench/threads/${encodeURIComponent(threadId)}/workbench-state?resourceId=${encodeURIComponent(resourceId)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        },
      ).catch(() => undefined);
    }, WORKBENCH_STATE_REPORT_DELAY),
  );
}

/**
 * 前端侧才知道的事件 → 通知收件箱(终端里跑完的长命令等)。
 * 落库后由 agent 的投递策略决定是立即送达还是攒进 <notification-summary>,
 * 全文由 notification_inbox 工具读取。不 debounce —— 每个事件都该留一条记录。
 */
export function reportWorkbenchNotification(
  threadId: string | null,
  resourceId: string,
  notification: {
    source: string;
    kind: string;
    summary: string;
    priority?: "low" | "medium" | "high" | "urgent";
    payload?: unknown;
    dedupeKey?: string;
  },
): void {
  if (!threadId) return;
  void fetch(
    `${MASTRA_SERVER_URL}/work/sessions/workbench/threads/${encodeURIComponent(threadId)}/notification?resourceId=${encodeURIComponent(resourceId)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(notification),
    },
  ).catch(() => undefined);
}

const WorkbenchContext = createContext<WorkbenchValue | null>(null);

export function WorkbenchProvider({ children }: { children: ReactNode }) {
  const user = DEFAULT_USER;
  // 供应商与选定模型存服务端(app_config key="providers"):Studio 的模型选择器与
  // Agent 的默认模型都要读到它,而 Studio 跑在 Mastra 进程里、读不到 localStorage。
  const [providers, setProvidersState] = useState<ProviderConfig[]>([]);
  const [modelSelection, setModelSelectionState] = useState<ModelSelection | null>(null);
  /** 服务端配置是否已到位 —— 到位前不回写,避免用空配置覆盖数据库 */
  const [providersLoaded, setProvidersLoaded] = useState(false);
  const [searchSelection, setSearchSelectionState] = useState<SearchSelection | null>(() =>
    readJson<SearchSelection | null>(SEARCH_SELECTION_KEY, null),
  );
  // 模式与审批规则:会话级状态(与官方 Session 同位),切线程时被线程自己的记录覆盖
  const [modeId, setModeIdState] = useState<WorkModeId>(() =>
    parseModeId(readJson<string>(MODE_KEY, DEFAULT_MODE_ID)),
  );
  const [permissionRules, setPermissionRulesState] = useState<PermissionRules>(() =>
    parsePermissionRules(readJson<unknown>(PERMISSION_RULES_KEY, DEFAULT_PERMISSION_RULES)),
  );
  /** 已采纳过线程设置的线程 id:每条线程只在切入时采纳一次,后续刷新不覆盖用户改动 */
  const adoptedThreadRef = useRef<string | null>(null);
  const [toolsConfig, setToolsConfig] = useState<ToolsConfig | null>(null);
  const [threads, setThreads] = useState<WorkThread[]>([]);
  const [threadsLoading, setThreadsLoading] = useState(true);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(() =>
    readJson<string | null>(ACTIVE_THREAD_KEY, null),
  );
  const activeThreadResolvedRef = useRef(false);
  const createThreadRequestRef = useRef<Promise<WorkThread | null> | null>(null);
  const [pendingJump, setPendingJump] = useState<PendingJump | null>(null);
  const [catalog, setCatalog] = useState<CatalogProvider[]>([]);
  const [catalogStatus, setCatalogStatus] = useState<"loading" | "ready" | "error">("loading");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [agentBusy, setAgentBusy] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [skillOpen, setSkillOpen] = useState(false);
  const [workspacePanelOpen, setWorkspacePanelOpen] = useState(false);
  const [panelTabs, setPanelTabs] = useState<LocalPanelTab[]>(() => [INITIAL_FILES_TAB]);
  const [activePanelTab, setActivePanelTab] = useState<ActivePanelTab>({
    kind: "files",
    id: INITIAL_FILES_TAB.id,
  });
  /** 标签标题的序号来源:第一个文件树叫「文件」,之后是「文件 2」「终端 1」… */
  const panelTabCountsRef = useRef({ files: 1, terminal: 0 });
  /** 两个面板的终端会话都登记在这里,聚合后上报 terminal state lane */
  const terminalSessionsRef = useRef(new Map<string, TerminalSessionInfo>());
  const [terminalSessionsVersion, setTerminalSessionsVersion] = useState(0);
  const [terminalPanelOpen, setTerminalPanelOpen] = useState(false);
  const [terminalRequest, setTerminalRequest] = useState<TerminalRequest | null>(null);
  const terminalRequestIdRef = useRef(0);
  const [browserRequest, setBrowserRequest] = useState<BrowserRequest | null>(null);
  const browserRequestIdRef = useRef(0);
  const [recentWorkspaces, setRecentWorkspaces] = useState<RecentWorkspace[]>([]);
  const [pendingLibraryFiles, setPendingLibraryFiles] = useState<
    Array<FileUIPart & { byteSize?: number }>
  >([]);

  useEffect(() => {
    localStorage.setItem(SEARCH_SELECTION_KEY, JSON.stringify(searchSelection));
  }, [searchSelection]);
  // 面板可见性 → workbench state lane:让模型知道用户此刻的注意力在哪
  useEffect(() => {
    reportWorkbenchState(activeThreadId, user.id, {
      workbench: {
        workspacePanelOpen,
        workspacePanelTab: activePanelTab.kind,
        terminalPanelOpen,
        libraryOpen,
      },
    });
  }, [activeThreadId, activePanelTab.kind, libraryOpen, terminalPanelOpen, workspacePanelOpen]);
  useEffect(() => {
    localStorage.setItem(MODE_KEY, JSON.stringify(modeId));
  }, [modeId]);
  useEffect(() => {
    localStorage.setItem(PERMISSION_RULES_KEY, JSON.stringify(permissionRules));
  }, [permissionRules]);
  useEffect(() => {
    if (activeThreadId) {
      localStorage.setItem(ACTIVE_THREAD_KEY, activeThreadId);
    } else {
      localStorage.removeItem(ACTIVE_THREAD_KEY);
    }
  }, [activeThreadId]);

  // models.dev 目录:服务端缓存 1 小时 + 会话内存缓存,未命中静默拉取
  useEffect(() => {
    loadModelCatalog()
      .then((nextCatalog) => {
        setCatalog(nextCatalog);
        setCatalogStatus("ready");
      })
      .catch(() => {
        setCatalog([]);
        setCatalogStatus("error");
      });
  }, []);

  // 供应商配置:挂载时从服务端读取(app_config key="providers")
  useEffect(() => {
    fetch(`${MASTRA_SERVER_URL}/work/providers/config`)
      .then((r) => (r.ok ? r.json() : null))
      .then(
        (
          config: { providers?: ProviderConfig[]; modelSelection?: ModelSelection | null } | null,
        ) => {
          if (!config) return;
          setProvidersState(config.providers ?? []);
          setModelSelectionState(config.modelSelection ?? null);
        },
      )
      .catch(() => undefined)
      .finally(() => setProvidersLoaded(true));
  }, []);

  // 自动保存供应商清单:任何修改 800ms 无后续变化后写回服务端。
  // 读取完成前不回写,否则初始空状态会覆盖数据库里已有的供应商与 Key。
  // 注意只写 providers 字段 —— modelSelection 由下面的 setModelSelection 单独写,
  // 否则「切线程采纳该线程的模型」会顺带改掉全局默认模型(见 saveProvidersConfig)。
  useEffect(() => {
    if (!providersLoaded) return;
    const timer = window.setTimeout(() => {
      void fetch(`${MASTRA_SERVER_URL}/work/providers/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providers }),
      }).catch(() => undefined);
    }, 800);
    return () => window.clearTimeout(timer);
  }, [providers, providersLoaded]);

  const setProviders = useCallback((next: ProviderConfig[]) => {
    setProvidersState(next);
  }, []);

  /**
   * 用户显式选定模型:立即写全局默认(新线程与 Studio 直接聊天都用它),
   * 并通过 Session model API 写入本线程当前 mode 的模型快照。
   */
  const setModelSelection = useCallback(
    (selection: ModelSelection | null) => {
      setModelSelectionState(selection);
      void fetch(`${MASTRA_SERVER_URL}/work/providers/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelSelection: selection }),
      }).catch(() => undefined);
      if (!activeThreadId) return;
      const current = threads.find((thread) => thread.id === activeThreadId);
      const modelSelectionByMode = { ...current?.metadata.modelSelectionByMode };
      if (selection) modelSelectionByMode[modeId] = selection;
      else delete modelSelectionByMode[modeId];
      const nextMetadata = {
        ...current?.metadata,
        modelSelectionByMode,
      };
      setThreads((currentThreads) =>
        currentThreads.map((thread) =>
          thread.id === activeThreadId ? { ...thread, metadata: nextMetadata } : thread,
        ),
      );
      void fetch(
        `${MASTRA_SERVER_URL}/work/sessions/workbench/threads/${activeThreadId}/model?resourceId=${encodeURIComponent(user.id)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ selection, modeId }),
        },
      ).catch(() => undefined);
    },
    [activeThreadId, modeId, threads],
  );

  const setSearchSelection = useCallback((selection: SearchSelection | null) => {
    setSearchSelectionState(selection);
  }, []);

  const selectThread = useCallback((id: string | null) => {
    setLibraryOpen(false);
    setSkillOpen(false);
    setSettingsOpen(false);
    setActiveThreadId(id);
  }, []);

  const queueLibraryFiles = useCallback((files: Array<FileUIPart & { byteSize?: number }>) => {
    setPendingLibraryFiles((current) => {
      const keys = new Set(current.map((file) => file.url));
      return [...current, ...files.filter((file) => !keys.has(file.url))];
    });
  }, []);

  const clearPendingLibraryFiles = useCallback(() => setPendingLibraryFiles([]), []);

  const activatePanelTab = useCallback((tab: ActivePanelTab) => {    setActivePanelTab(tab);
    setWorkspacePanelOpen(true);
  }, []);

  const addPanelTab = useCallback((kind: "files" | "terminal") => {
    const id = nanoid();
    const counts = panelTabCountsRef.current;
    counts[kind] += 1;
    const label = kind === "files" ? "文件" : "终端";
    setPanelTabs((current) => [
      ...current,
      { id, kind, title: counts[kind] > 1 ? `${label} ${counts[kind]}` : label },
    ]);
    setActivePanelTab({ kind, id });
    setWorkspacePanelOpen(true);
    return id;
  }, []);

  /**
   * 关闭一个本地标签。若关掉的正是激活项,就近激活它的邻居;一个本地标签都不剩时
   * 交给面板自己回落到浏览器页面(或空态)。
   */
  const closePanelTab = useCallback((id: string) => {
    setPanelTabs((current) => {
      const index = current.findIndex((tab) => tab.id === id);
      if (index < 0) return current;
      const next = current.filter((tab) => tab.id !== id);
      setActivePanelTab((active) => {
        if (active.kind === "browser" || active.id !== id) return active;
        const neighbor = next[Math.max(0, index - 1)];
        return neighbor ? { kind: neighbor.kind, id: neighbor.id } : { kind: "browser", index: 0 };
      });
      return next;
    });
  }, []);

  /** 打开面板并聚焦某类模块的第一个标签。browser 聚焦当前活动页(下标由面板同步)。 */
  const openWorkspacePanel = useCallback((kind: PanelTabKind = "files") => {
    setWorkspacePanelOpen(true);
    if (kind === "browser") {
      setActivePanelTab((active) =>
        active.kind === "browser" ? active : { kind: "browser", index: 0 },
      );
      return;
    }
    setPanelTabs((current) => {
      const existing = current.find((tab) => tab.kind === kind);
      if (existing) {
        setActivePanelTab({ kind, id: existing.id });
        return current;
      }
      // 该类型还没有标签(比如文件树被关掉过)→ 现开一个
      const id = nanoid();
      const counts = panelTabCountsRef.current;
      counts[kind] += 1;
      const label = kind === "files" ? "文件" : "终端";
      setActivePanelTab({ kind, id });
      return [...current, { id, kind, title: counts[kind] > 1 ? `${label} ${counts[kind]}` : label }];
    });
  }, []);

  const requestTerminalCommand = useCallback((request: Omit<TerminalRequest, "id">) => {
    setTerminalPanelOpen(true);
    setTerminalRequest({ ...request, id: ++terminalRequestIdRef.current });
  }, []);

  const openBrowserUrl = useCallback(
    (url: string) => {
      const normalized = url.trim();
      if (!normalized) return;
      try {
        const parsed = new URL(normalized);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return;
      } catch {
        return;
      }
      setLibraryOpen(false);
      setSkillOpen(false);
      // 新页会追加到 state.tabs 末尾,面板的活动页下标由服务端状态同步过来
      setActivePanelTab((active) =>
        active.kind === "browser" ? active : { kind: "browser", index: 0 },
      );
      setWorkspacePanelOpen(true);
      setBrowserRequest({
        id: ++browserRequestIdRef.current,
        newTab: true,
        threadId: activeThreadId,
        url: normalized,
      });
    },
    [activeThreadId],
  );

  // 三个检索引擎的 Key 配置存服务端(app_config),菜单据此判断引擎是否可用
  const refreshToolsConfig = useCallback(async () => {
    try {
      const response = await fetch(`${MASTRA_SERVER_URL}/work/tools`);
      if (!response.ok) throw new Error(String(response.status));
      setToolsConfig((await response.json()) as ToolsConfig);
    } catch {
      setToolsConfig(null);
    }
  }, []);

  useEffect(() => {
    void refreshToolsConfig();
  }, [refreshToolsConfig]);

  // ---- 线程 API(全部以 resourceId = user.id 隔离) ----

  const refreshThreads = useCallback(async () => {
    setThreadsLoading(true);
    try {
      const response = await fetch(
        `${MASTRA_SERVER_URL}/work/threads?resourceId=${encodeURIComponent(user.id)}`,
      );
      if (!response.ok) throw new Error(String(response.status));
      const { threads: list } = (await response.json()) as { threads: WorkThread[] };
      setThreads(list);
      const shouldResolveActiveThread = !activeThreadResolvedRef.current;
      activeThreadResolvedRef.current = true;
      setActiveThreadId((current) => {
        if (current && list.some((thread) => thread.id === current)) {
          return current;
        }
        if (!shouldResolveActiveThread) {
          return current;
        }
        return (
          [...list].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0]?.id ??
          null
        );
      });
    } catch {
      setThreads([]);
    } finally {
      setThreadsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshThreads();
  }, [refreshThreads]);

  const createThread = useCallback(
    (title = "New Chat") => {
      if (createThreadRequestRef.current) {
        return createThreadRequestRef.current;
      }

      const request = (async () => {
        try {
          // 新会话线程唯一由服务端判定:draft 且"无任何历史消息"才复用,
          // 前端不做本地判断(无法得知线程是否有消息)。
          const response = await fetch(`${MASTRA_SERVER_URL}/work/threads`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              resourceId: user.id,
              threadId: nanoid(),
              title,
              metadata: {
                draft: title === "New Chat",
                // 新线程继承当前会话的模式与审批规则(官方:Session 默认 → thread settings)
                modeId,
                permissionRules,
                ...(modelSelection ? { modelSelectionByMode: { [modeId]: modelSelection } } : {}),
              },
            }),
          });
          if (!response.ok) return null;
          const { thread } = (await response.json()) as { thread: WorkThread };
          await refreshThreads();
          selectThread(thread.id);
          return thread;
        } catch {
          return null;
        }
      })();

      createThreadRequestRef.current = request;
      void request.then(
        () => {
          if (createThreadRequestRef.current === request) {
            createThreadRequestRef.current = null;
          }
        },
        () => {
          if (createThreadRequestRef.current === request) {
            createThreadRequestRef.current = null;
          }
        },
      );
      return request;
    },
    [refreshThreads, selectThread, modeId, modelSelection, permissionRules],
  );

  const patchThread = useCallback(
    async (threadId: string, body: { title?: string; metadata?: ThreadMetadata }) => {
      await fetch(`${MASTRA_SERVER_URL}/work/threads/${threadId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resourceId: user.id, ...body }),
      });
      await refreshThreads();
    },
    [refreshThreads],
  );

  const renameThread = useCallback(
    (threadId: string, title: string) =>
      patchThread(threadId, {
        title,
        ...(title !== "New Chat" ? { metadata: { draft: false } } : {}),
      }),
    [patchThread],
  );
  const pinThread = useCallback(
    (threadId: string, pinned: boolean) => patchThread(threadId, { metadata: { pinned } }),
    [patchThread],
  );
  const archiveThread = useCallback(
    (threadId: string, archived: boolean) =>
      patchThread(threadId, {
        metadata: { archivedAt: archived ? new Date().toISOString() : null },
      }),
    [patchThread],
  );

  const deleteThread = useCallback(
    async (threadId: string) => {
      await fetch(
        `${MASTRA_SERVER_URL}/work/threads/${threadId}?resourceId=${encodeURIComponent(user.id)}`,
        { method: "DELETE" },
      );
      if (activeThreadId === threadId) selectThread(null);
      await refreshThreads();
    },
    [activeThreadId, refreshThreads, selectThread],
  );

  /**
   * 切换会话模式。会话状态立即生效(供 UI 与新线程默认值),同时落到当前线程元数据 ——
   * chat 路由每次请求都从 thread.metadata 读模式,所以持久化必须先于下一条消息;
   * 返回 Promise 让调用方能在需要时等它落库。
   */
  const setModeId = useCallback(
    async (next: WorkModeId) => {
      setModeIdState(next);
      if (activeThreadId) {
        const thread = threads.find((item) => item.id === activeThreadId);
        const snapshot = thread?.metadata.modelSelectionByMode?.[next];
        if (snapshot && providers.some((provider) => provider.id === snapshot.providerId)) {
          setModelSelectionState({
            providerId: snapshot.providerId,
            modelId: snapshot.modelId,
            modelName: snapshot.modelName,
            reasoningEffort: snapshot.reasoningEffort as ReasoningEffort | "off",
          });
        }
        await fetch(
          `${MASTRA_SERVER_URL}/work/sessions/workbench/threads/${activeThreadId}/mode?resourceId=${encodeURIComponent(user.id)}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ modeId: next }),
          },
        );
      }
    },
    [activeThreadId, providers, threads],
  );

  /** 覆盖工具审批规则(审批模式菜单与审批面板的「始终允许此类」共用) */
  const setPermissionRules = useCallback(
    async (rules: PermissionRules) => {
      setPermissionRulesState(rules);
      if (activeThreadId) {
        await fetch(
          `${MASTRA_SERVER_URL}/work/sessions/workbench/threads/${activeThreadId}/permissions?resourceId=${encodeURIComponent(user.id)}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(rules),
          },
        );
        await refreshThreads();
      }
    },
    [activeThreadId, refreshThreads],
  );

  /**
   * 强制重新采纳当前线程的会话设置。
   *
   * 用于服务端**单方面**改了线程设置的场合 —— 目前是 submit_plan 获批后
   * chat 路由按 transitionsTo 切模式。此时不能靠上面的「每线程只采纳一次」守卫,
   * 否则选择器会一直停在旧模式;清掉守卫再刷新线程即可让采纳重跑一次。
   */
  const refreshThreadSettings = useCallback(async () => {
    adoptedThreadRef.current = null;
    await refreshThreads();
  }, [refreshThreads]);

  /**
   * 切入线程时采纳该线程自己的模式 / 审批规则 / 模型形态(官方:thread settings
   * 覆盖 Session 当前选择)。每条线程只采纳一次 —— 否则用户改完设置后的任何一次
   * refreshThreads 都会把状态回滚成尚未落库的旧值。
   * 线程没有记录的字段保持当前会话选择不变。
   */
  useEffect(() => {
    if (!activeThreadId) {
      adoptedThreadRef.current = null;
      return;
    }
    if (adoptedThreadRef.current === activeThreadId || !providersLoaded) return;
    const thread = threads.find((item) => item.id === activeThreadId);
    if (!thread) return;
    adoptedThreadRef.current = activeThreadId;
    const metadata = thread.metadata;
    if (metadata.modeId !== undefined) setModeIdState(parseModeId(metadata.modeId));
    if (metadata.permissionRules !== undefined) {
      setPermissionRulesState(parsePermissionRules(metadata.permissionRules));
    }
    const snapshot = metadata.modelSelectionByMode?.[parseModeId(metadata.modeId)];
    // 供应商可能已被删掉:形态还在但模型不可用时保持当前选择,避免选择器变空
    if (snapshot && providers.some((provider) => provider.id === snapshot.providerId)) {
      setModelSelectionState({
        providerId: snapshot.providerId,
        modelId: snapshot.modelId,
        modelName: snapshot.modelName,
        reasoningEffort: snapshot.reasoningEffort as ReasoningEffort | "off",
      });
    }
  }, [activeThreadId, threads, providers, providersLoaded]);

  // 官方 Memory.cloneThread(POST /work/threads/:id/clone)
  // messageLimit:仅克隆最近 N 条(options.messageLimit),用于「从此消息克隆」
  const cloneThread = useCallback(
    async (
      threadId: string,
      selection?: number | { messageLimit?: number; messageIds?: string[] },
    ) => {
      const options = typeof selection === "number" ? { messageLimit: selection } : selection;
      try {
        const response = await fetch(`${MASTRA_SERVER_URL}/work/threads/${threadId}/clone`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            resourceId: user.id,
            ...(options?.messageLimit !== undefined ? { messageLimit: options.messageLimit } : {}),
            ...(options?.messageIds ? { messageIds: options.messageIds } : {}),
          }),
        });
        if (!response.ok) return null;
        const { thread } = (await response.json()) as { thread: WorkThread };
        await refreshThreads();
        selectThread(thread.id);
        return thread;
      } catch {
        return null;
      }
    },
    [refreshThreads, selectThread],
  );

  // 官方 Memory.recall 跨线程检索(GET /work/memory/search)
  const searchMessages = useCallback(async (query: string) => {
    const response = await fetch(
      `${MASTRA_SERVER_URL}/work/memory/search?q=${encodeURIComponent(query)}&resourceId=${encodeURIComponent(user.id)}`,
    );
    if (!response.ok) throw new Error(String(response.status));
    const { hits } = (await response.json()) as { hits: MessageSearchHit[] };
    return hits;
  }, []);

  // ---- 工作区目录(每线程绑定,见 ThreadMetadata.workspacePath) ----

  // 近期显式绑定目录:promptInput 选择器下拉的数据源
  const refreshRecentWorkspaces = useCallback(async () => {
    try {
      const response = await fetch(`${MASTRA_SERVER_URL}/work/workspace/recent`);
      if (!response.ok) return;
      const { recent } = (await response.json()) as { recent: RecentWorkspace[] };
      setRecentWorkspaces(recent);
    } catch {
      // 静默失败:选择器仍可手动选目录
    }
  }, []);

  useEffect(() => {
    void refreshRecentWorkspaces();
  }, [refreshRecentWorkspaces]);

  // 线程工作区文件树(单层按需拉取;仅显式绑定线程有权限)
  const fetchTreeEntries = useCallback(async (threadId: string, path?: string) => {
    const query = `?resourceId=${encodeURIComponent(user.id)}${path ? `&path=${encodeURIComponent(path)}` : ""}`;
    const response = await fetch(`${MASTRA_SERVER_URL}/work/threads/${threadId}/tree${query}`);
    if (!response.ok) return [];
    const { entries } = (await response.json()) as { entries: TreeEntry[] };
    return entries;
  }, []);

  const value = useMemo<WorkbenchValue>(
    () => ({
      user,
      threads,
      threadsLoading,
      refreshThreads,
      createThread,
      renameThread,
      deleteThread,
      pinThread,
      archiveThread,
      cloneThread,
      searchMessages,
      recentWorkspaces,
      refreshRecentWorkspaces,
      fetchTreeEntries,
      activeThreadId,
      setActiveThreadId: selectThread,
      pendingJump,
      setPendingJump,
      providers,
      setProviders,
      catalog,
      catalogStatus,
      modelSelection,
      setModelSelection,
      modeId,
      setModeId,
      permissionRules,
      setPermissionRules,
      refreshThreadSettings,
      searchSelection,
      setSearchSelection,
      toolsConfig,
      refreshToolsConfig,
      settingsOpen,
      setSettingsOpen,
      agentBusy,
      setAgentBusy,
      libraryOpen,
      setLibraryOpen,
      skillOpen,
      setSkillOpen,
      pendingLibraryFiles,
      queueLibraryFiles,
      clearPendingLibraryFiles,
      workspacePanelOpen,
      setWorkspacePanelOpen,
      panelTabs,
      activePanelTab,
      activatePanelTab,
      addPanelTab,
      closePanelTab,
      openWorkspacePanel,
      terminalPanelOpen,
      setTerminalPanelOpen,
      terminalRequest,
      requestTerminalCommand,
      browserRequest,
      openBrowserUrl,
    }),
    [
      threads,
      threadsLoading,
      refreshThreads,
      createThread,
      renameThread,
      deleteThread,
      pinThread,
      archiveThread,
      cloneThread,
      searchMessages,
      recentWorkspaces,
      refreshRecentWorkspaces,
      fetchTreeEntries,
      activeThreadId,
      selectThread,
      pendingJump,
      providers,
      setProviders,
      catalog,
      catalogStatus,
      modelSelection,
      setModelSelection,
      modeId,
      setModeId,
      permissionRules,
      setPermissionRules,
      refreshThreadSettings,
      searchSelection,
      setSearchSelection,
      toolsConfig,
      refreshToolsConfig,
      settingsOpen,
      agentBusy,
      libraryOpen,
      skillOpen,
      pendingLibraryFiles,
      queueLibraryFiles,
      clearPendingLibraryFiles,
      workspacePanelOpen,
      panelTabs,
      activePanelTab,
      activatePanelTab,
      addPanelTab,
      closePanelTab,
      openWorkspacePanel,
      terminalPanelOpen,
      terminalRequest,
      requestTerminalCommand,
      browserRequest,
      openBrowserUrl,
    ],
  );

  return <WorkbenchContext.Provider value={value}>{children}</WorkbenchContext.Provider>;
}

export function useWorkbench(): WorkbenchValue {
  const context = useContext(WorkbenchContext);
  if (!context) {
    throw new Error("useWorkbench must be used within WorkbenchProvider");
  }
  return context;
}
