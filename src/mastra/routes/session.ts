/**
 * 工作台会话控制路由(/work/sessions/:scope/threads/:threadId/*):
 * message / steer / follow-up / abort / mode / model / permissions /
 * grants / workbench-state / notification。
 * 官方文档:docs/en/docs/harness/agent-controller.mdx(sessions 章节)。
 */
import { toAISdkStream, workflowSnapshotToStream } from "@mastra/ai-sdk";
import type { Agent, AgentExecutionOptions } from "@mastra/core/agent";
import type { Session as ControllerSession, TokenUsage } from "@mastra/core/agent-controller";
import type { Mastra } from "@mastra/core/mastra";
import { MASTRA_RESOURCE_ID_KEY } from "@mastra/core/request-context";
import { type ContextWithMastra, registerApiRoute } from "@mastra/core/server";
import { TASK_STATE_TYPE, type TaskItem } from "@mastra/core/tools";
import {
  type AnyWorkflow,
  createWorkflowStateReader,
  type WorkflowState,
} from "@mastra/core/workflows";
import { createUIMessageStreamResponse } from "ai";
import { z } from "zod";
import { SESSION_EXECUTION_CONTEXT_KEY, SKILL_NAMES_CONTEXT_KEY } from "../agents";
import {
  AGENT_PROFILE_CONTEXT_KEY,
  ensureProfileAgentsRegistered,
  getAgentProfile,
} from "../agents/custom";
import {
  listWorkModes,
  MODE_ID_CONTEXT_KEY,
  PERMISSION_RULES_CONTEXT_KEY,
  parsePermissionRules,
  resolveMode,
  SESSION_TOOL_POLICY_CONTEXT_KEY,
  TOOL_CATEGORIES,
  toolCategoryOf,
} from "../agents/permissions";
import { mergeWorkbenchState, workbenchStateSchema } from "../agents/processors";
import { errorText, workError } from "../errors";
import {
  REQUEST_MODEL_ID_CONTEXT_KEY,
  resolveConfiguredModel,
  resolveDefaultModelId,
  resolveRequestModel,
  usesOpenAIResponses,
} from "../models/providers";
import {
  LIBRARY_ORIGIN_CONTEXT_KEY,
  LIBRARY_RESOURCE_CONTEXT_KEY,
  LIBRARY_THREAD_CONTEXT_KEY,
} from "../rag/types";
import { appStorage } from "../storage";
import { parseWebSearchSelection, WEB_SEARCH_CONTEXT_KEY } from "../tools";
import {
  WORKSPACE_PATH_CONTEXT_KEY,
  WORKSPACE_RESOURCE_ID_CONTEXT_KEY,
  WORKSPACE_THREAD_ID_CONTEXT_KEY,
} from "../workspace";
import { workbenchMessages } from "./threads/messages";
import type { ThreadMetadata } from "./threads/shared";
import { getOwnedThread, getWorkMemory, type OwnedThread } from "./threads/shared";

function scopeOf(value: string | undefined): string {
  return value?.trim() || "workbench";
}

/** Match the official Controller routes: acknowledge work while its outcome arrives over SSE. */
export function observeSessionWork(
  c: ContextWithMastra,
  session: ControllerSession,
  work: Promise<unknown>,
): void {
  void work.catch((error: unknown) => {
    const failure = error instanceof Error ? error : new Error(String(error));
    c.get("mastra").getLogger().error("Workbench session operation failed", { error: failure });
    session.emit({ type: "error", error: failure });
  });
}

/** Persist only the last-step context measure; cumulative usage belongs to Session. */
export function registerWorkbenchSessionLifecycle(mastra: Mastra): void {
  mastra.getAgentController("workbench")?.onSessionCreated((session) => {
    let lastStepUsage: TokenUsage | undefined;
    session.subscribe((event) => {
      if (event.type === "agent_start") lastStepUsage = undefined;
      if (event.type === "usage_update") lastStepUsage = event.usage;
    });
    session.onBeforeAgentEnd(async () => {
      if (!lastStepUsage || !session.thread.getId()) return;
      await session.thread.setSetting({
        key: "contextUsage",
        value: {
          inputTokens: lastStepUsage.promptTokens,
          outputTokens: lastStepUsage.completionTokens,
          totalTokens: lastStepUsage.totalTokens,
          inputTokenDetails: { cacheReadTokens: lastStepUsage.cachedInputTokens },
          outputTokenDetails: { reasoningTokens: lastStepUsage.reasoningTokens },
        },
      });
      await session.thread.setSetting({ key: "contextUsageVersion", value: 2 });
    });
  });
}

/** Native SSE reconnects restore the exact owned thread before the official handler subscribes. */
export async function workbenchControllerMiddleware(
  c: ContextWithMastra,
  next: () => Promise<void>,
) {
  const match = c.req.path.match(/^\/api\/agent-controller\/workbench\/sessions\/([^/]+)(\/.*)?$/);
  if (!match) return next();
  const resourceId = decodeURIComponent(match[1]);
  if (resourceId !== c.get("requestContext").get(MASTRA_RESOURCE_ID_KEY)) {
    throw workError("AUTH_FORBIDDEN");
  }
  // Resource identity comes from login; each workbench scope stays bound to one thread.
  const operation = match[2] ?? "";
  if (
    operation === "/resource" ||
    operation === "/resources" ||
    (c.req.method !== "GET" && ["/thread", "/threads", "/threads/clone"].includes(operation))
  ) {
    throw workError("AUTH_FORBIDDEN");
  }
  let scope: unknown;
  try {
    scope = JSON.parse(c.req.query("sessionScope") ?? "null");
  } catch {
    throw workError("VALIDATION_FAILED", { text: "Invalid workbench session scope" });
  }
  const parsed = z.tuple([z.literal("workbench"), z.string().trim().min(1)]).safeParse(scope);
  if (!parsed.success || c.req.query("sessionScope") !== JSON.stringify(parsed.data)) {
    throw workError("VALIDATION_FAILED", { text: "Invalid workbench session scope" });
  }
  await sessionFor(c, { resourceId, threadId: parsed.data[1], scope: parsed.data[0] });
  await next();
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
  controllerSession: ControllerSession;
  agent: Agent;
  memory: Awaited<ReturnType<typeof getWorkMemory>>;
  resourceId: string;
  threadId: string;
  thread: NonNullable<OwnedThread>;
}

interface SessionMessageBody {
  content?: string;
  metadata?: Record<string, unknown>;
  modelSettings?: unknown;
  providerOptions?: unknown;
  /** Official per-invocation subagent version overrides. */
  versions?: AgentExecutionOptions["versions"];
  /** Official scorer selection by registered scorer name. */
  scorers?: AgentExecutionOptions["scorers"];
  /** Official completion-scoring policy; scorers are resolved by the server. */
  isTaskComplete?: AgentExecutionOptions["isTaskComplete"];
  webSearch?: unknown;
  agentProfileId?: unknown;
}

/** Restore the native per-mode selection; a new mode starts with the user's default. */
async function restoreSessionModel(session: ControllerSession, resourceId: string) {
  const defaultModelId = await resolveDefaultModelId(resourceId);
  if (defaultModelId) {
    for (const mode of listWorkModes()) {
      if (!(await session.model.resolveForMode({ modeId: mode.id }))) {
        await session.model.switch({ modelId: defaultModelId, modeId: mode.id });
      }
    }
  }
  await session.model.syncFromPersisted({ modeId: session.mode.get() });
}

/** Resolve the single official Session for a workbench thread. */
export async function getWorkbenchSession(
  c: ContextWithMastra,
  threadId: string,
  resourceId: string,
  scope?: string,
) {
  const requestContext = c.get("requestContext");
  const memory = await getWorkMemory(requestContext);
  const thread = await getOwnedThread(memory, threadId, resourceId);
  if (!thread) throw workError("THREAD_NOT_FOUND");
  const controller = c.get("mastra").getAgentController("workbench");
  if (!controller) throw new Error("Workbench AgentController is not registered");
  const mode = resolveMode(thread.metadata?.currentModeId);
  requestContext.set(MODE_ID_CONTEXT_KEY, mode.id);
  await controller.init();
  requestContext.set(WORKSPACE_THREAD_ID_CONTEXT_KEY, threadId);
  requestContext.set(WORKSPACE_RESOURCE_ID_CONTEXT_KEY, resourceId);
  const workspacePath =
    requestContext.get(WORKSPACE_PATH_CONTEXT_KEY) ?? thread.metadata?.workspacePath;
  if (typeof workspacePath === "string" && workspacePath) {
    requestContext.set(WORKSPACE_PATH_CONTEXT_KEY, workspacePath);
  }
  const session = await controller.createSession({
    resourceId,
    threadId,
    scope: JSON.stringify([scopeOf(scope), threadId]),
    requestContext,
  });
  requestContext.set(SESSION_TOOL_POLICY_CONTEXT_KEY, (toolName: string) =>
    session.resolveToolApproval(toolName),
  );
  if (session.mode.get() !== mode.id) await session.mode.switch({ modeId: mode.id });
  await restoreSessionModel(session, resourceId);
  const rules = parsePermissionRules(thread.metadata?.permissionRules);
  const yolo =
    TOOL_CATEGORIES.every((category) => rules.categories[category] === "allow") &&
    Object.values(rules.tools).every((policy) => policy === "allow");
  requestContext.set(PERMISSION_RULES_CONTEXT_KEY, rules);
  if (
    JSON.stringify(session.permissions.getRules()) !== JSON.stringify(rules) ||
    session.state.get().yolo !== yolo
  ) {
    await session.state.set({ permissionRules: rules, yolo });
  }
  return session;
}

async function sessionFor(
  c: ContextWithMastra,
  target?: { threadId: string; resourceId: string; scope: string },
): Promise<SessionRouteResult> {
  const threadId = target?.threadId ?? c.req.param("threadId");
  const resourceId = target?.resourceId ?? c.req.query("resourceId");
  const scope = target?.scope ?? scopeOf(c.req.param("scope"));
  if (!resourceId || !threadId)
    throw workError("VALIDATION_FAILED", { text: "resourceId and threadId are required" });
  const memory = await getWorkMemory(c.get("requestContext"));
  const thread = await getOwnedThread(memory, threadId, resourceId);
  if (!thread) {
    throw workError("THREAD_NOT_FOUND");
  }
  const metadata = (thread.metadata ?? {}) as ThreadMetadata;
  const profile = await getAgentProfile(metadata.agentProfileId, resourceId);
  await ensureProfileAgentsRegistered(c.get("mastra"), profile, resourceId);
  const requestContext = c.get("requestContext");
  requestContext.set(WORKSPACE_THREAD_ID_CONTEXT_KEY, threadId);
  requestContext.set(WORKSPACE_RESOURCE_ID_CONTEXT_KEY, resourceId);
  requestContext.set(LIBRARY_RESOURCE_CONTEXT_KEY, resourceId);
  requestContext.set(LIBRARY_THREAD_CONTEXT_KEY, threadId);
  requestContext.set(LIBRARY_ORIGIN_CONTEXT_KEY, new URL(c.req.url).origin);
  requestContext.set(AGENT_PROFILE_CONTEXT_KEY, profile.id);
  if (metadata.workspacePath) {
    requestContext.set(WORKSPACE_PATH_CONTEXT_KEY, metadata.workspacePath);
  }
  const controllerSession = await getWorkbenchSession(c, threadId, resourceId, scope);
  const agent = c.get("mastra").getAgentController("workbench")?.getCurrentAgent(controllerSession);
  if (!agent) throw new Error("Workbench AgentController is not registered");
  return { controllerSession, agent, memory, resourceId, threadId, thread };
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
    result.resourceId,
  );
  requestContext.set(AGENT_PROFILE_CONTEXT_KEY, profile.id);
  await ensureProfileAgentsRegistered(c.get("mastra"), profile, result.resourceId);
  const skillNames = body.metadata?.skillNames;
  if (Array.isArray(skillNames)) {
    requestContext.set(
      SKILL_NAMES_CONTEXT_KEY,
      skillNames
        .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        .slice(0, 4),
    );
  }
  const selectedModel = { id: result.controllerSession.model.get() };
  const model = await resolveRequestModel(selectedModel, result.resourceId);
  if (!model) throw workError("MODEL_NOT_CONFIGURED");
  requestContext.set(REQUEST_MODEL_ID_CONTEXT_KEY, selectedModel.id);
  const webSearch = parseWebSearchSelection(body.webSearch);
  if (webSearch) requestContext.set(WEB_SEARCH_CONTEXT_KEY, webSearch);

  const rawProviderOptions =
    typeof body.providerOptions === "object" && body.providerOptions !== null
      ? (body.providerOptions as Record<string, unknown>)
      : undefined;
  const reasoningSummary = await usesOpenAIResponses(selectedModel, result.resourceId);
  const providerOptions = reasoningSummary
    ? {
        ...(rawProviderOptions ?? {}),
        openai: {
          ...((rawProviderOptions?.openai as Record<string, unknown> | undefined) ?? {}),
          reasoningSummary: "auto",
        },
      }
    : rawProviderOptions;
  const execution = {
    ...(typeof body.modelSettings === "object" && body.modelSettings !== null
      ? { modelSettings: body.modelSettings as AgentExecutionOptions["modelSettings"] }
      : {}),
    ...(providerOptions
      ? { providerOptions: providerOptions as AgentExecutionOptions["providerOptions"] }
      : {}),
    ...(body.versions !== undefined ? { versions: body.versions } : {}),
    ...(body.scorers !== undefined ? { scorers: body.scorers } : {}),
    ...(body.isTaskComplete !== undefined ? { isTaskComplete: body.isTaskComplete } : {}),
  };
  requestContext.set(SESSION_EXECUTION_CONTEXT_KEY, execution);
  return {
    ...execution,
    requestContext,
    untilIdle: true,
    memory: { thread: result.threadId, resource: result.resourceId },
  };
}

interface WorkflowRouteResult extends SessionRouteResult {
  workflow: AnyWorkflow;
  state: WorkflowState;
}

function workflowSnapshotRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>)
        : undefined;
    } catch {
      return undefined;
    }
  }
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

async function workflowRouteFor(c: ContextWithMastra): Promise<WorkflowRouteResult> {
  const session = await sessionFor(c);
  const workflowId = c.req.param("workflowId");
  const runId = c.req.param("runId");
  if (!workflowId || !runId)
    throw workError("VALIDATION_FAILED", { text: "workflowId and runId are required" });

  const workflows = await session.agent.listWorkflows({
    requestContext: c.get("requestContext"),
  });
  const workflow = workflows[workflowId];
  if (!workflow) throw workError("WORKFLOW_NOT_FOUND");

  const state = await workflow.getWorkflowRunById(runId, {
    fields: [
      "result",
      "error",
      "payload",
      "steps",
      "activeStepsPath",
      "serializedStepGraph",
      "suspendedPaths",
      "resumeLabels",
      "waitingPaths",
      "requestContext",
    ],
  });
  if (!state || state.resourceId !== session.resourceId) {
    throw workError("WORKFLOW_RUN_NOT_FOUND");
  }
  if (state.requestContext?.[WORKSPACE_THREAD_ID_CONTEXT_KEY] !== session.threadId) {
    throw workError("WORKFLOW_RUN_NOT_FOUND");
  }
  return { ...session, workflow, state };
}

function workflowResumeTarget(
  state: WorkflowState,
  body: { step?: unknown; label?: unknown; forEachIndex?: unknown },
): { step: string | string[]; forEachIndex?: number } {
  const explicitStep =
    typeof body.step === "string"
      ? body.step.trim()
      : Array.isArray(body.step)
        ? body.step.filter(
            (value): value is string => typeof value === "string" && value.trim().length > 0,
          )
        : undefined;
  const label = typeof body.label === "string" ? body.label.trim() : "";
  const reader = createWorkflowStateReader(state);
  const labeled = label ? reader.getResumeLabel(label) : undefined;
  const suspended = reader.getSuspendedStep();
  const step =
    explicitStep && (!Array.isArray(explicitStep) || explicitStep.length > 0)
      ? explicitStep
      : (labeled?.stepId ?? suspended?.path);
  if (!step || (Array.isArray(step) && step.length === 0)) {
    throw workError("WORKFLOW_RUN_INVALID_STATE");
  }
  const rawIndex = body.forEachIndex ?? labeled?.foreachIndex;
  if (rawIndex !== undefined && (!Number.isInteger(rawIndex) || Number(rawIndex) < 0)) {
    throw workError("VALIDATION_FAILED", { text: "forEachIndex must be a non-negative integer" });
  }
  return {
    step,
    ...(rawIndex === undefined ? {} : { forEachIndex: Number(rawIndex) }),
  };
}

async function persistentDisplayState(c: ContextWithMastra, result: SessionRouteResult) {
  const displayState = structuredClone(result.controllerSession.displayState.get());
  const threadState = await appStorage.getStore("threadState");
  const tasks = await threadState?.getState<TaskItem[]>({
    threadId: result.threadId,
    type: TASK_STATE_TYPE,
  });
  const agent = result.agent;
  const { runs } = await agent.listSuspendedRuns({
    threadId: result.threadId,
    resourceId: result.resourceId,
  });
  const manager = c.get("mastra").backgroundTaskManager;
  const backgroundTasks = manager
    ? (
        await manager.listTasks({
          resourceId: result.resourceId,
          threadId: result.threadId,
          orderBy: "createdAt",
          orderDirection: "desc",
          perPage: 50,
        })
      ).tasks
    : [];
  const workflowRuns = await (async () => {
    const workflows = await agent.listWorkflows({ requestContext: c.get("requestContext") });
    const listed = await Promise.all(
      Object.entries(workflows).map(async ([workflowName, workflow]) => {
        try {
          const listing = await workflow.listWorkflowRuns({
            resourceId: result.resourceId,
            perPage: false,
          });
          return listing.runs
            .filter((run) => {
              const snapshot = workflowSnapshotRecord(run.snapshot);
              const context =
                snapshot?.requestContext && typeof snapshot.requestContext === "object"
                  ? (snapshot.requestContext as Record<string, unknown>)
                  : undefined;
              return context?.[WORKSPACE_THREAD_ID_CONTEXT_KEY] === result.threadId;
            })
            .map((run) => {
              const snapshot = workflowSnapshotRecord(run.snapshot);
              const status = typeof snapshot?.status === "string" ? snapshot.status : undefined;
              return {
                workflowName,
                runId: run.runId,
                resourceId: run.resourceId,
                createdAt: run.createdAt,
                updatedAt: run.updatedAt,
                snapshot: run.snapshot,
                ...(status ? { status } : {}),
              };
            });
        } catch {
          return [];
        }
      }),
    );
    return listed
      .flat()
      .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime())
      .slice(0, 12);
  })();
  const backgroundSuspended = backgroundTasks.some((task) => task.status === "suspended");
  const workflowSuspended = workflowRuns.some((run) =>
    ["suspended", "paused"].includes(run.status ?? ""),
  );
  const workflowRunning = workflowRuns.some((run) =>
    ["pending", "running", "waiting"].includes(run.status ?? ""),
  );
  const storedSuspensions = runs.flatMap((run) => {
    const toolCalls = run.toolCalls.flatMap((toolCall) => {
      const toolName = toolCall.toolName ?? "";
      const policy = result.controllerSession.resolveToolApproval(toolName);
      if (toolCall.requiresApproval && policy !== "ask") return [];
      return [{ ...toolCall, category: toolCategoryOf(toolName), policy }];
    });
    return toolCalls.length > 0 ? [{ ...run, toolCalls }] : [];
  });
  const storedToolCalls = new Set(
    storedSuspensions.flatMap((run) => run.toolCalls.map((tool) => tool.toolCallId)),
  );
  const liveSuspensions = [...displayState.pendingSuspensions].flatMap(([toolCallId, tool]) => {
    const pending = result.controllerSession.suspensions.get({ toolCallId });
    if (
      !pending ||
      pending.threadId !== result.threadId ||
      pending.resourceId !== result.resourceId
    )
      return [];
    return [{ runId: pending.runId, toolCall: { ...tool, toolCallId, requiresApproval: false } }];
  });
  const activeRunId = result.controllerSession.getCurrentRunId();
  const liveApprovals = [...displayState.pendingApprovals].flatMap(([toolCallId, tool]) => {
    if (
      !activeRunId ||
      !result.controllerSession.approval.isArmed({
        toolCallId,
        threadId: result.threadId,
        runId: activeRunId,
      })
    )
      return [];
    return [{ runId: activeRunId, toolCall: { ...tool, toolCallId, requiresApproval: true } }];
  });
  const suspendedRuns = [
    ...storedSuspensions,
    ...[...liveSuspensions, ...liveApprovals]
      .filter(({ toolCall }) => !storedToolCalls.has(toolCall.toolCallId))
      .map(({ runId, toolCall }) => ({
        runId,
        toolCalls: [
          {
            ...toolCall,
            category: toolCategoryOf(toolCall.toolName),
            policy: result.controllerSession.resolveToolApproval(toolCall.toolName),
          },
        ],
      })),
  ];
  return {
    ...displayState,
    activeTools: Object.fromEntries(displayState.activeTools),
    toolInputBuffers: Object.fromEntries(displayState.toolInputBuffers),
    pendingSuspensions: Object.fromEntries(displayState.pendingSuspensions),
    pendingApprovals: Object.fromEntries(displayState.pendingApprovals),
    activeSubagents: Object.fromEntries(displayState.activeSubagents),
    modifiedFiles: Object.fromEntries(displayState.modifiedFiles),
    threadId: result.threadId,
    state: result.controllerSession.state.get(),
    grants: result.controllerSession.getGrants(),
    activeRunId: result.agent.getActiveThreadRunId(result),
    status: result.agent.getActiveThreadRunId(result)
      ? "running"
      : suspendedRuns.length > 0 || backgroundSuspended || workflowSuspended
        ? "suspended"
        : backgroundTasks.some((task) => task.status === "pending" || task.status === "running") ||
            workflowRunning
          ? "running"
          : "idle",
    tasks: Array.isArray(tasks) ? tasks : [],
    suspendedRuns,
    backgroundTasks,
    workflowRuns,
  };
}

/** Wait for the native run to stop before any destructive history operation. */
export async function abortWorkbenchSession(session: ControllerSession) {
  session.suspensions.clear();
  session.abort();
  const timeout = AbortSignal.timeout(10_000);
  while (session.stream.isActive() || session.run.getRunId() !== null) {
    timeout.throwIfAborted();
    const waiter = new AbortController();
    const signal = AbortSignal.any([timeout, waiter.signal]);
    try {
      await Promise.race([
        session.stream.waitForTeardown(signal),
        session.run.waitForTeardown(signal),
      ]);
    } finally {
      waiter.abort();
    }
  }
}

export const sessionFollowUpRoute = registerApiRoute(
  "/work/sessions/:scope/threads/:threadId/follow-up",
  {
    method: "POST",
    handler: async (c) => {
      const result = await sessionFor(c);
      const body = await c.req.json<SessionMessageBody>();
      if (typeof body.content !== "string" || !body.content.trim())
        throw workError("SESSION_INPUT_REQUIRED");
      const content = body.content.trim();
      const execution = await sessionExecutionOptions(c, result, body);
      observeSessionWork(
        c,
        result.controllerSession,
        result.controllerSession.followUp({
          content,
          requestContext: execution.requestContext,
        }),
      );
      return c.json({ queued: true });
    },
  },
);

export const sessionAbortRoute = registerApiRoute("/work/sessions/:scope/threads/:threadId/abort", {
  method: "POST",
  handler: async (c) => {
    const result = await sessionFor(c);
    await abortWorkbenchSession(result.controllerSession);
    return c.json({ aborted: true });
  },
});

export const sessionModeRoute = registerApiRoute("/work/sessions/:scope/threads/:threadId/mode", {
  method: "PATCH",
  handler: async (c) => {
    const result = await sessionFor(c);
    const body = (await c.req.json()) as { modeId?: unknown };
    const mode = resolveMode(body.modeId);
    await result.controllerSession.mode.switch({ modeId: mode.id });
    await restoreSessionModel(result.controllerSession, result.resourceId);
    const thread = await result.memory.getThreadById({ threadId: result.threadId });
    return c.json({ modeId: mode.id, mode, thread });
  },
});

export const sessionModelRoute = registerApiRoute("/work/sessions/:scope/threads/:threadId/model", {
  method: "PATCH",
  handler: async (c) => {
    const result = await sessionFor(c);
    const body = z
      .object({
        modeId: z.enum(["plan", "build", "review"]).optional(),
        selection: z.object({
          providerId: z.string().trim().min(1),
          modelId: z.string().trim().min(1),
          reasoningEffort: z.string().optional(),
        }),
      })
      .parse(await c.req.json());
    const modeId = body.modeId ?? result.controllerSession.mode.get();
    const { providerId, modelId, reasoningEffort = "off" } = body.selection;
    if (!(await resolveConfiguredModel(providerId, modelId, result.resourceId))) {
      throw workError("MODEL_NOT_CONFIGURED");
    }
    await result.controllerSession.model.switch({
      modelId: `${providerId}/${modelId}`,
      modeId,
    });
    await result.controllerSession.thread.setSetting({
      key: "reasoningEffortByMode",
      value: {
        ...((result.thread.metadata as ThreadMetadata)?.reasoningEffortByMode ?? {}),
        [modeId]: reasoningEffort,
      },
    });
    const thread = await result.memory.getThreadById({ threadId: result.threadId });
    return c.json({ modeId, modelId: result.controllerSession.model.get(), thread });
  },
});

export const updateSessionPermissionsRoute = registerApiRoute(
  "/work/sessions/:scope/threads/:threadId/permissions",
  {
    method: "PATCH",
    handler: async (c) => {
      const result = await sessionFor(c);
      const rules = parsePermissionRules(await c.req.json());
      const yolo =
        TOOL_CATEGORIES.every((category) => rules.categories[category] === "allow") &&
        Object.values(rules.tools).every((policy) => policy === "allow");
      await result.controllerSession.state.set({ permissionRules: rules, yolo });
      const thread = await result.memory.updateThread({
        id: result.threadId,
        title: result.thread.title,
        metadata: { ...result.thread.metadata, permissionRules: rules },
      });
      return c.json({ rules, grants: result.controllerSession.getGrants(), thread });
    },
  },
);

export const sessionDisplayStateRoute = registerApiRoute(
  "/work/sessions/:scope/threads/:threadId/display-state",
  {
    method: "GET",
    handler: async (c) => {
      const result = await sessionFor(c);
      const displayState = await persistentDisplayState(c, result);
      let messages: ReturnType<typeof workbenchMessages> | undefined;
      if (c.req.query("includeMessages") === "true") {
        const history = (
          await result.memory.recall({
            threadId: result.threadId,
            resourceId: result.resourceId,
            perPage: false,
          })
        ).messages;
        const current = displayState.currentMessage;
        if (current && !history.some((message) => message.id === current.id)) history.push(current);
        messages = workbenchMessages(history);
      }
      return c.json({
        displayState,
        ...(messages ? { messages } : {}),
      });
    },
  },
);

/**
 * Official Workflow state operations for the workbench. These routes expose
 * the persisted Mastra snapshot directly and use the AI SDK stream helpers for
 * replay/resume, so the UI does not need a second workflow event protocol.
 */
export const workflowRunDetailRoute = registerApiRoute(
  "/work/sessions/:scope/threads/:threadId/workflows/:workflowId/runs/:runId",
  {
    method: "GET",
    handler: async (c) => {
      const result = await workflowRouteFor(c);
      return c.json({ workflow: result.state });
    },
  },
);

export const workflowRunReplayRoute = registerApiRoute(
  "/work/sessions/:scope/threads/:threadId/workflows/:workflowId/runs/:runId/stream",
  {
    method: "GET",
    handler: async (c) => {
      const result = await workflowRouteFor(c);
      return createUIMessageStreamResponse({
        stream: workflowSnapshotToStream(result.state),
      });
    },
  },
);

export const workflowRunResumeRoute = registerApiRoute(
  "/work/sessions/:scope/threads/:threadId/workflows/:workflowId/runs/:runId/resume",
  {
    method: "POST",
    handler: async (c) => {
      const result = await workflowRouteFor(c);
      const body = (await c.req.json().catch(() => ({}))) as {
        resumeData?: unknown;
        step?: unknown;
        label?: unknown;
        forEachIndex?: unknown;
      };
      const target = workflowResumeTarget(result.state, body);
      const run = await result.workflow.createRun({
        runId: result.state.runId,
        resourceId: result.resourceId,
      });
      const stream = run.resumeStream({
        step: target.step,
        resumeData: body.resumeData,
        requestContext: c.get("requestContext"),
        ...(target.forEachIndex === undefined ? {} : { forEachIndex: target.forEachIndex }),
      });
      return createUIMessageStreamResponse({
        stream: toAISdkStream(stream, { from: "workflow", version: "v7" }),
      });
    },
  },
);

export const workflowRunRestartRoute = registerApiRoute(
  "/work/sessions/:scope/threads/:threadId/workflows/:workflowId/runs/:runId/restart",
  {
    method: "POST",
    handler: async (c) => {
      const result = await workflowRouteFor(c);
      const run = await result.workflow.createRun({
        runId: result.state.runId,
        resourceId: result.resourceId,
      });
      return c.json({ workflow: await run.restart({ requestContext: c.get("requestContext") }) });
    },
  },
);

export const workflowRunCancelRoute = registerApiRoute(
  "/work/sessions/:scope/threads/:threadId/workflows/:workflowId/runs/:runId/cancel",
  {
    method: "POST",
    handler: async (c) => {
      const result = await workflowRouteFor(c);
      const run = await result.workflow.createRun({
        runId: result.state.runId,
        resourceId: result.resourceId,
      });
      await run.cancel();
      return c.json({
        workflow: await result.workflow.getWorkflowRunById(result.state.runId),
      });
    },
  },
);

/**
 * 工作台状态上报(state lane 的生产者入口)。
 *
 * 渲染进程各面板把自己那一份 PUT 上来 —— 编辑器打开了什么、终端跑完了什么、
 * 哪些面板可见。服务端持久化工作台快照,真正把它变成模型可见的 <state> 是
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
      return c.json({
        state: await mergeWorkbenchState(result.resourceId, result.threadId, parsed.data),
      });
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
        const first = await result.controllerSession.sendNotificationSignal(parsed.data);
        return c.json({ ok: true, id: first?.record?.id, decision: first?.decision });
      } catch (error) {
        return c.json({ error: errorText(error, "Failed to record the notification") }, 500);
      }
    },
  },
);

export const sessionRoutes = [
  sessionFollowUpRoute,
  sessionAbortRoute,
  updateSessionWorkbenchStateRoute,
  sessionNotificationRoute,
  sessionModeRoute,
  sessionModelRoute,
  updateSessionPermissionsRoute,
  sessionDisplayStateRoute,
  workflowRunDetailRoute,
  workflowRunReplayRoute,
  workflowRunResumeRoute,
  workflowRunRestartRoute,
  workflowRunCancelRoute,
];
