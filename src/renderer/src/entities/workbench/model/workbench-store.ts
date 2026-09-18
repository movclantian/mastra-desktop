/**
 * 工作台客户端 UI 状态(zustand 单 store,按域分组)。
 * 分工:服务端数据(threads/配置/目录)归 TanStack Query;视图导航归 Router;
 * 这里只放纯客户端瞬态 —— 面板开合、排队输入、busy 标记、会话设置草稿。
 *
 * 不用 persist 中间件:现有 localStorage key 均带 userId 动态后缀,
 * persist 的 name 是创建期静态值;改为 hydrate(userId) 显式注入 +
 * 写 action 内同步写盘(与旧 hook 的 effect 写盘语义一致,零数据迁移)。
 * store 不持有 queryClient / router:涉及服务端写入或导航的动作
 * 由领域 hooks(use-session-settings / use-select-thread 等)组合完成。
 */

import { useNavigate } from "@tanstack/react-router";
import type { FileUIPart } from "ai";
import { nanoid } from "nanoid";
import { useCallback, useEffect } from "react";
import { create } from "zustand";
import { reportWorkbenchState } from "@/shared/api";
import { i18n } from "@/shared/i18n";
import { confirmWorkspaceDraftClose } from "@/shared/lib/workspace-drafts";
import {
  DEFAULT_MODE_ID,
  DEFAULT_PERMISSION_RULES,
  type PermissionRules,
  parseModeId,
  parsePermissionRules,
  type WorkModeId,
} from "./session";
import {
  ACTIVE_THREAD_KEY,
  MODE_KEY,
  PERMISSION_RULES_KEY,
  readJson,
  SEARCH_SELECTION_KEY,
  userStorageKey,
} from "./storage";
import { type TerminalSessionInfo, terminalNeedsCloseConfirmation } from "./terminal";
import {
  type ActivePanelTab,
  type AgentProfile,
  type BrowserRequest,
  DEFAULT_AGENT_PROFILE,
  type LocalPanelTab,
  type ModelSelection,
  type PendingJump,
  type SearchSelection,
  type TerminalRequest,
  type WorkspacePanelMode,
} from "./types";

function isSamePanelTab(left: ActivePanelTab, right: ActivePanelTab): boolean {
  if (left.kind === "welcome" || right.kind === "welcome") {
    return left.kind === right.kind;
  }
  if (left.kind === "browser" || right.kind === "browser") {
    return left.kind === "browser" && right.kind === "browser" && left.index === right.index;
  }
  return left.kind === right.kind && left.id === right.id;
}

function panelLabel(kind: "files" | "terminal" | "changes"): string {
  return kind === "files"
    ? i18n.t("workspace:files")
    : kind === "terminal"
      ? i18n.t("workspace:terminal")
      : i18n.t("workspace:codeChanges");
}

function confirmTerminalSessionClose(session: TerminalSessionInfo | undefined): boolean {
  return (
    !terminalNeedsCloseConfirmation(session?.status) ||
    window.confirm(i18n.t("workspace:terminalCloseConfirm"))
  );
}

export interface WorkbenchStore {
  // ---- user(登录后 hydrate)-----------------------------------------------
  userId: string | null;

  // ---- ui:瞬态 ------------------------------------------------------------
  /** URL ?thread= 的镜像:非 React 场景(openBrowserUrl 等)读取当前线程 */
  lastKnownThreadId: string | null;
  setLastKnownThreadId: (id: string | null) => void;
  pendingJump: PendingJump | null;
  setPendingJump: (jump: PendingJump | null) => void;
  pendingPrompt: string | null;
  setPendingPrompt: (prompt: string | null) => void;
  pendingLibraryFiles: Array<FileUIPart & { byteSize?: number }>;
  queueLibraryFiles: (files: Array<FileUIPart & { byteSize?: number }>) => void;
  clearPendingLibraryFiles: () => void;
  busyThreadIds: Record<string, boolean>;
  setThreadBusy: (threadId: string, busy: boolean) => void;
  agentBusyFlag: boolean;
  setAgentBusy: (busy: boolean) => void;

  // ---- panels:右侧/底部工作面板 -------------------------------------------
  workspacePanelOpen: boolean;
  setWorkspacePanelOpen: (open: boolean) => void;
  workspacePanelMode: WorkspacePanelMode;
  setWorkspacePanelMode: (mode: WorkspacePanelMode) => void;
  panelTabs: LocalPanelTab[];
  panelTabCounts: Record<"files" | "terminal" | "changes", number>;
  activePanelTab: ActivePanelTab;
  activatePanelTab: (tab: ActivePanelTab) => void;
  addPanelTab: (kind: "files" | "terminal" | "changes") => string;
  closePanelTab: (id: string) => boolean;
  reorderPanelTab: (id: string, overId: string) => void;
  openWorkspacePanel: (kind?: ActivePanelTab["kind"]) => void;
  terminalPanelOpen: boolean;
  setTerminalPanelOpen: (open: boolean) => void;
  terminalDrawerSessionIds: string[];
  activeTerminalDrawerSessionId: string;
  addTerminalDrawerSession: (id?: string) => string;
  closeTerminalDrawerSession: (id: string) => boolean;
  setActiveTerminalDrawerSessionId: (id: string) => void;
  reorderTerminalDrawerSession: (id: string, overId: string) => void;
  moveTerminalTab: (
    from: "workspace" | "terminal",
    to: "workspace" | "terminal",
    id: string,
    title?: string,
    overId?: string,
  ) => void;
  promptMinWidth: number;
  reportPromptMinWidth: (width: number) => void;
  /** 会话登记表(Map 本身不参与订阅,version 驱动上报 hook) */
  terminalSessions: Map<string, TerminalSessionInfo>;
  terminalSessionsVersion: number;
  reportTerminalSession: (id: string, info: TerminalSessionInfo | null) => void;
  terminalRequest: TerminalRequest | null;
  requestTerminalCommand: (request: Omit<TerminalRequest, "id">) => void;
  browserRequest: BrowserRequest | null;
  browserRequestId: number;
  terminalRequestId: number;
  /**
   * 打开线程浏览器并导航(面板态部分)。视图切回 /chat 与 threadId 由包装 hook
   * useOpenBrowserUrl 补齐(store 不碰 router)。
   */
  requestBrowserPanel: (url: string) => void;

  // ---- sessionDraft:当前会话设置 + 新线程默认值(localStorage 持久化)------
  modeId: WorkModeId;
  setModeIdDraft: (modeId: WorkModeId) => void;
  permissionRules: PermissionRules;
  setPermissionRulesDraft: (rules: PermissionRules) => void;
  agentSelection: AgentProfile;
  setAgentSelectionDraft: (profile: AgentProfile) => void;
  modelSelection: ModelSelection | null;
  setModelSelectionDraft: (selection: ModelSelection | null) => void;
  searchSelection: SearchSelection | null;
  setSearchSelectionDraft: (selection: SearchSelection | null) => void;
}

export const useWorkbenchStore = create<WorkbenchStore>((set, get) => ({
  userId: null,

  lastKnownThreadId: null,
  setLastKnownThreadId: (id) => set({ lastKnownThreadId: id }),
  pendingJump: null,
  setPendingJump: (jump) => set({ pendingJump: jump }),
  pendingPrompt: null,
  setPendingPrompt: (prompt) => set({ pendingPrompt: prompt }),
  pendingLibraryFiles: [],
  queueLibraryFiles: (files) =>
    set((state) => {
      const keys = new Set(state.pendingLibraryFiles.map((file) => file.url));
      return {
        pendingLibraryFiles: [
          ...state.pendingLibraryFiles,
          ...files.filter((file) => !keys.has(file.url)),
        ],
      };
    }),
  clearPendingLibraryFiles: () => set({ pendingLibraryFiles: [] }),
  busyThreadIds: {},
  setThreadBusy: (threadId, busy) => {
    if (!threadId) return;
    set((state) => {
      if (Boolean(state.busyThreadIds[threadId]) === busy) return state;
      const next = { ...state.busyThreadIds };
      if (busy) next[threadId] = true;
      else delete next[threadId];
      return { busyThreadIds: next };
    });
  },
  agentBusyFlag: false,
  setAgentBusy: (busy) => set({ agentBusyFlag: busy }),

  workspacePanelOpen: false,
  setWorkspacePanelOpen: (open) => set({ workspacePanelOpen: open }),
  workspacePanelMode: "docked",
  setWorkspacePanelMode: (mode) => {
    const userId = get().userId;
    if (userId) localStorage.setItem(`mastra-workspace-panel-mode:${userId}`, mode);
    set({ workspacePanelMode: mode });
  },
  panelTabs: [],
  panelTabCounts: { files: 0, terminal: 0, changes: 0 },
  activePanelTab: { kind: "welcome", id: "welcome" },
  activatePanelTab: (tab) =>
    set((state) => ({
      activePanelTab: isSamePanelTab(state.activePanelTab, tab) ? state.activePanelTab : tab,
      workspacePanelOpen: true,
    })),
  addPanelTab: (kind) => {
    const id = nanoid();
    set((state) => {
      const counts = { ...state.panelTabCounts, [kind]: state.panelTabCounts[kind] + 1 };
      const title = panelLabel(kind);
      return {
        panelTabCounts: counts,
        panelTabs: [
          ...state.panelTabs,
          { id, kind, title: counts[kind] > 1 ? `${title} ${counts[kind]}` : title },
        ],
        activePanelTab: { kind, id },
        workspacePanelOpen: true,
      };
    });
    return id;
  },
  closePanelTab: (id) => {
    const tab = get().panelTabs.find((item) => item.id === id);
    if (!tab) return false;
    if (tab.kind === "files" && !confirmWorkspaceDraftClose(get().lastKnownThreadId, tab.id)) {
      return false;
    }
    if (
      tab.kind === "terminal" &&
      !confirmTerminalSessionClose(get().terminalSessions.get(tab.id))
    ) {
      return false;
    }
    set((state) => {
      const index = state.panelTabs.findIndex((tab) => tab.id === id);
      if (index < 0) return state;
      const next = state.panelTabs.filter((tab) => tab.id !== id);
      const active = state.activePanelTab;
      const nextActive =
        active.kind === "browser" || active.id !== id
          ? active
          : (() => {
              const neighbor = next[Math.max(0, index - 1)];
              return neighbor
                ? { kind: neighbor.kind, id: neighbor.id }
                : { kind: "welcome" as const, id: "welcome" };
            })();
      return { panelTabs: next, activePanelTab: nextActive };
    });
    return true;
  },
  reorderPanelTab: (id, overId) =>
    set((state) => {
      if (id === overId) return state;
      const from = state.panelTabs.findIndex((tab) => tab.id === id);
      const to = state.panelTabs.findIndex((tab) => tab.id === overId);
      if (from < 0 || to < 0) return state;
      const next = [...state.panelTabs];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return { panelTabs: next };
    }),
  openWorkspacePanel: (kind) =>
    set((state) => {
      if (!kind || kind === "welcome") {
        return {
          workspacePanelOpen: true,
          activePanelTab:
            state.activePanelTab.kind === "welcome"
              ? state.activePanelTab
              : { kind: "welcome", id: "welcome" },
        };
      }
      if (kind === "browser") {
        return {
          workspacePanelOpen: true,
          activePanelTab:
            state.activePanelTab.kind === "browser"
              ? state.activePanelTab
              : { kind: "browser", index: 0 },
        };
      }
      const existing = state.panelTabs.find((tab) => tab.kind === kind);
      if (existing) {
        const next = { kind, id: existing.id } as ActivePanelTab;
        return {
          workspacePanelOpen: true,
          activePanelTab: isSamePanelTab(state.activePanelTab, next) ? state.activePanelTab : next,
        };
      }
      const counts = { ...state.panelTabCounts, [kind]: state.panelTabCounts[kind] + 1 };
      const title = panelLabel(kind);
      const id = nanoid();
      return {
        workspacePanelOpen: true,
        panelTabCounts: counts,
        panelTabs: [
          ...state.panelTabs,
          { id, kind, title: counts[kind] > 1 ? `${title} ${counts[kind]}` : title },
        ],
        activePanelTab: { kind, id },
      };
    }),
  terminalPanelOpen: false,
  setTerminalPanelOpen: (open) => set({ terminalPanelOpen: open }),
  terminalDrawerSessionIds: ["term-1"],
  activeTerminalDrawerSessionId: "term-1",
  addTerminalDrawerSession: (id) => {
    const nextId = id ?? nanoid(6);
    set((state) => ({
      terminalDrawerSessionIds: state.terminalDrawerSessionIds.includes(nextId)
        ? state.terminalDrawerSessionIds
        : [...state.terminalDrawerSessionIds, nextId],
      activeTerminalDrawerSessionId: nextId,
      terminalPanelOpen: true,
    }));
    return nextId;
  },
  closeTerminalDrawerSession: (id) => {
    if (!get().terminalDrawerSessionIds.includes(id)) return false;
    if (!confirmTerminalSessionClose(get().terminalSessions.get(id))) {
      return false;
    }
    set((state) => {
      if (state.terminalDrawerSessionIds.length <= 1) {
        const nextId = nanoid(6);
        return {
          terminalDrawerSessionIds: [nextId],
          activeTerminalDrawerSessionId: nextId,
        };
      }
      const next = state.terminalDrawerSessionIds.filter((s) => s !== id);
      const nextActive =
        state.activeTerminalDrawerSessionId === id
          ? next[next.length - 1]
          : state.activeTerminalDrawerSessionId;
      return {
        terminalDrawerSessionIds: next,
        activeTerminalDrawerSessionId: nextActive,
      };
    });
    return true;
  },
  setActiveTerminalDrawerSessionId: (id) => set({ activeTerminalDrawerSessionId: id }),
  reorderTerminalDrawerSession: (id, overId) => {
    set((state) => {
      if (id === overId) return state;
      const from = state.terminalDrawerSessionIds.indexOf(id);
      const to = state.terminalDrawerSessionIds.indexOf(overId);
      if (from < 0 || to < 0) return state;
      const next = [...state.terminalDrawerSessionIds];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return { terminalDrawerSessionIds: next };
    });
  },
  moveTerminalTab: (from, to, id, title, overId) => {
    if (from === to) return;
    set((state) => {
      if (from === "workspace" && to === "terminal") {
        const tab = state.panelTabs.find((t) => t.id === id);
        if (tab?.kind !== "terminal") return state;
        const nextPanelTabs = state.panelTabs.filter((t) => t.id !== id);
        const nextActivePanelTab =
          state.activePanelTab.kind === "terminal" && state.activePanelTab.id === id
            ? nextPanelTabs.length > 0
              ? {
                  kind: nextPanelTabs[nextPanelTabs.length - 1].kind,
                  id: nextPanelTabs[nextPanelTabs.length - 1].id,
                }
              : { kind: "welcome" as const, id: "welcome" }
            : state.activePanelTab;

        const baseSessions = state.terminalDrawerSessionIds.filter((s) => s !== id);
        let nextTerminalIds: string[];
        if (overId && baseSessions.includes(overId)) {
          const targetIndex = baseSessions.indexOf(overId);
          nextTerminalIds = [...baseSessions];
          nextTerminalIds.splice(targetIndex, 0, id);
        } else {
          nextTerminalIds = [...baseSessions, id];
        }

        return {
          panelTabs: nextPanelTabs,
          activePanelTab: nextActivePanelTab,
          terminalDrawerSessionIds: nextTerminalIds,
          activeTerminalDrawerSessionId: id,
          terminalPanelOpen: true,
        };
      }
      if (from === "terminal" && to === "workspace") {
        if (!state.terminalDrawerSessionIds.includes(id)) return state;
        let nextTerminalIds = state.terminalDrawerSessionIds.filter((s) => s !== id);
        let nextActiveTerminal = state.activeTerminalDrawerSessionId;
        if (nextTerminalIds.length === 0) {
          const freshId = nanoid(6);
          nextTerminalIds = [freshId];
          nextActiveTerminal = freshId;
        } else if (state.activeTerminalDrawerSessionId === id) {
          nextActiveTerminal = nextTerminalIds[nextTerminalIds.length - 1];
        }
        const counts = { ...state.panelTabCounts, terminal: state.panelTabCounts.terminal + 1 };
        const tabTitle =
          title ||
          (counts.terminal > 1
            ? i18n.t("workspace:terminalIndex", { index: counts.terminal })
            : i18n.t("workspace:terminal"));
        const newTab = { id, kind: "terminal" as const, title: tabTitle };
        const baseTabs = state.panelTabs.filter((t) => t.id !== id);
        let nextPanelTabs: typeof state.panelTabs;
        if (overId && baseTabs.some((t) => t.id === overId)) {
          const targetIndex = baseTabs.findIndex((t) => t.id === overId);
          nextPanelTabs = [...baseTabs];
          nextPanelTabs.splice(targetIndex, 0, newTab);
        } else {
          nextPanelTabs = [...baseTabs, newTab];
        }

        return {
          terminalDrawerSessionIds: nextTerminalIds,
          activeTerminalDrawerSessionId: nextActiveTerminal,
          panelTabCounts: counts,
          panelTabs: nextPanelTabs,
          activePanelTab: { kind: "terminal", id },
          workspacePanelOpen: true,
        };
      }
      return state;
    });
  },
  promptMinWidth: 0,
  reportPromptMinWidth: (width) =>
    set((state) => {
      const rounded = Math.ceil(width);
      return state.promptMinWidth === rounded ? state : { promptMinWidth: rounded };
    }),
  terminalSessions: new Map(),
  terminalSessionsVersion: 0,
  reportTerminalSession: (id, info) =>
    set((state) => {
      const sessions = new Map(state.terminalSessions);
      if (info) sessions.set(id, info);
      else if (!sessions.delete(id)) return state;
      return {
        terminalSessions: sessions,
        terminalSessionsVersion: state.terminalSessionsVersion + 1,
      };
    }),
  terminalRequest: null,
  terminalRequestId: 0,
  requestTerminalCommand: (request) =>
    set((state) => ({
      terminalPanelOpen: true,
      terminalRequest: { ...request, id: state.terminalRequestId + 1 },
      terminalRequestId: state.terminalRequestId + 1,
    })),
  browserRequest: null,
  browserRequestId: 0,
  requestBrowserPanel: (url) => {
    const normalized = url.trim();
    if (!normalized) return;
    try {
      const parsed = new URL(normalized);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return;
    } catch {
      return;
    }
    set((state) => ({
      activePanelTab:
        state.activePanelTab.kind === "browser"
          ? state.activePanelTab
          : { kind: "browser", index: 0 },
      workspacePanelOpen: true,
      browserRequest: {
        id: state.browserRequestId + 1,
        newTab: true,
        threadId: state.lastKnownThreadId,
        url: normalized,
      },
      browserRequestId: state.browserRequestId + 1,
    }));
  },

  modeId: DEFAULT_MODE_ID,
  setModeIdDraft: (modeId) => {
    const userId = get().userId;
    if (userId) localStorage.setItem(userStorageKey(MODE_KEY, userId), JSON.stringify(modeId));
    set({ modeId });
  },
  permissionRules: DEFAULT_PERMISSION_RULES,
  setPermissionRulesDraft: (rules) => {
    const userId = get().userId;
    if (userId) {
      localStorage.setItem(userStorageKey(PERMISSION_RULES_KEY, userId), JSON.stringify(rules));
    }
    set({ permissionRules: rules });
  },
  agentSelection: DEFAULT_AGENT_PROFILE,
  setAgentSelectionDraft: (profile) => set({ agentSelection: profile }),
  modelSelection: null,
  setModelSelectionDraft: (selection) => set({ modelSelection: selection }),
  searchSelection: null,
  setSearchSelectionDraft: (selection) => {
    const userId = get().userId;
    if (userId) {
      localStorage.setItem(userStorageKey(SEARCH_SELECTION_KEY, userId), JSON.stringify(selection));
    }
    set({ searchSelection: selection });
  },
}));

/**
 * 登录后注入用户并从 localStorage 恢复持久化草稿(幂等:重复调用结果一致)。
 * lastKnownThreadId 以 URL(?thread=)优先,无 thread 时回落 localStorage。
 */
export function hydrateWorkbenchStore(userId: string): void {
  const store = useWorkbenchStore.getState();
  if (store.userId === userId) return;
  useWorkbenchStore.setState({
    userId,
    lastKnownThreadId:
      readThreadFromHash() ??
      readJson<string | null>(userStorageKey(ACTIVE_THREAD_KEY, userId), null),
    workspacePanelMode: (() => {
      const stored = localStorage.getItem(`mastra-workspace-panel-mode:${userId}`);
      return stored === "floating" || stored === "fullscreen" ? stored : "docked";
    })(),
    modeId: parseModeId(readJson<string>(userStorageKey(MODE_KEY, userId), DEFAULT_MODE_ID)),
    permissionRules: parsePermissionRules(
      readJson<unknown>(userStorageKey(PERMISSION_RULES_KEY, userId), DEFAULT_PERMISSION_RULES),
    ),
    searchSelection: readJson<SearchSelection | null>(
      userStorageKey(SEARCH_SELECTION_KEY, userId),
      null,
    ),
  });
}

/** 启动时从 hash URL 读 ?thread=(仅初始化用;运行期由 router 订阅驱动) */
function readThreadFromHash(): string | null {
  try {
    const hash = window.location.hash.replace(/^#/, "");
    const query = hash.split("?")[1] ?? "";
    const thread = new URLSearchParams(query).get("thread");
    return thread?.trim() ? thread : null;
  } catch {
    return null;
  }
}

/** 登出清理:回到初始 UI 态(会话草稿随下次登录重新 hydrate) */
export function resetWorkbenchStore(): void {
  useWorkbenchStore.setState({
    userId: null,
    lastKnownThreadId: null,
    pendingJump: null,
    pendingPrompt: null,
    pendingLibraryFiles: [],
    busyThreadIds: {},
    agentBusyFlag: false,
    workspacePanelOpen: false,
    workspacePanelMode: "docked",
    panelTabs: [],
    panelTabCounts: { files: 0, terminal: 0, changes: 0 },
    activePanelTab: { kind: "welcome", id: "welcome" },
    terminalPanelOpen: false,
    promptMinWidth: 0,
    terminalSessions: new Map(),
    terminalSessionsVersion: 0,
    terminalRequest: null,
    terminalRequestId: 0,
    browserRequest: null,
    browserRequestId: 0,
    modeId: DEFAULT_MODE_ID,
    permissionRules: DEFAULT_PERMISSION_RULES,
    agentSelection: DEFAULT_AGENT_PROFILE,
    modelSelection: null,
    searchSelection: null,
  });
}

/**
 * 打开线程浏览器并导航的包装 hook:store 只管面板态,视图切回 /chat 由
 * 这里的 navigate 补齐(store 不碰 router)。
 */
export function useOpenBrowserUrl() {
  const navigate = useNavigate();
  const requestBrowserPanel = useWorkbenchStore((state) => state.requestBrowserPanel);
  return useCallback(
    (url: string) => {
      void navigate({ to: "/chat" });
      requestBrowserPanel(url);
    },
    [navigate, requestBrowserPanel],
  );
}

/**
 * 工作台/终端状态上报(原 use-workbench-panels 的两个上报 effect):
 * 挂在 RootShell,依赖 URL 的当前线程与视图。activeThreadId/activeView
 * 由调用方传入(Router 来源),面板/终端态订阅本 store。
 */
export function useWorkbenchStateReporter(
  activeThreadId: string | null,
  activeView: "chat" | "agents" | "skills" | "library" | "schedules" | "settings",
): void {
  const userId = useWorkbenchStore((state) => state.userId);
  const workspacePanelOpen = useWorkbenchStore((state) => state.workspacePanelOpen);
  const activePanelTabKind = useWorkbenchStore((state) => state.activePanelTab.kind);
  const terminalPanelOpen = useWorkbenchStore((state) => state.terminalPanelOpen);
  const terminalSessionsVersion = useWorkbenchStore((state) => state.terminalSessionsVersion);

  useEffect(() => {
    if (!activeThreadId || !userId) return;
    void reportWorkbenchState(activeThreadId, userId, {
      workbench: {
        workspacePanelOpen,
        workspacePanelTab: activePanelTabKind,
        terminalPanelOpen,
        libraryOpen: activeView === "library",
      },
    });
  }, [
    activePanelTabKind,
    activeThreadId,
    activeView,
    terminalPanelOpen,
    userId,
    workspacePanelOpen,
  ]);

  useEffect(() => {
    if (!activeThreadId || !userId) return;
    void terminalSessionsVersion;
    const sessions = [...useWorkbenchStore.getState().terminalSessions.values()];
    if (sessions.length === 0) {
      void reportWorkbenchState(activeThreadId, userId, {
        terminal: { open: false, sessionCount: 0 },
      });
      return;
    }
    const settled = sessions
      .filter((session) => session.settledAt !== undefined)
      .sort((left, right) => (right.settledAt ?? 0) - (left.settledAt ?? 0))[0];
    const focused = sessions.find((session) => session.status === "ready") ?? sessions[0];
    void reportWorkbenchState(activeThreadId, userId, {
      terminal: {
        open: true,
        sessionCount: sessions.length,
        activeTitle: focused.title,
        activeStatus: focused.status,
        ...(settled?.lastCommand ? { lastCommand: settled.lastCommand } : {}),
        ...(settled?.lastExitCode === undefined ? {} : { lastExitCode: settled.lastExitCode }),
      },
    });
  }, [activeThreadId, terminalSessionsVersion, userId]);
}
