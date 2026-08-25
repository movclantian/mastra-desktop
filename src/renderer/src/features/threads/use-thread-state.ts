import { nanoid } from "nanoid";
import { useCallback, useEffect, useRef, useState } from "react";
import type { PermissionRules, WorkModeId } from "@/features/session";
import type { MainView } from "@/features/workbench/navigation";
import { ACTIVE_THREAD_KEY, readJson, userStorageKey } from "@/features/workbench/storage";
import {
  createThreadRequest,
  deleteThreadRequest,
  fetchThreads,
  generateThreadTitle,
  searchMemory,
  updateThread,
} from "./api";
import type {
  AgentProfile,
  MessageSearchHit,
  ModelSelection,
  PendingJump,
  ThreadMetadata,
  WorkThread,
} from "./types";

export interface UseThreadStateOptions {
  resourceId: string;
  getThreadDefaults: () => {
    agentSelection: AgentProfile;
    modeId: WorkModeId;
    permissionRules: PermissionRules;
    modelSelection: ModelSelection | null;
  };
  setActiveView: (view: MainView) => void;
  closeSettings: () => void;
}

export interface ThreadState {
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
  activeThreadId: string | null;
  selectThread: (threadId: string | null) => void;
  pendingJump: PendingJump | null;
  setPendingJump: (jump: PendingJump | null) => void;
  updateThreadLocal: (threadId: string, updater: (thread: WorkThread) => WorkThread) => void;
}

export function useThreadState(options: UseThreadStateOptions): ThreadState {
  const { resourceId, getThreadDefaults, setActiveView, closeSettings } = options;
  const [threads, setThreads] = useState<WorkThread[]>([]);
  const [threadsLoading, setThreadsLoading] = useState(true);
  const [activeThreadId, setActiveThreadIdState] = useState<string | null>(() =>
    readJson<string | null>(userStorageKey(ACTIVE_THREAD_KEY, resourceId), null),
  );
  const [pendingJump, setPendingJump] = useState<PendingJump | null>(null);
  const activeThreadResolvedRef = useRef(false);
  const threadsLoadedRef = useRef(false);
  const createThreadRequestRef = useRef<Promise<WorkThread | null> | null>(null);

  const selectThread = useCallback(
    (threadId: string | null) => {
      setActiveView("chat");
      closeSettings();
      setActiveThreadIdState(threadId);
    },
    [closeSettings, setActiveView],
  );

  useEffect(() => {
    const key = userStorageKey(ACTIVE_THREAD_KEY, resourceId);
    if (activeThreadId) localStorage.setItem(key, JSON.stringify(activeThreadId));
    else localStorage.removeItem(key);
  }, [activeThreadId, resourceId]);

  // 骨架屏只属于首屏。之后的每一次刷新(点开线程、发消息、重命名、置顶…)
  // 都必须静默完成:线程列表是常驻导航,把它整体换成骨架屏再换回来,既是
  // 用户直接看到的"列表重载一次",也让每次刷新都多出两轮 threadsLoading
  // 翻转 —— 而 threads/threadsLoading 都在 workbench context 里,每翻一次
  // 就把整棵订阅树(侧栏每一项 + 整个 ChatPanel)重渲染一遍。
  const refreshThreads = useCallback(async () => {
    if (!threadsLoadedRef.current) setThreadsLoading(true);
    try {
      const list = await fetchThreads(resourceId);
      setThreads(list);
      const shouldResolveActiveThread = !activeThreadResolvedRef.current;
      activeThreadResolvedRef.current = true;
      setActiveThreadIdState((current) => {
        if (current && list.some((thread) => thread.id === current)) return current;
        if (!shouldResolveActiveThread) return current;
        return (
          [...list].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0]?.id ??
          null
        );
      });
    } catch {
      // 静默刷新失败保留现有列表:一次网络抖动不该把整个导航清空
      if (!threadsLoadedRef.current) setThreads([]);
    } finally {
      threadsLoadedRef.current = true;
      setThreadsLoading(false);
    }
  }, [resourceId]);

  useEffect(() => {
    void refreshThreads();
  }, [refreshThreads]);

  const updateThreadLocal = useCallback(
    (threadId: string, updater: (thread: WorkThread) => WorkThread) => {
      setThreads((current) =>
        current.map((thread) => (thread.id === threadId ? updater(thread) : thread)),
      );
    },
    [],
  );

  const createThread = useCallback(
    (title?: string) => {
      if (createThreadRequestRef.current) return createThreadRequestRef.current;
      const request = (async () => {
        try {
          const { agentSelection, modeId, permissionRules, modelSelection } = getThreadDefaults();
          const thread = await createThreadRequest(resourceId, {
            threadId: nanoid(),
            ...(title ? { title } : {}),
            metadata: {
              draft: !title || title === "New Chat",
              agentProfileId: agentSelection.id,
              modeId,
              permissionRules,
              ...(modelSelection ? { modelSelectionByMode: { [modeId]: modelSelection } } : {}),
            },
          });
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
          if (createThreadRequestRef.current === request) createThreadRequestRef.current = null;
        },
        () => {
          if (createThreadRequestRef.current === request) createThreadRequestRef.current = null;
        },
      );
      return request;
    },
    [getThreadDefaults, refreshThreads, resourceId, selectThread],
  );

  const patchThread = useCallback(
    async (threadId: string, body: { title?: string; metadata?: ThreadMetadata }) => {
      await updateThread(threadId, resourceId, body);
      await refreshThreads();
    },
    [refreshThreads, resourceId],
  );

  const renameThread = useCallback(
    (threadId: string, title: string) =>
      patchThread(threadId, {
        title,
        ...(title ? { metadata: { draft: false } } : {}),
      }),
    [patchThread],
  );

  const generateTitle = useCallback(
    async (threadId: string) => {
      try {
        const title = await generateThreadTitle(threadId, resourceId);
        await refreshThreads();
        return title;
      } catch {
        return null;
      }
    },
    [refreshThreads, resourceId],
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
      await deleteThreadRequest(threadId, resourceId);
      if (activeThreadId === threadId) selectThread(null);
      await refreshThreads();
    },
    [activeThreadId, refreshThreads, resourceId, selectThread],
  );

  const searchMessages = useCallback(
    (query: string) => searchMemory(resourceId, query),
    [resourceId],
  );

  return {
    threads,
    threadsLoading,
    refreshThreads,
    createThread,
    renameThread,
    generateThreadTitle: generateTitle,
    deleteThread,
    pinThread,
    archiveThread,
    searchMessages,
    activeThreadId,
    selectThread,
    pendingJump,
    setPendingJump,
    updateThreadLocal,
  };
}
