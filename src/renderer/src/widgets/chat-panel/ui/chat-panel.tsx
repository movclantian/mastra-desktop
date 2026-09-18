import { useChat } from "@ai-sdk/react";
import { arrayMove } from "@dnd-kit/sortable";
import { useRouterState } from "@tanstack/react-router";
import { type FileUIPart, isToolUIPart, type LanguageModelUsage } from "ai";
import { GitBranchIcon } from "lucide-react";
import { nanoid } from "nanoid";
import * as React from "react";
import { toast } from "sonner";
import type { AgentMemberDefinition, AgentProfile, ToolCategory } from "@/entities/workbench";
import {
  buildReasoningRequest,
  buildRequestModel,
  fetchThreadSource,
  getModelCapabilities,
  getModelContextWindow,
  withCategoryPolicy,
} from "@/entities/workbench";
import { useCatalogQuery } from "@/entities/workbench/model/queries/config";
import {
  useCloneThreadMutation,
  useCreateThreadMutation,
  useInvalidateThreads,
  useSelectThread,
  useThreadsQuery,
} from "@/entities/workbench/model/queries/threads";
import { useSessionSettings } from "@/entities/workbench/model/use-session-settings";
import { useWorkbenchStore } from "@/entities/workbench/model/workbench-store";
import { useAuth } from "@/features/auth";
import { useTranslation } from "@/shared/i18n";
import { readErrorPayload, toastError } from "@/shared/lib";
import { PromptInputProvider } from "@/shared/ui/ai-elements/prompt-input";
import { Queue } from "@/shared/ui/ai-elements/queue";
import { AnimatedShinyText } from "@/shared/ui/animated-shiny-text";
import { BlurFade } from "@/shared/ui/blur-fade";
import { Button } from "@/shared/ui/button";
import { DotPattern } from "@/shared/ui/dot-pattern";
import { DotmSquare3 } from "@/shared/ui/dotm-square-3";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/shared/ui/hover-card";
import { Item, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@/shared/ui/item";
import { Message, MessageAvatar, MessageContent, MessageHeader } from "@/shared/ui/message";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
  useMessageScroller,
  useMessageScrollerVisibility,
} from "@/shared/ui/message-scroller";
import { Meteors } from "@/shared/ui/meteors";
import { ScrollArea } from "@/shared/ui/scroll-area";
import { SparklesText } from "@/shared/ui/sparkles-text";
import { TypingAnimation } from "@/shared/ui/typing-animation";
import { WordRotate } from "@/shared/ui/word-rotate";
import {
  abortThread,
  enqueueFollowUp,
  fetchThreadMessagesPage,
  runWorkflowAction,
  toggleThreadMessageReaction,
} from "../api/chat-api";
import { persistAttachments as uploadAttachments } from "../lib/attachments";
import { buildDisplayMessages, type DisplayMessage } from "../lib/display";
import { subscribeBackgroundTaskStream } from "../model/background-task-stream";
import { useFetchDisplayStateQuery } from "../model/display-state-query";
import {
  type AgentInteraction,
  type AgentTask,
  areTasksEqual,
  type BackgroundTaskState,
  getActiveToolsFromMessages,
  getBackgroundTasksFromMessages,
  getSubagentsFromMessages,
  getTasksFromMessages,
  getToolName,
  getWorkflowStateFromDisplayState,
  getWorkflowStateFromMessages,
  type LibraryFilePart,
  type MessageFileReference,
  type MessageReaction,
  mergeWorkflowRuntimeStates,
  parseSuspendedRuns,
  type QueuedRequest,
  toggleMessageReactions,
  type WorkDisplayState,
  type WorkflowRuntimeRun,
} from "../model/types";
import { usePlaceholderChat, useThreadChats } from "../model/use-thread-chats";
import {
  AgentInteractionPanel,
  AgentMemberMessageView,
  AgentMemberSwitcher,
  AgentQueuePanel,
  AssistantAvatar,
  ChatPromptInput,
  ChatWorkspaceSelector,
  getAgentMemberRuntimes,
  MessageItem,
  UserRequestQueuePanel,
  WorkflowRunPanel,
} from "./";
import type { WorkflowRunAction } from "./agent-panels";

// ---------------------------------------------------------------------------
// 官方 MessageScroller 命令式滚动驱动器 (负责跨会话/搜索结果跳转)
// ---------------------------------------------------------------------------

function ChatPanelScrollerController({
  pendingJump,
  activeThreadId,
  messagesCount,
  onClearPendingJump,
}: {
  pendingJump: { threadId: string; messageId: string } | null;
  activeThreadId: string | null;
  messagesCount: number;
  onClearPendingJump: () => void;
}) {
  const { scrollToMessage } = useMessageScroller();

  React.useEffect(() => {
    if (!pendingJump || !activeThreadId || pendingJump.threadId !== activeThreadId) return;
    if (messagesCount === 0) return;
    const queuedOrHandled = scrollToMessage(pendingJump.messageId, {
      align: "center",
      behavior: "smooth",
    });
    if (queuedOrHandled) {
      onClearPendingJump();
      const el = document.querySelector(`[data-message-id="${pendingJump.messageId}"]`);
      if (el) {
        el.classList.add("ring-2", "ring-primary/60", "rounded-xl");
        const timer = window.setTimeout(() => {
          el.classList.remove("ring-2", "ring-primary/60", "rounded-xl");
        }, 2000);
        return () => window.clearTimeout(timer);
      }
    }
    return undefined;
  }, [pendingJump, activeThreadId, messagesCount, scrollToMessage, onClearPendingJump]);

  return null;
}

// ---------------------------------------------------------------------------
// 官方 message-actions:发送失败的行内提示需要防闪烁 —— 瞬时错误自动重连期间
// status 会短暂停在 error,立刻亮起“发送失败”再消失会误导用户。
// 值持续为 true 超过 delayMs 才确认,false 立即复位。
// ---------------------------------------------------------------------------

function useDelayedTrue(value: boolean, delayMs: number): boolean {
  const [confirmed, setConfirmed] = React.useState(false);
  React.useEffect(() => {
    if (!value) {
      setConfirmed(false);
      return;
    }
    const timer = window.setTimeout(() => setConfirmed(true), delayMs);
    return () => window.clearTimeout(timer);
  }, [delayMs, value]);
  return confirmed;
}

// ---------------------------------------------------------------------------
// 官方 message-scroller-visibility:会话大纲(Transcript Outline)。
// 触发按钮是竖排小条(当前锚点轮次高亮),HoverCard 展示可点击跳转的提问列表。
// ---------------------------------------------------------------------------

interface OutlineEntry {
  id: string;
  text: string;
}

function TranscriptOutline({ entries }: { entries: OutlineEntry[] }) {
  const { t } = useTranslation();
  const { scrollToMessage } = useMessageScroller();
  const { currentAnchorId } = useMessageScrollerVisibility();

  return (
    <HoverCard>
      <HoverCardTrigger
        render={
          <button
            aria-label={t("chat:welcome.outlineAriaLabel")}
            className="pointer-events-auto flex h-9 w-9 flex-col items-center justify-center gap-1 rounded-md transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            type="button"
          />
        }
      >
        {entries.map((entry) => (
          <span
            className="h-0.5 w-4 rounded-full bg-muted-foreground/40 data-[current=true]:bg-foreground"
            data-current={entry.id === currentAnchorId}
            key={entry.id}
          />
        ))}
      </HoverCardTrigger>
      <HoverCardContent
        align="center"
        className="flex w-64 flex-col gap-1 rounded-2xl p-1"
        side="left"
        sideOffset={-28}
      >
        <ScrollArea className="max-h-72">
          <div className="flex flex-col gap-1 pr-2">
            {entries.map((entry) => (
              <button
                aria-current={currentAnchorId === entry.id ? "location" : undefined}
                className="flex min-h-7 items-center rounded-xl px-2 py-1.5 text-left text-sm transition-colors outline-none hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground aria-current:bg-accent aria-current:text-accent-foreground"
                key={entry.id}
                onClick={() =>
                  scrollToMessage(entry.id, {
                    align: "start",
                    behavior: "smooth",
                  })
                }
                type="button"
              >
                <span className="min-w-0 whitespace-normal break-words">{entry.text}</span>
              </button>
            ))}
          </div>
        </ScrollArea>
      </HoverCardContent>
    </HoverCard>
  );
}

// ---------------------------------------------------------------------------
// 会话面板
// ---------------------------------------------------------------------------

export function ChatPanel() {
  const { t } = useTranslation();
  const { user: authUser } = useAuth();
  const user = authUser ?? { id: "anonymous", name: "Guest", email: "guest@example.com" };
  const userId = user?.id ?? "anonymous";
  const threads = useThreadsQuery(userId).data ?? [];
  // URL ?thread= 即当前线程(真相在 Router)
  const activeThreadId = useRouterState({
    select: (state) => (state.location.search as { thread?: string }).thread ?? null,
  });
  const createThreadMutation = useCreateThreadMutation(userId);
  const cloneThreadMutation = useCloneThreadMutation(userId);
  const invalidateThreads = useInvalidateThreads();
  const selectThread = useSelectThread();
  const catalog = useCatalogQuery().data ?? [];
  const {
    providers,
    modelSelection,
    agentSelection,
    searchSelection,
    permissionRules,
    setPermissionRules,
    refreshThreadSettings,
  } = useSessionSettings(userId, activeThreadId);
  const pendingJump = useWorkbenchStore((state) => state.pendingJump);
  const setPendingJump = useWorkbenchStore((state) => state.setPendingJump);
  const setThreadBusy = useWorkbenchStore((state) => state.setThreadBusy);
  const setAgentBusy = useWorkbenchStore((state) => state.setAgentBusy);
  const openWorkspacePanel = useWorkbenchStore((state) => state.openWorkspacePanel);
  const cloneThreadAsync = cloneThreadMutation.mutateAsync;

  const activeThread = threads.find((t) => t.id === activeThreadId);
  // 工作区选定(promptInput 顶部选择器):随未锁定线程的首条消息以
  // body.workspacePath 上传,服务端绑定后选择器隐藏(会话目录不可中途更换)
  const [pendingWorkspacePath, setPendingWorkspacePath] = React.useState<string | null>(null);
  const [tasks, setTasks] = React.useState<AgentTask[]>([]);
  const [taskSnapshotLoaded, setTaskSnapshotLoaded] = React.useState(false);
  const [queuedRequests, setQueuedRequests] = React.useState<QueuedRequest[]>([]);
  const [queueDispatchVersion, setQueueDispatchVersion] = React.useState(0);
  const [queueCanDispatch, setQueueCanDispatch] = React.useState(false);
  const [persistedInteractions, setPersistedInteractions] = React.useState<AgentInteraction[]>([]);
  const [backgroundTasks, setBackgroundTasks] = React.useState<BackgroundTaskState[]>([]);
  const [workflowRuns, setWorkflowRuns] = React.useState<WorkDisplayState["workflowRuns"]>([]);
  const [activeMemberId, setActiveMemberId] = React.useState<string | null>(null);
  const [dismissedMemberActivitySignature, setDismissedMemberActivitySignature] = React.useState<
    string | null
  >(null);
  const [dismissedQueueSignature, setDismissedQueueSignature] = React.useState<string | null>(null);
  const [resolvedInteractionKeys, setResolvedInteractionKeys] = React.useState<Set<string>>(
    () => new Set(),
  );
  const displayStateRequestId = React.useRef(0);
  const rewriteRefreshRef = React.useRef(false);
  // 分支来源(官方 isClone / getSourceThread):非分支线程为 undefined,分支线程
  // 在 effect 里取回 { id, title };来源已删除/查询失败为 null
  const [cloneSource, setCloneSource] = React.useState<
    | {
        id: string;
        title: string;
      }
    | null
    | undefined
  >(undefined);

  React.useEffect(() => {
    const sourceThreadId = activeThread?.metadata.clone?.sourceThreadId;
    if (!activeThreadId || !sourceThreadId) {
      setCloneSource(undefined);
      return;
    }
    let disposed = false;
    setCloneSource(undefined);
    void fetchThreadSource(activeThreadId, user.id)
      .then((source) => {
        if (!disposed) setCloneSource(source);
      })
      .catch(() => {
        if (!disposed) setCloneSource(null);
      });
    return () => {
      disposed = true;
    };
  }, [activeThread?.metadata.clone?.sourceThreadId, activeThreadId, user.id]);

  const selectedProvider = providers.find((p) => p.id === modelSelection?.providerId);
  const selectedContextWindow = React.useMemo(
    () =>
      selectedProvider && modelSelection
        ? getModelContextWindow(selectedProvider, modelSelection.modelId, catalog)
        : undefined,
    [catalog, modelSelection, selectedProvider],
  );
  const selectedCapabilities = React.useMemo(
    () =>
      selectedProvider && modelSelection
        ? getModelCapabilities(selectedProvider, modelSelection.modelId, catalog)
        : undefined,
    [catalog, modelSelection, selectedProvider],
  );
  const attachmentTokenBudgetRef = React.useRef(selectedContextWindow ?? 32_000);
  const selectedSkillNamesRef = React.useRef<string[]>([]);

  const persistAttachments = React.useCallback(
    (files: FileUIPart[], threadId: string) => uploadAttachments(files, user.id, threadId),
    [user.id],
  );

  // 最新 threadId 的 ref:解决「首条消息先建线程再发送」时
  // memoized transport 持有旧值的竞态
  const activeThreadIdRef = React.useRef(activeThreadId);
  activeThreadIdRef.current = activeThreadId;
  // 新线程首条消息发送期间,路由会先切到新线程。此时不能用尚为空的
  // 服务端历史覆盖 Chat 即将写入的乐观用户消息。
  const initialSendRef = React.useRef<{ threadId: string | null } | null>(null);
  // 工作区路径/锁定状态同样经 ref 透传给 memoized transport
  const pendingWorkspacePathRef = React.useRef(pendingWorkspacePath);
  pendingWorkspacePathRef.current = pendingWorkspacePath;
  const workspaceLockedRef = React.useRef(false);

  // 每次请求携带的公共字段(BYOK 模型 + 思考等级 + 检索开关 + memory 标识 + 附件预算)。
  // body 格式参考 docs/en/reference/ai-sdk/chat-route.mdx。
  // 放在 ref 里而不是 memo 依赖里:每个线程有自己的 Chat 实例与 transport(见下),
  // 它们都要读**最新**的选择,而不是各自创建时的快照。
  const buildRequestBodyRef = React.useRef<(threadId: string) => Record<string, unknown>>(
    () => ({}),
  );
  buildRequestBodyRef.current = (threadId: string) => ({
    ...(selectedProvider && modelSelection
      ? { model: buildRequestModel(selectedProvider, modelSelection.modelId) }
      : {}),
    // 模型形态快照:服务端写进 thread.metadata.modelSelection,
    // 切回本线程时前端据此恢复模型与思考等级选择
    ...(modelSelection
      ? {
          modelSelection: {
            providerId: modelSelection.providerId,
            modelId: modelSelection.modelId,
            modelName: modelSelection.modelName,
            reasoningEffort: modelSelection.reasoningEffort,
          },
        }
      : {}),
    // 思考等级:标准 modelSettings.reasoning(max 档退回 providerOptions)
    ...(selectedProvider && modelSelection && modelSelection.reasoningEffort !== "off"
      ? buildReasoningRequest(selectedProvider, modelSelection.reasoningEffort)
      : {}),
    // 联网检索开关:服务端据此注入检索工具并要求结构化检索报告
    ...(searchSelection ? { webSearch: searchSelection } : {}),
    // 首条消息的显式工作区选定(未锁定线程才携带,服务端绑定后忽略后续)
    ...(pendingWorkspacePathRef.current && !workspaceLockedRef.current
      ? { workspacePath: pendingWorkspacePathRef.current }
      : {}),
    // 线程 id 取自该 Chat 自己的绑定,不是"当前激活线程" —— 后台流式线程若发请求也不会串台
    memory: { resource: user.id, thread: threadId },
    attachmentTokenBudget: attachmentTokenBudgetRef.current,
    attachmentCapabilities: {
      vision: selectedCapabilities?.vision === true,
      audio: selectedCapabilities?.audio === true,
    },
    skillNames: selectedSkillNamesRef.current,
    agentProfileId: agentSelection.id,
  });

  const { getThreadChat, retainActive } = useThreadChats(
    user.id,
    (threadId) => buildRequestBodyRef.current(threadId),
    setThreadBusy,
  );
  const placeholderChat = usePlaceholderChat();
  const activeChat = activeThreadId ? getThreadChat(activeThreadId) : placeholderChat;

  // throttle 必填。AI SDK 默认不节流(throttle: undefined),于是每个 chunk 都经
  // useSyncExternalStore 独立通知一次 —— 那是同步车道(SyncLane),每次都要走完
  // 一整轮 render + commit。React 在每次 commit 收尾时若发现同步车道上还有活,
  // 就把嵌套更新计数 +1,累到 50 直接抛 "Maximum update depth exceeded"。
  //
  // 模型逐 token 吐字时 chunk 间有真实间隔,计数每轮都清零,所以纯文本对话看不出问题;
  // 工具调用结束的那一刻不一样 —— 服务端在本机(零网络延迟)会把工具结果整块加上紧随
  // 其后的续写文本一次性 flush 出来,几十个 chunk 落在同一批微任务里被读出,连续几十次
  // 同步 commit 之间没有任何空隙,计数一路撞上限。异常在 chunk 处理栈里抛出,于是表现为
  // useChat 的 onError:「本轮生成失败」+ 流式中断。
  //
  // 50ms(20fps)对流式文字已足够顺滑,同时把这条对话树的重渲染次数压到原来的几十分之一。
  const { messages, setMessages, status, stop } = useChat({
    chat: activeChat,
    resume: Boolean(activeThreadId),
    throttle: 50,
  });

  // 历史分页(官方 message-scroller-load-history):每线程已加载页数与
  // “还有更早历史”只驱动命令式加载,不参与渲染,全部走 ref。
  const historyPageCountRef = React.useRef(new Map<string, number>());
  const hasEarlierHistoryRef = React.useRef(false);
  const loadingEarlierHistoryRef = React.useRef(false);
  // 消息最新快照:handleToggleReaction 等回调要读当前 reactions 做乐观更新,
  // 但不能把 messages 放进 useCallback 依赖 —— 流式期间每 50ms 一变会让
  // memoized MessageItem 全体失效。
  const messagesRef = React.useRef(messages);
  messagesRef.current = messages;

  // 工作区锁定:线程已绑定目录或已有消息往来;锁定后隐藏 promptInput 选择器
  const workspaceLocked = Boolean(activeThread?.metadata.workspacePath) || messages.length > 0;
  workspaceLockedRef.current = workspaceLocked;

  // 首条消息会在服务端请求开始时锁定工作区,但线程列表仍是旧快照。
  // 在本地消息出现后补一次刷新,让右侧文件树及时拿到 workspaceExplicit。
  //
  // 每条线程只补这一次。判据不能只是「有消息且未绑定目录」—— 那个条件对
  // 一条永远不绑定工作区的纯问答线程恒为真,于是每次点开它、每次历史加载
  // 完成(messages.length 由 0 变 N)都会再拉一次线程列表,表现为「点一下
  // 线程,整个列表重载一次」。
  const workspaceSyncedThreadsRef = React.useRef(new Set<string>());
  React.useEffect(() => {
    if (!activeThreadId || messages.length === 0 || activeThread?.metadata.workspacePath) return;
    if (workspaceSyncedThreadsRef.current.has(activeThreadId)) return;
    workspaceSyncedThreadsRef.current.add(activeThreadId);
    void invalidateThreads(userId);
  }, [
    activeThread?.metadata.workspacePath,
    activeThreadId,
    invalidateThreads,
    messages.length,
    userId,
  ]);

  // 首轮会话流式完成时（状态由 streaming 变为 ready）：立即刷新线程列表，实时呈现服务端智能起名的标题
  const previousStatusRef = React.useRef(status);
  React.useEffect(() => {
    const wasStreaming = previousStatusRef.current === "streaming";
    previousStatusRef.current = status;
    if (wasStreaming && status === "ready" && activeThreadId) {
      void invalidateThreads(userId);
    }
  }, [activeThreadId, invalidateThreads, status, userId]);

  // 从服务端拉取历史消息并重建消息流(线程切换 / 压缩后刷新共用)。
  //
  // setMessages 恒定写「当前」Chat(useChat 里它闭包的是一个永久稳定的 ref),
  // 所以必须校验归属:快速切换时 A 的历史可能在 B 已激活后才返回,写进去等于
  // 用 A 的旧历史覆盖 B —— B 若正在流式,这一下就把流打断在视觉上。
  //
  // 分页(官方 message-scroller-load-history):并行拉取该线程已加载深度的
  // 全部页(page 0 最新),向上加载过更早历史后刷新不会把已读内容收回去。
  const reloadMessages = React.useCallback((): Promise<boolean> => {
    const threadId = activeThreadId;
    if (!threadId) {
      setMessages([]);
      return Promise.resolve(true);
    }
    const pageCount = historyPageCountRef.current.get(threadId) ?? 1;
    return Promise.all(
      Array.from({ length: pageCount }, (_, page) =>
        fetchThreadMessagesPage(threadId, user.id, page),
      ),
    )
      .then((pages) => {
        if (activeThreadIdRef.current !== threadId) return false;
        // 页数组倒序(最旧在前)再 flat 得到时间正序;按 id 去重防页界重叠
        const seen = new Set<string>();
        const loaded = pages
          .slice()
          .reverse()
          .flatMap((page) => page.messages)
          .filter((message) => {
            if (seen.has(message.id)) return false;
            seen.add(message.id);
            return true;
          });
        // hasMore 指向更旧的页:取已加载的最旧一页(数组末项)判断
        hasEarlierHistoryRef.current = pages[pages.length - 1]?.hasMore ?? false;
        setMessages(loaded);
        return true;
      })
      .catch(() => {
        if (activeThreadIdRef.current === threadId) {
          setMessages([]);
        }
        return false;
      });
  }, [activeThreadId, setMessages, user.id]);

  // 向上滚动到顶部附近时加载更早一页历史:前置插入 + preserveScrollOnPrepend
  // (MessageScrollerViewport 默认启用)保持阅读位置不跳动。
  const loadEarlierHistory = React.useCallback(() => {
    const threadId = activeThreadIdRef.current;
    if (!threadId || loadingEarlierHistoryRef.current || !hasEarlierHistoryRef.current) return;
    loadingEarlierHistoryRef.current = true;
    const nextPage = historyPageCountRef.current.get(threadId) ?? 1;
    fetchThreadMessagesPage(threadId, user.id, nextPage)
      .then((page) => {
        if (activeThreadIdRef.current !== threadId) return;
        historyPageCountRef.current.set(threadId, nextPage + 1);
        hasEarlierHistoryRef.current = page.hasMore;
        setMessages((current) => {
          const existingIds = new Set(current.map((message) => message.id));
          return [...page.messages.filter((message) => !existingIds.has(message.id)), ...current];
        });
      })
      .catch(() => {
        toast.error(t("chat:welcome.toastLoadEarlierFailed"));
      })
      .finally(() => {
        loadingEarlierHistoryRef.current = false;
      });
  }, [setMessages, user.id]);

  // display-state 请求经 Query 缓存(按 threadId keyed,同线程并发读取自动去重),
  // 派生拆分(tasks/interactions/backgroundRuns)仍留本地 —— 它们驱动的是
  // 逐字段相等性比较的渲染优化,不是可复用的服务端状态。
  const fetchDisplayStateQuery = useFetchDisplayStateQuery();
  const fetchDisplayState = React.useCallback(
    async (threadId: string) => {
      const payload = await fetchDisplayStateQuery(userId, threadId);
      if (!payload.displayState) return undefined;
      return {
        ...payload.displayState,
        tasks: Array.isArray(payload.displayState.tasks) ? payload.displayState.tasks : [],
        suspendedRuns: parseSuspendedRuns(payload.displayState.suspendedRuns),
      } satisfies WorkDisplayState;
    },
    [fetchDisplayStateQuery, userId],
  );

  const reloadDisplayState = React.useCallback(async () => {
    const requestId = ++displayStateRequestId.current;
    if (!activeThreadId) {
      setTasks([]);
      setTaskSnapshotLoaded(true);
      setPersistedInteractions([]);
      setBackgroundTasks([]);
      setWorkflowRuns([]);
      return;
    }
    try {
      const displayState = await fetchDisplayState(activeThreadId);
      if (requestId !== displayStateRequestId.current) return;
      const nextTasks = displayState?.tasks ?? [];
      setTasks((current) => (areTasksEqual(current, nextTasks) ? current : nextTasks));
      setPersistedInteractions(displayState?.suspendedRuns ?? []);
      setBackgroundTasks(displayState?.backgroundTasks ?? []);
      setWorkflowRuns(displayState?.workflowRuns ?? []);
      setTaskSnapshotLoaded(Boolean(displayState));
    } catch {
      if (requestId !== displayStateRequestId.current) return;
      setTasks((current) => (current.length === 0 ? current : []));
      setPersistedInteractions([]);
      setBackgroundTasks([]);
      setWorkflowRuns([]);
    }
  }, [activeThreadId, fetchDisplayState]);

  /**
   * 从持久化快照读取本线程仍在等待的工具交互(Agent.listSuspendedRuns)。
   * 同时被两处使用:一轮响应结束后的面板恢复,以及 resume 前的过期预检。
   * 类别与生效策略由统一 display-state 快照在服务端算好。
   */
  const fetchSuspendedInteractions = React.useCallback(
    async (threadId: string): Promise<AgentInteraction[]> => {
      return (await fetchDisplayState(threadId))?.suspendedRuns ?? [];
    },
    [fetchDisplayState],
  );

  // 切换线程:首次进入才拉历史,并回收闲置线程的 Chat 实例。
  //
  // 不能无条件 reloadMessages —— 切回一条仍在流式的线程时,setMessages 会把
  // 正在增长的消息覆盖成服务端尚未落库的旧历史,等于把流打断在视觉上。
  // 因此只有「这个 Chat 还没装载过历史」时才拉:实例是新建的(切换/首次)且当前空闲。
  React.useEffect(() => {
    // 换线程后“还有更早历史”未知,reloadMessages 完成后会重新赋值
    hasEarlierHistoryRef.current = false;
    const initialSend = initialSendRef.current;
    const isInitialSendThread =
      initialSend !== null &&
      (initialSend.threadId === null || initialSend.threadId === activeThreadId);
    if (!isInitialSendThread && activeChat.messages.length === 0 && activeChat.status === "ready") {
      void reloadMessages();
    }
    setTasks([]);
    setTaskSnapshotLoaded(false);
    displayStateRequestId.current += 1;
    setQueuedRequests([]);
    setQueueCanDispatch(false);
    setPersistedInteractions([]);
    setBackgroundTasks([]);
    setWorkflowRuns([]);
    setResolvedInteractionKeys(new Set());
    retainActive(activeThreadId);
  }, [activeChat, activeThreadId, reloadMessages, retainActive]);

  const interactionReloadVersion = React.useRef(0);
  // 任务和暂停交互都是服务端持久化状态;只在切线和一轮响应结束后读取,
  // 避免流式 token 每次更新都触发额外请求。队列必须等待该读取完成,
  // 否则 ask_user / submit_plan 刚挂起时会被下一条排队消息越过。
  // messages.length 是故意的触发器:消息条数变化(新一轮完成)时重读,
  // 而非每个流式 token 都触发
  React.useEffect(() => {
    if (status !== "ready" && status !== "error") return;
    const version = ++interactionReloadVersion.current;
    setQueueCanDispatch(false);
    void reloadDisplayState().finally(() => {
      if (interactionReloadVersion.current === version) {
        setQueueCanDispatch(true);
      }
    });
  }, [messages.length, reloadDisplayState, status]);

  /**
   * 重试:重生成**指定**的那条助手消息,而不是永远重生成最后一条。
   * regenerate({ messageId }) 会以 trigger: 'regenerate-message' 发送,
   * toAISdkStream 据此把那条助手消息从输入里切掉再重跑(见 transport 的注释)。
   */
  const handleRetry = React.useCallback(
    (messageId: string) => {
      setQueueCanDispatch(false);
      rewriteRefreshRef.current = true;
      void activeChat.regenerate({ messageId });
    },
    [activeChat],
  );

  const handleEdit = React.useCallback(
    (messageId: string, text: string) => {
      setQueueCanDispatch(false);
      rewriteRefreshRef.current = true;
      void activeChat.sendMessage({ text, messageId });
    },
    [activeChat],
  );

  // 表情反应(官方 BubbleReactions 业务对接):乐观更新 + 服务端持久化。
  // messageId 是聚合显示消息的 id(= 末条源消息 id),与服务端存储行一致。
  const handleToggleReaction = React.useCallback(
    (messageId: string, emoji: string) => {
      const threadId = activeThreadIdRef.current;
      if (!threadId) return;
      const target = messagesRef.current.find((message) => message.id === messageId);
      const previous = target?.metadata?.reactions;
      const applyReactions = (reactions: MessageReaction[]) =>
        setMessages((current) =>
          current.map((message) =>
            message.id === messageId
              ? { ...message, metadata: { ...message.metadata, reactions } }
              : message,
          ),
        );
      applyReactions(toggleMessageReactions(previous, emoji, user.id));
      void toggleThreadMessageReaction(threadId, user.id, messageId, emoji)
        .then((result) => applyReactions(result.reactions))
        .catch(() => {
          applyReactions(previous ?? []);
          toast.error(t("chat:welcome.toastReactionFailed"));
        });
    },
    [setMessages, user.id],
  );

  // Refresh once after an edit/regenerate stream completes.
  React.useEffect(() => {
    if (status !== "ready" || !rewriteRefreshRef.current) return;
    rewriteRefreshRef.current = false;
    void reloadMessages();
  }, [reloadMessages, status]);

  /**
   * 停止生成。服务端已不把 HTTP 断连当作中止信号,所以先按当前会话线程
   * 真正 abort 掉 run(否则只是本地不再读流),再断开 AI SDK 客户端流。
   *
   * 刻意**不**在这之后重新拉历史:chat.stop() 保留已收到的 token(官方语义),
   * 而服务端此刻可能还没把中止点之后的状态落库,立刻重读反而会把已显示的部分抹掉。
   */
  const handleStop = React.useCallback(async () => {
    const threadId = activeThreadIdRef.current;
    if (threadId) {
      await abortThread(threadId, user.id).catch(() => undefined);
    }
    setQueuedRequests((current) => current.filter((request) => !request.queuedOnServer));
    await stop();
  }, [stop, user.id]);

  const isBusy = status === "submitted" || status === "streaming";
  React.useEffect(() => {
    if (!activeThreadId) return;
    setThreadBusy(activeThreadId, isBusy);
  }, [activeThreadId, isBusy, setThreadBusy]);
  React.useEffect(() => {
    if (!isBusy || !activeThreadId) return;
    const timer = window.setInterval(() => {
      void reloadDisplayState();
    }, 1200);
    return () => window.clearInterval(timer);
  }, [activeThreadId, isBusy, reloadDisplayState]);

  // Keep the queue current after the agent stream closes. The official
  // BackgroundTaskManager stream emits lifecycle events for tasks that finish
  // after the conversation has become idle, so polling is not required for
  // this global status lane.
  React.useEffect(() => {
    if (!activeThreadId) return;
    return subscribeBackgroundTaskStream(activeThreadId, user.id, (task) => {
      setBackgroundTasks((current) => [task, ...current.filter((entry) => entry.id !== task.id)]);
    });
  }, [activeThreadId, user.id]);
  // 同步到 workbench:设置页(存储位置迁移会重启服务)据此判断是否需要二次确认
  React.useEffect(() => {
    setAgentBusy(isBusy);
  }, [isBusy, setAgentBusy]);
  const liveTasks = React.useMemo(() => getTasksFromMessages(messages), [messages]);
  const streamingTasks = React.useMemo(() => {
    const currentMessage = messages.at(-1);
    return isBusy && currentMessage?.role === "assistant"
      ? getTasksFromMessages([currentMessage])
      : undefined;
  }, [isBusy, messages]);
  const visibleTasks = streamingTasks ?? (taskSnapshotLoaded ? tasks : (liveTasks ?? tasks));
  const activeTools = React.useMemo(
    () => (isBusy ? getActiveToolsFromMessages(messages) : []),
    [isBusy, messages],
  );
  const handledPanelToolCallsRef = React.useRef(new Set<string>());
  React.useEffect(() => {
    const handled = handledPanelToolCallsRef.current;
    for (const message of messages) {
      for (const part of message.parts) {
        if (!isToolUIPart(part) || handled.has(part.toolCallId)) continue;
        handled.add(part.toolCallId);
        if (!isBusy) continue;
        const toolName = getToolName(part);
        if (!toolName) continue;
        if (toolName.startsWith("browser_")) {
          openWorkspacePanel("browser");
        } else if (
          toolName.startsWith("mastra_workspace_") &&
          toolName !== "mastra_workspace_execute_command"
        ) {
          openWorkspacePanel("files");
        }
      }
    }
  }, [isBusy, messages, openWorkspacePanel]);
  const streamedBackgroundTasks = React.useMemo(
    () => getBackgroundTasksFromMessages(messages),
    [messages],
  );
  const visibleBackgroundTasks = React.useMemo(() => {
    const merged = new Map(streamedBackgroundTasks.map((task) => [task.id, task]));
    // Merge the persisted snapshot with stream updates. The manager snapshot
    // may be older than a terminal event that arrived on this connection, so
    // replacing the whole record would make the panel jump backwards.
    for (const task of backgroundTasks) {
      const streamed = merged.get(task.id);
      merged.set(task.id, { ...task, ...(streamed ?? {}) });
    }
    return [...merged.values()];
  }, [backgroundTasks, streamedBackgroundTasks]);
  const subagents = React.useMemo(() => getSubagentsFromMessages(messages), [messages]);
  const streamedWorkflow = React.useMemo(() => getWorkflowStateFromMessages(messages), [messages]);
  const persistedWorkflow = React.useMemo(
    () => getWorkflowStateFromDisplayState(workflowRuns),
    [workflowRuns],
  );
  const workflow = React.useMemo(
    () => mergeWorkflowRuntimeStates(streamedWorkflow, persistedWorkflow),
    [persistedWorkflow, streamedWorkflow],
  );
  const runtimeMembers = React.useMemo<AgentMemberDefinition[]>(() => {
    const members = new Map<string, AgentMemberDefinition>();
    const addMember = (member: AgentMemberDefinition) => {
      if (!members.has(member.id)) members.set(member.id, member);
    };

    for (const [index, subagent] of subagents.entries()) {
      addMember({
        id: `runtime-${subagent.agentType || index + 1}`,
        name: subagent.displayName ?? subagent.agentType,
        profession: t("chat:agents.subagent"),
        description: subagent.task,
        instructions: subagent.task,
        skills: [],
        memoryScope: "thread",
      });
    }

    for (const task of visibleBackgroundTasks) {
      const source = (task.agentId || task.toolName).trim();
      if (!source) continue;
      const agentType = source.replace(/^agent-/, "").replace(/^mastra-work-/, "");
      if (!agentType) continue;
      const displayName =
        agentType === "explorer" ? "Explorer" : agentType === "reviewer" ? "Reviewer" : agentType;
      addMember({
        id: `runtime-${agentType}`,
        name: displayName,
        profession: t("chat:agents.subagent"),
        description: t("chat:panels.backgroundTaskDescription", { name: task.toolName }),
        instructions: t("chat:panels.backgroundTaskDescription", { name: task.toolName }),
        skills: [],
        memoryScope: "thread",
      });
    }

    return [...members.values()];
  }, [subagents, t, visibleBackgroundTasks]);
  const multiAgentProfile = React.useMemo<AgentProfile | null>(() => {
    if (agentSelection.type === "team") {
      const knownMemberIds = new Set(agentSelection.members.map((member) => member.id));
      const runtimeOnlyMembers = runtimeMembers.filter(
        (member) =>
          !knownMemberIds.has(member.id) &&
          !agentSelection.members.some(
            (existing) =>
              existing.id === member.id.replace(/^runtime-/, "") ||
              existing.name.toLocaleLowerCase() === member.name.toLocaleLowerCase(),
          ),
      );
      return runtimeOnlyMembers.length > 0
        ? { ...agentSelection, members: [...agentSelection.members, ...runtimeOnlyMembers] }
        : agentSelection;
    }
    if (runtimeMembers.length === 0) return null;
    const rootMember: AgentMemberDefinition = {
      id: agentSelection.id,
      name: agentSelection.displayName || agentSelection.name,
      profession: agentSelection.profession || t("chat:agents.mainAgent"),
      description: agentSelection.description,
      instructions: agentSelection.instructions,
      skills: agentSelection.skills,
      memoryScope: "thread",
    };
    return {
      ...agentSelection,
      type: "team",
      members: [rootMember, ...runtimeMembers],
      workflow: undefined,
    };
  }, [agentSelection, runtimeMembers]);
  const multiAgentMembers = multiAgentProfile?.members ?? [];
  const agentMemberRuntimes = React.useMemo(
    () =>
      multiAgentProfile
        ? getAgentMemberRuntimes(multiAgentProfile, subagents, workflow, visibleBackgroundTasks)
        : {},
    [multiAgentProfile, subagents, visibleBackgroundTasks, workflow],
  );
  // 成员头像条只属于当前线程已经发生的团队协作。仅选择一个团队、尚未
  // 产生任何委派或 Workflow 运行时，不提前占用输入区空间。
  const hasMultiAgentActivity =
    multiAgentMembers.length > 1 &&
    (subagents.length > 0 || workflow !== null || visibleBackgroundTasks.length > 0);
  const memberActivitySignature = React.useMemo(
    () =>
      [
        multiAgentMembers.map((member) => member.id).join(","),
        subagents.map((subagent) => `${subagent.agentType}:${subagent.status}`).join(","),
        visibleBackgroundTasks.map((task) => `${task.id}:${task.status}`).join(","),
        workflow?.runs.map((run) => `${run.runId}:${run.status}`).join(",") ?? "",
      ].join("|"),
    [multiAgentMembers, subagents, visibleBackgroundTasks, workflow],
  );
  const showMemberSwitcher =
    hasMultiAgentActivity && dismissedMemberActivitySignature !== memberActivitySignature;
  const allSubagentsFinished =
    subagents.length > 0 &&
    subagents.every((subagent) => subagent.status === "completed" || subagent.status === "error");
  // 普通 Agent 的成员组第一项是主 Agent 本身。选中它时继续走原始
  // displayMessages -> MessageItem 渲染，确保与未打开成员视图完全一致。
  const mainAgentMemberId = agentSelection.type === "agent" ? agentSelection.id : null;
  const activeMember =
    activeMemberId && activeMemberId !== mainAgentMemberId
      ? multiAgentMembers.find((member) => member.id === activeMemberId)
      : undefined;
  const memberScopeKey = `${activeThreadId ?? "new"}:${agentSelection.id}`;
  React.useEffect(() => {
    setActiveMemberId(null);
    setDismissedMemberActivitySignature(null);
    setDismissedQueueSignature(null);
  }, [memberScopeKey]);
  React.useEffect(() => {
    setActiveMemberId((current) =>
      hasMultiAgentActivity && current && multiAgentMembers.some((member) => member.id === current)
        ? current
        : null,
    );
  }, [hasMultiAgentActivity, multiAgentMembers]);
  const handleWorkflowAction = React.useCallback(
    async (run: WorkflowRuntimeRun, action: WorkflowRunAction, resumeData?: unknown) => {
      if (!activeThreadId) return;
      try {
        const response = await runWorkflowAction(
          activeThreadId,
          user.id,
          run.workflowId,
          run.runId,
          action,
          resumeData,
        );
        if (!response.ok) {
          toastError(await readErrorPayload(response, t("chat:welcome.toastWorkflowFailed")));
          return;
        }
        // Resume/restart are UI streams. Consume the response so the official
        // workflow run advances to its terminal state and persists its result.
        await response.text();
        await reloadDisplayState();
        await reloadMessages();
      } catch (error) {
        toastError(error, t("chat:welcome.toastWorkflowFailed"));
      }
    },
    [activeThreadId, reloadDisplayState, reloadMessages, t, user.id],
  );
  const interactions = React.useMemo(
    () =>
      persistedInteractions.filter((interaction) => !resolvedInteractionKeys.has(interaction.key)),
    [persistedInteractions, resolvedInteractionKeys],
  );
  const visibleInteractions = status === "submitted" || status === "streaming" ? [] : interactions;
  const displayMessages = React.useMemo(() => buildDisplayMessages(messages), [messages]);

  // 官方 message-scroller-visibility:大纲条目 = 有文本的用户消息(锚定轮次)
  const outlineEntries = React.useMemo(
    () =>
      displayMessages
        .filter((entry) => entry.message.role === "user")
        .map((entry) => ({
          id: entry.message.id,
          text: entry.message.parts
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n")
            .trim(),
        }))
        .filter((entry) => entry.text.length > 0),
    [displayMessages],
  );
  const [resumingKeys, setResumingKeys] = React.useState<Set<string>>(new Set());
  const resumingKeysRef = React.useRef(new Set<string>());

  const handleResumeInteraction = React.useCallback(
    async (interaction: AgentInteraction, resumeData: unknown) => {
      const threadId = activeThreadId;
      if (!threadId) return;
      const resumeKey = `${threadId}:${interaction.key}`;
      if (resumingKeysRef.current.has(resumeKey)) return;
      // State updates are asynchronous and cannot be used as a same-tick mutex.
      // The ref closes the gap between two rapid approval clicks or duplicate UI events.
      resumingKeysRef.current.add(resumeKey);
      setResumingKeys((current) => new Set(current).add(resumeKey));
      // 恢复目标以服务端挂起运行列表为准；不要在恢复前刷新 Chat 内存消息。
      // 刷新会替换 AI SDK 的 tool invocation，导致恢复时找不到 toolCallId。
      try {
        const pending = await fetchSuspendedInteractions(threadId);
        const stillPending = pending.some(
          (item) => item.runId === interaction.runId && item.toolCallId === interaction.toolCallId,
        );
        const chat = getThreadChat(threadId);
        if (!stillPending) {
          setResolvedInteractionKeys((current) => new Set(current).add(interaction.key));
          setPersistedInteractions(pending);
          toast.error(t("chat:welcome.toastToolExpired"));
          return;
        }

        const decision =
          typeof resumeData === "object" && resumeData !== null
            ? (resumeData as { approved?: unknown; reason?: unknown })
            : undefined;
        if (interaction.requiresApproval && typeof decision?.approved !== "boolean")
          throw new Error("Missing approved field in tool approval response");

        // 恢复期间由 visibleInteractions 隐藏面板;只有流成功完成后才标记解决,
        // 失败时保留卡片供用户重试,避免竞态错误把审批项永久吞掉。
        setQueueCanDispatch(false);
        await chat.sendMessage(undefined, {
          body: {
            runId: interaction.runId,
            toolCallId: interaction.toolCallId,
            ...(interaction.requiresApproval ? { approval: resumeData } : { resumeData }),
          },
        });
        setResolvedInteractionKeys((current) => new Set(current).add(interaction.key));
        // 计划获批时服务端会按 transitionsTo 切模式,重新采纳线程设置让选择器跟上
        if (interaction.toolName === "submit_plan" && activeThreadIdRef.current === threadId)
          await refreshThreadSettings();
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error ?? "");
        if (
          /expired|no longer pending|no suspended|no tool invocation|pending task/i.test(detail)
        ) {
          setResolvedInteractionKeys((current) => new Set(current).add(interaction.key));
          setPersistedInteractions(await fetchSuspendedInteractions(threadId).catch(() => []));
          toast.error(t("chat:welcome.toastToolExpired"));
        } else {
          setResolvedInteractionKeys((current) => {
            const next = new Set(current);
            next.delete(interaction.key);
            return next;
          });
          toast.error(t("chat:welcome.toastToolFailed"));
        }
      } finally {
        resumingKeysRef.current.delete(resumeKey);
        setResumingKeys((current) => {
          const next = new Set(current);
          next.delete(resumeKey);
          return next;
        });
      }
    },
    [activeThreadId, fetchSuspendedInteractions, getThreadChat, refreshThreadSettings],
  );

  /**
   * 「始终允许此类」:把该类别写成 allow 并**等写入完成**再批准本次调用。
   * 顺序不能反 —— resume 是一次新的 HTTP 请求,chat 路由会重新从 thread.metadata
   * 读规则,规则没落库就批准的话,这一轮之后的同类工具仍会继续弹审批。
   */
  const handleAlwaysAllowCategory = React.useCallback(
    async (category: ToolCategory) => {
      if (!activeThreadId) return;
      await setPermissionRules(withCategoryPolicy(permissionRules, category, "allow"));
    },
    [activeThreadId, permissionRules, setPermissionRules],
  );

  const lastMessage = messages.at(-1);
  // 优先读取本次响应的 metadata;刷新后则从线程元数据恢复最后一次真实用量
  // —— 两者都来自模型供应商 usage,不再用消息字符数推算。
  const streamedUsage = (
    [...messages].reverse().find((m) => m.role === "assistant")?.metadata as
      | { usage?: LanguageModelUsage }
      | undefined
  )?.usage;
  const persistedUsage = activeThread?.metadata.contextUsage as LanguageModelUsage | undefined;
  const latestUsage = streamedUsage ?? persistedUsage;
  const usedContextTokens = Math.max(0, latestUsage?.inputTokens ?? 0);
  const responseReserve = Math.min(8_192, Math.floor((selectedContextWindow ?? 32_000) * 0.1));
  const attachmentTokenBudget = Math.max(
    0,
    (selectedContextWindow ?? 32_000) - usedContextTokens - responseReserve,
  );
  React.useEffect(() => {
    attachmentTokenBudgetRef.current = attachmentTokenBudget;
  }, [attachmentTokenBudget]);
  const streamingMessageId =
    status === "streaming" && lastMessage?.role === "assistant" ? lastMessage.id : undefined;

  // 官方 message-actions:发送失败的行内常驻提示。瞬时错误自动重连期间
  // status 短暂为 error,延迟 2s 确认避免闪烁(见 useDelayedTrue)。
  const failedUserMessage =
    status === "error" && lastMessage?.role === "user" ? lastMessage : undefined;
  const sendFailed = useDelayedTrue(Boolean(failedUserMessage), 2000);

  // 行内重试:同 messageId 的 sendMessage 会替换该用户消息并重新触发请求
  // (AI SDK 语义),服务端 chat 路由按 submit-message + messageId 截断重跑。
  const handleRetrySend = React.useCallback(() => {
    const failed = failedUserMessage;
    if (!failed) return;
    setQueueCanDispatch(false);
    rewriteRefreshRef.current = true;
    const text = failed.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    const files = failed.parts.filter((part) => part.type === "file");
    void activeChat.sendMessage(
      text
        ? { text, files, metadata: failed.metadata, messageId: failed.id }
        : { files, metadata: failed.metadata, messageId: failed.id },
    );
  }, [activeChat, failedUserMessage]);

  // 从某条消息处创建分支(官方 cloneThread 的 messageFilter 截断):复制截至
  // 该消息(含)的历史到新线程并切换过去。聚合助手消息的 id 是末条源消息 id,
  // 截断点恰好包含整轮回复。
  const handleForkFromMessage = React.useCallback(
    async (messageId: string) => {
      const threadId = activeThreadId;
      if (!threadId) return;
      const clone = await cloneThreadAsync({ threadId, upToMessageId: messageId }).catch(
        () => null,
      );
      if (clone) toast.success(t("chat:welcome.toastBranchCreated", { title: clone.title }));
      else toast.error(t("chat:welcome.toastBranchFailed"));
    },
    [activeThreadId, cloneThreadAsync, t],
  );

  // 始终返回同一层级的 MessageScrollerItem,避免相邻用户消息出现时因增加
  // Fragment/分组父节点而重建旧锚点。showAvatar 只控制视觉,不改变 DOM 身份。
  const renderMessageItem = (entry: DisplayMessage, showAvatar = true) => (
    <MessageItem
      isGenerating={isBusy}
      isStreaming={entry.sourceIds.includes(streamingMessageId ?? "")}
      key={entry.sourceIds[0]}
      message={entry.message}
      onEdit={handleEdit}
      onForkFromMessage={handleForkFromMessage}
      onRetry={handleRetry}
      onRetrySend={handleRetrySend}
      onToggleReaction={handleToggleReaction}
      showAvatar={showAvatar}
      sendFailed={
        sendFailed && failedUserMessage !== undefined && entry.message.id === failedUserMessage.id
      }
      userId={user.id}
    />
  );

  const handleSubmit = async (
    message: {
      text: string;
      files?: FileUIPart[];
      skills?: string[];
      fileReferences?: MessageFileReference[];
    },
    clearPrompt: () => void,
  ) => {
    const text = message.text.trim();
    const files = message.files ?? [];
    if (!(text || files.length > 0 || (message.skills ?? []).length > 0)) return;

    if (isBusy) {
      const threadId = activeThreadIdRef.current;
      if (!threadId) return;
      try {
        const persistedFiles = await persistAttachments(files, threadId);
        let queuedOnServer = false;
        const onlyNativeFollowUps = queuedRequests.every((request) =>
          Boolean(request.queuedOnServer),
        );
        if (text && persistedFiles.length === 0 && onlyNativeFollowUps) {
          const payload = await enqueueFollowUp(threadId, user.id, {
            content: text,
            ...(selectedProvider && modelSelection
              ? {
                  model: buildRequestModel(selectedProvider, modelSelection.modelId),
                  ...(modelSelection.reasoningEffort !== "off"
                    ? buildReasoningRequest(selectedProvider, modelSelection.reasoningEffort)
                    : {}),
                }
              : {}),
            ...(searchSelection ? { webSearch: searchSelection } : {}),
            agentProfileId: agentSelection.id,
            metadata: {
              skillNames: message.skills ?? [],
              fileReferences: message.fileReferences ?? [],
            },
          });
          queuedOnServer = payload.queued;
        }
        setQueuedRequests((current) => [
          ...current,
          {
            id: nanoid(),
            text,
            files: persistedFiles,
            skills: message.skills,
            fileReferences: message.fileReferences,
            queuedOnServer,
          },
        ]);
      } catch (error) {
        toastError(error, t("chat:welcome.toastAttachmentSaveFailed"));
        return;
      }
      clearPrompt();
      return;
    }

    // 未锁定线程的首条消息会消费工作区选定(workspaceLocked 在发送前快照)
    const consumesWorkspaceSelection = !workspaceLocked;

    // 无激活线程时,先创建线程再发送。标记必须早于 mutation:mutation 的
    // onSuccess 会先切路由,随后 mutateAsync 才把新线程返回到这里。
    const initialSend: { threadId: string | null } | null = activeThreadId
      ? null
      : { threadId: null };
    if (initialSend) {
      initialSendRef.current = initialSend;
      const thread = await createThreadMutation.mutateAsync().catch(() => null);
      if (!thread) {
        if (initialSendRef.current === initialSend) initialSendRef.current = null;
        toast.error(t("chat:welcome.toastCreateSessionFailed"));
        return;
      }
      initialSend.threadId = thread.id;
      // 立即更新 ref:sendMessage 读到的是最新 threadId,不等 re-render
      activeThreadIdRef.current = thread.id;
    }

    const targetThreadId = activeThreadIdRef.current;
    if (!targetThreadId) {
      if (initialSendRef.current === initialSend) initialSendRef.current = null;
      return;
    }
    let persistedFiles: LibraryFilePart[];
    try {
      persistedFiles = await persistAttachments(files, targetThreadId);
    } catch (error) {
      if (initialSendRef.current === initialSend) initialSendRef.current = null;
      toastError(error, t("chat:welcome.toastAttachmentSaveFailed"));
      return;
    }
    clearPrompt();
    setQueueCanDispatch(false);
    selectedSkillNamesRef.current = message.skills ?? [];
    // 显式发到目标线程自己的 Chat 实例:新建线程时渲染层还没切过去,
    // 用渲染时绑定的实例会把消息发进上一条线程。
    await getThreadChat(targetThreadId)
      .sendMessage(
        text
          ? {
              text,
              files: persistedFiles,
              metadata: {
                skillNames: message.skills ?? [],
                fileReferences: message.fileReferences ?? [],
              },
            }
          : {
              files: persistedFiles,
              metadata: {
                skillNames: message.skills ?? [],
                fileReferences: message.fileReferences ?? [],
              },
            },
      )
      .finally(() => {
        if (initialSendRef.current === initialSend) initialSendRef.current = null;
      });
    // prepareThreadSession 已将首条消息携带的显式目录写入线程元数据;
    // 立即同步线程列表,避免右侧工作区继续显示“未绑定”。
    await invalidateThreads(userId);
    selectedSkillNamesRef.current = [];
    // 工作区选定已随首条消息上传,清空待选状态(选择器此后不再渲染)
    if (consumesWorkspaceSelection) setPendingWorkspacePath(null);
  };

  const removeQueuedRequest = React.useCallback((id: string) => {
    setQueuedRequests((current) => current.filter((request) => request.id !== id));
  }, []);

  const reorderQueuedRequests = React.useCallback((activeId: string, overId: string) => {
    setQueuedRequests((current) => {
      const from = current.findIndex((request) => request.id === activeId);
      const to = current.findIndex((request) => request.id === overId);
      return from === -1 || to === -1 ? current : arrayMove(current, from, to);
    });
  }, []);

  // 「立即转向」:打断当前回合,把指定排队请求直接发出(失败放回队首)。
  //
  // 服务端 session.steer() 会 abort 当前 run 并 clearFollowUps(),因此已被
  // 服务端会话接受的 native follow-up 全部作废 —— 前端必须同步
  // 清掉它们(带 queuedOnServer 的项),否则界面上会留下永远不会被执行的幽灵项。
  // 纯本地排队项不受影响,继续按顺序等下一回合。
  const steerQueuedRequestNow = React.useCallback(
    (request: QueuedRequest) => {
      const targetThreadId = activeThreadIdRef.current;
      if (!targetThreadId || sendingQueuedRequest.current) return;
      if (request.files.length > 0) {
        toast.error(t("chat:welcome.toastQueueWithAttachments"));
        return;
      }
      sendingQueuedRequest.current = true;
      setQueueCanDispatch(false);
      setQueuedRequests((current) =>
        current.filter((item) => item.id !== request.id && !item.queuedOnServer),
      );
      void (async () => {
        await getThreadChat(targetThreadId).stop();
        await getThreadChat(targetThreadId).sendMessage(
          {
            text: request.text,
            metadata: {
              skillNames: request.skills ?? [],
              fileReferences: request.fileReferences ?? [],
            },
          },
          {
            body: {
              agentProfileId: agentSelection.id,
              sessionAction: "steer",
              sessionScope: "workbench",
            },
          },
        );
      })()
        .catch(() => {
          setQueuedRequests((current) => [request, ...current]);
          toast.error(t("chat:welcome.toastSteerFailed"));
        })
        .finally(() => {
          sendingQueuedRequest.current = false;
          setQueueDispatchVersion((version) => version + 1);
        });
    },
    [agentSelection.id, getThreadChat, t],
  );

  const sendingQueuedRequest = React.useRef(false);
  // queueDispatchVersion 是故意的重触发器:一条排队请求发送完毕后
  // 立即重新评估队列,即使其余依赖未变化
  React.useEffect(() => {
    const workflowBlocksQueue = Boolean(workflow?.active);
    if (
      status !== "ready" ||
      !activeThreadId ||
      !queueCanDispatch ||
      interactions.length > 0 ||
      workflowBlocksQueue ||
      queuedRequests.length === 0 ||
      sendingQueuedRequest.current
    ) {
      return;
    }

    const nextRequest = queuedRequests[0];
    if (!nextRequest) return;
    sendingQueuedRequest.current = true;
    setQueueCanDispatch(false);
    const request = nextRequest.queuedOnServer
      ? getThreadChat(activeThreadId).resumeStream()
      : (() => {
          selectedSkillNamesRef.current = nextRequest.skills ?? [];
          return getThreadChat(activeThreadId).sendMessage(
            nextRequest.text
              ? {
                  text: nextRequest.text,
                  files: nextRequest.files,
                  metadata: {
                    skillNames: nextRequest.skills ?? [],
                    fileReferences: nextRequest.fileReferences ?? [],
                  },
                }
              : {
                  files: nextRequest.files,
                  metadata: {
                    skillNames: nextRequest.skills ?? [],
                    fileReferences: nextRequest.fileReferences ?? [],
                  },
                },
          );
        })();
    void request
      .then(async () => {
        if (nextRequest.queuedOnServer) await reloadMessages();
        setQueuedRequests((current) => current.filter((queued) => queued.id !== nextRequest.id));
      })
      .catch(() => {
        toast.error(t("chat:welcome.toastQueueSendFailed"));
      })
      .finally(() => {
        selectedSkillNamesRef.current = [];
        sendingQueuedRequest.current = false;
        setQueueDispatchVersion((version) => version + 1);
      });
  }, [
    activeThreadId,
    getThreadChat,
    interactions.length,
    queueCanDispatch,
    queueDispatchVersion,
    queuedRequests,
    reloadMessages,
    status,
    workflow,
  ]);

  // 输入区(Queue 卡片 + 工作区卡片 + 输入框):新会话时垂直居中展示,
  // 有消息后固定底部 —— 同一份 JSX,两种布局复用。
  const queueContentSignature = React.useMemo(
    () =>
      [
        visibleTasks.map((task) => `${task.id}:${task.status}`).join(","),
        activeTools.map((tool) => `${tool.toolCallId}:${tool.status}`).join(","),
        queuedRequests.filter((request) => request.queuedOnServer).length,
      ].join("|"),
    [activeTools, queuedRequests, visibleTasks],
  );
  const showAgentQueue =
    !dismissedQueueSignature || dismissedQueueSignature !== queueContentSignature;
  const hasQueueCard =
    queuedRequests.length > 0 ||
    (showAgentQueue && (visibleTasks.length > 0 || activeTools.length > 0));
  const promptArea = (
    <PromptInputProvider
      persistenceKey={`mastra-work:prompt:${user.id}:${activeThreadId ?? "new"}`}
    >
      {/* 排队请求与任务共用一张 Queue 卡片(各自渲染内部 section,空态自渲染
          为 null):两个队列本是一体 —— 用户排的"接下来做什么"和 Agent 正在
          做的任务。
          外层 max-w-3xl 容器与下方输入框同宽基准,w-[96%] 才是"略窄于输入框"
          (工作区卡片同规格,见 workspace-selector.tsx)。 */}
      {showMemberSwitcher ? (
        <div className="mx-auto mb-1 w-full max-w-3xl px-1">
          <AgentMemberSwitcher
            activeMemberId={activeMemberId}
            members={multiAgentMembers}
            onSelect={(memberId) =>
              setActiveMemberId((current) => (current === memberId ? null : memberId))
            }
            onClose={
              allSubagentsFinished
                ? () => {
                    setActiveMemberId(null);
                    setDismissedMemberActivitySignature(memberActivitySignature);
                  }
                : undefined
            }
            runtimes={agentMemberRuntimes}
          />
        </div>
      ) : null}
      {hasQueueCard ? (
        <div className="mx-auto w-full max-w-3xl">
          <Queue className="mx-auto w-[96%] rounded-b-none border-b-0 px-2 pt-1 pb-1">
            <UserRequestQueuePanel
              onRemove={removeQueuedRequest}
              onReorder={reorderQueuedRequests}
              onSteerNow={steerQueuedRequestNow}
              requests={queuedRequests}
            />
            <AgentQueuePanel
              activeTools={activeTools}
              onClose={() => setDismissedQueueSignature(queueContentSignature)}
              queuedFollowUps={queuedRequests.filter((request) => request.queuedOnServer).length}
              tasks={showAgentQueue ? visibleTasks : []}
            />
          </Queue>
        </div>
      ) : null}

      <WorkflowRunPanel onAction={handleWorkflowAction} workflow={workflow} />

      <div className="mx-auto w-full max-w-3xl">
        <AgentInteractionPanel
          busyKeys={resumingKeys}
          interactions={visibleInteractions}
          messages={messages}
          onAlwaysAllow={handleAlwaysAllowCategory}
          onResume={handleResumeInteraction}
          threadId={activeThreadId}
        />
        {visibleInteractions.length === 0 ? (
          <>
            {/* 工作区卡片与输入框相接;上方还有 Queue 卡片时去掉顶边连成一体 */}
            {!workspaceLocked ? (
              <ChatWorkspaceSelector
                className={hasQueueCard ? "rounded-t-none border-t-0" : undefined}
                value={pendingWorkspacePath}
                onChange={setPendingWorkspacePath}
              />
            ) : null}
            <ChatPromptInput
              activeThread={Boolean(activeThread)}
              usage={latestUsage}
              onSubmit={handleSubmit}
              status={status}
              onStop={handleStop}
              attachmentTokenBudget={attachmentTokenBudget}
              attachmentCapabilities={selectedCapabilities}
            />
          </>
        ) : null}
      </div>
    </PromptInputProvider>
  );

  return (
    // 官方 streaming 组合:autoScroll + 用户消息 scrollAnchor —— 新回合把
    // 用户气泡锚定在视口顶部、回复在下方流入,长过视口后交接为跟随底部;
    // 任何方式上滚(滚轮/触摸/键盘/滚动条)后位置稳定,跳转按钮回底并恢复
    // 跟随(滚动条拖动的解除由 ui/message-scroller 包装层补偿)。
    <MessageScrollerProvider
      autoScroll
      defaultScrollPosition="last-anchor"
      scrollPreviousItemPeek={48}
    >
      <ChatPanelScrollerController
        pendingJump={pendingJump}
        activeThreadId={activeThreadId}
        messagesCount={messages.length}
        onClearPendingJump={() => setPendingJump(null)}
      />
      <div className="flex size-full min-h-0 flex-col">
        {/* 空态判定必须同步:切到有历史的线程时,messages 在历史 fetch 完成前
            是空数组,仅凭 messages.length===0 判空会先闪一帧居中的新会话布局。
            用 draft 区分 —— 新建会话创建的是 draft 线程(服务端保证无历史消息,
            一有往来即失效),有历史的线程非 draft,加载期间稳定走聊天布局。 */}
        {messages.length === 0 &&
        !isBusy &&
        (!activeThread || activeThread.metadata.draft === true) ? (
          // 新会话: Magic UI 点阵背景 + 粒子光效 + 快捷灵感卡片 + 居中输入区
          <div className="relative flex min-h-0 flex-1 flex-col items-center justify-center gap-6 px-4 pb-12 overflow-hidden">
            <DotPattern className="opacity-40 [mask-image:radial-gradient(ellipse_at_center,white,transparent_75%)]" />
            {/* 流星层:只在空会话出现,发出首条消息后整块卸载 */}
            <Meteors
              className="pointer-events-none"
              number={14}
              minDelay={0.6}
              maxDelay={4}
              minDuration={4}
              maxDuration={11}
            />
            <BlurFade delay={0.05} inView>
              <div className="flex flex-col items-center text-center gap-2">
                <div className="flex items-center gap-2">
                  <SparklesText
                    text={t("chat:welcome.title")}
                    className="text-xl md:text-2xl font-bold tracking-tight"
                  />
                </div>
                {activeThread ? (
                  <AnimatedShinyText className="text-xs text-muted-foreground max-w-md">
                    {t("chat:welcome.continueOrExplore", { title: activeThread.title })}
                  </AnimatedShinyText>
                ) : (
                  /* 逐句打字轮播:比一句静态副标题更能说清这个工作台能做什么 */
                  <TypingAnimation
                    className="max-w-md text-xs text-muted-foreground"
                    typeSpeed={45}
                    deleteSpeed={22}
                    pauseDelay={2200}
                    loop
                    words={(() => {
                      const subtitles = t("chat:welcome.subtitles", { returnObjects: true });
                      return Array.isArray(subtitles) ? (subtitles as string[]) : [];
                    })()}
                  />
                )}
              </div>
            </BlurFade>

            {/* 4 张快捷提示卡片 */}
            <div className="w-full max-w-2xl">
              <ItemGroup className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                {[
                  {
                    title: t("chat:welcome.starters.archTitle"),
                    desc: t("chat:welcome.starters.archDesc"),
                    prompt: t("chat:welcome.starters.archPrompt"),
                  },
                  {
                    title: t("chat:welcome.starters.workflowTitle"),
                    desc: t("chat:welcome.starters.workflowDesc"),
                    prompt: t("chat:welcome.starters.workflowPrompt"),
                  },
                  {
                    title: t("chat:welcome.starters.testTitle"),
                    desc: t("chat:welcome.starters.testDesc"),
                    prompt: t("chat:welcome.starters.testPrompt"),
                  },
                  {
                    title: t("chat:welcome.starters.kbTitle"),
                    desc: t("chat:welcome.starters.kbDesc"),
                    prompt: t("chat:welcome.starters.kbPrompt"),
                  },
                ].map((starter, index) => (
                  /* 逐张错位浮现(与 skill-hub 卡片列表同一手法),而不是整块一起淡入 */
                  <BlurFade
                    key={starter.title}
                    delay={0.12 + index * 0.06}
                    duration={0.28}
                    blur="4px"
                    inView
                  >
                    <Item
                      render={
                        <button
                          type="button"
                          onClick={() => {
                            handleSubmit({ text: starter.prompt, files: [] }, () => undefined);
                          }}
                        />
                      }
                      className="flex h-full w-full cursor-pointer flex-col items-start justify-between gap-1 rounded-xl border border-border bg-card/70 p-3 shadow-xs transition-all duration-200 hover:border-primary/40 hover:bg-card text-left"
                    >
                      <ItemContent className="w-full min-w-0">
                        <ItemTitle className="w-full truncate text-xs font-semibold text-foreground">
                          {starter.title}
                        </ItemTitle>
                        <ItemDescription className="line-clamp-2 text-[11px] leading-relaxed text-muted-foreground">
                          {starter.desc}
                        </ItemDescription>
                      </ItemContent>
                    </Item>
                  </BlurFade>
                ))}
              </ItemGroup>
            </div>

            <div className="w-full relative z-10">{promptArea}</div>
          </div>
        ) : (
          <>
            {/* 分支溯源横幅(官方 isClone / getSourceThread):点击跳回原会话 */}
            {activeThread?.metadata.clone ? (
              <div className="flex min-h-0 shrink-0 items-center gap-2 border-b bg-muted/40 px-4 py-1.5 text-xs">
                <GitBranchIcon className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 truncate text-muted-foreground">
                  {t("chat:welcome.forkedFrom")}
                  <span className="font-medium text-foreground">
                    {cloneSource?.title ?? t("chat:welcome.originalSession")}
                  </span>
                </span>
                {cloneSource ? (
                  <Button
                    className="h-6 shrink-0 px-2 text-xs"
                    onClick={() => selectThread(cloneSource.id)}
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    {t("chat:welcome.viewOriginal")}
                  </Button>
                ) : null}
              </div>
            ) : null}
            <MessageScroller className="flex-1">
              <MessageScrollerViewport
                onScroll={(event) => {
                  // 官方 message-scroller-load-history:接近顶部时加载更早历史
                  if (event.currentTarget.scrollTop <= 64) loadEarlierHistory();
                }}
              >
                <MessageScrollerContent
                  aria-busy={isBusy}
                  className="mx-auto w-full max-w-3xl px-4 py-6"
                >
                  {activeMember ? (
                    <AgentMemberMessageView
                      isBusy={isBusy}
                      member={activeMember}
                      messages={messages}
                      runtime={
                        agentMemberRuntimes[activeMember.id] ?? { status: "idle", entries: [] }
                      }
                    />
                  ) : (
                    // key 取合并消息的**首条**源消息 id:每跨一个工具/推理边界,Mastra 就再封
                    // 一条 assistant 行并被合并进同一组(见 buildDisplayMessages),sourceIds
                    // 因此在流式途中不断增长。用全量拼接当 key 会让 key 每次都变,React 于是
                    // 销毁重建整条消息的 DOM —— 既白扔掉工具卡片的展开态,又让 MessageScroller
                    // 把全新元素当成没锚定过的新锚点反复重锚,滚动状态store 每轮同步翻新一次,
                    // 嵌套更新计数一路累加到上限。组的起点一旦建立就不再变,是唯一稳定的身份。
                    displayMessages.map((entry, index) =>
                      renderMessageItem(
                        entry,
                        entry.message.role !== "user" ||
                          displayMessages[index + 1]?.message.role !== "user",
                      ),
                    )
                  )}
                  {!activeMember && isBusy && lastMessage?.role !== "assistant" ? (
                    <MessageScrollerItem messageId="typing-indicator">
                      <Message>
                        <MessageAvatar className="self-start">
                          <AssistantAvatar />
                        </MessageAvatar>
                        <MessageContent>
                          <MessageHeader className="px-0">MastraWork</MessageHeader>
                          <div className="flex items-center gap-2 text-xs text-muted-foreground font-medium">
                            <DotmSquare3 size={15} dotSize={2} colorPreset="solid-theme" />
                            <WordRotate
                              words={
                                t("chat:welcome.deepThinkingRotations", {
                                  returnObjects: true,
                                }) as string[]
                              }
                              duration={6000}
                              className="text-xs text-primary"
                            />
                          </div>
                        </MessageContent>
                      </Message>
                    </MessageScrollerItem>
                  ) : null}
                  {/* 压缩进行中 Marker(marker-status / marker-shimmer):仅压缩期间显示。
                      完成态不再在此渲染 —— 摘要消息已位于线程头部,由消息流中的
                      CompactedMessageCard 展示(分隔线 + 摘要 + 可展开折叠历史)。 */}
                </MessageScrollerContent>
              </MessageScrollerViewport>
              <MessageScrollerButton />
              {/* 官方 message-scroller-visibility:右侧会话大纲(≥2 个提问轮次才出现)。
                  容器 pointer-events-none 防挡住消息区滚动,触发按钮自身恢复交互。 */}
              {outlineEntries.length >= 2 ? (
                <div className="pointer-events-none absolute inset-y-0 right-2 flex items-center">
                  <TranscriptOutline entries={outlineEntries} />
                </div>
              ) : null}
            </MessageScroller>
            <div className="relative z-10 shrink-0 bg-background px-4 pb-4">{promptArea}</div>
          </>
        )}
      </div>
    </MessageScrollerProvider>
  );
}
