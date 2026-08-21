import { Chat, useChat } from "@ai-sdk/react";
import { arrayMove } from "@dnd-kit/sortable";
import { DefaultChatTransport, type FileUIPart, type LanguageModelUsage } from "ai";
import { MessageCircleDashedIcon, WaypointsIcon } from "lucide-react";
import { nanoid } from "nanoid";
import * as React from "react";
import { toast } from "sonner";
import { PromptInputProvider } from "@/components/ai-elements/prompt-input";
import { Queue } from "@/components/ai-elements/queue";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import { Spinner } from "@/components/ui/spinner";
import {
  buildReasoningRequest,
  buildRequestModel,
  getModelCapabilities,
  getModelContextWindow,
  MASTRA_SERVER_URL,
} from "@/lib/providers";
import type { ToolCategory } from "@/lib/session-policy";
import { useWorkbench } from "@/lib/workbench";
import { AgentInteractionPanel, AgentQueuePanel } from "./agent-panels";
import { MessageItem } from "./message-list";
import { ChatPromptInput, UserRequestQueuePanel } from "./prompt-input";
import {
  type AgentInteraction,
  type AgentTask,
  areTasksEqual,
  type CompressResult,
  getActiveToolsFromMessages,
  getMessageInteractions,
  getSubagentsFromMessages,
  getTasksFromMessages,
  getToolName,
  isToolPart,
  type LibraryFilePart,
  type MessageBranchRecord,
  type MessageBranchVersion,
  type MessageFileReference,
  mergeInteractions,
  parseSuspendedRuns,
  type QueuedRequest,
  type WorkDisplayState,
  type WorkUIMessage,
} from "./types";
import { ChatWorkspaceSelector } from "./workspace-selector";

// ---------------------------------------------------------------------------
// 会话面板
// ---------------------------------------------------------------------------

interface DisplayMessage {
  message: WorkUIMessage;
  sourceIds: string[];
  sourceEndIndex: number;
}

const STREAM_RECONNECT_LIMIT = 2;

function isTransientStreamError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /fetch|network|econnreset|econnrefused|und_err|socket|timeout|连接|网络/i.test(message);
}

function streamErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return message.trim() || "流式响应意外中断";
}

/**
 * Mastra seals each response-boundary (reasoning/tool loop) as a separate
 * assistant memory row. That boundary is important to the model, but it is
 * not a conversation turn for the user. Keep all parts in order while making
 * consecutive assistant rows one visual message. Branch rows stay separate so
 * their selectors and pair metadata remain addressable by id.
 */
function buildDisplayMessages(
  messages: WorkUIMessage[],
  branchesByMessageId: Map<string, MessageBranchRecord>,
): DisplayMessage[] {
  const display: DisplayMessage[] = [];

  for (const [index, message] of messages.entries()) {
    const hasBranch = branchesByMessageId.has(message.id);
    const previous = display.at(-1);
    const previousMessage = previous?.message;
    const previousHasBranch = previous
      ? previous.sourceIds.some((id) => branchesByMessageId.has(id))
      : false;
    const compacted = Boolean(
      (message.metadata as { compactedHistory?: unknown } | undefined)?.compactedHistory,
    );
    const previousCompacted = Boolean(
      (previousMessage?.metadata as { compactedHistory?: unknown } | undefined)?.compactedHistory,
    );

    if (
      message.role === "assistant" &&
      previousMessage?.role === "assistant" &&
      previous !== undefined &&
      !hasBranch &&
      !previousHasBranch &&
      !compacted &&
      !previousCompacted
    ) {
      previous.message = {
        ...previousMessage,
        id: message.id,
        parts: [...previousMessage.parts, ...message.parts],
        metadata: {
          ...previousMessage.metadata,
          ...message.metadata,
        },
      };
      previous.sourceIds.push(message.id);
      previous.sourceEndIndex = index;
      continue;
    }

    display.push({
      message,
      sourceIds: [message.id],
      sourceEndIndex: index,
    });
  }

  return display;
}

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
    searchSelection,
    cloneThread,
    refreshThreads,
    pendingJump,
    setPendingJump,
    catalog,
    refreshThreadSettings,
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
    async (files: FileUIPart[], threadId: string): Promise<LibraryFilePart[]> => {
      const isPersisted = (file: FileUIPart) =>
        /\/work\/library\/assets\/[^/]+\/content/.test(file.url);
      const pending = files.filter((file) => !isPersisted(file));
      if (pending.length === 0) return files as LibraryFilePart[];
      const form = new FormData();
      form.set("resourceId", user.id);
      form.set("threadId", threadId);
      for (const file of pending) {
        const source =
          "file" in file && file.file instanceof File
            ? file.file
            : await fetch(file.url).then((response) => response.blob());
        form.append("files", source, file.filename ?? "未命名附件");
      }
      const response = await fetch(`${MASTRA_SERVER_URL}/work/library/assets`, {
        method: "POST",
        body: form,
      });
      const payload = (await response.json()) as {
        assets?: Array<{ id: string; filename: string; mediaType: string; byteSize: number }>;
        error?: string;
      };
      if (!response.ok || !payload.assets) {
        throw new Error(payload.error || "附件保存失败");
      }
      let uploadedIndex = 0;
      return files.map((file) => {
        if (isPersisted(file)) return file;
        const asset = payload.assets?.[uploadedIndex++];
        if (!asset) throw new Error("附件上传结果不完整");
        return {
          type: "file",
          byteSize: asset.byteSize,
          filename: asset.filename,
          mediaType: asset.mediaType,
          url: `${MASTRA_SERVER_URL}/work/library/assets/${encodeURIComponent(asset.id)}/content?resourceId=${encodeURIComponent(user.id)}`,
        };
      });
    },
    [user.id],
  );

  // 官方 Memory.cloneThread:克隆线程并切换。
  // messageLimit = index + 1:克隆「到该消息为止」的最近 N 条(options.messageLimit)
  const handleCloneThread = React.useCallback(
    async (selection?: number | { messageLimit?: number; messageIds?: string[] }) => {
      if (!activeThreadId) return;
      const thread = await cloneThread(activeThreadId, selection);
      const messageLimit = typeof selection === "number" ? selection : selection?.messageLimit;
      const singleMessage = typeof selection !== "number" && selection?.messageIds?.length === 1;
      if (thread) {
        toast.success(
          singleMessage
            ? `已将选定消息克隆到新线程「${thread.title}」`
            : messageLimit
              ? `已从此处克隆到新线程「${thread.title}」`
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
  });

  /**
   * 每线程一个 Chat 实例。
   *
   * 只用一个 useChat 服务全部线程会串台:A 还在流式时切到 B,A 的 delta 会继续写进
   * 同一个 Chat,于是 A 的回复出现在 B 的列表里,连带 `[messages.length, status]`
   * 那个 effect 也会拿 A 的结束事件去拉 B 的挂起交互。
   *
   * 传 `id` 能让 useChat 在 id 变化时换新实例(@ai-sdk/react 的 shouldRecreateChat),
   * 串台就没了 —— 但 AI SDK **没有** id → Chat 的全局注册表(v5 起 ChatStore 已移除),
   * 旧实例会被丢弃,切回来看不到仍在进行的输出。所以注册表由我们自己持有:
   * 切走的线程留在自己的实例里继续流,切回来直接接上实时输出。
   */
  const chatsRef = React.useRef(new Map<string, Chat<WorkUIMessage>>());
  const generatedMessageIdsRef = React.useRef(new Map<string, string>());
  const reconnectAttemptsRef = React.useRef(new Map<string, number>());
  const reconnectTimersRef = React.useRef(new Map<string, number>());
  const getThreadChat = React.useCallback(
    (threadId: string) => {
      const existing = chatsRef.current.get(threadId);
      if (existing) return existing;
      let chat!: Chat<WorkUIMessage>;
      chat = new Chat<WorkUIMessage>({
        id: threadId,
        generateId: () => {
          const id = nanoid();
          generatedMessageIdsRef.current.set(threadId, id);
          return id;
        },
        transport: new DefaultChatTransport<WorkUIMessage>({
          api: `${MASTRA_SERVER_URL}/chat/mastra-work-agent`,
          prepareReconnectToStreamRequest: ({ body }) => {
            const followUpId = typeof body?.followUpId === "string" ? body.followUpId : undefined;
            return {
              api: `${MASTRA_SERVER_URL}/work/sessions/workbench/threads/${encodeURIComponent(threadId)}/stream?resourceId=${encodeURIComponent(user.id)}${
                followUpId ? `&followUpId=${encodeURIComponent(followUpId)}` : ""
              }`,
            };
          },
          prepareSendMessagesRequest: ({ messages, body, trigger, messageId, id }) => {
            // 自定义 prepareSendMessagesRequest 会**整体替换**默认 body,所以
            // trigger / messageId 必须显式带上 —— 否则 regenerate() 到了服务端
            // 不再是 'regenerate-message',handleChatStream 就不会把待重生成的
            // 那条助手消息从输入里切掉(见 @mastra/ai-sdk 的 messagesToSend)。
            // 逐次调用传入的 body(如 resume 的 runId/resumeData)优先于公共字段。
            reconnectAttemptsRef.current.delete(threadId);
            const payload: Record<string, unknown> = {
              ...buildRequestBodyRef.current(threadId),
              responseMessageId: generatedMessageIdsRef.current.get(threadId),
              ...body,
              id,
              trigger,
              messageId,
              messages,
            };
            return { body: payload };
          },
        }),
        onFinish: ({ isError }) => {
          if (!isError) {
            reconnectAttemptsRef.current.delete(threadId);
            const timer = reconnectTimersRef.current.get(threadId);
            if (timer !== undefined) {
              window.clearTimeout(timer);
              reconnectTimersRef.current.delete(threadId);
            }
          }
        },
        onError: (error) => {
          const detail = streamErrorMessage(error);
          if (!isTransientStreamError(error)) {
            toast.error(`本轮生成失败：${detail}`);
            return;
          }

          const attempt = (reconnectAttemptsRef.current.get(threadId) ?? 0) + 1;
          reconnectAttemptsRef.current.set(threadId, attempt);
          if (attempt > STREAM_RECONNECT_LIMIT) {
            toast.error(`流式响应中断：${detail}`);
            return;
          }

          const delay = attempt * 800;
          const timer = window.setTimeout(() => {
            reconnectTimersRef.current.delete(threadId);
            void chat
              .resumeStream()
              .then(async () => {
                if (chat.status !== "ready") return;
                const response = await fetch(
                  `${MASTRA_SERVER_URL}/work/sessions/workbench/threads/${encodeURIComponent(threadId)}/display-state?resourceId=${encodeURIComponent(user.id)}`,
                );
                const payload = (await response.json().catch(() => ({}))) as {
                  displayState?: { activeRunId?: string | null };
                };
                if (!payload.displayState?.activeRunId) {
                  reconnectAttemptsRef.current.delete(threadId);
                  toast.error(`流式响应中断：${detail}`);
                }
              })
              .catch(() => undefined);
          }, delay);
          reconnectTimersRef.current.set(threadId, timer);
        },
      });
      chatsRef.current.set(threadId, chat);
      return chat;
    },
    [user.id],
  );

  React.useEffect(
    () => () => {
      for (const timer of reconnectTimersRef.current.values()) window.clearTimeout(timer);
      reconnectTimersRef.current.clear();
    },
    [],
  );

  // 没有激活线程时也必须调用 useChat(Hook 规则),用一个从不发送的空实例占位。
  // 显式给它一个 transport:Chat 构造时不校验,但留着 undefined 一旦被误用就是运行时崩。
  const placeholderChat = React.useMemo(
    () => new Chat<WorkUIMessage>({ id: "no-thread", transport: new DefaultChatTransport() }),
    [],
  );
  const activeChat = activeThreadId ? getThreadChat(activeThreadId) : placeholderChat;

  const { messages, setMessages, status, stop } = useChat({
    chat: activeChat,
    resume: Boolean(activeThreadId),
  });

  // 工作区锁定:线程已绑定目录或已有消息往来;锁定后隐藏 promptInput 选择器
  const workspaceLocked = Boolean(activeThread?.metadata.workspacePath) || messages.length > 0;
  workspaceLockedRef.current = workspaceLocked;

  // 首条消息会在服务端请求开始时锁定工作区,但线程列表仍是旧快照。
  // 在本地消息出现后补一次刷新,让右侧文件树及时拿到 workspaceExplicit。
  // 没有 workspacePath 时才触发,避免流式消息期间重复请求线程列表。
  React.useEffect(() => {
    if (!activeThreadId || messages.length === 0 || activeThread?.metadata.workspacePath) return;
    void refreshThreads();
  }, [activeThread?.metadata.workspacePath, activeThreadId, messages.length, refreshThreads]);

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
    return fetch(
      `${MASTRA_SERVER_URL}/work/threads/${threadId}/messages?resourceId=${encodeURIComponent(user.id)}`,
    )
      .then((r) => (r.ok ? r.json() : { messages: [] }))
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
      const response = await fetch(
        `${MASTRA_SERVER_URL}/work/sessions/workbench/threads/${encodeURIComponent(threadId)}/display-state?resourceId=${encodeURIComponent(user.id)}`,
      );
      if (!response.ok) return undefined;
      const payload = (await response.json()) as {
        displayState?: Omit<WorkDisplayState, "suspendedRuns"> & { suspendedRuns?: unknown };
      };
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
      return;
    }
    try {
      const displayState = await fetchDisplayState(activeThreadId);
      if (requestId !== displayStateRequestId.current) return;
      const nextTasks = displayState?.tasks ?? [];
      setTasks((current) => (areTasksEqual(current, nextTasks) ? current : nextTasks));
      setPersistedInteractions(displayState?.suspendedRuns ?? []);
      setTaskSnapshotLoaded(Boolean(displayState));
    } catch {
      if (requestId !== displayStateRequestId.current) return;
      setTasks((current) => (current.length === 0 ? current : []));
      setPersistedInteractions([]);
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
    setResolvedInteractionKeys(new Set());
    // 回收:只保留当前线程与仍在流式的线程,否则每访问一条线程就永久多留一份消息数组
    for (const [threadId, chat] of chatsRef.current) {
      const busy = chat.status === "submitted" || chat.status === "streaming";
      if (threadId !== activeThreadId && !busy) {
        chatsRef.current.delete(threadId);
      }
    }
  }, [activeChat, activeThreadId, reloadMessages]);

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
        const response = await fetch(
          `${MASTRA_SERVER_URL}/work/threads/${encodeURIComponent(activeThreadId)}/compacted-edit`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ resourceId: user.id, messageId, text }),
          },
        );
        const data = (await response.json().catch(() => ({}))) as {
          thread?: { id: string };
          error?: string;
        };
        if (!response.ok || !data.thread?.id) {
          throw new Error(data.error ?? "无法创建压缩记忆修正分支");
        }
        await refreshThreads();
        setActiveThreadId(data.thread.id);
        await getThreadChat(data.thread.id).sendMessage({ text });
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "无法创建修正分支");
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
        fetch(
          `${MASTRA_SERVER_URL}/work/threads/${activeThreadId}/branches/${encodeURIComponent(targetRootId)}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ resourceId: user.id, currentVersionId }),
          },
        )
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
      await fetch(
        `${MASTRA_SERVER_URL}/work/sessions/workbench/threads/${encodeURIComponent(threadId)}/abort?resourceId=${encodeURIComponent(user.id)}`,
        {
          method: "POST",
        },
      ).catch(() => undefined);
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
      const response = await fetch(
        `${MASTRA_SERVER_URL}/work/threads/${activeThreadId}/summarize`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: buildRequestModel(selectedProvider, modelSelection.modelId),
            resourceId: user.id,
          }),
        },
      );
      if (!response.ok) {
        const error = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(error?.error ?? String(response.status));
      }
      setCompressResult((await response.json()) as CompressResult);
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

  const handleResumeInteraction = React.useCallback(
    async (interaction: AgentInteraction, resumeData: unknown) => {
      if (!activeThreadId || isBusy) return;
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
      }
    },
    [
      activeThreadId,
      fetchSuspendedInteractions,
      getThreadChat,
      isBusy,
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
      const response = await fetch(
        `${MASTRA_SERVER_URL}/work/sessions/workbench/threads/${encodeURIComponent(activeThreadId)}/grants?resourceId=${encodeURIComponent(user.id)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ category }),
        },
      );
      if (!response.ok) throw new Error("无法授予当前会话权限");
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
    if (!(text || files.length > 0)) return;

    if (isBusy) {
      const threadId = activeThreadIdRef.current;
      if (!threadId) return;
      try {
        const persistedFiles = await persistAttachments(files, threadId);
        let followUpId: string | undefined;
        const onlyNativeFollowUps = queuedRequests.every((request) => Boolean(request.followUpId));
        if (text && persistedFiles.length === 0 && onlyNativeFollowUps) {
          const response = await fetch(
            `${MASTRA_SERVER_URL}/work/sessions/workbench/threads/${encodeURIComponent(threadId)}/follow-up?resourceId=${encodeURIComponent(user.id)}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
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
                metadata: {
                  skillNames: message.skills ?? [],
                  fileReferences: message.fileReferences ?? [],
                },
              }),
            },
          );
          const payload = (await response.json()) as { followUpId?: string; error?: string };
          if (!response.ok || !payload.followUpId) {
            throw new Error(payload.error ?? "排队消息未被 Agent 接受");
          }
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
        toast.error(error instanceof Error ? error.message : "附件保存失败");
        return;
      }
      clearPrompt();
      return;
    }

    // 未锁定线程的首条消息会消费工作区选定(workspaceLocked 在发送前快照)
    const consumesWorkspaceSelection = !workspaceLocked;

    // 无激活线程时,先创建线程再发送
    if (!activeThreadId) {
      const thread = await createThread(text.slice(0, 30) || "New Chat");
      if (!thread) {
        toast.error("创建会话失败,请确认 Mastra 服务已启动");
        return;
      }
      // 立即更新 ref:sendMessage 读到的是最新 threadId,不等 re-render
      activeThreadIdRef.current = thread.id;
      // 首条消息用线程标题
      if (text) void renameThread(thread.id, text.slice(0, 30));
    }

    const targetThreadId = activeThreadIdRef.current;
    if (!targetThreadId) return;
    let persistedFiles: LibraryFilePart[];
    try {
      persistedFiles = await persistAttachments(files, targetThreadId);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "附件保存失败");
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
  // queueMessage 接受的 native follow-up 在服务端全部作废 —— 前端必须同步
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
          { body: { sessionAction: "steer", sessionScope: "workbench" } },
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
    [getThreadChat],
  );

  const sendingQueuedRequest = React.useRef(false);
  // queueDispatchVersion 是故意的重触发器:一条排队请求发送完毕后
  // 立即重新评估队列,即使其余依赖未变化
  // biome-ignore lint/correctness/useExhaustiveDependencies: 故意的额外依赖
  React.useEffect(() => {
    if (
      status !== "ready" ||
      !activeThreadId ||
      !queueCanDispatch ||
      interactions.length > 0 ||
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
  ]);

  // 输入区(Queue 卡片 + 工作区卡片 + 输入框):新会话时垂直居中展示,
  // 有消息后固定底部 —— 同一份 JSX,两种布局复用。
  const hasQueueCard =
    queuedRequests.length > 0 ||
    visibleTasks.length > 0 ||
    activeTools.length > 0 ||
    subagents.length > 0;
  const promptArea = (
    <PromptInputProvider
      persistenceKey={`mastra-work:prompt:${user.id}:${activeThreadId ?? "new"}`}
    >
      {/* 排队请求与任务共用一张 Queue 卡片(各自渲染内部 section,空态自渲染
          为 null):两个队列本是一体 —— 用户排的"接下来做什么"和 Agent 正在
          做的任务,单卡片双 section 消除原先两张卡叠放的割裂感。
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
              queuedFollowUps={queuedRequests.filter((request) => request.followUpId).length}
              subagents={subagents}
              tasks={visibleTasks}
            />
          </Queue>
        </div>
      ) : null}

      <div className="mx-auto w-full max-w-3xl">
        <AgentInteractionPanel
          busy={isBusy}
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
          // 新会话:问候语 + 输入区整体垂直居中
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-8 px-4 pb-16">
            <Empty className="flex-none">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <MessageCircleDashedIcon />
                </EmptyMedia>
                <EmptyTitle>开始新对话</EmptyTitle>
                <EmptyDescription>
                  {activeThread
                    ? `继续「${activeThread.title}」`
                    : "发送消息开始与 MastraWork 对话"}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
            <div className="w-full">{promptArea}</div>
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
                    <MessageItem
                      key={sourceIds.join(":")}
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
                      onClone={handleCloneThread}
                      onCloneMessage={(messageId) =>
                        void handleCloneThread({ messageIds: [messageId] })
                      }
                    />
                  ))}
                  {isBusy && lastMessage?.role !== "assistant" ? (
                    <MessageScrollerItem
                      className="flex items-center gap-2 py-2 text-xs text-muted-foreground"
                      messageId="typing-indicator"
                    >
                      <WaypointsIcon className="size-4 animate-pulse" />
                      <span>
                        <span className="font-medium">MastraWork</span> 正在思考...
                      </span>
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
