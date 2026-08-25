/**
 * 工作台聊天主路由(POST /chat/:agentId)。
 * 官方文档:docs/en/reference/ai-sdk/chat-route.mdx(body 结构 messages + memory)、
 * docs/en/reference/ai-sdk/handle-chat-stream.mdx(handleChatStream / toAISdkStream)。
 * 职责:解析请求级上下文(模型 / 检索引擎 / 附件预算 / 技能),准备线程会话
 * (工作区绑定 / 模式跃迁 / 模型快照,见 prepareThreadSession),再按运行形态
 * 分流 —— harness session 订阅流(新回合 / steer)或官方 handleChatStream。
 */
import { existsSync, statSync } from "node:fs";
import { handleChatStream, toAISdkStream } from "@mastra/ai-sdk";
import { toAISdkMessages } from "@mastra/ai-sdk/ui";
import type {
  AgentExecutionOptions,
  AgentMessageInput,
  AgentSignalContents,
  AgentThreadSubscription,
  MastraLanguageModel,
} from "@mastra/core/agent";
import type { RequestContext } from "@mastra/core/request-context";
import { registerApiRoute } from "@mastra/core/server";
import type { MastraModelOutput } from "@mastra/core/stream";
import type { Memory } from "@mastra/memory";
import {
  createUIMessageStreamResponse,
  type LanguageModelUsage,
  type TextStreamPart,
  type ToolSet,
  type UIMessage,
} from "ai";
import { SKILL_NAMES_CONTEXT_KEY } from "../agents";
import {
  AGENT_PROFILE_CONTEXT_KEY,
  ensureProfileAgentsRegistered,
  getAgentProfile,
} from "../agents/custom";
import { MODE_ID_CONTEXT_KEY, resolveMode } from "../agents/modes";
import { PERMISSION_RULES_CONTEXT_KEY } from "../agents/permissions";
import { workError } from "../errors";
import { isTerminalAgentChunk, workSessionHost } from "../harness";
import {
  defaultModelFamily,
  REQUEST_MODEL_CONTEXT_KEY,
  requestModelFamily,
  resolveRequestModel,
  usesOpenAIResponses,
} from "../models";
import {
  LIBRARY_ATTACHMENT_BUDGET_CONTEXT_KEY,
  LIBRARY_ATTACHMENT_CAPABILITIES_CONTEXT_KEY,
  LIBRARY_ORIGIN_CONTEXT_KEY,
  LIBRARY_RERANK_MODEL_CONTEXT_KEY,
  LIBRARY_RESOURCE_CONTEXT_KEY,
  LIBRARY_THREAD_CONTEXT_KEY,
  searchLibrary,
} from "../rag";
import {
  MODEL_FAMILY_CONTEXT_KEY,
  parseWebSearchSelection,
  WEB_SEARCH_CONTEXT_KEY,
} from "../tools";
import {
  addRecentWorkspace,
  ensureDirectory,
  implicitThreadWorkspacePath,
  isWorkspaceEnabled,
  WORKSPACE_PATH_CONTEXT_KEY,
  WORKSPACE_RESOURCE_ID_CONTEXT_KEY,
  WORKSPACE_THREAD_ID_CONTEXT_KEY,
} from "../workspace";
import { getWorkMemory } from "./threads";
import { removeObservationalMemoryReferences } from "./threads/compact";
import {
  getOwnedThread,
  getWorkMemoryForThread,
  normalizeChatHistoryMessages,
} from "./threads/shared";
import type { ThreadMetadata } from "./threads/types";

/** 消息 metadata:用量 + 用户显式引用,前端据此显示上下文与强调徽章 */
interface WorkMessageMetadata {
  usage?: LanguageModelUsage;
  skillNames?: string[];
  fileReferences?: Array<{ id: string; filename: string; url: string }>;
}

interface LibraryCitationSource {
  id: string;
  assetId: string;
  filename: string;
  url: string;
  snippet: string;
  score: number;
}

interface WorkspaceLogData {
  objectId: string;
  sha256: string;
  byteSize: number;
  contentType: string;
  encoding: string;
  chunkSize: number;
  chunkCount: number;
  storagePath: string;
  workspacePath: string;
  characterCount: number;
  lineCount: number;
  exitCode: number | null;
  stdout: { lines: number; bytes: number };
  stderr: { lines: number; bytes: number };
  source: string;
}

type WorkDataParts = {
  "task-update": { tasks: unknown[] };
  "library-sources": LibraryCitationSource[];
  "workspace-log": WorkspaceLogData;
};

type WorkUIMessage = UIMessage<WorkMessageMetadata, WorkDataParts>;

async function truncateHistoryForRewrite(options: {
  memory: Memory;
  threadId: string;
  resourceId: string;
  trigger?: unknown;
  messageId?: unknown;
}): Promise<void> {
  if (
    (options.trigger !== "regenerate-message" && options.trigger !== "submit-message") ||
    typeof options.messageId !== "string"
  ) {
    return;
  }

  const recalled = await options.memory.recall({
    threadId: options.threadId,
    resourceId: options.resourceId,
    perPage: false,
  });
  const messages = recalled.messages ?? [];
  const targetIndex = messages.findIndex((message) => message.id === options.messageId);
  const target = targetIndex >= 0 ? messages[targetIndex] : undefined;
  if (!target) throw workError("MESSAGE_NOT_FOUND");
  // AI SDK uses the last assistant message id when sendMessage(undefined)
  // submits an approval response. That is a native approval resume, not a
  // user edit, so its persisted history must remain untouched.
  if (options.trigger === "submit-message" && target.role === "assistant") return;
  if (
    (options.trigger === "regenerate-message" && target.role !== "assistant") ||
    (options.trigger === "submit-message" && target.role !== "user")
  ) {
    throw workError("MESSAGE_NOT_FOUND");
  }

  const startIndex = options.trigger === "regenerate-message" ? targetIndex : targetIndex + 1;
  const messageIds = messages.slice(startIndex).map((message) => message.id);
  if (messageIds.length === 0) return;

  await options.memory.settled();
  let restoreObservations: (() => Promise<void>) | undefined;
  try {
    restoreObservations = await removeObservationalMemoryReferences(
      options.memory,
      options.threadId,
      options.resourceId,
      messageIds,
    );
    await options.memory.deleteMessages(messageIds);
  } catch (error) {
    await restoreObservations?.();
    throw error;
  }
  await options.memory.settled();
}

function userMessageInput(message: WorkUIMessage): AgentMessageInput | undefined {
  type AgentMessageContents = Exclude<AgentSignalContents, string>;
  const contents = message.parts.reduce<AgentMessageContents>((result, part) => {
    if (part.type === "text" && part.text.trim()) {
      result.push({ type: "text", text: part.text });
      return result;
    }
    if (part.type !== "file") return result;
    try {
      result.push({
        type: "file",
        data: new URL(part.url),
        mediaType: part.mediaType,
        ...(part.filename ? { filename: part.filename } : {}),
      });
    } catch {
      return result;
    }
    return result;
  }, []);
  if (contents.length === 0) return undefined;
  return {
    contents,
    ...(message.metadata ? { metadata: message.metadata as Record<string, unknown> } : {}),
  };
}

async function normalizeIncrementalMessages(options: {
  memory: Memory;
  threadId: string;
  resourceId: string;
  messages: WorkUIMessage[];
  trigger?: unknown;
  messageId?: unknown;
  runId?: unknown;
  toolCallId?: unknown;
  resumeData?: unknown;
}): Promise<WorkUIMessage[]> {
  if (!Array.isArray(options.messages)) {
    throw workError("VALIDATION_FAILED", { text: "messages must be an array" });
  }
  const persisted = await options.memory.recall({
    threadId: options.threadId,
    resourceId: options.resourceId,
    perPage: false,
  });
  const persistedIds = new Set((persisted.messages ?? []).map((message) => message.id));
  const persistedChatMessages = toAISdkMessages(
    normalizeChatHistoryMessages(persisted.messages ?? []),
    { version: "v7" },
  ) as WorkUIMessage[];
  const unique = new Map<string, WorkUIMessage>();
  for (const message of options.messages) {
    if (!message || typeof message.id !== "string" || !message.id.trim()) {
      throw workError("VALIDATION_FAILED", { text: "Every message must have an id" });
    }
    if (unique.has(message.id)) {
      throw workError("VALIDATION_FAILED", { text: "Duplicate message ids are not accepted" });
    }
    unique.set(message.id, message);
  }

  const trigger = options.trigger;
  const targetId = typeof options.messageId === "string" ? options.messageId : undefined;
  if (trigger === "regenerate-message" && targetId) {
    // AI SDK removes the target assistant from the request before sending it.
    // Resolve it from Memory and use the preceding persisted user turn as the
    // only input for the new run.
    if (options.messages.some((message) => !persistedIds.has(message.id))) {
      throw workError("VALIDATION_FAILED", {
        text: "Regeneration may only reference persisted messages",
      });
    }
    const persistedIndex = (persisted.messages ?? []).findIndex(
      (message) => message.id === targetId,
    );
    const target = persisted.messages?.[persistedIndex];
    if (target?.role !== "assistant") throw workError("MESSAGE_NOT_FOUND");
    const previousUser = [...(persisted.messages ?? []).slice(0, persistedIndex)]
      .reverse()
      .find((message) => message.role === "user");
    if (!previousUser) {
      throw workError("VALIDATION_FAILED", {
        text: "The regenerated assistant message has no persisted user turn",
      });
    }
    const [canonicalUser] = toAISdkMessages([previousUser], { version: "v7" }) as WorkUIMessage[];
    if (!canonicalUser) {
      throw workError("VALIDATION_FAILED", { text: "The persisted user turn is invalid" });
    }
    return [canonicalUser];
  }

  if (trigger === "submit-message" && targetId && !persistedIds.has(targetId)) {
    throw workError("MESSAGE_NOT_FOUND");
  }

  const current = options.messages.filter((message) => !persistedIds.has(message.id));
  if (options.resumeData !== undefined) {
    if (current.length > 0) {
      throw workError("VALIDATION_FAILED", {
        text: "Tool resume responses may only reference persisted messages",
      });
    }
    const runId = typeof options.runId === "string" ? options.runId.trim() : "";
    const toolCallId = typeof options.toolCallId === "string" ? options.toolCallId.trim() : "";
    if (!runId || !toolCallId) {
      throw workError("VALIDATION_FAILED", {
        text: "runId and toolCallId are required for tool resume responses",
      });
    }
    const latest = options.messages.at(-1);
    if (!latest || !persistedIds.has(latest.id) || latest.role !== "assistant") {
      throw workError("VALIDATION_FAILED", {
        text: "A persisted tool interaction message is required",
      });
    }
    const persistedLatest = persistedChatMessages.find((message) => message.id === latest.id);
    if (!persistedLatest) {
      throw workError("MESSAGE_NOT_FOUND");
    }
    return [persistedLatest];
  }

  // 未落库的消息一律只能是用户回合:客户端伪造的助手历史到此为止,永远进不了
  // Memory。多于一条则取最后一条 —— 上一轮生成失败(模型报错 / 断流)时 AI SDK
  // 会把那条用户消息留在本地列表里,它从未落库,于是下一次发送就带着两条「新
  // 消息」。拒绝会让整条线程卡死在同一个错误上直到刷新;丢弃早先那次未发生的
  // 尝试才是它的真实语义。进 run 的始终只有最后一条,防伪造强度不变。
  if (current.some((message) => message.role !== "user")) {
    throw workError("VALIDATION_FAILED", { text: "The new message must be a user message" });
  }
  const newestUser = current.at(-1);
  if (newestUser) return [newestUser];

  // Edits reuse the persisted user message id; send only the replacement to the run.
  if (trigger === "submit-message" && targetId) {
    const replacement = unique.get(targetId);
    if (replacement?.role === "user") return [replacement];
  }

  // Native approval responses reuse the persisted assistant row. The request
  // target came from listSuspendedRuns(); Mastra's handleChatStream owns the
  // UI-message approval conversion and resume operation.
  const latest = options.messages.at(-1);
  const nativeApprovalTarget =
    typeof options.runId === "string" &&
    options.runId.trim() &&
    typeof options.toolCallId === "string" &&
    options.toolCallId.trim();
  if (latest && persistedIds.has(latest.id) && nativeApprovalTarget) {
    return [latest];
  }

  throw workError("VALIDATION_FAILED", { text: "A new user message is required" });
}

function subscribedAgentStream(
  subscription: AgentThreadSubscription,
  targetRunId: string,
  onClose: () => void,
) {
  return new ReadableStream({
    async start(controller) {
      try {
        for await (const chunk of subscription.stream) {
          if ((chunk as { runId?: unknown }).runId !== targetRunId) continue;
          controller.enqueue(chunk);
          if (isTerminalAgentChunk(chunk)) break;
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      } finally {
        onClose();
      }
    },
    cancel: onClose,
  });
}

const TASK_TOOL_NAMES = new Set(["task_write", "task_update", "task_complete", "task_check"]);
const LIBRARY_SEARCH_TOOL_NAMES = new Set(["library_vector_search", "library_graph_search"]);

function asTaskSnapshot(value: unknown): unknown[] | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const tasks = (value as { tasks?: unknown }).tasks;
  return Array.isArray(tasks) ? tasks : undefined;
}

function asLibrarySources(value: unknown): LibraryCitationSource[] {
  if (typeof value !== "object" || value === null) return [];
  const results = (value as { results?: unknown }).results;
  if (!Array.isArray(results)) return [];

  return results.flatMap((item) => {
    if (typeof item !== "object" || item === null) return [];
    const result = item as Record<string, unknown>;
    const assetId = typeof result.assetId === "string" ? result.assetId : "";
    const url = typeof result.url === "string" ? result.url : "";
    if (!assetId || !url) return [];
    try {
      new URL(url);
    } catch {
      return [];
    }
    const score =
      typeof result.score === "number" && Number.isFinite(result.score) ? result.score : 0;
    return [
      {
        id:
          typeof result.citationId === "string" && result.citationId
            ? result.citationId
            : `library-${assetId}`,
        assetId,
        filename:
          typeof result.filename === "string" && result.filename ? result.filename : "资料库文件",
        url,
        snippet: typeof result.text === "string" ? result.text.slice(0, 280) : "",
        score,
      },
    ];
  });
}

/**
 * 合成一个自定义 data-* chunk 插进既有 UI 流。
 *
 * 这里必须有一次 cast:我们在**别人定义好的** chunk 联合类型里新增自定义 part,
 * 类型只能由调用方的 chunk 类型承载。集中到一个具名函数里,免得两处各写一遍。
 */
function dataChunk<C>(type: string, id: string, data: unknown): C {
  return { type, id, data } as unknown as C;
}

/**
 * AI SDK v7 将 task 工具结果作为普通 tool-output part 发送,但任务状态
 * 不会自动成为 UI data part。追加一个轻量快照,
 * 让输入区能在同一轮流式响应中立即刷新,同时仍保留普通 tool part 的持久化。
 *
 * 对 chunk 类型泛型化(而不是写死成某个具体 chunk 类型):handleChatStream 的
 * v7 重载返回的是它自己内置的那份 AI SDK v7 类型副本,与我们从 `ai` 导入的
 * 同名类型并非同一处声明,写死会在这里被判为不兼容;泛型让调用点的真实类型
 * 原样贯穿,下游读 messageMetadata.usage 也就还有类型。
 */
function streamTaskUpdates<C>(stream: ReadableStream<C>): ReadableStream<C> {
  const toolNames = new Map<string, string>();
  return stream.pipeThrough(
    new TransformStream<C, C>({
      transform(chunk, controller) {
        const raw = chunk as {
          type?: unknown;
          toolCallId?: unknown;
          toolName?: unknown;
          output?: unknown;
        };
        if (
          raw.type === "tool-input-available" &&
          typeof raw.toolCallId === "string" &&
          typeof raw.toolName === "string"
        ) {
          toolNames.set(raw.toolCallId, raw.toolName);
        }

        controller.enqueue(chunk);
        if (raw.type !== "tool-output-available" || typeof raw.toolCallId !== "string") return;

        const toolName = toolNames.get(raw.toolCallId) ?? "";
        if (TASK_TOOL_NAMES.has(toolName)) {
          const tasks = asTaskSnapshot(raw.output);
          if (tasks) {
            controller.enqueue(dataChunk<C>("data-task-update", raw.toolCallId, { tasks }));
          }
        }
        if (LIBRARY_SEARCH_TOOL_NAMES.has(toolName)) {
          const sources = asLibrarySources(raw.output);
          if (sources.length > 0) {
            controller.enqueue(
              dataChunk<C>("data-library-sources", `${raw.toolCallId}:library-sources`, sources),
            );
          }
        }
        toolNames.delete(raw.toolCallId);
      },
    }),
  );
}

function streamLibrarySources<C>(
  stream: ReadableStream<C>,
  sources: LibraryCitationSource[],
): ReadableStream<C> {
  if (sources.length === 0) return stream;
  return stream.pipeThrough(
    new TransformStream<C, C>({
      start(controller) {
        controller.enqueue(dataChunk<C>("data-library-sources", "library-sources", sources));
      },
      transform(chunk, controller) {
        controller.enqueue(chunk);
      },
    }),
  );
}

function durableClientStream<C>(
  stream: ReadableStream<C>,
  options: {
    librarySources: LibraryCitationSource[];
    onFinish: (usage: LanguageModelUsage | undefined) => Promise<void>;
  },
): ReadableStream<C> {
  const persistingStream = streamLibrarySources(
    streamTaskUpdates(stream),
    options.librarySources,
  ).pipeThrough(
    new TransformStream<C, C>({
      async transform(value, controller) {
        const raw = value as {
          type?: unknown;
          messageMetadata?: { usage?: LanguageModelUsage };
        };
        if (raw.type === "finish") {
          try {
            await options.onFinish(raw.messageMetadata?.usage);
          } catch {
            // The Agent message is already durable; auxiliary metadata must not
            // convert a successful run into an AI SDK transport error.
          }
        }
        controller.enqueue(value);
      },
    }),
  );

  // Keep consuming if the browser disconnects. An explicit session abort is
  // the only operation that stops the underlying Agent run.
  const [clientStream, monitorStream] = persistingStream.tee();
  void (async () => {
    const reader = monitorStream.getReader();
    try {
      while (!(await reader.read()).done) {
        // onFinish performs the durable auxiliary writes.
      }
    } finally {
      reader.releaseLock();
    }
  })().catch(() => undefined);
  return clientStream;
}

async function persistLatestUsage(
  threadId: string | undefined,
  resourceId: string | undefined,
  usage: LanguageModelUsage | undefined,
  requestContext: RequestContext,
) {
  if (!threadId) return;
  const memory = resourceId
    ? await getWorkMemoryForThread(requestContext, threadId, resourceId)
    : await getWorkMemory(requestContext);
  const thread = await memory.getThreadById({ threadId });
  if (!thread) return;

  await memory.updateThread({
    id: threadId,
    // draft 一经产生真实消息往来即失效(新会话线程 = 无任何历史消息)
    metadata: { ...thread.metadata, draft: false, ...(usage ? { contextUsage: usage } : {}) },
  });
}

/**
 * 线程会话准备:一次读取 + 一次写入,解决 Harness session 的三件事。
 *
 * 1. **工作区绑定**(目录侧):首条消息锁定 thread.metadata.workspacePath,此后不可更换。
 *    显式绑定 = 请求携带的 workspacePath(校验为真实目录后记入近期列表);
 *    隐式绑定 = <threadsRoot>/<threadId>/,按需创建。
 * 2. **模式跃迁**:submit_plan 获批(resumeData.action === "approved")且当前模式配了
 *    transitionsTo 时切换模式。裁决只在服务端做一次,前端 resume 后刷新线程即可看到。
 * 3. **模型形态快照**:把本次请求用的模型形态写进线程,切线程时前端据此恢复选择。
 *    只存形态(providerId / modelId / modelName / reasoningEffort),apiKey 与
 *    gateway url 永不落线程元数据。
 *
 * 合并成一个函数是为了只读一次线程、只写一次元数据 —— 三件事各自读写会在
 * 同一请求里产生三轮 getThreadById + updateThread。
 */
async function prepareThreadSession(options: {
  threadId: string;
  resourceId: string;
  requestedWorkspacePath?: string;
  modelSnapshot?: NonNullable<ThreadMetadata["modelSelectionByMode"]>[string];
  planApproved: boolean;
  agentProfileId?: string;
  requestContext: RequestContext;
}): Promise<
  | {
      workspacePath?: string;
      modeId: string;
      permissionRules: unknown;
      agentProfileId: string;
    }
  | undefined
> {
  const memory = await getWorkMemoryForThread(
    options.requestContext,
    options.threadId,
    options.resourceId,
  );
  const thread = await memory.getThreadById({ threadId: options.threadId });
  if (!thread) return undefined;
  const metadata = (thread.metadata ?? {}) as ThreadMetadata;
  const patch: ThreadMetadata = {};
  const profile = await getAgentProfile(
    options.agentProfileId ?? metadata.agentProfileId,
    options.resourceId,
  );
  if (metadata.agentProfileId !== profile.id && options.agentProfileId)
    patch.agentProfileId = profile.id;

  const workspaceEnabled = isWorkspaceEnabled();
  let workspacePath = workspaceEnabled ? metadata.workspacePath : undefined;
  if (workspaceEnabled && !workspacePath) {
    const requested = options.requestedWorkspacePath;
    if (requested && existsSync(requested) && statSync(requested).isDirectory()) {
      workspacePath = requested;
      patch.workspacePath = requested;
      patch.workspaceExplicit = true;
      await addRecentWorkspace(requested);
    } else {
      // 隐式绑定:使用线程专属默认目录,同样作为用户可浏览的工作区
      const implicitPath = implicitThreadWorkspacePath(options.threadId);
      ensureDirectory(implicitPath);
      workspacePath = implicitPath;
      patch.workspacePath = implicitPath;
      patch.workspaceExplicit = false;
    }
  }

  const mode = resolveMode(metadata.modeId);
  let modeId: string = mode.id;
  if (options.planApproved && mode.transitionsTo) {
    modeId = mode.transitionsTo;
    patch.modeId = modeId;
  }

  const snapshot = options.modelSnapshot;
  if (snapshot) {
    const current = metadata.modelSelectionByMode?.[modeId];
    const unchanged =
      current?.providerId === snapshot.providerId &&
      current?.modelId === snapshot.modelId &&
      current?.reasoningEffort === snapshot.reasoningEffort;
    if (!unchanged) {
      patch.modelSelectionByMode = {
        ...metadata.modelSelectionByMode,
        [modeId]: snapshot,
      };
    }
  }

  if (Object.keys(patch).length > 0) {
    await memory.updateThread({
      id: options.threadId,
      title: thread.title,
      metadata: { ...metadata, ...patch },
    });
  }

  return {
    workspacePath,
    modeId,
    permissionRules: metadata.permissionRules,
    agentProfileId: profile.id,
  };
}

/** 请求体里的模型形态快照(前端 transport 随 body.modelSelection 上传) */
function parseModelSnapshot(
  value: unknown,
): NonNullable<ThreadMetadata["modelSelectionByMode"]>[string] | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.providerId !== "string" || typeof raw.modelId !== "string") return undefined;
  return {
    providerId: raw.providerId,
    modelId: raw.modelId,
    modelName: typeof raw.modelName === "string" ? raw.modelName : raw.modelId,
    reasoningEffort: typeof raw.reasoningEffort === "string" ? raw.reasoningEffort : "off",
  };
}

/** submit_plan 的批准判定(resume 形状见 docs/en/reference/tools/submit-plan-tool.mdx) */
function isPlanApproval(resumeData: unknown): boolean {
  if (typeof resumeData !== "object" || resumeData === null) return false;
  return (resumeData as { action?: unknown }).action === "approved";
}

export const workChatRoute = registerApiRoute("/chat/:agentId", {
  method: "POST",
  handler: async (c) => {
    // chatRoute() is the convenience wrapper around this same adapter. We keep
    // the lower-level handler here because the workbench must prepare request
    // context and transform UI data chunks per thread before returning the
    // standard AI SDK response; the stream protocol itself remains official.
    // body 结构参考 docs/en/reference/ai-sdk/chat-route.mdx
    // (messages + memory: { thread, resource })
    const body = (await c.req.json()) as {
      messages: WorkUIMessage[];
      // AgentMemoryOption.thread 必填(string 或 { id } 对象)
      memory?: { thread: string; resource?: string };
      /** 首条消息时用户显式选定的工作区目录(promptInput 选择器,发送后锁定) */
      workspacePath?: string;
      attachmentTokenBudget?: number;
      attachmentCapabilities?: { vision?: boolean; audio?: boolean };
      skillNames?: string[];
      sessionScope?: string;
      sessionAction?: "steer";
      agentProfileId?: string;
      [key: string]: unknown;
    };
    const authenticatedUser = c.get("requestContext")?.get("user") as { id?: unknown } | undefined;
    const authenticatedResourceId =
      typeof authenticatedUser?.id === "string" ? authenticatedUser.id : undefined;
    if (!authenticatedResourceId) throw workError("AUTH_REQUIRED");
    const requestContext = c.get("requestContext");
    if (!body.memory?.thread) {
      throw workError("VALIDATION_FAILED", { text: "memory.thread is required" });
    }
    body.memory.resource = authenticatedResourceId;
    if (
      !(await getOwnedThread(
        await getWorkMemoryForThread(requestContext, body.memory.thread, authenticatedResourceId),
        body.memory.thread,
        authenticatedResourceId,
      ))
    ) {
      throw workError("THREAD_NOT_FOUND");
    }
    const requestMemory = await getWorkMemoryForThread(
      requestContext,
      body.memory.thread,
      authenticatedResourceId,
    );
    body.messages = await normalizeIncrementalMessages({
      memory: requestMemory,
      threadId: body.memory.thread,
      resourceId: authenticatedResourceId,
      messages: body.messages,
      trigger: body.trigger,
      messageId: body.messageId,
      runId: body.runId,
      toolCallId: body.toolCallId,
      resumeData: body.resumeData,
    });
    await truncateHistoryForRewrite({
      memory: requestMemory,
      threadId: body.memory.thread,
      resourceId: authenticatedResourceId,
      trigger: body.trigger,
      messageId: body.messageId,
    });
    const mastra = c.get("mastra");
    if (body.memory?.resource) {
      requestContext.set(LIBRARY_RESOURCE_CONTEXT_KEY, body.memory.resource);
      requestContext.set(LIBRARY_ORIGIN_CONTEXT_KEY, new URL(c.req.url).origin);
      requestContext.set(WORKSPACE_RESOURCE_ID_CONTEXT_KEY, body.memory.resource);
    }
    if (body.memory?.thread) {
      requestContext.set(LIBRARY_THREAD_CONTEXT_KEY, body.memory.thread);
      requestContext.set(WORKSPACE_THREAD_ID_CONTEXT_KEY, body.memory.thread);
    }
    // BYOK 模型解析在路由层完成:所有供应商都按当前资源构造官方 LanguageModel。
    // agent.stream() 运行时经 getLLM({ model })
    // 覆盖模型(见 @mastra/core Agent.stream);ChatStreamHandlerParams 类型未
    // 公开 model 字段,用条件展开透传(spread 不触发 excess property check)。
    const {
      model: rawModel,
      modelSelection: rawModelSelection,
      webSearch: rawWebSearch,
      workspacePath: rawWorkspacePath,
      attachmentTokenBudget,
      attachmentCapabilities,
      skillNames,
      sessionScope,
      sessionAction,
      agentProfileId: rawAgentProfileId,
      modelSettings: rawModelSettings,
      ...bodyRest
    } = body;
    const model =
      rawModel !== undefined
        ? await resolveRequestModel(rawModel, authenticatedResourceId)
        : undefined;
    if (rawModel !== undefined && !model) {
      throw workError("MODEL_NOT_CONFIGURED");
    }
    // 请求显式指定了模型 → 存入 context,Agent 默认 model 回调优先返回它:
    // listMemoryTools 等内部步骤(getModel 走默认回调)与主对话用同一模型,
    // 且「只测试某模型」不依赖全局默认选定。
    if (model !== undefined) {
      requestContext.set(REQUEST_MODEL_CONTEXT_KEY, model);
    }
    if (model && typeof model === "object" && "doGenerate" in model && "doStream" in model) {
      // RequestContext 值为 unknown;读取端(library/tools.ts 的 requestLibraryScope)
      // 自行断言,这里无需先转成 MastraLanguageModel(原生 AI SDK 模型与
      // MastraLanguageModel 存在 @ai-sdk/provider 版本偏差,直接 cast 会报 TS2352)。
      requestContext.set(LIBRARY_RERANK_MODEL_CONTEXT_KEY, model);
    }
    if (typeof attachmentTokenBudget === "number" && Number.isFinite(attachmentTokenBudget)) {
      requestContext.set(
        LIBRARY_ATTACHMENT_BUDGET_CONTEXT_KEY,
        Math.max(0, Math.floor(attachmentTokenBudget)),
      );
    }
    const requestedAgentProfileId =
      typeof rawAgentProfileId === "string" ? rawAgentProfileId : undefined;
    let profile = await getAgentProfile(requestedAgentProfileId, authenticatedResourceId);
    let profileAgent = (
      await ensureProfileAgentsRegistered(mastra, profile, authenticatedResourceId)
    ).profile;
    requestContext.set(AGENT_PROFILE_CONTEXT_KEY, profile.id);
    requestContext.set(LIBRARY_ATTACHMENT_CAPABILITIES_CONTEXT_KEY, {
      vision: attachmentCapabilities?.vision === true,
      audio: attachmentCapabilities?.audio === true,
    });
    requestContext.set(
      SKILL_NAMES_CONTEXT_KEY,
      Array.isArray(skillNames)
        ? skillNames.filter((value): value is string => typeof value === "string").slice(0, 4)
        : [],
    );
    // 联网检索:引擎 + 强度经 RequestContext 传入 Agent 的动态 tools/instructions
    // (关闭时不注入任何检索工具);同时挂结构化「检索报告」——
    // 用独立 structuring 模型,主 Agent 的工具调用与文本回答不受影响
    // (structured-output.mdx),@mastra/ai-sdk 会把最终对象以
    // data-structured-output 事件推给前端渲染引用卡片(handle-chat-stream.mdx)。
    // 模型家族(Mastra registry id):自定义 baseUrl 网关一律得到 undefined,
    // 所以 'openai' 只会是官方 OpenAI —— 供应商专属参数据此判断能不能发。
    const modelFamily =
      rawModel !== undefined
        ? requestModelFamily(rawModel)
        : await defaultModelFamily(authenticatedResourceId);
    const webSearch = parseWebSearchSelection(rawWebSearch);
    if (webSearch) {
      requestContext.set(WEB_SEARCH_CONTEXT_KEY, webSearch);
      // provider 原生检索(webSearchTool)只支持 OpenAI/Anthropic/Google/xAI,
      // 家族推断不出来时注入会让整个 run 抛 MastraError,故把家族一并传给
      // Agent 的动态 tools 由它决定是否注入。
      if (modelFamily) requestContext.set(MODEL_FAMILY_CONTEXT_KEY, modelFamily);
    }
    // 线程会话状态:工作区目录、会话模式、审批规则、模型快照一次读写(见 prepareThreadSession)。
    // 模式与规则经 RequestContext 交给 Agent 的动态 instructions / tools / defaultOptions;
    // 不经我们路由的调用(Studio 直接聊天)读不到,落到默认模式 + 默认规则。
    if (body.memory?.thread) {
      const session = await prepareThreadSession({
        threadId: body.memory.thread,
        resourceId: authenticatedResourceId,
        requestedWorkspacePath: rawWorkspacePath,
        modelSnapshot: parseModelSnapshot(rawModelSelection),
        planApproved: isPlanApproval(body.resumeData),
        agentProfileId: requestedAgentProfileId,
        requestContext,
      });
      if (session) {
        profile = await getAgentProfile(session.agentProfileId, authenticatedResourceId);
        profileAgent = (
          await ensureProfileAgentsRegistered(mastra, profile, authenticatedResourceId)
        ).profile;
        if (session.workspacePath) {
          requestContext.set(WORKSPACE_PATH_CONTEXT_KEY, session.workspacePath);
        }
        requestContext.set(WORKSPACE_THREAD_ID_CONTEXT_KEY, body.memory.thread);
        if (body.memory.resource) {
          requestContext.set(WORKSPACE_RESOURCE_ID_CONTEXT_KEY, body.memory.resource);
        }
        requestContext.set(MODE_ID_CONTEXT_KEY, session.modeId);
        if (session.permissionRules !== undefined) {
          requestContext.set(PERMISSION_RULES_CONTEXT_KEY, session.permissionRules);
        }
        requestContext.set(AGENT_PROFILE_CONTEXT_KEY, session.agentProfileId);
        if (body.memory.resource) {
          const liveSession = workSessionHost.getOrCreate({
            resourceId: body.memory.resource,
            scope: typeof body.sessionScope === "string" ? body.sessionScope : undefined,
            threadId: body.memory.thread,
            agent: profileAgent,
          });
          liveSession.setMode(session.modeId);
        }
      }
    }
    const explicitResumeTarget =
      typeof body.runId === "string" && typeof body.toolCallId === "string"
        ? { runId: body.runId.trim(), toolCallId: body.toolCallId.trim() }
        : undefined;
    const resumeTargets = explicitResumeTarget ? [explicitResumeTarget] : [];
    if (resumeTargets.length > 0 && body.memory?.thread && body.memory.resource) {
      // Mastra storage is the source of truth for suspended tools. Message
      // parts are only the AI SDK transport representation and must not be
      // reinterpreted here.
      const { runs } = await profileAgent.listSuspendedRuns({
        threadId: body.memory.thread,
        resourceId: body.memory.resource,
      });
      const allTargetsPending = resumeTargets.every((target) =>
        runs
          .find((run) => run.runId === target.runId)
          ?.toolCalls.some((toolCall) => toolCall.toolCallId === target.toolCallId),
      );
      if (!allTargetsPending) {
        throw workError("VALIDATION_FAILED", {
          text: "The requested tool interaction is no longer pending",
        });
      }
    }
    // 检索到的资料库片段以「本轮专属的对话消息」下发(AgentExecutionOptions.context,
    // docs/en/docs/memory/overview.mdx:排在历史与 recall 之后、用户新消息之前,且不写入记忆)。
    // 刻意不再拼进 instructions:Anthropic 渲染序是 tools → system → messages,
    // system 每轮变一次,整段消息历史的前缀缓存就全部失效。
    // 类型取自 AgentExecutionOptions 而不是 ai 的 ModelMessage:@mastra/core 内置了自己
    // 那份 ai-sdk 类型副本(assistant 分支的 part 联合不同),直接用 ai 的会判为不兼容。
    let libraryContext: NonNullable<AgentExecutionOptions["context"]> = [];
    if (body.memory?.resource) {
      let librarySources: LibraryCitationSource[] = [];
      const latestUser = [...body.messages].reverse().find((message) => message.role === "user");
      const query = latestUser?.parts
        .filter((part) => part.type === "text")
        .map((part) => ("text" in part ? part.text : ""))
        .join(" ")
        .trim();
      if (query) {
        // 原生 AI SDK 模型与 @mastra/rag 要求的 MastraLanguageModel 存在
        // @ai-sdk/provider 版本偏差,仅类型不兼容;rerank 运行时只调 doGenerate,安全。
        const rerankModel =
          model && typeof model === "object" && "doGenerate" in model && "doStream" in model
            ? (model as unknown as MastraLanguageModel)
            : undefined;
        const hits = await searchLibrary({
          resourceId: body.memory.resource,
          query,
          threadId: body.memory.thread,
          rerankModel,
        });
        if (hits.length > 0) {
          const origin = new URL(c.req.url).origin;
          librarySources = hits.map((hit) => ({
            id: hit.citationId,
            assetId: hit.assetId,
            filename: hit.filename || "资料库文件",
            url: new URL(
              `/work/library/assets/${encodeURIComponent(hit.assetId)}/content?resourceId=${encodeURIComponent(body.memory?.resource ?? "")}`,
              origin,
            ).href,
            snippet: hit.text.slice(0, 280),
            score: hit.score,
          }));
          // <library-context> 标签与用法约定写在 BASE_INSTRUCTIONS 里(与 <state> 同一套语义),
          // 这样规则常驻 system 而数据留在对话尾部。
          libraryContext = [
            {
              role: "user",
              content: `<library-context>\n${hits
                .map((hit) => `[${hit.filename || "资料库文件"}] [^${hit.citationId}]\n${hit.text}`)
                .join("\n\n---\n\n")}\n\n${librarySources
                .map(
                  (source) =>
                    `[^${source.id}]: [${source.filename}](${source.url}) — ${source.snippet}`,
                )
                .join("\n")}\n</library-context>`,
            },
          ];
          requestContext.set("libraryCitationSources", librarySources);
        }
      }
    }
    // version:'v7' 让流与消息直接使用 AI SDK v7 类型,路由边界零类型转换
    // (docs/en/reference/ai-sdk/handle-chat-stream.mdx)。
    const handlerOptions = {
      mastra,
      agentId: profileAgent.id,
      version: "v7" as const,
      sendReasoning: true,
      // params 里没有 context 字段,本轮资料库片段只能走 defaultOptions(AgentExecutionOptions)
      ...(libraryContext.length > 0 ? { defaultOptions: { context: libraryContext } } : {}),
      messageMetadata: ({ part }: { part: TextStreamPart<ToolSet> }) =>
        part.type === "finish" ? { usage: part.totalUsage } : undefined,
    };
    // Responses 网关的推理只回加密块(reasoningEncryptedContent),请求
    // reasoningSummary 让上游输出明文摘要 —— 前端展示与 Memory 落库才有推理文本。
    // 与 body 自带的 providerOptions(如 max effort 的 reasoningEffort)合并且不覆盖。
    const reasoningSummary = await usesOpenAIResponses(rawModel);
    const rawProviderOptions =
      typeof bodyRest.providerOptions === "object" && bodyRest.providerOptions !== null
        ? (bodyRest.providerOptions as Record<string, unknown>)
        : {};
    // prompt_cache_key:OpenAI 靠它把同一会话的请求路由到同一台缓存机器 —— 前缀一致
    // 还不够,得落在同一台上才谈得上命中。线程 id 天然「同会话稳定、跨会话不同」。
    // 只发给官方 OpenAI:自定义 OpenAI 协议网关未必接受这个参数,严格实现会直接 400,
    // 而它们的缓存路由本就由自己决定,发过去也没有收益。
    const openaiProviderOptions = {
      ...((rawProviderOptions.openai as Record<string, unknown> | undefined) ?? {}),
      ...(reasoningSummary ? { reasoningSummary: "auto" } : {}),
      ...(modelFamily === "openai" && body.memory?.thread
        ? { promptCacheKey: body.memory.thread }
        : {}),
    };
    const params = {
      ...bodyRest,
      ...(model !== undefined ? { model } : {}),
      ...(resolveMode(requestContext.get(MODE_ID_CONTEXT_KEY)).availableTools !== undefined
        ? { activeTools: resolveMode(requestContext.get(MODE_ID_CONTEXT_KEY)).availableTools }
        : {}),
      ...(Object.keys(openaiProviderOptions).length > 0
        ? { providerOptions: { ...rawProviderOptions, openai: openaiProviderOptions } }
        : {}),
      messages: body.messages,
      requestContext,
      untilIdle: true,
    };
    const sessionExecutionOptions =
      body.memory?.thread && body.memory.resource
        ? ({
            ...(params.activeTools ? { activeTools: params.activeTools } : {}),
            ...(typeof rawModelSettings === "object" && rawModelSettings !== null
              ? { modelSettings: rawModelSettings as AgentExecutionOptions["modelSettings"] }
              : {}),
            ...(typeof params.providerOptions === "object" && params.providerOptions !== null
              ? {
                  providerOptions:
                    params.providerOptions as AgentExecutionOptions["providerOptions"],
                }
              : {}),
            ...((bodyRest as Record<string, unknown>).versions !== undefined
              ? {
                  versions: (bodyRest as Record<string, unknown>)
                    .versions as AgentExecutionOptions["versions"],
                }
              : {}),
            ...((bodyRest as Record<string, unknown>).scorers !== undefined
              ? {
                  scorers: (bodyRest as Record<string, unknown>)
                    .scorers as AgentExecutionOptions["scorers"],
                }
              : {}),
            ...((bodyRest as Record<string, unknown>).isTaskComplete !== undefined
              ? {
                  isTaskComplete: (bodyRest as Record<string, unknown>)
                    .isTaskComplete as AgentExecutionOptions["isTaskComplete"],
                }
              : {}),
            requestContext,
            untilIdle: true,
            memory: { thread: body.memory.thread, resource: body.memory.resource },
          } satisfies AgentExecutionOptions)
        : undefined;
    if (sessionExecutionOptions && body.memory?.thread && body.memory.resource) {
      workSessionHost
        .getOrCreate({
          resourceId: body.memory.resource,
          scope: sessionScope,
          threadId: body.memory.thread,
          agent: profileAgent,
        })
        .setExecutionDefaults(sessionExecutionOptions);
    }
    // 资料库片段只属于当前这一轮,所以交给 sendMessage/steer 而不写进 setExecutionDefaults ——
    // 会话默认值会被后续自动唤醒的 run 复用,那时旧检索结果已经是纯噪音。
    const turnExecutionOptions =
      sessionExecutionOptions && libraryContext.length > 0
        ? ({ ...sessionExecutionOptions, context: libraryContext } satisfies AgentExecutionOptions)
        : sessionExecutionOptions;
    const librarySources = requestContext.get("libraryCitationSources") as
      | LibraryCitationSource[]
      | undefined;
    const prepareClientStream = <C>(stream: ReadableStream<C>) =>
      durableClientStream(stream, {
        librarySources: librarySources ?? [],
        onFinish: async (usage) => {
          await persistLatestUsage(
            body.memory?.thread,
            body.memory?.resource,
            usage,
            requestContext,
          );
        },
      });
    if (sessionAction === "steer" && body.memory?.thread && body.memory.resource) {
      const latestUser = [...body.messages].reverse().find((message) => message.role === "user");
      const content = latestUser?.parts
        .filter((part) => part.type === "text")
        .map((part) => ("text" in part ? part.text : ""))
        .join(" ")
        .trim();
      if (!latestUser || !content) {
        throw workError("VALIDATION_FAILED", { text: "A text message is required" });
      }
      const session = workSessionHost.getOrCreate({
        resourceId: body.memory.resource,
        scope: sessionScope,
        threadId: body.memory.thread,
        agent: profileAgent,
      });
      session.setMode(resolveMode(requestContext.get(MODE_ID_CONTEXT_KEY)).id);
      // 客户端消息 id 即持久化 id(见 WorkSession 的 userSignal):下一次请求的
      // 增量校验才能把这条插话认成已落库的历史,而不是又一条「本轮新消息」。
      const signal = await session.steer(
        {
          contents: content,
          ...(latestUser.metadata
            ? { metadata: latestUser.metadata as Record<string, unknown> }
            : {}),
        },
        turnExecutionOptions,
        latestUser.id,
      );
      const accepted = await signal.accepted;
      if (accepted.action !== "wake") {
        throw workError("SESSION_RUN_ACTIVE");
      }
      const stream = toAISdkStream(accepted.output, {
        from: "agent",
        version: "v7",
        sendReasoning: true,
        messageMetadata: ({ part }) =>
          part.type === "finish" ? { usage: part.totalUsage } : undefined,
      });
      return createUIMessageStreamResponse({ stream: prepareClientStream(stream) });
    }
    const latestMessage = body.messages.at(-1);
    const sessionMemory = body.memory;
    const startsNewSessionTurn = Boolean(
      body.trigger === "submit-message" &&
        typeof body.messageId !== "string" &&
        body.runId === undefined &&
        body.resumeData === undefined &&
        latestMessage?.role === "user" &&
        sessionMemory?.thread &&
        sessionMemory.resource,
    );
    if (startsNewSessionTurn && latestMessage && sessionMemory?.thread && sessionMemory.resource) {
      const input = userMessageInput(latestMessage);
      if (!input)
        throw workError("VALIDATION_FAILED", { text: "A text or file message is required" });
      const session = workSessionHost.getOrCreate({
        resourceId: sessionMemory.resource,
        scope: sessionScope,
        threadId: sessionMemory.thread,
        agent: profileAgent,
      });
      session.setMode(resolveMode(requestContext.get(MODE_ID_CONTEXT_KEY)).id);
      const subscription = await session.subscribe(sessionMemory.thread);
      // 落库沿用客户端消息 id(见 WorkSession 的 userSignal),否则前端本地的
      // 这条用户消息在下一轮请求里会被增量校验判成新消息。
      const signal = session.sendMessage(input, turnExecutionOptions, latestMessage.id);
      const accepted = await signal.accepted;
      if (!("runId" in accepted) || accepted.action === "blocked") {
        session.releaseSubscription(subscription);
        throw workError("SESSION_MESSAGE_REJECTED");
      }
      const fullStream = subscribedAgentStream(subscription, accepted.runId, () =>
        session.releaseSubscription(subscription),
      );
      const stream = toAISdkStream({ fullStream } as unknown as MastraModelOutput, {
        from: "agent",
        version: "v7",
        sendReasoning: true,
        messageMetadata: ({ part }) =>
          part.type === "finish" ? { usage: part.totalUsage } : undefined,
      });
      return createUIMessageStreamResponse({ stream: prepareClientStream(stream) });
    }
    // 刻意**不传** abortSignal: c.req.raw.signal —— 客户端断连(刷新窗口、切走)不等于
    // 用户要求中止生成。不传之后:断连时下面的监控分支仍会把流读完,Agent 跑到结束并
    // 由 Memory 落库,重新打开线程就能看到完整回复,长任务不会因为一次刷新白跑。
    // 真正的「停止」走会话 abort 端点(Agent.abortThreadStream),
    // 与 AI SDK 的 resumable-stream 指南同一分工:disconnect ≠ explicit stop。
    // 不再配置 structuredOutput(jsonPromptInjection 会把报告 schema 注入提示词,
    // 第三方网关模型会把它当正文打印在回复末尾);联网引用由检索工具输出直接
    // 驱动(buildCitationEntries 的工具输出通路)。
    const stream = await handleChatStream({ ...handlerOptions, params });

    return createUIMessageStreamResponse({ stream: prepareClientStream(stream) });
  },
});
