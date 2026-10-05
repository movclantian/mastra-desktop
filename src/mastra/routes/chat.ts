/**
 * 工作台聊天主路由(POST /chat/:agentId)。
 * 官方文档:docs/en/reference/agent-controller/session.mdx。
 * 职责:解析请求级上下文(模型 / 检索引擎 / 附件预算 / 技能),准备线程会话
 * (工作区与 Agent profile 绑定,见 prepareThreadSession),再按运行形态
 * 由官方 Session 执行；输出通过 Controller 的原生事件订阅送达。
 */
import { existsSync, statSync } from "node:fs";
import { toAISdkMessages } from "@mastra/ai-sdk/ui";
import type { AgentExecutionOptions, AgentSignal } from "@mastra/core/agent";
import type { RequestContext } from "@mastra/core/request-context";
import { registerApiRoute } from "@mastra/core/server";
import type { Memory } from "@mastra/memory";
import { safeValidateUIMessages, type UIMessage } from "ai";
import { z } from "zod";
import { SESSION_EXECUTION_CONTEXT_KEY, SKILL_NAMES_CONTEXT_KEY } from "../agents";
import {
  AGENT_PROFILE_CONTEXT_KEY,
  ensureProfileAgentsRegistered,
  getAgentProfile,
} from "../agents/custom";
import { workError } from "../errors";
import {
  REQUEST_MODEL_ID_CONTEXT_KEY,
  requestModelFamily,
  resolveRequestModel,
  usesOpenAIResponses,
} from "../models/providers";
import { searchLibrary } from "../rag/retrieval/search";
import {
  LIBRARY_ATTACHMENT_BUDGET_CONTEXT_KEY,
  LIBRARY_ATTACHMENT_CAPABILITIES_CONTEXT_KEY,
  LIBRARY_ORIGIN_CONTEXT_KEY,
  LIBRARY_RESOURCE_CONTEXT_KEY,
  LIBRARY_THREAD_CONTEXT_KEY,
  type LibraryCitationSource,
  libraryCitationSources,
} from "../rag/types";
import { appStorage } from "../storage";
import { parseWebSearchSelection, WEB_SEARCH_CONTEXT_KEY } from "../tools";
import {
  addRecentWorkspace,
  ensureDirectory,
  implicitThreadWorkspacePath,
  WORKSPACE_PATH_CONTEXT_KEY,
  WORKSPACE_RESOURCE_ID_CONTEXT_KEY,
  WORKSPACE_THREAD_ID_CONTEXT_KEY,
} from "../workspace";
import { abortWorkbenchSession, getWorkbenchSession, observeSessionWork } from "./session";
import type { ThreadMetadata } from "./threads/shared";
import {
  deleteThreadMessages,
  getOwnedThread,
  getWorkMemory,
  normalizeChatHistoryMessages,
} from "./threads/shared";

/** 用户显式引用随消息持久化，供界面恢复技能与附件展示。 */
interface WorkMessageMetadata {
  skillNames?: string[];
  fileReferences?: Array<{
    id: string;
    filename: string;
    url: string;
    mediaType?: string;
  }>;
}

type WorkUIMessage = UIMessage<WorkMessageMetadata>;

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
  const messages = normalizeChatHistoryMessages(recalled.messages ?? []);
  const targetIndex = messages.findIndex((message) => message.id === options.messageId);
  const target = targetIndex >= 0 ? messages[targetIndex] : undefined;
  if (!target) throw workError("MESSAGE_NOT_FOUND");
  if (
    (options.trigger === "regenerate-message" && target.role !== "assistant") ||
    (options.trigger === "submit-message" && target.role !== "user")
  ) {
    throw workError("MESSAGE_NOT_FOUND");
  }

  // Remove the edited user too: its replacement must invalidate derived OM even
  // when no assistant reply was saved. Include signals after the rewrite boundary.
  const startIndex = recalled.messages.findIndex((message) => message.id === options.messageId);
  const messageIds = recalled.messages.slice(startIndex).map((message) => message.id);
  if (messageIds.length === 0) return;

  await deleteThreadMessages(options.memory, options.threadId, options.resourceId, messageIds);
}

async function normalizeIncrementalMessages(options: {
  memory: Memory;
  threadId: string;
  resourceId: string;
  messages: WorkUIMessage[];
  trigger?: unknown;
  messageId?: unknown;
  isResume: boolean;
}): Promise<WorkUIMessage[]> {
  if (!Array.isArray(options.messages)) {
    throw workError("VALIDATION_FAILED", { text: "messages must be an array" });
  }
  // The Agent's persisted suspended run validates resumes; client history is
  // neither needed nor trusted (including recovery before history has loaded).
  if (options.isResume) return [];
  await options.memory.settled();
  const recalled = await options.memory.recall({
    threadId: options.threadId,
    resourceId: options.resourceId,
    perPage: false,
  });
  const persisted = { messages: normalizeChatHistoryMessages(recalled.messages ?? []) };
  const persistedIds = new Set((persisted.messages ?? []).map((message) => message.id));
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
  if (trigger === "regenerate-message" && !targetId) {
    throw workError("VALIDATION_FAILED", { text: "Regeneration requires a messageId" });
  }
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

  if (trigger === "submit-message" && targetId) {
    const target = persisted.messages.find((message) => message.id === targetId);
    if (target?.role !== "user") throw workError("MESSAGE_NOT_FOUND");
    const replacement = unique.get(targetId);
    if (replacement?.role !== "user" || options.messages.at(-1)?.id !== targetId) {
      throw workError("VALIDATION_FAILED", {
        text: "An edit must end with the replacement user message",
      });
    }
    if (options.messages.some((message) => !persistedIds.has(message.id))) {
      throw workError("VALIDATION_FAILED", {
        text: "An edit cannot also submit a new message",
      });
    }
    return [replacement];
  }

  const current = options.messages.filter((message) => !persistedIds.has(message.id));

  // 未落库的消息一律只能是用户回合:客户端伪造的助手历史到此为止,永远进不了
  // Memory。多于一条则取最后一条 —— 上一轮生成失败(模型报错 / 断流)时 AI SDK
  // 会把那条用户消息留在本地列表里,它从未落库,于是下一次发送就带着两条「新
  // 消息」。拒绝会让整条线程卡死在同一个错误上直到刷新;丢弃早先那次未发生的
  // 尝试才是它的真实语义。进 run 的始终只有最后一条,防伪造强度不变。
  if (current.some((message) => message.role !== "user")) {
    throw workError("VALIDATION_FAILED", { text: "The new message must be a user message" });
  }
  const newestUser = current.at(-1);
  if (newestUser) {
    const store = await appStorage.getStore("memory");
    if (!store) throw new Error("Memory storage is not configured");
    const { messages } = await store.listMessagesById({ messageIds: [newestUser.id] });
    if (messages.length) {
      throw workError("VALIDATION_FAILED", { text: "Message id is already in use" });
    }
    return [newestUser];
  }

  throw workError("VALIDATION_FAILED", { text: "A new user message is required" });
}

/** Bind the workspace and agent profile before opening the native Session. */
async function prepareThreadSession(options: {
  threadId: string;
  resourceId: string;
  requestedWorkspacePath?: string;
  agentProfileId?: string;
  requestContext: RequestContext;
}): Promise<
  | {
      workspacePath?: string;
      agentProfileId: string;
    }
  | undefined
> {
  const memory = await getWorkMemory(options.requestContext);
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

  let workspacePath = metadata.workspacePath;
  if (!workspacePath) {
    const requested = options.requestedWorkspacePath;
    if (requested && existsSync(requested) && statSync(requested).isDirectory()) {
      workspacePath = requested;
      patch.workspacePath = requested;
      patch.workspaceExplicit = true;
      await addRecentWorkspace(requested, options.resourceId);
    } else {
      // 隐式绑定:使用线程专属默认目录,同样作为用户可浏览的工作区
      const implicitPath = await implicitThreadWorkspacePath(options.threadId, options.resourceId);
      ensureDirectory(implicitPath);
      workspacePath = implicitPath;
      patch.workspacePath = implicitPath;
      patch.workspaceExplicit = false;
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
    agentProfileId: profile.id,
  };
}

export const workChatRoute = registerApiRoute("/chat/:agentId", {
  method: "POST",
  handler: async (c) => {
    // body 结构参考 docs/en/reference/ai-sdk/chat-route.mdx
    // (messages + memory: { thread, resource })
    const parsed = z
      .object({
        messages: z.unknown(),
        memory: z.object({ thread: z.string().trim().min(1), resource: z.string().optional() }),
        workspacePath: z.string().optional(),
        attachmentTokenBudget: z.number().finite().nonnegative().optional(),
        attachmentCapabilities: z
          .object({ vision: z.boolean().optional(), audio: z.boolean().optional() })
          .optional(),
        skillNames: z.array(z.string()).max(4).optional(),
        sessionScope: z.string().optional(),
        sessionAction: z.literal("steer").optional(),
        agentProfileId: z.string().optional(),
        trigger: z.enum(["submit-message", "regenerate-message"]).optional(),
        messageId: z.string().min(1).optional(),
        runId: z.string().trim().min(1).optional(),
        toolCallId: z.string().trim().min(1).optional(),
        approval: z.object({ approved: z.boolean(), reason: z.string().optional() }).optional(),
        resumeData: z.unknown().optional(),
        modelSettings: z.record(z.string(), z.unknown()).optional(),
        providerOptions: z.record(z.string(), z.unknown()).optional(),
        webSearch: z.unknown().optional(),
        versions: z.unknown().optional(),
        scorers: z.unknown().optional(),
        isTaskComplete: z.unknown().optional(),
      })
      .safeParse(await c.req.json());
    if (!parsed.success)
      throw workError("VALIDATION_FAILED", {
        text: "Invalid chat request",
        details: { issues: parsed.error.issues },
      });
    const validatedMessages = await safeValidateUIMessages<WorkUIMessage>({
      messages: parsed.data.messages,
    });
    if (!validatedMessages.success)
      throw workError("VALIDATION_FAILED", { text: validatedMessages.error.message });
    const body = { ...parsed.data, messages: validatedMessages.data };
    const isResume = body.approval !== undefined || body.resumeData !== undefined;
    if (
      isResume !== Boolean(body.runId && body.toolCallId) ||
      Boolean(body.runId) !== Boolean(body.toolCallId) ||
      (body.approval !== undefined && body.resumeData !== undefined) ||
      (isResume && (body.trigger === "regenerate-message" || body.sessionAction))
    ) {
      throw workError("VALIDATION_FAILED", {
        text: "Resume requires exactly one response and a run/tool-call pair",
      });
    }
    const authenticatedUser = c.get("requestContext")?.get("user") as { id?: unknown } | undefined;
    const authenticatedResourceId =
      typeof authenticatedUser?.id === "string" ? authenticatedUser.id : undefined;
    if (!authenticatedResourceId) throw workError("AUTH_REQUIRED");
    const requestContext = c.get("requestContext");
    if (!body.memory?.thread) {
      throw workError("VALIDATION_FAILED", { text: "memory.thread is required" });
    }
    const threadId = body.memory.thread;
    body.memory.resource = authenticatedResourceId;
    if (
      !(await getOwnedThread(
        await getWorkMemory(requestContext),
        body.memory.thread,
        authenticatedResourceId,
      ))
    ) {
      throw workError("THREAD_NOT_FOUND");
    }
    const requestMemory = await getWorkMemory(requestContext);
    body.messages = await normalizeIncrementalMessages({
      memory: requestMemory,
      threadId: body.memory.thread,
      resourceId: authenticatedResourceId,
      messages: body.messages,
      trigger: body.trigger,
      messageId: body.messageId,
      isResume,
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
    const {
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
    if (typeof attachmentTokenBudget === "number" && Number.isFinite(attachmentTokenBudget)) {
      requestContext.set(
        LIBRARY_ATTACHMENT_BUDGET_CONTEXT_KEY,
        Math.max(0, Math.floor(attachmentTokenBudget)),
      );
    }
    const requestedAgentProfileId =
      typeof rawAgentProfileId === "string" ? rawAgentProfileId : undefined;
    let profile = await getAgentProfile(requestedAgentProfileId, authenticatedResourceId);
    await ensureProfileAgentsRegistered(mastra, profile, authenticatedResourceId);
    const profileAgent = mastra.getAgentById("mastra-work-agent");
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
    if (body.memory?.thread) {
      const session = await prepareThreadSession({
        threadId: body.memory.thread,
        resourceId: authenticatedResourceId,
        requestedWorkspacePath: rawWorkspacePath,
        agentProfileId: requestedAgentProfileId,
        requestContext,
      });
      if (session) {
        profile = await getAgentProfile(session.agentProfileId, authenticatedResourceId);
        await ensureProfileAgentsRegistered(mastra, profile, authenticatedResourceId);
        if (session.workspacePath) {
          requestContext.set(WORKSPACE_PATH_CONTEXT_KEY, session.workspacePath);
        }
        requestContext.set(WORKSPACE_THREAD_ID_CONTEXT_KEY, body.memory.thread);
        if (body.memory.resource) {
          requestContext.set(WORKSPACE_RESOURCE_ID_CONTEXT_KEY, body.memory.resource);
        }
        requestContext.set(AGENT_PROFILE_CONTEXT_KEY, session.agentProfileId);
      }
    }
    const controllerSession = await getWorkbenchSession(
      c,
      body.memory.thread,
      authenticatedResourceId,
      sessionScope,
    );
    const selectedModel = { id: controllerSession.model.get() };
    const model = await resolveRequestModel(selectedModel, authenticatedResourceId);
    if (!model) throw workError("MODEL_NOT_CONFIGURED");
    requestContext.set(REQUEST_MODEL_ID_CONTEXT_KEY, selectedModel.id);
    const modelFamily = await requestModelFamily(selectedModel, authenticatedResourceId);
    const webSearch = parseWebSearchSelection(rawWebSearch);
    if (webSearch) requestContext.set(WEB_SEARCH_CONTEXT_KEY, webSearch);
    const explicitResumeTarget =
      typeof body.runId === "string" && typeof body.toolCallId === "string"
        ? { runId: body.runId.trim(), toolCallId: body.toolCallId.trim() }
        : undefined;
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
        const hits = await searchLibrary({
          origin: new URL(c.req.url).origin,
          resourceId: body.memory.resource,
          query,
          threadId: body.memory.thread,
          rerankModel: model,
        });
        if (hits.length > 0) {
          librarySources = libraryCitationSources({ results: hits });
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
    // Responses 网关的推理只回加密块(reasoningEncryptedContent),请求
    // reasoningSummary 让上游输出明文摘要 —— 前端展示与 Memory 落库才有推理文本。
    // 与 body 自带的 providerOptions(如 max effort 的 reasoningEffort)合并且不覆盖。
    const reasoningSummary = await usesOpenAIResponses(selectedModel, authenticatedResourceId);
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
    requestContext.set(SESSION_EXECUTION_CONTEXT_KEY, {
      context: libraryContext,
      modelSettings: rawModelSettings,
      providerOptions: { ...rawProviderOptions, openai: openaiProviderOptions },
      ...(body.versions ? { versions: body.versions } : {}),
      ...(body.scorers ? { scorers: body.scorers } : {}),
      ...(body.isTaskComplete ? { isTaskComplete: body.isTaskComplete } : {}),
    });
    if (!isResume) {
      const message = body.messages.at(-1);
      if (
        message?.role !== "user" ||
        !message.parts.some(
          (part) => (part.type === "text" && part.text.trim()) || part.type === "file",
        )
      ) {
        throw workError("SESSION_INPUT_REQUIRED");
      }
      if (message.parts.some((part) => part.type !== "text" && part.type !== "file")) {
        throw workError("VALIDATION_FAILED", { text: "User input must contain text or files" });
      }
    }
    const librarySources = requestContext.get("libraryCitationSources") as
      | LibraryCitationSource[]
      | undefined;
    if (explicitResumeTarget) {
      const pending = controllerSession.suspensions.get({
        toolCallId: explicitResumeTarget.toolCallId,
      });
      const approval = controllerSession.displayState
        .get()
        .pendingApprovals.get(explicitResumeTarget.toolCallId);
      let tool: { toolCallId?: string; toolName?: string; requiresApproval: boolean } | undefined;
      if (
        pending?.runId === explicitResumeTarget.runId &&
        pending.threadId === threadId &&
        pending.resourceId === authenticatedResourceId
      ) {
        tool = {
          toolCallId: explicitResumeTarget.toolCallId,
          toolName: pending.toolName,
          requiresApproval: false,
        };
      } else if (
        approval &&
        controllerSession.approval.isArmed({ ...explicitResumeTarget, threadId })
      ) {
        tool = { ...approval, requiresApproval: true };
      } else {
        const { runs } = await profileAgent.listSuspendedRuns({
          threadId,
          resourceId: authenticatedResourceId,
        });
        tool = runs
          .find((run) => run.runId === explicitResumeTarget.runId)
          ?.toolCalls.find((call) => call.toolCallId === explicitResumeTarget.toolCallId);
      }
      if (!tool?.toolCallId)
        throw workError("VALIDATION_FAILED", { text: "Tool interaction is no longer pending" });
      const toolCallId = tool.toolCallId;
      if (tool.requiresApproval !== (body.approval !== undefined)) {
        throw workError("VALIDATION_FAILED", {
          text: "Response does not match the pending interaction type",
        });
      }
      if (body.approval) {
        const { approved, reason } = body.approval;
        if (controllerSession.approval.isArmed({ toolCallId: toolCallId })) {
          const result = controllerSession.respondToToolApproval({
            toolCallId: toolCallId,
            decision: approved ? "approve" : "decline",
            requestContext,
            declineContext: reason ? { message: reason } : undefined,
          });
          if (!result.accepted)
            throw workError("SESSION_MESSAGE_REJECTED", { text: result.reason });
        } else {
          if (!controllerSession.claimToolResponse(toolCallId))
            throw workError("SESSION_MESSAGE_REJECTED");
          const target = {
            ...explicitResumeTarget,
            threadId,
            resourceId: authenticatedResourceId,
            requestContext,
          };
          const work = approved
            ? controllerSession.approveToolCall(target)
            : controllerSession.declineToolCall({
                ...target,
                declineContext: reason ? { message: reason } : undefined,
              });
          observeSessionWork(
            c,
            controllerSession,
            work.finally(() => controllerSession.releaseToolResponse(toolCallId)),
          );
        }
      } else {
        controllerSession.suspensions.register({
          ...explicitResumeTarget,
          toolName: tool.toolName ?? "",
          threadId,
          resourceId: authenticatedResourceId,
        });
        const claim = controllerSession.claimToolSuspension(toolCallId);
        if (!claim.accepted) throw workError("SESSION_MESSAGE_REJECTED", { text: claim.reason });
        observeSessionWork(
          c,
          controllerSession,
          controllerSession
            .respondToToolSuspension({
              toolCallId: toolCallId,
              resumeData: body.resumeData,
              requestContext,
            })
            .finally(() => controllerSession.releaseToolResponse(toolCallId)),
        );
      }
      return c.json({ ok: true, librarySources: librarySources ?? [] });
    }
    const message = body.messages.at(-1);
    if (message?.role !== "user") throw workError("SESSION_INPUT_REQUIRED");
    if (sessionAction === "steer") await abortWorkbenchSession(controllerSession);
    if (
      body.messageId &&
      (body.trigger === "submit-message" || body.trigger === "regenerate-message")
    ) {
      await abortWorkbenchSession(controllerSession);
      await truncateHistoryForRewrite({
        memory: requestMemory,
        threadId,
        resourceId: authenticatedResourceId,
        trigger: body.trigger,
        messageId: body.messageId,
      });
    }
    const contents = message.parts.flatMap<Exclude<AgentSignal["contents"], string>[number]>(
      (part) => {
        if (part.type === "text") return [{ type: "text", text: part.text }];
        if (part.type === "file")
          return [
            { type: "file", data: part.url, mediaType: part.mediaType, filename: part.filename },
          ];
        return [];
      },
    );
    await controllerSession.sendSignal(
      {
        type: "user",
        id: message.id,
        contents,
        metadata: { ...message.metadata, librarySources: librarySources ?? [] },
      },
      { requestContext, requireDelivery: true, untilIdle: true },
    ).accepted;
    await controllerSession.thread.setSetting({ key: "draft", value: false });
    return c.json({ ok: true, librarySources: librarySources ?? [] });
  },
});
