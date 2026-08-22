/**
 * 工作台会话控制路由(/work/sessions/:scope/threads/:threadId/*):
 * stream / message / steer / follow-up / abort / mode / model / permissions /
 * grants / workbench-state / notification。
 * 官方文档:docs/en/docs/harness/agent-controller.mdx(sessions 章节)。
 */
import { toAISdkStream } from "@mastra/ai-sdk";
import type { AgentExecutionOptions, AgentThreadSubscription } from "@mastra/core/agent";
import { type ContextWithMastra, registerApiRoute } from "@mastra/core/server";
import type { MastraModelOutput } from "@mastra/core/stream";
import { TASK_STATE_TYPE, type TaskItem } from "@mastra/core/tools";
import { createUIMessageStreamResponse } from "ai";
import { z } from "zod";
import { SKILL_NAMES_CONTEXT_KEY } from "../../agents";
import { AGENT_PROFILE_CONTEXT_KEY, getAgentProfile } from "../../agents/custom";
import { applyModeToRules, MODE_ID_CONTEXT_KEY, resolveMode } from "../../agents/modes";
import {
  applySessionGrants,
  PERMISSION_RULES_CONTEXT_KEY,
  parsePermissionRules,
  resolveToolPolicy,
  TOOL_CATEGORIES,
  type ToolCategory,
  toolCategoryOf,
} from "../../agents/permissions";
import { mergeWorkbenchState, workbenchStateSchema } from "../../agents/processors";
import { SUBAGENT_MODELS_CONTEXT_KEY } from "../../agents/subagents";
import { workError } from "../../errors";
import {
  isTerminalAgentChunk,
  SESSION_SCOPE_DEFAULT,
  type WorkNotificationInput,
  type WorkSession,
  workSessionHost,
} from "../../harness";
import { OM_MODELS_CONTEXT_KEY } from "../../memory";
import {
  REQUEST_MODEL_CONTEXT_KEY,
  requestModelFamily,
  resolveConfiguredModel,
  resolveRequestModel,
  usesOpenAIResponses,
} from "../../models";
import { appStorage } from "../../storage";
import {
  MODEL_FAMILY_CONTEXT_KEY,
  parseWebSearchSelection,
  WEB_SEARCH_CONTEXT_KEY,
} from "../../tools";
import { WORKSPACE_PATH_CONTEXT_KEY } from "../../workspace";
import { getOwnedThread, getWorkMemory, type OwnedThread } from "./threads/shared";
import type { ThreadMetadata } from "./threads/types";

function scopeOf(value: string | undefined): string {
  return value?.trim() || SESSION_SCOPE_DEFAULT;
}

/**
 * 通知记录的入参校验。字段对齐 Agent.sendNotificationSignal():source/kind/summary
 * 必填,priority 缺省时由框架按 medium 处理,dedupeKey 用于合并同源重复事件。
 */
const notificationInputSchema = z.object({
  source: z.string().min(1),
  kind: z.string().min(1),
  summary: z.string().min(1),
  priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
  payload: z.unknown().optional(),
  dedupeKey: z.string().min(1).optional(),
  coalesceKey: z.string().min(1).optional(),
  attributes: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

interface SessionRouteResult {
  session: WorkSession;
  resourceId: string;
  threadId: string;
  thread: NonNullable<OwnedThread>;
}

interface SessionMessageBody {
  content?: string;
  metadata?: Record<string, unknown>;
  model?: unknown;
  modelSettings?: unknown;
  providerOptions?: unknown;
  webSearch?: unknown;
  agentProfileId?: unknown;
}

async function sessionFor(c: ContextWithMastra): Promise<SessionRouteResult> {
  const threadId = c.req.param("threadId");
  const resourceId = c.req.query("resourceId");
  const scope = scopeOf(c.req.param("scope"));
  if (!resourceId || !threadId)
    throw workError("VALIDATION_FAILED", { text: "resourceId and threadId are required" });
  const memory = await getWorkMemory();
  const thread = await getOwnedThread(memory, threadId, resourceId);
  if (!thread) {
    throw workError("THREAD_NOT_FOUND");
  }
  const metadata = (thread.metadata ?? {}) as ThreadMetadata;
  const profile = await getAgentProfile(metadata.agentProfileId);
  const session = workSessionHost.getOrCreate({
    resourceId,
    scope,
    threadId,
    agent: c.get("mastra").getAgentById(profile.id),
  });
  const mode = resolveMode(metadata.modeId);
  session.setMode(mode.id);
  const requestContext = c.get("requestContext");
  requestContext.set(MODE_ID_CONTEXT_KEY, mode.id);
  requestContext.set(AGENT_PROFILE_CONTEXT_KEY, profile.id);
  requestContext.set(PERMISSION_RULES_CONTEXT_KEY, metadata.permissionRules);
  if (metadata.workspacePath) {
    requestContext.set(WORKSPACE_PATH_CONTEXT_KEY, metadata.workspacePath);
  }
  const modelSelection = metadata.modelSelectionByMode?.[mode.id];
  if (modelSelection) {
    const model = await resolveConfiguredModel(modelSelection.providerId, modelSelection.modelId);
    if (model) requestContext.set(REQUEST_MODEL_CONTEXT_KEY, model);
  }
  if (metadata.subagentModels) {
    requestContext.set(SUBAGENT_MODELS_CONTEXT_KEY, metadata.subagentModels);
  }
  if (metadata.observerModelId || metadata.reflectorModelId) {
    requestContext.set(OM_MODELS_CONTEXT_KEY, {
      observerModelId: metadata.observerModelId,
      reflectorModelId: metadata.reflectorModelId,
    });
  }
  session.setExecutionDefaults({
    ...(mode.availableTools ? { activeTools: mode.availableTools } : {}),
    requestContext,
    memory: { thread: threadId, resource: resourceId },
  });
  return { session, resourceId, threadId, thread };
}

async function sessionExecutionOptions(
  c: ContextWithMastra,
  result: SessionRouteResult,
  body: SessionMessageBody,
): Promise<AgentExecutionOptions> {
  const requestContext = c.get("requestContext");
  const profile = await getAgentProfile(
    typeof body.agentProfileId === "string"
      ? body.agentProfileId
      : ((result.thread.metadata as ThreadMetadata | undefined)?.agentProfileId ?? undefined),
  );
  requestContext.set(AGENT_PROFILE_CONTEXT_KEY, profile.id);
  result.session.setAgent(c.get("mastra").getAgentById(profile.id));
  const skillNames = body.metadata?.skillNames;
  if (Array.isArray(skillNames)) {
    requestContext.set(
      SKILL_NAMES_CONTEXT_KEY,
      skillNames
        .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        .slice(0, 4),
    );
  }
  if (body.model !== undefined) {
    const model = await resolveRequestModel(body.model);
    if (!model) throw workError("MODEL_NOT_CONFIGURED");
    requestContext.set(REQUEST_MODEL_CONTEXT_KEY, model);
    const family = requestModelFamily(body.model);
    if (family) requestContext.set(MODEL_FAMILY_CONTEXT_KEY, family);
  }
  const webSearch = parseWebSearchSelection(body.webSearch);
  if (webSearch) requestContext.set(WEB_SEARCH_CONTEXT_KEY, webSearch);

  const rawProviderOptions =
    typeof body.providerOptions === "object" && body.providerOptions !== null
      ? (body.providerOptions as Record<string, unknown>)
      : undefined;
  const reasoningSummary = body.model !== undefined && (await usesOpenAIResponses(body.model));
  const providerOptions = reasoningSummary
    ? {
        ...(rawProviderOptions ?? {}),
        openai: {
          ...((rawProviderOptions?.openai as Record<string, unknown> | undefined) ?? {}),
          reasoningSummary: "auto",
        },
      }
    : rawProviderOptions;
  const mode = resolveMode((result.thread.metadata as ThreadMetadata | undefined)?.modeId);
  return {
    ...(mode.availableTools ? { activeTools: mode.availableTools } : {}),
    ...(typeof body.modelSettings === "object" && body.modelSettings !== null
      ? { modelSettings: body.modelSettings as AgentExecutionOptions["modelSettings"] }
      : {}),
    ...(providerOptions
      ? { providerOptions: providerOptions as AgentExecutionOptions["providerOptions"] }
      : {}),
    requestContext,
    memory: { thread: result.threadId, resource: result.resourceId },
  };
}

async function persistentDisplayState(c: ContextWithMastra, result: SessionRouteResult) {
  const displayState = result.session.getDisplayState();
  const threadState = await appStorage.getStore("threadState");
  const tasks = await threadState?.getState<TaskItem[]>({
    threadId: result.threadId,
    type: TASK_STATE_TYPE,
  });
  const metadata = (result.thread.metadata ?? {}) as ThreadMetadata;
  const profile = await getAgentProfile(metadata.agentProfileId);
  const agent = c.get("mastra").getAgentById(profile.id);
  const { runs } = await agent.listSuspendedRuns({
    threadId: result.threadId,
    resourceId: result.resourceId,
  });
  const policyMetadata = (result.thread.metadata ?? {}) as {
    modeId?: string;
    permissionRules?: unknown;
  };
  const rules = applyModeToRules(
    applySessionGrants(parsePermissionRules(policyMetadata.permissionRules), {
      ...result.session.getGrants(),
      yolo: result.session.getState().yolo === true,
    }),
    resolveMode(policyMetadata.modeId),
  );
  return {
    ...displayState,
    status: displayState.activeRunId ? "running" : runs.length > 0 ? "suspended" : "idle",
    tasks: Array.isArray(tasks) ? tasks : [],
    suspendedRuns: runs.map((run) => ({
      ...run,
      toolCalls: run.toolCalls.map((toolCall) => ({
        ...toolCall,
        category: toolCategoryOf(toolCall.toolName ?? ""),
        policy: resolveToolPolicy(rules, toolCall.toolName ?? ""),
      })),
    })),
  };
}

function subscriptionStream(subscription: AgentThreadSubscription, onClose: () => void) {
  const fullStream = new ReadableStream({
    async start(controller) {
      try {
        for await (const chunk of subscription.stream) {
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
  return toAISdkStream({ fullStream } as unknown as MastraModelOutput, {
    from: "agent",
    version: "v7",
    sendReasoning: true,
  });
}

export const sessionStreamRoute = registerApiRoute(
  "/work/sessions/:scope/threads/:threadId/stream",
  {
    method: "GET",
    handler: async (c) => {
      const result = await sessionFor(c);
      const followUpId = c.req.query("followUpId");
      const followUpSubscription = followUpId
        ? await result.session.subscribeFollowUp(followUpId)
        : undefined;
      if (followUpId && !followUpSubscription) return new Response(null, { status: 204 });
      if (!followUpSubscription && !result.session.getDisplayState().activeRunId) {
        return new Response(null, { status: 204 });
      }
      const subscription =
        followUpSubscription ?? (await result.session.subscribe(result.threadId));
      const stream = subscriptionStream(subscription, () =>
        result.session.releaseSubscription(subscription),
      );
      return createUIMessageStreamResponse({ stream });
    },
  },
);

export const sessionMessageRoute = registerApiRoute(
  "/work/sessions/:scope/threads/:threadId/message",
  {
    method: "POST",
    handler: async (c) => {
      const result = await sessionFor(c);
      const body = (await c.req.json()) as SessionMessageBody;
      if (!body.content?.trim()) throw workError("SESSION_INPUT_REQUIRED");
      const execution = await sessionExecutionOptions(c, result, body);
      const accepted = result.session.sendMessage(
        { contents: body.content.trim(), ...(body.metadata ? { metadata: body.metadata } : {}) },
        execution,
      );
      return c.json({ ok: true, accepted: await accepted.accepted });
    },
  },
);

export const sessionSteerRoute = registerApiRoute("/work/sessions/:scope/threads/:threadId/steer", {
  method: "POST",
  handler: async (c) => {
    const result = await sessionFor(c);
    const body = (await c.req.json()) as SessionMessageBody;
    if (!body.content?.trim()) throw workError("SESSION_INPUT_REQUIRED");
    const execution = await sessionExecutionOptions(c, result, body);
    const accepted = await result.session.steer(
      { contents: body.content.trim(), ...(body.metadata ? { metadata: body.metadata } : {}) },
      execution,
    );
    return c.json({ ok: true, accepted: await accepted.accepted });
  },
});

export const sessionFollowUpRoute = registerApiRoute(
  "/work/sessions/:scope/threads/:threadId/follow-up",
  {
    method: "POST",
    handler: async (c) => {
      const result = await sessionFor(c);
      const body = (await c.req.json()) as SessionMessageBody;
      if (!body.content?.trim()) throw workError("SESSION_INPUT_REQUIRED");
      const execution = await sessionExecutionOptions(c, result, body);
      const followUp = await result.session.followUp(
        { contents: body.content.trim(), ...(body.metadata ? { metadata: body.metadata } : {}) },
        execution,
      );
      if (followUp.action === "blocked") {
        throw workError("SESSION_FOLLOW_UP_BLOCKED");
      }
      return c.json({ ok: true, ...followUp });
    },
  },
);

export const sessionAbortRoute = registerApiRoute("/work/sessions/:scope/threads/:threadId/abort", {
  method: "POST",
  handler: async (c) => {
    const result = await sessionFor(c);
    return c.json({ aborted: result.session.abort() });
  },
});

export const sessionStateRoute = registerApiRoute("/work/sessions/:scope/threads/:threadId/state", {
  method: "GET",
  handler: async (c) => {
    const result = await sessionFor(c);
    return c.json({ state: result.session.getState() });
  },
});

export const updateSessionStateRoute = registerApiRoute(
  "/work/sessions/:scope/threads/:threadId/state",
  {
    method: "PATCH",
    handler: async (c) => {
      const result = await sessionFor(c);
      try {
        const state = result.session.setState(await c.req.json());
        return c.json({ state });
      } catch (error) {
        return c.json(
          { error: error instanceof Error ? error.message : "Invalid session state" },
          400,
        );
      }
    },
  },
);

export const sessionModeRoute = registerApiRoute("/work/sessions/:scope/threads/:threadId/mode", {
  method: "PATCH",
  handler: async (c) => {
    const result = await sessionFor(c);
    const body = (await c.req.json()) as { modeId?: unknown };
    const mode = resolveMode(body.modeId);
    const memory = await getWorkMemory();
    const thread = await memory.updateThread({
      id: result.threadId,
      title: result.thread.title,
      metadata: { ...result.thread.metadata, modeId: mode.id },
    });
    result.session.setMode(mode.id);
    result.session.notifyPolicyChange(
      `The user switched the session mode to "${mode.id}". Its instructions and tool restrictions take effect immediately — re-plan if your current approach relied on the previous mode.`,
      { change: "mode", modeId: mode.id },
    );
    return c.json({ modeId: mode.id, mode, thread });
  },
});

export const sessionModelRoute = registerApiRoute("/work/sessions/:scope/threads/:threadId/model", {
  method: "PATCH",
  handler: async (c) => {
    const result = await sessionFor(c);
    const body = (await c.req.json()) as {
      modeId?: unknown;
      selection?: unknown;
    };
    const mode = resolveMode(body.modeId ?? (result.thread.metadata as ThreadMetadata)?.modeId);
    if (body.selection === null) {
      const modelSelectionByMode = {
        ...((result.thread.metadata as ThreadMetadata)?.modelSelectionByMode ?? {}),
      };
      delete modelSelectionByMode[mode.id];
      const memory = await getWorkMemory();
      const thread = await memory.updateThread({
        id: result.threadId,
        title: result.thread.title,
        metadata: { ...result.thread.metadata, modelSelectionByMode },
      });
      return c.json({ modeId: mode.id, selection: null, thread });
    }
    if (typeof body.selection !== "object" || body.selection === null) {
      throw workError("MODEL_SELECTION_REQUIRED");
    }
    const raw = body.selection as Record<string, unknown>;
    if (typeof raw.providerId !== "string" || typeof raw.modelId !== "string") {
      throw workError("MODEL_SELECTION_REQUIRED", {
        text: "selection.providerId and selection.modelId are required",
      });
    }
    const model = await resolveConfiguredModel(raw.providerId, raw.modelId);
    if (!model) throw workError("MODEL_NOT_CONFIGURED");
    const selection = {
      providerId: raw.providerId,
      modelId: raw.modelId,
      modelName: typeof raw.modelName === "string" ? raw.modelName : raw.modelId,
      reasoningEffort: typeof raw.reasoningEffort === "string" ? raw.reasoningEffort : "off",
    };
    const metadata = result.thread.metadata as ThreadMetadata;
    const memory = await getWorkMemory();
    const thread = await memory.updateThread({
      id: result.threadId,
      title: result.thread.title,
      metadata: {
        ...result.thread.metadata,
        modelSelectionByMode: {
          ...(metadata.modelSelectionByMode ?? {}),
          [mode.id]: selection,
        },
      },
    });
    return c.json({ modeId: mode.id, selection, thread });
  },
});

export const sessionPermissionsRoute = registerApiRoute(
  "/work/sessions/:scope/threads/:threadId/permissions",
  {
    method: "GET",
    handler: async (c) => {
      const result = await sessionFor(c);
      const rules = parsePermissionRules(
        (result.thread.metadata as ThreadMetadata | undefined)?.permissionRules,
      );
      return c.json({ rules, grants: result.session.getGrants() });
    },
  },
);

export const updateSessionPermissionsRoute = registerApiRoute(
  "/work/sessions/:scope/threads/:threadId/permissions",
  {
    method: "PATCH",
    handler: async (c) => {
      const result = await sessionFor(c);
      const rules = parsePermissionRules(await c.req.json());
      const memory = await getWorkMemory();
      const thread = await memory.updateThread({
        id: result.threadId,
        title: result.thread.title,
        metadata: { ...result.thread.metadata, permissionRules: rules },
      });
      result.session.notifyPolicyChange(
        "The user rewrote this session's tool approval rules. Some tools may have become available and others withheld — check what a tool returns rather than assuming the previous policy still holds.",
        { change: "permission-rules" },
      );
      return c.json({ rules, grants: result.session.getGrants(), thread });
    },
  },
);

export const sessionDisplayStateRoute = registerApiRoute(
  "/work/sessions/:scope/threads/:threadId/display-state",
  {
    method: "GET",
    handler: async (c) => {
      const result = await sessionFor(c);
      return c.json({ displayState: await persistentDisplayState(c, result) });
    },
  },
);

export const sessionSubagentModelsRoute = registerApiRoute(
  "/work/sessions/:scope/threads/:threadId/subagent-models",
  {
    method: "GET",
    handler: async (c) => {
      const result = await sessionFor(c);
      const metadata = (result.thread.metadata ?? {}) as {
        subagentModels?: Record<string, string>;
      };
      return c.json({ subagentModels: metadata.subagentModels ?? {} });
    },
  },
);

export const updateSessionSubagentModelsRoute = registerApiRoute(
  "/work/sessions/:scope/threads/:threadId/subagent-models",
  {
    method: "PATCH",
    handler: async (c) => {
      const result = await sessionFor(c);
      const body = (await c.req.json()) as { agentType?: unknown; modelId?: unknown };
      if (typeof body.agentType !== "string" || !body.agentType.trim()) {
        throw workError("VALIDATION_FAILED", { text: "agentType is required" });
      }
      if (body.modelId !== null && typeof body.modelId !== "string") {
        throw workError("VALIDATION_FAILED", { text: "modelId must be a string or null" });
      }
      const metadata = (result.thread.metadata ?? {}) as {
        subagentModels?: Record<string, string>;
      };
      const next = { ...(metadata.subagentModels ?? {}) };
      if (body.modelId === null || body.modelId.trim() === "") delete next[body.agentType];
      else next[body.agentType] = body.modelId.trim();
      const memory = await getWorkMemory();
      const thread = await memory.updateThread({
        id: result.threadId,
        title: result.thread.title,
        metadata: { ...result.thread.metadata, subagentModels: next },
      });
      return c.json({ subagentModels: next, thread });
    },
  },
);

export const sessionGrantRoute = registerApiRoute(
  "/work/sessions/:scope/threads/:threadId/grants",
  {
    method: "POST",
    handler: async (c) => {
      const result = await sessionFor(c);
      const body = (await c.req.json()) as { category?: unknown };
      if (!TOOL_CATEGORIES.includes(body.category as ToolCategory)) {
        throw workError("VALIDATION_FAILED", { text: "unsupported grant category" });
      }
      result.session.grantCategory(body.category as ToolCategory);
      result.session.notifyPolicyChange(
        `The user granted the "${body.category}" tool category for the rest of this session. Those tools no longer need per-call approval — proceed without asking again.`,
        { change: "grant-category", category: String(body.category) },
      );
      return c.json({ grants: result.session.getGrants() });
    },
  },
);

export const sessionGrantRevokeRoute = registerApiRoute(
  "/work/sessions/:scope/threads/:threadId/grants/:category",
  {
    method: "DELETE",
    handler: async (c) => {
      const result = await sessionFor(c);
      const category = c.req.param("category") as ToolCategory;
      if (!TOOL_CATEGORIES.includes(category))
        throw workError("VALIDATION_FAILED", { text: "unsupported grant category" });
      result.session.revokeCategory(category);
      return c.json({ grants: result.session.getGrants() });
    },
  },
);

export const sessionToolGrantRoute = registerApiRoute(
  "/work/sessions/:scope/threads/:threadId/grants/tools",
  {
    method: "POST",
    handler: async (c) => {
      const result = await sessionFor(c);
      const body = (await c.req.json()) as { toolName?: unknown };
      if (typeof body.toolName !== "string" || !body.toolName.trim()) {
        throw workError("VALIDATION_FAILED", { text: "toolName is required" });
      }
      result.session.grantTool(body.toolName.trim());
      result.session.notifyPolicyChange(
        `The user granted the "${body.toolName.trim()}" tool for the rest of this session. It no longer needs per-call approval.`,
        { change: "grant-tool", toolName: body.toolName.trim() },
      );
      return c.json({ grants: result.session.getGrants() });
    },
  },
);

export const sessionToolGrantRevokeRoute = registerApiRoute(
  "/work/sessions/:scope/threads/:threadId/grants/tools/:toolName",
  {
    method: "DELETE",
    handler: async (c) => {
      const result = await sessionFor(c);
      const toolName = c.req.param("toolName").trim();
      if (!toolName) throw workError("VALIDATION_FAILED", { text: "toolName is required" });
      result.session.revokeTool(toolName);
      return c.json({ grants: result.session.getGrants() });
    },
  },
);

/**
 * 工作台状态上报(state lane 的生产者入口)。
 *
 * 渲染进程各面板把自己那一份 PUT 上来 —— 编辑器打开了什么、终端跑完了什么、
 * 哪些面板可见。服务端只维护内存镜像,真正把它变成模型可见的 <state> 是
 * agents/processors.ts 里三条 lane 的 computeStateSignal():只在模型要推理时
 * 注入,所以频繁上报不会唤醒空闲的 agent、也不会污染历史。
 */
export const updateSessionWorkbenchStateRoute = registerApiRoute(
  "/work/sessions/:scope/threads/:threadId/workbench-state",
  {
    method: "PUT",
    handler: async (c) => {
      const result = await sessionFor(c);
      const parsed = workbenchStateSchema.safeParse(await c.req.json());
      if (!parsed.success) {
        throw workError("VALIDATION_FAILED", {
          text: "Invalid workbench state",
          details: { issues: parsed.error.issues },
        });
      }
      return c.json({ state: mergeWorkbenchState(result.threadId, parsed.data) });
    },
  },
);

/**
 * 外部事件 → 通知收件箱。前端用它投递自己那侧才知道的事件(终端里跑完的长
 * 命令等);服务端侧的后台任务走 src/mastra/index.ts 注册的索引完成回调。
 * 投递时机与是否攒成 summary 由 agent 的默认投递策略决定,这里只负责落库。
 */
export const sessionNotificationRoute = registerApiRoute(
  "/work/sessions/:scope/threads/:threadId/notification",
  {
    method: "POST",
    handler: async (c) => {
      const result = await sessionFor(c);
      const parsed = notificationInputSchema.safeParse(await c.req.json());
      if (!parsed.success) {
        throw workError("VALIDATION_FAILED", {
          text: "Invalid notification",
          details: { issues: parsed.error.issues },
        });
      }
      try {
        const sent = (await result.session.sendNotification(
          parsed.data as WorkNotificationInput,
        )) as
          | Array<{
              record?: { id?: string };
              decision?: unknown;
            }>
          | {
              record?: { id?: string };
              decision?: unknown;
            };
        const first = Array.isArray(sent)
          ? sent[0]
          : (sent as { record?: { id?: string }; decision?: unknown });
        return c.json({ ok: true, id: first?.record?.id, decision: first?.decision });
      } catch (error) {
        return c.json(
          { error: error instanceof Error ? error.message : "Failed to record the notification" },
          500,
        );
      }
    },
  },
);

export const sessionRoutes = [
  sessionStreamRoute,
  sessionMessageRoute,
  sessionSteerRoute,
  sessionFollowUpRoute,
  sessionAbortRoute,
  sessionStateRoute,
  updateSessionStateRoute,
  updateSessionWorkbenchStateRoute,
  sessionNotificationRoute,
  sessionModeRoute,
  sessionModelRoute,
  sessionPermissionsRoute,
  updateSessionPermissionsRoute,
  sessionDisplayStateRoute,
  sessionSubagentModelsRoute,
  updateSessionSubagentModelsRoute,
  sessionGrantRoute,
  sessionGrantRevokeRoute,
  sessionToolGrantRoute,
  sessionToolGrantRevokeRoute,
];
