/**
 * 工作台全局状态(React Context):线程 / 用户 / 模型选择 / 检索引擎 /
 * 终端与浏览器请求队列 / 面板可见性。与服务端的契约见各路由文件
 * (src/mastra/routes/)。联网检索常量与 src/mastra/tools/web-search.ts 一一对应。
 */
import type { FileUIPart } from "ai";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import type { SkillMetadata } from "@/entities/skill";

import type { CatalogProvider, ProviderConfig } from "./providers";
import {
  DEFAULT_MODE_ID,
  DEFAULT_PERMISSION_RULES,
  type PermissionRules,
  type WorkModeId,
} from "./session";
import type { TerminalSessionInfo } from "./terminal";
import { useThreadState } from "./thread-state";
import type { MainView } from "./types";
import {
  type ActivePanelTab,
  type AgentProfile,
  type BrowserRequest,
  DEFAULT_AGENT_PROFILE,
  type LocalPanelTab,
  type MessageSearchHit,
  type ModelSelection,
  type PanelTabKind,
  type PendingJump,
  type RecentWorkspace,
  type SearchSelection,
  type TerminalRequest,
  type ToolsConfig,
  type TreeEntry,
  type WorkspaceChangeSnapshot,
  type WorkspaceFileChange,
  type WorkThread,
  type WorkUser,
} from "./types";
import { useNavigationState } from "./use-navigation-state";
import { useWorkbenchConfig } from "./use-workbench-config";
import { useWorkbenchPanels } from "./use-workbench-panels";
import { useWorkbenchWorkspace } from "./use-workbench-workspace";

/**
 * 多用户体系工作台状态:
 * - user(resourceId):一切数据的隔离边界 —— 线程、供应商配置、工作区均按用户隔离
 * - thread:与 Agent 的会话线程(Mastra Memory thread),每条线程绑定一个工作区目录
 *   (Harness session 概念):显式绑定(用户选定目录,sidebar 展示文件树并按目录分组)
 *   或隐式绑定(<threadsRoot>/<threadId>/,仅 Agent 工作目录)
 */

/**
 * 模式与审批规则的**新线程默认值**。真相在 thread.metadata(服务端),
 * 这两个 key 只承担「下一条新线程用什么」——与服务端线程 metadata
 * 「Session 持有当前模式、thread settings 持久化」的分工一致。
 */
interface WorkbenchValue {
  // 用户(单机应用,恒为本地常量)
  user: WorkUser;
  // 线程(每线程绑定工作区目录,见 ThreadMetadata.workspacePath)
  threads: WorkThread[];
  threadsLoading: boolean;
  refreshThreads: () => Promise<void>;
  createThread: (title?: string) => Promise<WorkThread | null>;
  renameThread: (threadId: string, title: string) => Promise<void>;
  generateThreadTitle: (threadId: string) => Promise<string | null>;
  deleteThread: (threadId: string) => Promise<void>;
  pinThread: (threadId: string, pinned: boolean) => Promise<void>;
  archiveThread: (threadId: string, archived: boolean) => Promise<void>;
  searchMessages: (query: string) => Promise<MessageSearchHit[]>;
  // 近期显式绑定的工作区目录(promptInput 选择器数据源)
  recentWorkspaces: RecentWorkspace[];
  refreshRecentWorkspaces: () => Promise<void>;
  // 线程工作区文件树(显式和隐式绑定线程均可访问;单层按需拉取)
  fetchTreeEntries: (threadId: string, path?: string) => Promise<TreeEntry[]>;
  fetchThreadChanges: (threadId: string) => Promise<WorkspaceFileChange[]>;
  fetchThreadChangeContent: (
    threadId: string,
    changeId: string,
    side: "before" | "after",
  ) => Promise<{ content: string; binary: boolean; metadata: WorkspaceChangeSnapshot } | null>;
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
  agents: AgentProfile[];
  agentSelection: AgentProfile;
  setAgentSelection: (profile: AgentProfile) => Promise<void>;
  refreshAgents: () => Promise<void>;
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
  settingsSection: string;
  setSettingsSection: (section: string) => void;
  openSettings: (section?: string) => void;
  /** 记录各线程当前是否处于后台执行/流式中 */
  busyThreadIds: Record<string, boolean>;
  setThreadBusy: (threadId: string, busy: boolean) => void;
  isThreadBusy: (threadId: string) => boolean;
  /** Agent 是否有任务进行中(流式生成/等待响应);chat panel 同步,设置页消费 */
  agentBusy: boolean;
  setAgentBusy: (busy: boolean) => void;
  activeView: MainView;
  setActiveView: (view: MainView) => void;
  activeSkill: SkillMetadata | null;
  setActiveSkill: (skill: SkillMetadata | null) => void;
  /** 技能示例写入新会话输入框的一次性文本。 */
  pendingPrompt: string | null;
  setPendingPrompt: (prompt: string | null) => void;
  pendingLibraryFiles: Array<FileUIPart & { byteSize?: number }>;
  queueLibraryFiles: (files: Array<FileUIPart & { byteSize?: number }>) => void;
  clearPendingLibraryFiles: () => void;
  // 线程级工作面板(Minke right/bottom tabs 对应的应用状态)
  workspacePanelOpen: boolean;
  setWorkspacePanelOpen: (open: boolean) => void;
  /** 右侧面板里前端拥有的标签实例(文件树 / 终端 / 代码更改);浏览器页面由面板自己派生渲染 */
  panelTabs: LocalPanelTab[];
  activePanelTab: ActivePanelTab;
  activatePanelTab: (tab: ActivePanelTab) => void;
  /** 新建一个本地标签并激活它,返回新标签 id */
  addPanelTab: (kind: "files" | "terminal" | "changes") => string;
  closePanelTab: (id: string) => void;
  /** 打开面板并聚焦该类型的第一个标签(browser 聚焦当前活动页) */
  openWorkspacePanel: (kind?: PanelTabKind) => void;
  terminalPanelOpen: boolean;
  setTerminalPanelOpen: (open: boolean) => void;
  /**
   * 输入区底部工具栏在「中间那段弹性空白刚好被消费完」时的宽度 —— 也就是 PromptInput
   * 真正的最小边界,由 ChatPromptInput 实测上报(左组宽 + 右组宽 + 左右内距)。
   *
   * 布局里唯一有资格决定这个数的就是内容本身,所以它不该被写成常量:控件增删、
   * 标签改名、换语言、切到更长的模型名,值都会跟着变。AppShell 拿它去限制右侧面板
   * 能拖多宽、以及 Electron 窗口能缩多窄。0 表示尚未测到,此时不施加约束。
   */
  promptMinWidth: number;
  reportPromptMinWidth: (width: number) => void;
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

const WorkbenchContext = createContext<WorkbenchValue | null>(null);

export function WorkbenchProvider({ children, user }: { children: ReactNode; user?: WorkUser }) {
  const currentUser: WorkUser = user ?? {
    id: "anonymous",
    name: "Guest",
    email: "guest@example.com",
  };
  const userObj = currentUser;
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState("themes");
  const closeSettings = useCallback(() => setSettingsOpen(false), []);
  const openSettings = useCallback((section?: string) => {
    if (section) setSettingsSection(section);
    setSettingsOpen(true);
  }, []);
  const [busyThreadIds, setBusyThreadIds] = useState<Record<string, boolean>>({});

  const setThreadBusy = useCallback((threadId: string, busy: boolean) => {
    if (!threadId) return;
    setBusyThreadIds((prev) => {
      if (Boolean(prev[threadId]) === busy) return prev;
      const next = { ...prev };
      if (busy) {
        next[threadId] = true;
      } else {
        delete next[threadId];
      }
      return next;
    });
  }, []);

  const [activeAgentBusy, setActiveAgentBusy] = useState(false);
  const agentBusy = useMemo(
    () => Object.keys(busyThreadIds).length > 0 || activeAgentBusy,
    [busyThreadIds, activeAgentBusy],
  );
  const setAgentBusy = useCallback((busy: boolean) => {
    setActiveAgentBusy(busy);
  }, []);
  const { activeView, setActiveView, activeSkill, setActiveSkill } = useNavigationState();
  const [pendingPrompt, setPendingPrompt] = useState<string | null>(null);
  const [pendingLibraryFiles, setPendingLibraryFiles] = useState<
    Array<FileUIPart & { byteSize?: number }>
  >([]);

  const threadDefaultsRef = useRef({
    agentSelection: DEFAULT_AGENT_PROFILE,
    modeId: DEFAULT_MODE_ID,
    permissionRules: DEFAULT_PERMISSION_RULES,
    modelSelection: null as ModelSelection | null,
  });
  const getThreadDefaults = useCallback(() => threadDefaultsRef.current, []);

  const threadState = useThreadState({
    resourceId: userObj.id,
    getThreadDefaults,
    setActiveView,
    closeSettings,
  });
  const {
    threads,
    threadsLoading,
    refreshThreads,
    createThread,
    renameThread,
    generateThreadTitle,
    deleteThread,
    pinThread,
    archiveThread,
    searchMessages,
    activeThreadId,
    selectThread,
    pendingJump,
    setPendingJump,
  } = threadState;

  const config = useWorkbenchConfig({
    user: userObj,
    activeThreadId,
    threads,
    refreshThreads,
    updateThreadLocal: threadState.updateThreadLocal,
    setActiveView,
  });
  threadDefaultsRef.current = {
    agentSelection: config.agentSelection,
    modeId: config.modeId,
    permissionRules: config.permissionRules,
    modelSelection: config.modelSelection,
  };
  const {
    providers,
    setProviders,
    catalog,
    catalogStatus,
    modelSelection,
    setModelSelection,
    agents,
    agentSelection,
    setAgentSelection,
    refreshAgents,
    modeId,
    setModeId,
    permissionRules,
    setPermissionRules,
    refreshThreadSettings,
    searchSelection,
    setSearchSelection,
    toolsConfig,
    refreshToolsConfig,
  } = config;

  const isThreadBusy = useCallback(
    (threadId: string) => {
      if (busyThreadIds[threadId]) return true;
      const thread = threads.find((item) => item.id === threadId);
      return Boolean(thread?.metadata?.isWorking || thread?.metadata?.activeRunId);
    },
    [busyThreadIds, threads],
  );

  const panels = useWorkbenchPanels({
    resourceId: userObj.id,
    activeThreadId,
    activeView,
    setActiveView,
  });
  const {
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
    promptMinWidth,
    reportPromptMinWidth,
    reportTerminalSession,
    terminalRequest,
    requestTerminalCommand,
    browserRequest,
    openBrowserUrl,
  } = panels;
  const {
    recentWorkspaces,
    refreshRecentWorkspaces,
    fetchTreeEntries,
    fetchThreadChanges,
    fetchThreadChangeContent,
  } = useWorkbenchWorkspace(userObj.id);

  const queueLibraryFiles = useCallback((files: Array<FileUIPart & { byteSize?: number }>) => {
    setPendingLibraryFiles((current) => {
      const keys = new Set(current.map((file) => file.url));
      return [...current, ...files.filter((file) => !keys.has(file.url))];
    });
  }, []);

  const clearPendingLibraryFiles = useCallback(() => setPendingLibraryFiles([]), []);

  const value = useMemo<WorkbenchValue>(
    () => ({
      user: currentUser,
      threads,
      threadsLoading,
      refreshThreads,
      createThread,
      renameThread,
      generateThreadTitle,
      deleteThread,
      pinThread,
      archiveThread,
      searchMessages,
      recentWorkspaces,
      refreshRecentWorkspaces,
      fetchTreeEntries,
      fetchThreadChanges,
      fetchThreadChangeContent,
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
      agents,
      agentSelection,
      setAgentSelection,
      refreshAgents,
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
      settingsSection,
      setSettingsSection,
      openSettings,
      busyThreadIds,
      setThreadBusy,
      isThreadBusy,
      agentBusy,
      setAgentBusy,
      activeView,
      setActiveView,
      activeSkill,
      setActiveSkill,
      pendingPrompt,
      setPendingPrompt,
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
      promptMinWidth,
      reportPromptMinWidth,
      reportTerminalSession,
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
      generateThreadTitle,
      deleteThread,
      pinThread,
      archiveThread,
      searchMessages,
      recentWorkspaces,
      refreshRecentWorkspaces,
      fetchTreeEntries,
      fetchThreadChanges,
      fetchThreadChangeContent,
      activeThreadId,
      selectThread,
      pendingJump,
      providers,
      setProviders,
      catalog,
      catalogStatus,
      modelSelection,
      setModelSelection,
      agents,
      agentSelection,
      setAgentSelection,
      refreshAgents,
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
      settingsSection,
      openSettings,
      busyThreadIds,
      setThreadBusy,
      isThreadBusy,
      agentBusy,
      setAgentBusy,
      activeView,
      pendingPrompt,
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
      promptMinWidth,
      reportPromptMinWidth,
      reportTerminalSession,
      terminalRequest,
      requestTerminalCommand,
      browserRequest,
      openBrowserUrl,
      activeSkill,
      user,
      setAgentBusy,
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
