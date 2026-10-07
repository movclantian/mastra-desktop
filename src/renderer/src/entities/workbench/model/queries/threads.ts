/**
 * 线程域 Query/Mutation 层:threads 列表查询 + 全部线程操作。
 * 乐观更新约定:onMutate 先 setQueryData 改缓存(替代旧的 updateThreadLocal),
 * onError 用快照回滚,onSettled 一律 invalidate 拉回服务端真相。
 * isPending 即旧 threadsLoading —— Query 无缓存首屏才为 true,后续
 * invalidate 的后台刷新不会回落,天然满足「骨架屏只属首屏」。
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { nanoid } from "nanoid";
import { useCallback, useEffect, useRef } from "react";
import { toast } from "sonner";
import { getWorkbenchClientSession } from "@/shared/api";
import { i18n } from "@/shared/i18n";
import { confirmWorkspaceDraftSwitch } from "@/shared/lib/workspace-drafts";
import { redactDiagnosticText } from "../../../../../../shared/credential-contract";
import {
  cloneThreadRequest,
  createThreadRequest,
  deleteThreadRequest,
  fetchThreads,
  generateThreadTitle as generateThreadTitleRequest,
  updateThread,
  updateThreadModel,
} from "../../api/workbench-api";
import { closeDeletedThreadBrowserView } from "../close-deleted-thread-browser-view";
import { qk } from "../query-keys";
import type { WorkModeId } from "../session";
import { ACTIVE_THREAD_KEY, userStorageKey } from "../storage";
import { DEFAULT_AGENT_PROFILE, threadActivityAt, type WorkThread } from "../types";
import { useWorkbenchStore } from "../workbench-store";

export function useThreadsQuery(userId: string) {
  return useQuery({
    queryKey: qk.threads(userId),
    queryFn: () => fetchThreads(userId),
    staleTime: 15_000,
  });
}

export function useInvalidateThreads() {
  const queryClient = useQueryClient();
  return useCallback(
    (userId: string) => queryClient.invalidateQueries({ queryKey: qk.threads(userId) }),
    [queryClient],
  );
}

/** 轻量乐观 mutation 工厂:patch 缓存 → 调 API → 失败回滚 → 结束 invalidate */
function useOptimisticThreadMutation<TVars>(
  userId: string,
  apply: (thread: WorkThread, variables: TVars) => WorkThread,
  request: (variables: TVars) => Promise<unknown>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (variables: TVars) => {
      await request(variables);
    },
    onMutate: async (variables) => {
      await queryClient.cancelQueries({ queryKey: qk.threads(userId) });
      const previous = queryClient.getQueryData<WorkThread[]>(qk.threads(userId));
      if (previous) {
        queryClient.setQueryData<WorkThread[]>(
          qk.threads(userId),
          (current) => current?.map((thread) => apply(thread, variables)) ?? current,
        );
      }
      return { previous };
    },
    onError: (_error, _variables, context) => {
      if (context?.previous) {
        queryClient.setQueryData(qk.threads(userId), context.previous);
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: qk.threads(userId) });
    },
  });
}

export function usePinThreadMutation(userId: string) {
  return useOptimisticThreadMutation(
    userId,
    (thread, { threadId, pinned }: { threadId: string; pinned: boolean }) =>
      thread.id === threadId ? { ...thread, metadata: { ...thread.metadata, pinned } } : thread,
    ({ threadId, pinned }) => updateThread(threadId, userId, { metadata: { pinned } }),
  );
}

export function useArchiveThreadMutation(userId: string) {
  return useOptimisticThreadMutation(
    userId,
    (thread, { threadId, archived }: { threadId: string; archived: boolean }) =>
      thread.id === threadId
        ? {
            ...thread,
            metadata: {
              ...thread.metadata,
              archivedAt: archived ? new Date().toISOString() : null,
            },
          }
        : thread,
    ({ threadId, archived }) =>
      updateThread(threadId, userId, {
        metadata: { archivedAt: archived ? new Date().toISOString() : null },
      }),
  );
}

export function useRenameThreadMutation(userId: string) {
  return useOptimisticThreadMutation(
    userId,
    (thread, { threadId, title }: { threadId: string; title: string }) =>
      thread.id === threadId
        ? {
            ...thread,
            title,
            ...(title ? { metadata: { ...thread.metadata, draft: false } } : {}),
          }
        : thread,
    ({ threadId, title }) => updateThread(threadId, userId, { title }),
  );
}

export function useGenerateThreadTitleMutation(userId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (threadId: string) => generateThreadTitleRequest(threadId, userId),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: qk.threads(userId) });
    },
  });
}

export interface CreateThreadOptions {
  /** 仅供有输入上下文的调用方覆盖标题；旧的 string 调用仍兼容。 */
  title?: string;
  /** 提交瞬间的模式快照，避免新线程创建与输入栏切换发生竞态。 */
  modeId?: WorkModeId;
  /** 由发送方在附件就绪、Session 进入提交状态后统一选择线程。 */
  deferSelection?: boolean;
}

/** 新建线程:默认值取自 sessionDraft store(原 getThreadDefaults ref) */
export function useCreateThreadMutation(userId: string) {
  const queryClient = useQueryClient();
  const selectThread = useSelectThread();
  return useMutation({
    mutationFn: async (input?: string | CreateThreadOptions) => {
      const title = typeof input === "string" ? input : input?.title;
      const modeOverride = typeof input === "string" ? undefined : input?.modeId;
      const { agentSelection, modeId, permissionRules, modelSelection } =
        useWorkbenchStore.getState();
      const currentModeId = modeOverride ?? modeId;
      const thread = await createThreadRequest(userId, {
        threadId: nanoid(),
        ...(title ? { title } : {}),
        metadata: {
          draft: !title || title === "New Chat",
          agentProfileId: agentSelection.id,
          currentModeId,
          permissionRules,
        },
      });
      return modelSelection ? updateThreadModel(thread.id, userId, modelSelection) : thread;
    },
    onSuccess: (thread, input) => {
      void queryClient.invalidateQueries({ queryKey: qk.threads(userId) });
      if (typeof input !== "object" || input?.deferSelection !== true) {
        selectThread(thread.id);
      }
    },
  });
}

export function useDeleteThreadMutation(userId: string) {
  const queryClient = useQueryClient();
  const selectThread = useSelectThread();
  const forgetThread = (threadId: string) => {
    const store = useWorkbenchStore.getState();
    const wasSelected = store.lastKnownThreadId === threadId;
    store.forgetThread(threadId);
    if (wasSelected) selectThread(null);
    queryClient.setQueryData<WorkThread[]>(qk.threads(userId), (threads) =>
      threads?.filter((thread) => thread.id !== threadId),
    );
  };
  return useMutation({
    mutationKey: qk.deleteThread(userId),
    mutationFn: async (threadId: string) => {
      await window.api?.terminal?.closeThread({ resourceId: userId, threadId });
      return deleteThreadRequest(threadId, userId);
    },
    onSuccess: async (_data, threadId) => {
      forgetThread(threadId);
      await closeDeletedThreadBrowserView(window.api?.browserView, {
        resourceId: userId,
        threadId,
      });
    },
    onSettled: async (_data, error, threadId) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: qk.threads(userId) }),
        queryClient.invalidateQueries({ queryKey: qk.schedules() }),
      ]);
      const threads = queryClient.getQueryData<WorkThread[]>(qk.threads(userId));
      // Cleanup can fail after the server has already deleted the row.
      if (error && threads && !threads.some((thread) => thread.id === threadId))
        forgetThread(threadId);
    },
  });
}

/** 克隆/分叉(官方 copyThread):成功后刷新并切换到新分支 */
export function useCloneThreadMutation(userId: string) {
  const queryClient = useQueryClient();
  const selectThread = useSelectThread();
  return useMutation({
    mutationFn: (options: { threadId: string; upToMessageId?: string }) =>
      cloneThreadRequest(options.threadId, userId, { upToMessageId: options.upToMessageId }),
    onSuccess: (clone) => {
      void queryClient.invalidateQueries({ queryKey: qk.threads(userId) });
      selectThread(clone.id);
    },
  });
}

/**
 * 切换当前线程:URL(?thread=)为真相,navigate 写入;lastKnownThreadId
 * 同步进 store(供非 React 场景:mutation 回调里判断当前线程)。
 * 语义与旧 selectThread 一致:总是回到 chat 视图。
 */
export function useSelectThread() {
  const navigate = useNavigate();
  return useCallback(
    async (threadId: string | null) => {
      const current = useWorkbenchStore.getState().lastKnownThreadId;
      const owner = useWorkbenchStore.getState().userId;
      if (!(await confirmWorkspaceDraftSwitch(current, threadId))) return;
      if (
        useWorkbenchStore.getState().lastKnownThreadId !== current ||
        useWorkbenchStore.getState().userId !== owner
      )
        return;
      useWorkbenchStore.getState().setLastKnownThreadId(threadId);
      // localStorage 兜底:直接打开无 hash 时仍能恢复上次会话
      const userId = useWorkbenchStore.getState().userId;
      if (userId) {
        const key = userStorageKey(ACTIVE_THREAD_KEY, userId);
        if (threadId) localStorage.setItem(key, JSON.stringify(threadId));
        else localStorage.removeItem(key);
      }
      void navigate({
        to: "/chat",
        search: (prev) => ({ ...prev, thread: threadId ?? undefined }),
      });
    },
    [navigate],
  );
}

/**
 * 线程 busy 判定(组件层派生,不落 store):本地 busy 标记(ChatPanel 流式同步)
 * 与服务端 isWorking/activeRunId 元数据(threads query)取并集。
 */
export function useIsThreadBusy(userId: string): (threadId: string) => boolean {
  const busyThreadIds = useWorkbenchStore((state) => state.busyThreadIds);
  const threads = useThreadsQuery(userId).data ?? [];
  return useCallback(
    (threadId: string) => {
      if (busyThreadIds[threadId]) return true;
      const thread = threads.find((item) => item.id === threadId);
      return Boolean(thread?.metadata?.isWorking || thread?.metadata?.activeRunId);
    },
    [busyThreadIds, threads],
  );
}

/** URL thread → store 镜像(挂 RootShell):mutation 回调等非 React 场景读取当前线程 */
export function useSyncThreadToStore(threadId: string | null): void {
  const setLastKnownThreadId = useWorkbenchStore((state) => state.setLastKnownThreadId);
  const initializedRef = useRef(false);
  useEffect(() => {
    // 首次同步:URL 无 thread 时保留 hydrate 从 localStorage 恢复的值,
    // 之后严格跟随 URL(后退/前进/清除都生效)
    if (!initializedRef.current) {
      initializedRef.current = true;
      if (threadId) setLastKnownThreadId(threadId);
      return;
    }
    setLastKnownThreadId(threadId);
  }, [setLastKnownThreadId, threadId]);
}

/**
 * 首屏兜底解析(原 refreshThreads 的 resolve 语义):线程列表首次到位后,
 * 若既无 URL thread 也无有效 localStorage thread,选中最近发起请求的线程。
 * 仅触发一次;之后的失效刷新不会误切线程。
 */
export function useActiveThreadResolver(threads: WorkThread[] | undefined): void {
  const urlThread = useRouterState({
    select: (state) => (state.location.search as { thread?: string }).thread ?? null,
  });
  const selectThread = useSelectThread();
  const resolvedRef = useRef(false);
  useEffect(() => {
    if (resolvedRef.current || !threads) return;
    // An initially empty account is resolved too; later creation owns its navigation.
    resolvedRef.current = true;
    const current = urlThread ?? useWorkbenchStore.getState().lastKnownThreadId;
    if (current && threads.some((thread) => thread.id === current)) return;
    const latest = [...threads].sort(
      (left, right) =>
        threadActivityAt(right).localeCompare(threadActivityAt(left)) ||
        left.id.localeCompare(right.id),
    )[0];
    if (latest) selectThread(latest.id);
  }, [selectThread, threads, urlThread]);
}

/** Start a dedicated troubleshooting conversation through the native message endpoint. */
export function useAssistantDiagnosis(userId: string) {
  const queryClient = useQueryClient();
  const selectThread = useSelectThread();
  const pending = useRef(false);
  const start = async (context: string) => {
    if (pending.current || !userId) return;
    pending.current = true;
    const progress = toast.loading(i18n.t("plugins:startingDiagnosis"));
    let prompt = "";
    let threadId: string | undefined;
    try {
      const { modelSelection, permissionRules } = useWorkbenchStore.getState();
      const thread = await createThreadRequest(userId, {
        threadId: nanoid(),
        title: i18n.t("plugins:diagnose"),
        metadata: {
          agentProfileId: DEFAULT_AGENT_PROFILE.id,
          currentModeId: "build",
          permissionRules,
        },
      });
      threadId = thread.id;
      if (modelSelection) await updateThreadModel(thread.id, userId, modelSelection);
      const safeContext = redactDiagnosticText(context);
      prompt = `${i18n.t("plugins:diagnosisPrompt")}\n\n<diagnostic-data>\n${safeContext}\n</diagnostic-data>`;
      await getWorkbenchClientSession(userId, thread.id).sendMessage(prompt, {
        requestContext: {
          "mastra-work:message-options": { clientMessageId: crypto.randomUUID() },
        },
      });
    } catch (error) {
      if (threadId && prompt) useWorkbenchStore.getState().setPendingPrompt(prompt);
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      if (threadId) {
        await queryClient.invalidateQueries({ queryKey: qk.threads(userId) });
        selectThread(threadId);
      }
      pending.current = false;
      toast.dismiss(progress);
    }
  };
  return {
    start,
    action: (context: string) => ({
      label: i18n.t("plugins:diagnose"),
      onClick: () => {
        void start(context);
      },
    }),
  };
}
