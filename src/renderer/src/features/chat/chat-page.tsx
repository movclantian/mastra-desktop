import { useChat } from "@ai-sdk/react";
import { arrayMove } from "@dnd-kit/sortable";
import type { FileUIPart, LanguageModelUsage } from "ai";
import { nanoid } from "nanoid";
import * as React from "react";
import { toast } from "sonner";
import { PromptInputProvider } from "@/components/ai-elements/prompt-input";
import { Queue } from "@/components/ai-elements/queue";
import { AnimatedShinyText } from "@/components/ui/animated-shiny-text";
import { BlurFade } from "@/components/ui/blur-fade";
import { DotPattern } from "@/components/ui/dot-pattern";
import { DotmSquare3 } from "@/components/ui/dotm-square-3";
import { MagicCard } from "@/components/ui/magic-card";
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker";
import { Message, MessageAvatar, MessageContent, MessageHeader } from "@/components/ui/message";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import { SparklesText } from "@/components/ui/sparkles-text";
import { Spinner } from "@/components/ui/spinner";
import { WordRotate } from "@/components/ui/word-rotate";
import {
  buildReasoningRequest,
  buildRequestModel,
  getModelCapabilities,
  getModelContextWindow,
} from "@/features/providers";
import type { ToolCategory } from "@/features/session/session-policy";
import { useWorkbench } from "@/features/workbench";
import { readErrorPayload, toastError } from "@/lib/errors";
import {
  abortThread,
  createCompactedEdit,
  enqueueFollowUp,
  fetchDisplayState as fetchDisplayStateRequest,
  fetchThreadMessages as fetchThreadMessagesRequest,
  grantToolCategory,
  runBackgroundTaskAction,
  runWorkflowAction,
  summarizeThread,
  updateMessageBranch,
} from "./api";
import { subscribeBackgroundTaskStream } from "./background-task-stream";
import type { BackgroundTaskAction, WorkflowRunAction } from "./components";
import {
  AgentInteractionPanel,
  AgentQueuePanel,
  AssistantAvatar,
  ChatPromptInput,
  ChatWorkspaceSelector,
  MessageItem,
  UserRequestQueuePanel,
  WorkflowRunPanel,
} from "./components";
import { usePlaceholderChat, useThreadChats } from "./hooks/use-thread-chats";
import { persistAttachments as uploadAttachments } from "./lib/attachments";
import { buildDisplayMessages } from "./lib/display";
import {
  type AgentInteraction,
  type AgentTask,
  areTasksEqual,
  type BackgroundTaskState,
  type CompressResult,
  getActiveToolsFromMessages,
  getBackgroundTasksFromMessages,
  getMessageInteractions,
  getSubagentsFromMessages,
  getTasksFromMessages,
  getToolName,
  getWorkflowStateFromDisplayState,
  getWorkflowStateFromMessages,
  isToolPart,
  type LibraryFilePart,
  type MessageBranchRecord,
  type MessageBranchVersion,
  type MessageFileReference,
  mergeInteractions,
  mergeWorkflowRuntimeStates,
  parseSuspendedRuns,
  type QueuedRequest,
  type WorkDisplayState,
  type WorkflowRuntimeRun,
  type WorkUIMessage,
} from "./types";

// ---------------------------------------------------------------------------
// 会话面板
// ---------------------------------------------------------------------------

export function ChatPanel() {
  const {
    user,
    threads,
    activeThreadId,
    setActiveThreadId,
    createThread,
    renameThread,
    providers,
    modelSelection,
    agentSelection,
    searchSelection,
    cloneThread,
    refreshThreads,
    pendingJump,
    setPendingJump,
    catalog,
    refreshThreadSettings,
    setThreadBusy,
    setAgentBusy,
    openWorkspacePanel,
    setTerminalPanelOpen,
  } = useWorkbench();

  const activeThread = threads.find((t) => t.id === activeThreadId);
  // 工作区选定(promptInput 顶部选择器):随未锁定线程的首条消息以
  // body.workspacePath 上传,服务端绑定后选择器隐藏(会话目录不可中途更换)
  const [pendingWorkspacePath, setPendingWorkspacePath] = React.useState<string | null>(null);
  const [compacting, setCompacting] = React.useState(false);
  const [compressResult, setCompressResult] = React.useState<CompressResult | null>(null);
  const [tasks, setTasks] = React.useState<AgentTask[]>([]);
  const [taskSnapshotLoaded, setTaskSnapshotLoaded] = React.useState(false);
  const [queuedRequests, setQueuedRequests] = React.useState<QueuedRequest[]>([]);
  const [queueDispatchVersion, setQueueDispatchVersion] = React.useState(0);
  const [queueCanDispatch, setQueueCanDispatch] = React.useState(false);
  const [persistedInteractions, setPersistedInteractions] = React.useState<AgentInteraction[]>([]);
  const [backgroundTasks, setBackgroundTasks] = React.useState<BackgroundTaskState[]>([]);
  const [workflowRuns, setWorkflowRuns] = React.useState<WorkDisplayState["workflowRuns"]>([]);
  const [messageBranches, setMessageBranches] = React.useState<Record<string, MessageBranchRecord>>(
    {},
  );
  const [resolvedInteractionKeys, setResolvedInteractionKeys] = React.useState<Set<string>>(
    () => new Set(),
  );
  const [estimatedContextTokens, setEstimatedContextTokens] = React.useState(0);
  const displayStateRequestId = React.useRef(0);
  const branchRefreshRef = React.useRef(false);

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

  // 官方 Memory.cloneThread:按消息 ID 精确选择克隆内容,从而表达对话前缀。
  const handleCloneThread = React.useCallback(
    async (selection?: { messageIds?: string[] }) => {
      if (!activeThreadId) return;
      const thread = await cloneThread(activeThreadId, selection);
      const singleMessage = selection?.messageIds?.length === 1;
      if (thread) {
        toast.success(
          singleMessage
            ? `已将选定消息克隆到新线程「${thread.title}」`
            : `已克隆到新线程「${thread.title}」`,
        );
      } else {
        toast.error("克隆线程失败");
      }
    },
    [activeThreadId, cloneThread],
  );

  // 最新 threadId 的 ref:解决「首条消息先建线程再发送」时
  // memoized transport 持有旧值的竞态
  const activeThreadIdRef = React.useRef(activeThreadId);
  activeThreadIdRef.current = activeThreadId;
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
    // 模型形态快照(不含 Key/url):服务端写进 thread.metadata.modelSelection,
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

  // 工作区锁定:线程已绑定目录或已有消息往来;锁定后隐藏 promptInput 选择器
  const workspaceLocked = Boolean(activeThread?.metadata.workspacePath) || messages.length > 0;
  workspaceLockedRef.current = workspaceLocked;

  const handleCloneFromHere = React.useCallback(
    (messageIndex: number) => {
      const messageIds = messages
        .slice(0, messageIndex + 1)
        .map((message) => message.id)
        .filter((id): id is string => Boolean(id));
      if (messageIds.length > 0) void handleCloneThread({ messageIds });
    },
    [handleCloneThread, messages],
  );

  const handleCloneMessage = React.useCallback(
    (messageId: string, messageIndex: number) => {
      const selectedIndex = Math.max(
        0,
        messages.findIndex((message) => message.id === messageId),
        messageIndex,
      );
      const selected = messages[selectedIndex];
      if (!selected) return;

      // An assistant-only history is not a valid continuation context. Clone
      // the user turn plus every assistant row belonging to that turn.
      const startIndex =
        selected.role === "assistant"
          ? Math.max(
              0,
              messages
                .slice(0, selectedIndex + 1)
                .findLastIndex((message) => message.role === "user"),
            )
          : selectedIndex;
      const messageIds = messages
        .slice(startIndex, selectedIndex + 1)
        .map((message) => message.id)
        .filter((id): id is string => Boolean(id));
      if (messageIds.length > 0) void handleCloneThread({ messageIds });
    },
    [handleCloneThread, messages],
  );

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
    void refreshThreads();
  }, [activeThread?.metadata.workspacePath, activeThreadId, messages.length, refreshThreads]);

  // 首轮会话流式完成时（状态由 streaming 变为 ready）：立即刷新线程列表，实时呈现服务端智能起名的标题
  const previousStatusRef = React.useRef(status);
  React.useEffect(() => {
    const wasStreaming = previousStatusRef.current === "streaming";
    previousStatusRef.current = status;
    if (wasStreaming && status === "ready" && activeThreadId) {
      void refreshThreads();
    }
  }, [activeThreadId, refreshThreads, status]);

  // 从服务端拉取历史消息并重建消息流(线程切换 / 压缩后刷新共用)。
  //
  // setMessages 恒定写「当前」Chat(useChat 里它闭包的是一个永久稳定的 ref),
  // 所以必须校验归属:快速切换时 A 的历史可能在 B 已激活后才返回,写进去等于
  // 用 A 的旧历史覆盖 B —— B 若正在流式,这一下就把流打断在视觉上。
  const reloadMessages = React.useCallback(() => {
    const threadId = activeThreadId;
    if (!threadId) {
      setMessages([]);
      setMessageBranches({});
      return Promise.resolve();
    }
    return fetchThreadMessagesRequest(threadId, user.id)
      .then(
        (data: { messages: WorkUIMessage[]; branches?: Record<string, MessageBranchRecord> }) => {
          if (activeThreadIdRef.current !== threadId) return;
          setMessages(data.messages ?? []);
          setMessageBranches(data.branches ?? {});
        },
      )
      .catch(() => {
        if (activeThreadIdRef.current === threadId) {
          setMessages([]);
          setMessageBranches({});
        }
      });
  }, [activeThreadId, setMessages, user.id]);

  const fetchDisplayState = React.useCallback(
    async (threadId: string) => {
      const payload = await fetchDisplayStateRequest(threadId, user.id);
      if (!payload.displayState) return undefined;
      return {
        ...payload.displayState,
        tasks: Array.isArray(payload.displayState.tasks) ? payload.displayState.tasks : [],
        suspendedRuns: parseSuspendedRuns(payload.displayState.suspendedRuns),
      } satisfies WorkDisplayState;
    },
    [user.id],
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
    if (activeChat.messages.length === 0 && activeChat.status === "ready") {
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: 故意的额外依赖
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
   * handleChatStream 据此把那条助手消息从输入里切掉再重跑(见 transport 的注释)。
   */
  const handleRetry = React.useCallback(
    (messageId: string) => {
      setQueueCanDispatch(false);
      branchRefreshRef.current = true;
      void activeChat.regenerate({ messageId });
    },
    [activeChat],
  );

  const handleEdit = React.useCallback(
    (messageId: string, text: string) => {
      setQueueCanDispatch(false);
      branchRefreshRef.current = true;
      void activeChat.sendMessage({ text, messageId });
    },
    [activeChat],
  );

  const handleCompactedEdit = React.useCallback(
    async (messageId: string, text: string) => {
      if (!activeThreadId) return;
      try {
        const data = await createCompactedEdit(activeThreadId, user.id, messageId, text);
        await refreshThreads();
        setActiveThreadId(data.threadId);
        await getThreadChat(data.threadId).sendMessage({ text });
      } catch (error) {
        toastError(error, "无法创建修正分支");
      }
    },
    [activeThreadId, getThreadChat, refreshThreads, setActiveThreadId, user.id],
  );

  const handleBranchChange = React.useCallback(
    (rootId: string, versionId: string) => {
      if (!activeThreadId || !versionId) return;
      const branch = messageBranches[rootId];
      const selected = branch?.versions.find((version) => version.id === versionId);
      if (!branch || !selected) return;

      // 父子同步:版本创建时记录了配对(编辑=同轮生成的对侧,重试=父用户版本),
      // 切换一侧分支时把另一侧也切到对应版本;旧数据没有配对则只切本侧
      const pairRootId = selected.pairVersionId
        ? Object.values(messageBranches).find(
            (record) =>
              record.rootId !== rootId &&
              record.versions.some((version) => version.id === selected.pairVersionId),
          )?.rootId
        : undefined;
      const pairBranch = pairRootId ? messageBranches[pairRootId] : undefined;
      const pairVersion = pairBranch?.versions.find(
        (version) => version.id === selected.pairVersionId,
      );

      // 按角色定位要替换的展示位:用户编辑版本复用同一 message id、助手重试
      // 版本 id 不同,必须限定 role,否则会把父子另一侧的消息槽位换错
      const applyVersion = (
        messages: WorkUIMessage[],
        record: MessageBranchRecord,
        target: MessageBranchVersion,
      ) => {
        const index = messages.findIndex(
          (message) =>
            message.role === target.role &&
            record.versions.some(
              (version) => version.role === target.role && version.message.id === message.id,
            ),
        );
        if (index < 0) return messages;
        const next = [...messages];
        next[index] = target.message;
        return next;
      };

      setMessages((messages) => {
        let next = applyVersion(messages, branch, selected);
        if (pairBranch && pairVersion) next = applyVersion(next, pairBranch, pairVersion);
        return next;
      });
      setMessageBranches((current) => {
        const next = { ...current, [rootId]: { ...branch, currentVersionId: versionId } };
        if (pairBranch && pairRootId && pairVersion) {
          next[pairRootId] = { ...pairBranch, currentVersionId: pairVersion.id };
        }
        return next;
      });

      const patchBranch = (targetRootId: string, currentVersionId: string) =>
        updateMessageBranch(activeThreadId, user.id, targetRootId, currentVersionId)
          .then(() => true)
          .catch(() => false);
      // PATCH 完成后重拉:分支作用于整条时间线 —— 切走时服务端把旧下游从
      // Memory 隔离(快照进旧版本 tail),切入版本的下游由消息投影插回。
      // 乐观替换只换了两行,下游消息必须靠 reload 恢复
      void (async () => {
        const primaryOk = await patchBranch(rootId, versionId);
        let pairOk = true;
        if (pairBranch && pairRootId && pairVersion) {
          pairOk = await patchBranch(pairRootId, pairVersion.id);
        }
        if (primaryOk && pairOk && status === "ready") void reloadMessages();
      })();
    },
    [activeThreadId, messageBranches, reloadMessages, setMessages, status, user.id],
  );

  // Branch metadata is committed by the server stream finalizer before the native Chat
  // stream closes. Refresh once for edit/regenerate, never once per token.
  React.useEffect(() => {
    if (status !== "ready" || !branchRefreshRef.current) return;
    branchRefreshRef.current = false;
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
    setQueuedRequests((current) => current.filter((request) => !request.followUpId));
    await stop();
  }, [stop, user.id]);

  // 手动压缩上下文(真压缩):服务端重写线程 —— 折叠删除旧消息并把摘要注入线程头部,
  // 此后模型只接收「摘要 + 近期消息」。完成后刷新线程列表与消息流,并弹窗展示压缩详情。
  const runCompress = async () => {
    if (!activeThreadId || !selectedProvider || !modelSelection || compacting) return;
    setCompacting(true);
    try {
      setCompressResult(
        await summarizeThread(
          activeThreadId,
          user.id,
          buildRequestModel(selectedProvider, modelSelection.modelId),
        ),
      );
      // 线程已被服务端重写(折叠删除 + 摘要消息 + 元数据),刷新列表与消息流
      await Promise.all([refreshThreads(), reloadMessages()]);
    } catch (error) {
      toast.error(
        error instanceof Error && error.message
          ? error.message
          : "压缩上下文失败,请确认 Mastra 服务已启动",
      );
    } finally {
      setCompacting(false);
    }
  };

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
        if (!isToolPart(part) || handled.has(part.toolCallId)) continue;
        handled.add(part.toolCallId);
        if (!isBusy) continue;
        const toolName = getToolName(part);
        if (!toolName) continue;
        if (toolName.startsWith("browser_")) {
          openWorkspacePanel("browser");
        } else if (toolName === "mastra_workspace_execute_command") {
          setTerminalPanelOpen(true);
        } else if (toolName.startsWith("mastra_workspace_")) {
          openWorkspacePanel("files");
        }
      }
    }
  }, [isBusy, messages, openWorkspacePanel, setTerminalPanelOpen]);
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
          toastError(await readErrorPayload(response, "Workflow 操作失败"));
          return;
        }
        // Resume/restart are UI streams. Consume the response so the official
        // workflow run advances to its terminal state and persists its result.
        await response.text();
        await reloadDisplayState();
        await reloadMessages();
      } catch (error) {
        toastError(error, "Workflow 操作失败");
      }
    },
    [activeThreadId, reloadDisplayState, reloadMessages, user.id],
  );
  const handleBackgroundTaskAction = React.useCallback(
    async (task: BackgroundTaskState, action: BackgroundTaskAction, resumeData?: unknown) => {
      try {
        const response = await runBackgroundTaskAction(task.id, action, resumeData);
        if (!response.ok) {
          toastError(await readErrorPayload(response, "后台任务操作失败"));
          return;
        }
        await reloadDisplayState();
        await reloadMessages();
      } catch (error) {
        toastError(error, "后台任务操作失败");
      }
    },
    [reloadDisplayState, reloadMessages],
  );
  const messageBranchByMessageId = React.useMemo(() => {
    const byMessageId = new Map<string, MessageBranchRecord>();
    for (const branch of Object.values(messageBranches)) {
      for (const version of branch.versions) byMessageId.set(version.message.id, branch);
    }
    return byMessageId;
  }, [messageBranches]);
  // 每条助手消息的「当前激活用户节点」版本 id:取其上方最近用户消息的分支
  // currentVersionId。助手切换器的选项 = 该用户版本的直接子回复(pairVersionId
  // 匹配),切换用户节点时 currentVersionId 变化 → 选项列表随之重算
  const parentUserVersionIdByMessageId = React.useMemo(() => {
    const byMessageId = new Map<string, string>();
    let activeUserVersionId: string | undefined;
    for (const message of messages) {
      if (message.role === "user") {
        activeUserVersionId =
          messageBranchByMessageId.get(message.id)?.currentVersionId ?? activeUserVersionId;
        continue;
      }
      if (activeUserVersionId) byMessageId.set(message.id, activeUserVersionId);
    }
    return byMessageId;
  }, [messageBranchByMessageId, messages]);
  const interactions = React.useMemo(
    () =>
      mergeInteractions(getMessageInteractions(messages), persistedInteractions).filter(
        (interaction) => !resolvedInteractionKeys.has(interaction.key),
      ),
    [messages, persistedInteractions, resolvedInteractionKeys],
  );
  const displayMessages = React.useMemo(
    () => buildDisplayMessages(messages, messageBranchByMessageId),
    [messageBranchByMessageId, messages],
  );

  const [resumingKeys, setResumingKeys] = React.useState<Set<string>>(new Set());
  const resumingKeysRef = React.useRef(new Set<string>());

  const handleResumeInteraction = React.useCallback(
    async (interaction: AgentInteraction, resumeData: unknown) => {
      if (!activeThreadId || resumingKeysRef.current.has(interaction.key)) return;
      // State updates are asynchronous and cannot be used as a same-tick mutex.
      // The ref closes the gap between two rapid approval clicks or duplicate UI events.
      resumingKeysRef.current.add(interaction.key);
      setResumingKeys((current) => new Set(current).add(interaction.key));
      // 过期预检:审批可能已被另一个窗口处理、或该 run 已自行结束。
      // 挂起快照是存储支撑的(不是内存态),所以「不在列表里」= 这次交互已经落定,
      // 此时再 resume 只会拿到一个无效 runId。取不到列表(网络/服务未起)不拦,
      // 让原路径去报错,避免把可用操作误判成过期。
      try {
        const pending = await fetchSuspendedInteractions(activeThreadId);
        const stillPending = pending.some(
          (item) =>
            item.runId === interaction.runId &&
            (interaction.toolCallId === undefined || item.toolCallId === interaction.toolCallId),
        );
        if (!stillPending) {
          setResolvedInteractionKeys((current) => new Set(current).add(interaction.key));
          setPersistedInteractions(pending);
          toast.error("这次工具交互已过期(可能已在别处处理),已从待办中移除");
          await reloadMessages();
          return;
        }
      } catch {
        // 预检失败不阻断:继续走正常 resume
      }
      // 先从输入区移除已提交的交互,避免旧历史 part 在 resume 流期间继续覆盖 PromptInput。
      setQueueCanDispatch(false);
      setResolvedInteractionKeys((current) => {
        const next = new Set(current);
        next.add(interaction.key);
        return next;
      });
      try {
        // 空消息 + runId/resumeData 会走 handleChatStream 的原生 resume 分支,
        // 不会额外创建一条“用户回答”消息,工具结果仍由同一 run 写回数据库。
        // 发送走该线程自己的 Chat 实例,而不是渲染时绑定的那个。
        await getThreadChat(activeThreadId).sendMessage(undefined, {
          body: {
            runId: interaction.runId,
            ...(interaction.toolCallId ? { toolCallId: interaction.toolCallId } : {}),
            resumeData,
          },
        });
        await reloadMessages();
        // 计划获批时服务端会按 transitionsTo 切模式,重新采纳线程设置让选择器跟上
        if (interaction.toolName === "submit_plan") await refreshThreadSettings();
      } catch {
        setResolvedInteractionKeys((current) => {
          const next = new Set(current);
          next.delete(interaction.key);
          return next;
        });
        toast.error("无法继续 Agent 工具调用,请重试");
      } finally {
        resumingKeysRef.current.delete(interaction.key);
        setResumingKeys((current) => {
          const next = new Set(current);
          next.delete(interaction.key);
          return next;
        });
      }
    },
    [
      activeThreadId,
      fetchSuspendedInteractions,
      getThreadChat,
      refreshThreadSettings,
      reloadMessages,
    ],
  );

  /**
   * 「始终允许此类」:把该类别写成 allow 并**等写入完成**再批准本次调用。
   * 顺序不能反 —— resume 是一次新的 HTTP 请求,chat 路由会重新从 thread.metadata
   * 读规则,规则没落库就批准的话,这一轮之后的同类工具仍会继续弹审批。
   */
  const handleAlwaysAllowCategory = React.useCallback(
    async (category: ToolCategory) => {
      if (!activeThreadId) return;
      await grantToolCategory(activeThreadId, user.id, category);
    },
    [activeThreadId, user.id],
  );

  const lastMessage = messages.at(-1);
  // 优先读取本次响应的 metadata;刷新后则从线程元数据恢复最后一次真实用量
  // (压缩后服务端写入预估 token,下次真实响应自动覆盖)。
  const streamedUsage = (
    [...messages].reverse().find((m) => m.role === "assistant")?.metadata as
      | { usage?: LanguageModelUsage }
      | undefined
  )?.usage;
  const persistedUsage = activeThread?.metadata.contextUsage as LanguageModelUsage | undefined;
  const latestUsage = streamedUsage ?? persistedUsage;
  React.useEffect(() => {
    if (status === "submitted" || status === "streaming") return;
    const serializedCharacters = messages.reduce(
      (total, message) => total + JSON.stringify(message.parts).length,
      0,
    );
    setEstimatedContextTokens(Math.ceil(serializedCharacters / 4));
  }, [messages, status]);
  const usedContextTokens =
    latestUsage?.inputTokens && latestUsage.inputTokens > 0
      ? latestUsage.inputTokens
      : Math.max(latestUsage?.totalTokens ?? 0, estimatedContextTokens);
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

  // 搜索结果跳转:消息加载完成后滚动到目标气泡并短暂高亮
  React.useEffect(() => {
    if (!pendingJump || !activeThreadId) return;
    if (pendingJump.threadId !== activeThreadId) return;
    // 等待本线程消息渲染完成
    if (messages.length === 0) return;
    const timer = window.setTimeout(() => {
      const el = document.querySelector(`[data-message-id="${pendingJump.messageId}"]`);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        el.classList.add("ring-2", "ring-primary/60", "rounded-xl");
        window.setTimeout(() => {
          el.classList.remove("ring-2", "ring-primary/60", "rounded-xl");
        }, 2000);
      }
      setPendingJump(null);
    }, 120);
    return () => window.clearTimeout(timer);
  }, [pendingJump, activeThreadId, messages.length, setPendingJump]);

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
        let followUpId: string | undefined;
        const onlyNativeFollowUps = queuedRequests.every((request) => Boolean(request.followUpId));
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
          followUpId = payload.followUpId;
        }
        setQueuedRequests((current) => [
          ...current,
          {
            id: nanoid(),
            text,
            files: persistedFiles,
            skills: message.skills,
            fileReferences: message.fileReferences,
            followUpId,
          },
        ]);
      } catch (error) {
        toastError(error, "附件保存失败");
        return;
      }
      clearPrompt();
      return;
    }

    // 未锁定线程的首条消息会消费工作区选定(workspaceLocked 在发送前快照)
    const consumesWorkspaceSelection = !workspaceLocked;

    // 无激活线程时,先创建线程再发送
    if (!activeThreadId) {
      const initialTitle = text.replace(/^[#\-\s*]+/, "").slice(0, 24) || "New Chat";
      const thread = await createThread(initialTitle);
      if (!thread) {
        toast.error("创建会话失败,请确认 Mastra 服务已启动");
        return;
      }
      // 立即更新 ref:sendMessage 读到的是最新 threadId,不等 re-render
      activeThreadIdRef.current = thread.id;
      if (text) void renameThread(thread.id, initialTitle);
    } else if (text && (activeThread?.title === "New Chat" || activeThread?.metadata.draft)) {
      // 已有草稿线程发送首条消息：T=0 即刻赋予首句确定性标题，避免等待 LLM
      const initialTitle = text.replace(/^[#\-\s*]+/, "").slice(0, 24) || "新任务";
      void renameThread(activeThread.id, initialTitle);
    }

    const targetThreadId = activeThreadIdRef.current;
    if (!targetThreadId) return;
    let persistedFiles: LibraryFilePart[];
    try {
      persistedFiles = await persistAttachments(files, targetThreadId);
    } catch (error) {
      toastError(error, "附件保存失败");
      return;
    }
    clearPrompt();
    setQueueCanDispatch(false);
    selectedSkillNamesRef.current = message.skills ?? [];
    // 显式发到目标线程自己的 Chat 实例:新建线程时渲染层还没切过去,
    // 用渲染时绑定的实例会把消息发进上一条线程。
    await getThreadChat(targetThreadId).sendMessage(
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
    );
    // prepareThreadSession 已将首条消息携带的显式目录写入线程元数据;
    // 立即同步线程列表,避免右侧工作区继续显示“未绑定”。
    await refreshThreads();
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
  // 清掉它们(带 followUpId 的项),否则界面上会留下永远不会被执行的幽灵项。
  // 纯本地排队项不受影响,继续按顺序等下一回合。
  const steerQueuedRequestNow = React.useCallback(
    (request: QueuedRequest) => {
      const targetThreadId = activeThreadIdRef.current;
      if (!targetThreadId || sendingQueuedRequest.current) return;
      if (request.files.length > 0) {
        toast.error("带附件的排队请求会在当前回合结束后发送");
        return;
      }
      sendingQueuedRequest.current = true;
      setQueueCanDispatch(false);
      setQueuedRequests((current) =>
        current.filter((item) => item.id !== request.id && !item.followUpId),
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
          toast.error("无法立即转向当前任务,请稍后重试");
        })
        .finally(() => {
          sendingQueuedRequest.current = false;
          setQueueDispatchVersion((version) => version + 1);
        });
    },
    [agentSelection.id, getThreadChat],
  );

  const sendingQueuedRequest = React.useRef(false);
  // queueDispatchVersion 是故意的重触发器:一条排队请求发送完毕后
  // 立即重新评估队列,即使其余依赖未变化
  // biome-ignore lint/correctness/useExhaustiveDependencies: 故意的额外依赖
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
    const request = nextRequest.followUpId
      ? getThreadChat(activeThreadId).resumeStream({
          body: { followUpId: nextRequest.followUpId },
        })
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
        if (nextRequest.followUpId) await reloadMessages();
        setQueuedRequests((current) => current.filter((queued) => queued.id !== nextRequest.id));
      })
      .catch(() => {
        toast.error("排队请求发送失败,请检查服务连接后重试");
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
  const hasQueueCard =
    queuedRequests.length > 0 ||
    visibleTasks.length > 0 ||
    activeTools.length > 0 ||
    subagents.length > 0 ||
    visibleBackgroundTasks.length > 0;
  const promptArea = (
    <PromptInputProvider
      persistenceKey={`mastra-work:prompt:${user.id}:${activeThreadId ?? "new"}`}
    >
      {/* 排队请求与任务共用一张 Queue 卡片(各自渲染内部 section,空态自渲染
          为 null):两个队列本是一体 —— 用户排的"接下来做什么"和 Agent 正在
          做的任务。
          外层 max-w-3xl 容器与下方输入框同宽基准,w-[96%] 才是"略窄于输入框"
          (工作区卡片同规格,见 workspace-selector.tsx)。 */}
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
              onBackgroundAction={handleBackgroundTaskAction}
              queuedFollowUps={queuedRequests.filter((request) => request.followUpId).length}
              subagents={subagents}
              tasks={visibleTasks}
              backgroundTasks={visibleBackgroundTasks}
            />
          </Queue>
        </div>
      ) : null}

      <WorkflowRunPanel onAction={handleWorkflowAction} workflow={workflow} />

      <div className="mx-auto w-full max-w-3xl">
        <AgentInteractionPanel
          busy={resumingKeys.size > 0}
          interactions={interactions}
          messages={messages}
          onAlwaysAllow={handleAlwaysAllowCategory}
          onResume={handleResumeInteraction}
        />
        {interactions.length === 0 ? (
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
              estimatedUsedTokens={estimatedContextTokens}
              onSubmit={handleSubmit}
              status={status}
              onStop={handleStop}
              compacting={compacting}
              onCompress={runCompress}
              compressResult={compressResult}
              onCompressResultClose={() => setCompressResult(null)}
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
    <MessageScrollerProvider autoScroll>
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
            <BlurFade delay={0.05} inView>
              <div className="flex flex-col items-center text-center gap-2">
                <div className="flex items-center gap-2">
                  <SparklesText
                    text="Mastra AI 智能工作台"
                    className="text-xl md:text-2xl font-bold tracking-tight"
                  />
                </div>
                <AnimatedShinyText className="text-xs text-muted-foreground max-w-md">
                  {activeThread
                    ? `继续对话「${activeThread.title}」或选择快捷卡片探索`
                    : "全功能多 Agent 协作工作台 · 支持工具链调用、本地工作区与知识库管理"}
                </AnimatedShinyText>
              </div>
            </BlurFade>

            {/* 4 张快捷提示卡片 (基于 MagicCard 鼠标探照灯流光) */}
            <BlurFade delay={0.12} inView className="w-full max-w-2xl">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                {[
                  {
                    title: "🔍 分析当前工作区架构",
                    desc: "深度扫描项目目录结构，梳理核心依赖与模块分层关系",
                    prompt: "请详细分析当前工作区目录架构与核心模块关系，给出分层设计总结。",
                  },
                  {
                    title: "⚡ 编排多 Agent 协作工作流",
                    desc: "构建具备子智能体派发、状态监听与自动汇总的流水线",
                    prompt: "请帮我规划并设计一个多 Agent 协作的工作流，明确各自职责分工。",
                  },
                  {
                    title: "🧪 生成自动化测试与类型",
                    desc: "基于核心函数与业务逻辑自动补充严苛的 TypeScript 契约",
                    prompt: "请分析核心代码并编写全套单元测试用例与边界异常处理。",
                  },
                  {
                    title: "📚 检索与总结知识库文档",
                    desc: "提炼核心知识库与 MCP 工具文档，生成可执行的最佳实践",
                    prompt: "请结合当前知识库与工具规范，总结并输出完整的开发指南。",
                  },
                ].map((starter) => (
                  <MagicCard
                    key={starter.title}
                    gradientSize={160}
                    gradientFrom="var(--primary)"
                    gradientTo="var(--accent)"
                    onClick={() => {
                      handleSubmit({ text: starter.prompt, files: [] }, () => undefined);
                    }}
                    className="p-3 cursor-pointer hover:border-primary/50 transition-colors bg-card/60 backdrop-blur-xs flex flex-col justify-between gap-1"
                  >
                    <span className="text-xs font-semibold text-foreground truncate">
                      {starter.title}
                    </span>
                    <p className="text-[11px] text-muted-foreground line-clamp-2 leading-relaxed">
                      {starter.desc}
                    </p>
                  </MagicCard>
                ))}
              </div>
            </BlurFade>

            <div className="w-full relative z-10">{promptArea}</div>
          </div>
        ) : (
          <>
            <MessageScroller className="flex-1">
              <MessageScrollerViewport>
                <MessageScrollerContent
                  aria-busy={isBusy}
                  className="mx-auto w-full max-w-3xl px-4 py-6"
                >
                  {displayMessages.map(({ message, sourceIds, sourceEndIndex }) => (
                    // key 取合并组的**首条**源消息 id:每跨一个工具/推理边界,Mastra 就再封
                    // 一条 assistant 行并被合并进同一组(见 buildDisplayMessages),sourceIds
                    // 因此在流式途中不断增长。用全量拼接当 key 会让 key 每次都变,React 于是
                    // 销毁重建整条消息的 DOM —— 既白扔掉工具卡片的展开态,又让 MessageScroller
                    // 把全新元素当成没锚定过的新锚点反复重锚,滚动状态store 每轮同步翻新一次,
                    // 嵌套更新计数一路累加到上限。组的起点一旦建立就不再变,是唯一稳定的身份。
                    <MessageItem
                      key={sourceIds[0]}
                      message={message}
                      messageIndex={sourceEndIndex}
                      isStreaming={sourceIds.includes(streamingMessageId ?? "")}
                      branch={messageBranchByMessageId.get(message.id)}
                      parentUserVersionId={parentUserVersionIdByMessageId.get(message.id)}
                      onBranchChange={handleBranchChange}
                      onEdit={handleEdit}
                      onEditCompacted={handleCompactedEdit}
                      userId={user.id}
                      onRetry={handleRetry}
                      onClone={handleCloneFromHere}
                      onCloneMessage={handleCloneMessage}
                    />
                  ))}
                  {isBusy && lastMessage?.role !== "assistant" ? (
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
                              words={[
                                "正在深入推理中...",
                                "正在解析指令与上下文...",
                                "正在检索工具库与工作区...",
                                "正在调度智能体组织回复...",
                              ]}
                              duration={2200}
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
                  {compacting ? (
                    <div className="mt-2">
                      <Marker role="status">
                        <MarkerIcon>
                          <Spinner className="size-4" />
                        </MarkerIcon>
                        <MarkerContent className="shimmer">
                          Compacting conversation...
                        </MarkerContent>
                      </Marker>
                    </div>
                  ) : null}
                </MessageScrollerContent>
              </MessageScrollerViewport>
              <MessageScrollerButton />
            </MessageScroller>
            <div className="relative z-10 shrink-0 bg-background px-4 pb-4">{promptArea}</div>
          </>
        )}
      </div>
    </MessageScrollerProvider>
  );
}
