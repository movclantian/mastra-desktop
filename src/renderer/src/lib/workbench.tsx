import { nanoid } from "nanoid";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  type CatalogProvider,
  loadModelCatalog,
  MASTRA_SERVER_URL,
  type ProviderConfig,
  type ReasoningEffort,
} from "./providers";

/**
 * 多用户体系工作台状态:
 * - user(resourceId):一切数据的隔离边界 —— 线程、供应商配置、工作区均按用户隔离
 * - workspace:任务集合分组,线程可通过 metadata.workspaceId 归组,"无工作区"线程单独一组
 * - thread:与 Agent 的会话线程(Mastra Memory thread)
 */

export interface WorkUser {
  id: string;
  name: string;
  email: string;
}

export interface Workspace {
  id: string;
  name: string;
}

export interface ThreadMetadata {
  workspaceId?: string;
  pinned?: boolean;
  archivedAt?: string | null;
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

const USER_KEY = "mastra-work:user";
const WORKSPACES_KEY = "mastra-work:workspaces";
const PROVIDERS_KEY = "mastra-work:providers";
const MODEL_SELECTION_KEY = "mastra-work:model-selection";

function readJson<T>(key: string, fallback: T): T {
  const raw = localStorage.getItem(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

const DEFAULT_USER: WorkUser = {
  id: "user-local",
  name: "Local User",
  email: "local@mastra-work.app",
};

const DEFAULT_WORKSPACES: Workspace[] = [{ id: "ws-default", name: "默认工作区" }];

interface WorkbenchValue {
  // 用户
  user: WorkUser;
  updateUser: (user: WorkUser) => void;
  // 工作区
  workspaces: Workspace[];
  activeWorkspaceId: string | null; // null = 不选择工作区
  setActiveWorkspaceId: (id: string | null) => void;
  addWorkspace: (name: string) => void;
  renameWorkspace: (id: string, name: string) => void;
  deleteWorkspace: (id: string) => void;
  // 线程
  threads: WorkThread[];
  threadsLoading: boolean;
  refreshThreads: () => Promise<void>;
  createThread: (workspaceId: string | null, title?: string) => Promise<WorkThread | null>;
  renameThread: (threadId: string, title: string) => Promise<void>;
  deleteThread: (threadId: string) => Promise<void>;
  pinThread: (threadId: string, pinned: boolean) => Promise<void>;
  archiveThread: (threadId: string, archived: boolean) => Promise<void>;
  moveThread: (threadId: string, workspaceId: string | null) => Promise<void>;
  activeThreadId: string | null;
  setActiveThreadId: (id: string | null) => void;
  // 供应商(BYOK)
  providers: ProviderConfig[];
  setProviders: (providers: ProviderConfig[]) => void;
  // models.dev 目录
  catalog: CatalogProvider[];
  // 模型选择
  modelSelection: ModelSelection | null;
  setModelSelection: (selection: ModelSelection | null) => void;
  // 设置弹窗
  settingsOpen: boolean;
  setSettingsOpen: (open: boolean) => void;
}

const WorkbenchContext = createContext<WorkbenchValue | null>(null);

export function WorkbenchProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<WorkUser>(() => readJson(USER_KEY, DEFAULT_USER));
  const [workspaces, setWorkspaces] = useState<Workspace[]>(() =>
    readJson(WORKSPACES_KEY, DEFAULT_WORKSPACES),
  );
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(null);
  const [providers, setProvidersState] = useState<ProviderConfig[]>(() =>
    readJson<ProviderConfig[]>(PROVIDERS_KEY, []),
  );
  const [modelSelection, setModelSelectionState] = useState<ModelSelection | null>(() =>
    readJson<ModelSelection | null>(MODEL_SELECTION_KEY, null),
  );
  const [threads, setThreads] = useState<WorkThread[]>([]);
  const [threadsLoading, setThreadsLoading] = useState(true);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<CatalogProvider[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  }, [user]);
  useEffect(() => {
    localStorage.setItem(WORKSPACES_KEY, JSON.stringify(workspaces));
  }, [workspaces]);
  useEffect(() => {
    localStorage.setItem(PROVIDERS_KEY, JSON.stringify(providers));
  }, [providers]);
  useEffect(() => {
    localStorage.setItem(MODEL_SELECTION_KEY, JSON.stringify(modelSelection));
  }, [modelSelection]);

  // models.dev 目录:优先命中 1 小时缓存,未命中静默拉取
  useEffect(() => {
    loadModelCatalog()
      .then(setCatalog)
      .catch(() => setCatalog([]));
  }, []);

  const setProviders = useCallback((next: ProviderConfig[]) => {
    setProvidersState(next);
  }, []);

  const setModelSelection = useCallback((selection: ModelSelection | null) => {
    setModelSelectionState(selection);
  }, []);

  // ---- 线程 API(全部以 resourceId = user.id 隔离) ----

  const refreshThreads = useCallback(async () => {
    setThreadsLoading(true);
    try {
      const response = await fetch(
        `${MASTRA_SERVER_URL}/api/work/threads?resourceId=${encodeURIComponent(user.id)}`,
      );
      if (!response.ok) throw new Error(String(response.status));
      const { threads: list } = (await response.json()) as { threads: WorkThread[] };
      setThreads(list);
    } catch {
      setThreads([]);
    } finally {
      setThreadsLoading(false);
    }
  }, [user.id]);

  useEffect(() => {
    void refreshThreads();
  }, [refreshThreads]);

  const createThread = useCallback(
    async (workspaceId: string | null, title = "New Chat") => {
      try {
        const response = await fetch(`${MASTRA_SERVER_URL}/api/work/threads`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            resourceId: user.id,
            threadId: nanoid(),
            title,
            metadata: { workspaceId: workspaceId ?? undefined },
          }),
        });
        if (!response.ok) return null;
        const { thread } = (await response.json()) as { thread: WorkThread };
        await refreshThreads();
        setActiveThreadId(thread.id);
        return thread;
      } catch {
        return null;
      }
    },
    [user.id, refreshThreads],
  );

  const patchThread = useCallback(
    async (threadId: string, body: { title?: string; metadata?: ThreadMetadata }) => {
      await fetch(`${MASTRA_SERVER_URL}/api/work/threads/${threadId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resourceId: user.id, ...body }),
      });
      await refreshThreads();
    },
    [user.id, refreshThreads],
  );

  const renameThread = useCallback(
    (threadId: string, title: string) => patchThread(threadId, { title }),
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
  const moveThread = useCallback(
    (threadId: string, workspaceId: string | null) =>
      patchThread(threadId, { metadata: { workspaceId: workspaceId ?? undefined } }),
    [patchThread],
  );

  const deleteThread = useCallback(
    async (threadId: string) => {
      await fetch(`${MASTRA_SERVER_URL}/api/work/threads/${threadId}`, { method: "DELETE" });
      if (activeThreadId === threadId) setActiveThreadId(null);
      await refreshThreads();
    },
    [activeThreadId, refreshThreads],
  );

  // ---- 工作区 ----

  const addWorkspace = useCallback((name: string) => {
    setWorkspaces((prev) => [...prev, { id: `ws-${nanoid(6)}`, name }]);
  }, []);
  const renameWorkspace = useCallback((id: string, name: string) => {
    setWorkspaces((prev) => prev.map((w) => (w.id === id ? { ...w, name } : w)));
  }, []);
  const deleteWorkspace = useCallback((id: string) => {
    setWorkspaces((prev) => prev.filter((w) => w.id !== id));
  }, []);

  const value = useMemo<WorkbenchValue>(
    () => ({
      user,
      updateUser: setUser,
      workspaces,
      activeWorkspaceId,
      setActiveWorkspaceId,
      addWorkspace,
      renameWorkspace,
      deleteWorkspace,
      threads,
      threadsLoading,
      refreshThreads,
      createThread,
      renameThread,
      deleteThread,
      pinThread,
      archiveThread,
      moveThread,
      activeThreadId,
      setActiveThreadId,
      providers,
      setProviders,
      catalog,
      modelSelection,
      setModelSelection,
      settingsOpen,
      setSettingsOpen,
    }),
    [
      user,
      workspaces,
      activeWorkspaceId,
      addWorkspace,
      renameWorkspace,
      deleteWorkspace,
      threads,
      threadsLoading,
      refreshThreads,
      createThread,
      renameThread,
      deleteThread,
      pinThread,
      archiveThread,
      moveThread,
      activeThreadId,
      providers,
      setProviders,
      catalog,
      modelSelection,
      setModelSelection,
      settingsOpen,
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
