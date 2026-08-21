import { toAISdkStream } from "@mastra/ai-sdk";
import type { AgentExecutionOptions, AgentThreadSubscription } from "@mastra/core/agent";
import { type ContextWithMastra, registerApiRoute } from "@mastra/core/server";
import type { MastraModelOutput } from "@mastra/core/stream";
import { TASK_STATE_TYPE, type TaskItem } from "@mastra/core/tools";
import { createUIMessageStreamResponse } from "ai";
import { SKILL_NAMES_CONTEXT_KEY } from "../../agents";
import {
  REQUEST_MODEL_CONTEXT_KEY,
  requestModelFamily,
  resolveConfiguredModel,
  resolveRequestModel,
  usesOpenAIResponses,
} from "../../agents/llm";
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
import { SUBAGENT_MODELS_CONTEXT_KEY } from "../../agents/subagents";
import {
  MODEL_FAMILY_CONTEXT_KEY,
  parseWebSearchSelection,
  WEB_SEARCH_CONTEXT_KEY,
} from "../../agents/tools";
import { OM_MODELS_CONTEXT_KEY } from "../../memory";
import { appStorage } from "../../storage";
import { WORKSPACE_PATH_CONTEXT_KEY } from "../../workspace";
import {
  isTerminalAgentChunk,
  SESSION_SCOPE_DEFAULT,
  type WorkSession,
  workSessionHost,
} from "../session";
import { getOwnedThread, getWorkMemory, type OwnedThread } from "./threads/shared";
import type { ThreadMetadata } from "./threads/types";

function scopeOf(value: string | undefined): string {
  return value?.trim() || SESSION_SCOPE_DEFAULT;
}

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
}

async function sessionFor(c: ContextWithMastra): Promise<SessionRouteResult | { error: Response }> {
  const threadId = c.req.param("threadId");
  const resourceId = c.req.query("resourceId");
  const scope = scopeOf(c.req.param("scope"));
  if (!resourceId || !threadId)
    return { error: c.json({ error: "resourceId and threadId are required" }, 400) };
  const memory = await getWorkMemory();
  const thread = await getOwnedThread(memory, threadId, resourceId);
  if (!thread) {
    return { error: c.json({ error: "Thread not found" }, 404) };
  }
  const session = workSessionHost.getOrCreate({ resourceId, scope, threadId });
  const metadata = (thread.metadata ?? {}) as ThreadMetadata;
  const mode = resolveMode(metadata.modeId);
  session.setMode(mode.id);
  const requestContext = c.get("requestContext");
  requestContext.set(MODE_ID_CONTEXT_KEY, mode.id);
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
  session.applyRequestContext(requestContext);
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
): Promise<AgentExecutionOptions | { error: Response }> {
  const requestContext = c.get("requestContext");
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
    if (!model) return { error: c.json({ error: "The selected model is not configured" }, 400) };
    requestContext.set(REQUEST_MODEL_CONTEXT_KEY, model);
    const family = requestModelFamily(body.model);
    if (family) requestContext.set(MODEL_FAMILY_CONTEXT_KEY, family);
  }
  const webSearch = parseWebSearchSelection(body.webSearch);
  if (webSearch) requestContext.set(WEB_SEARCH_CONTEXT_KEY, webSearch);
  result.session.applyRequestContext(requestContext);

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
  const agent = c.get("mastra").getAgentById("mastra-work-agent");
  const { runs } = await agent.listSuspendedRuns({
    threadId: result.threadId,
    resourceId: result.resourceId,
  });
  const metadata = (result.thread.metadata ?? {}) as {
    modeId?: string;
    permissionRules?: unknown;
  };
  const rules = applyModeToRules(
    applySessionGrants(parsePermissionRules(metadata.permissionRules), {
      ...result.session.getGrants(),
      yolo: result.session.getState().yolo === true,
    }),
    resolveMode(metadata.modeId),
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

function subscriptionStream(
  subscription: AgentThreadSubscription,
  onClose: () => void,
  targetRunId?: string,
) {
  const fullStream = new ReadableStream({
    async start(controller) {
      try {
        for await (const chunk of subscription.stream) {
          if (targetRunId && (chunk as { runId?: string }).runId !== targetRunId) continue;
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
      if ("error" in result) return result.error;
      const followUpId = c.req.query("followUpId");
      const followUp = followUpId ? await result.session.subscribeFollowUp(followUpId) : undefined;
      if (followUpId && !followUp) return new Response(null, { status: 204 });
      if (!followUp && !result.session.getDisplayState().activeRunId) {
        return new Response(null, { status: 204 });
      }
      const subscription =
        followUp?.subscription ?? (await result.session.subscribe(result.threadId));
      const stream = subscriptionStream(
        subscription,
        () => result.session.releaseSubscription(subscription),
        followUp?.runId,
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
      if ("error" in result) return result.error;
      const body = (await c.req.json()) as SessionMessageBody;
      if (!body.content?.trim()) return c.json({ error: "content is required" }, 400);
      const execution = await sessionExecutionOptions(c, result, body);
      if ("error" in execution) return execution.error;
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
    if ("error" in result) return result.error;
    const body = (await c.req.json()) as SessionMessageBody;
    if (!body.content?.trim()) return c.json({ error: "content is required" }, 400);
    const execution = await sessionExecutionOptions(c, result, body);
    if ("error" in execution) return execution.error;
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
      if ("error" in result) return result.error;
      const body = (await c.req.json()) as SessionMessageBody;
      if (!body.content?.trim()) return c.json({ error: "content is required" }, 400);
      const execution = await sessionExecutionOptions(c, result, body);
      if ("error" in execution) return execution.error;
      const followUp = await result.session.followUp(
        { contents: body.content.trim(), ...(body.metadata ? { metadata: body.metadata } : {}) },
        execution,
      );
      if (followUp.action === "blocked") {
        return c.json({ error: "The follow-up was cancelled before it could be queued" }, 409);
      }
      return c.json({ ok: true, ...followUp });
    },
  },
);

export const sessionAbortRoute = registerApiRoute("/work/sessions/:scope/threads/:threadId/abort", {
  method: "POST",
  handler: async (c) => {
    const result = await sessionFor(c);
    if ("error" in result) return result.error;
    return c.json({ aborted: result.session.abort() });
  },
});

export const sessionStateRoute = registerApiRoute("/work/sessions/:scope/threads/:threadId/state", {
  method: "GET",
  handler: async (c) => {
    const result = await sessionFor(c);
    if ("error" in result) return result.error;
    return c.json({ state: result.session.getState() });
  },
});

export const updateSessionStateRoute = registerApiRoute(
  "/work/sessions/:scope/threads/:threadId/state",
  {
    method: "PATCH",
    handler: async (c) => {
      const result = await sessionFor(c);
      if ("error" in result) return result.error;
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
    if ("error" in result) return result.error;
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
    if ("error" in result) return result.error;
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
      return c.json({ error: "selection is required" }, 400);
    }
    const raw = body.selection as Record<string, unknown>;
    if (typeof raw.providerId !== "string" || typeof raw.modelId !== "string") {
      return c.json({ error: "selection.providerId and selection.modelId are required" }, 400);
    }
    const model = await resolveConfiguredModel(raw.providerId, raw.modelId);
    if (!model) return c.json({ error: "The selected model is not configured" }, 400);
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
      if ("error" in result) return result.error;
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
      if ("error" in result) return result.error;
      const rules = parsePermissionRules(await c.req.json());
      const memory = await getWorkMemory();
      const thread = await memory.updateThread({
        id: result.threadId,
        title: result.thread.title,
        metadata: { ...result.thread.metadata, permissionRules: rules },
      });
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
      if ("error" in result) return result.error;
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
      if ("error" in result) return result.error;
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
      if ("error" in result) return result.error;
      const body = (await c.req.json()) as { agentType?: unknown; modelId?: unknown };
      if (typeof body.agentType !== "string" || !body.agentType.trim()) {
        return c.json({ error: "agentType is required" }, 400);
      }
      if (body.modelId !== null && typeof body.modelId !== "string") {
        return c.json({ error: "modelId must be a string or null" }, 400);
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
      if ("error" in result) return result.error;
      const body = (await c.req.json()) as { category?: unknown };
      if (!TOOL_CATEGORIES.includes(body.category as ToolCategory)) {
        return c.json({ error: "unsupported grant category" }, 400);
      }
      result.session.grantCategory(body.category as ToolCategory);
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
      if ("error" in result) return result.error;
      const category = c.req.param("category") as ToolCategory;
      if (!TOOL_CATEGORIES.includes(category))
        return c.json({ error: "unsupported grant category" }, 400);
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
      if ("error" in result) return result.error;
      const body = (await c.req.json()) as { toolName?: unknown };
      if (typeof body.toolName !== "string" || !body.toolName.trim()) {
        return c.json({ error: "toolName is required" }, 400);
      }
      result.session.grantTool(body.toolName.trim());
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
      if ("error" in result) return result.error;
      const toolName = c.req.param("toolName").trim();
      if (!toolName) return c.json({ error: "toolName is required" }, 400);
      result.session.revokeTool(toolName);
      return c.json({ grants: result.session.getGrants() });
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
