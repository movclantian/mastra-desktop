/**
 * 工作台原生 Controller HTTP 上下文与产品会话操作：
 * 工作区绑定、持久权限、历史恢复、模型偏好、工作流和工作台状态。
 * 官方文档:docs/en/docs/harness/agent-controller.mdx(sessions 章节)。
 */
import { getGoalActivityDurationMs } from "@mastra/core/agent";
import type { Session as ControllerSession, TokenUsage } from "@mastra/core/agent-controller";
import type { Mastra } from "@mastra/core/mastra";
import { MASTRA_RESOURCE_ID_KEY } from "@mastra/core/request-context";
import { type ContextWithMastra, registerApiRoute } from "@mastra/core/server";
import { TASK_STATE_TYPE, type TaskItem } from "@mastra/core/tools";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { DesktopNotification } from "../../shared/window-contract";
import { AGENT_PROFILE_CONTEXT_KEY, getAgentProfile } from "../agents/custom";
import { parsePermissionRules, TOOL_CATEGORIES, toolCategoryOf } from "../agents/permissions";
import {
  createWorkMessageSignal,
  WORK_MESSAGE_OPTIONS_CONTEXT_KEY,
  workbenchStateSchema,
} from "../agents/processors";
import {
  finishTeamInvocation,
  getTeamInvocationDetail,
  listTeamInvocations,
} from "../agents/team-activity";
import {
  getTeamHandoffState,
  handoffInputSchema,
  transferTeamHandoff,
} from "../agents/team-handoff";
import { errorText, workError } from "../errors";
import {
  desktopEvents,
  publishDesktopNotification,
  scheduledDesktopNotifications,
} from "../harness/signals";
import { resolveModelSelection } from "../models/providers";
import { appStorage, getLibsqlClient } from "../storage/database";
import { cancelThreadBackgroundTasks, ensureTaskExecutorAvailable } from "./background-tasks";
import {
  activeThreadMediaGeneration,
  activeThreadWorkflow,
  assertNoActiveConversationRun,
  cancelConversationRuns,
  listThreadWorkflowRuns,
  reconcileMediaMessages,
  startConversationRun,
} from "./conversation-runs";
import { getSessionMessageQueue } from "./message-queue";
import {
  prepareWorkbenchMessage,
  type SessionRouteResult,
  sessionFor,
  workbenchMessageOptionsSchema,
} from "./session-context";
import { workbenchMessages } from "./threads/messages";
import { withThreadWrite } from "./threads/shared";

/** Persisted tool results take precedence over a suspension snapshot left by a resumed run. */
async function listPendingAgentRuns({
  agent,
  threadId,
  resourceId,
}: Pick<SessionRouteResult, "agent" | "threadId" | "resourceId">) {
  const result = await agent.listSuspendedRuns({ threadId, resourceId });
  const ids = result.runs.flatMap((run) =>
    run.toolCalls.flatMap((tool) => (tool.toolCallId ? [tool.toolCallId] : [])),
  );
  if (ids.length === 0) return result;
  const client = await getLibsqlClient();
  const rows = await client.execute({
    sql: `SELECT DISTINCT json_extract(part.value, '$.toolInvocation.toolCallId') AS id
      FROM mastra_messages AS message, json_each(message.content, '$.parts') AS part
      WHERE message.thread_id = ? AND message.resourceId = ?
        AND json_extract(part.value, '$.toolInvocation.toolCallId') IN (SELECT value FROM json_each(?))
        AND json_extract(part.value, '$.toolInvocation.state') IN ('result', 'output-error', 'output-available')`,
    args: [threadId, resourceId, JSON.stringify(ids)],
  });
  const settled = new Set(rows.rows.map((row) => String(row.id)));
  const runs = result.runs.flatMap((run) => {
    const toolCalls = run.toolCalls.filter((tool) => !settled.has(tool.toolCallId ?? ""));
    return toolCalls.length ? [{ ...run, toolCalls }] : [];
  });
  return { runs, total: runs.length };
}

/** One authenticated subscription covers all of the user's threads, including scheduled runs. */
const desktopNotificationsRoute = registerApiRoute("/work/desktop-notifications", {
  method: "GET",
  handler: async (c) => {
    const resourceId = c.get("requestContext").get(MASTRA_RESOURCE_ID_KEY) as string;
    if (!resourceId) throw workError("AUTH_REQUIRED");
    return streamSSE(c, async (stream) => {
      const send = (notification: DesktopNotification) => {
        void stream
          .writeSSE({
            event: "notification",
            id: notification.id,
            data: JSON.stringify(notification),
          })
          .catch(() => stream.abort());
      };
      desktopEvents.on(resourceId, send);
      stream.onAbort(() => {
        desktopEvents.off(resourceId, send);
      });
      try {
        while (!stream.aborted) {
          await stream.writeSSE({ event: "ping", data: "" });
          await stream.sleep(30_000);
        }
      } finally {
        desktopEvents.off(resourceId, send);
      }
    });
  },
});

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

/** Promote only accepted user turns; native Memory owns asynchronous title generation. */
async function promoteUserThread(session: ControllerSession) {
  const threadId = session.thread.getId();
  if (!threadId) return;
  const resourceId = session.identity.getResourceId();
  const store = await appStorage.getStore("memory");
  if (!store) return;
  await withThreadWrite(resourceId, threadId, async () => {
    if (session.thread.getId() !== threadId) return;
    await store.updateThreadMetadata({
      id: threadId,
      resourceId,
      update: (thread) =>
        thread.metadata?.draft === true ? { ...thread.metadata, draft: false } : undefined,
    });
  });
}

/** Persist only the last-step context measure; cumulative usage belongs to Session. */
export function registerWorkbenchSessionLifecycle(mastra: Mastra): void {
  mastra.getAgentController("workbench")?.onSessionCreated((session) => {
    let lastStepUsage: TokenUsage | undefined;
    let promotingThread: Promise<void> | undefined;
    session.subscribe((event) => {
      if (event.type === "agent_start") lastStepUsage = undefined;
      if (event.type === "usage_update") lastStepUsage = event.usage;
      if (
        event.type === "message_start" &&
        (event.message.role === "user" ||
          (event.message.role === "signal" && event.message.type === "user")) &&
        !promotingThread
      ) {
        promotingThread = promoteUserThread(session)
          .catch((error: unknown) => {
            mastra.getLogger().error("User thread metadata update failed", {
              threadId: session.thread.getId(),
              error,
            });
          })
          .finally(() => {
            promotingThread = undefined;
          });
      }
    });
    session.onBeforeAgentEnd((event) => {
      const runId = session.getCurrentRunId();
      const scheduled = runId ? scheduledDesktopNotifications.get(runId) : undefined;
      if (runId) scheduledDesktopNotifications.delete(runId);
      if (event.reason && event.reason !== "complete") return;
      const threadId = session.thread.getId();
      if (!threadId) return;
      publishDesktopNotification({
        id: runId ?? crypto.randomUUID(),
        resourceId: session.identity.getResourceId(),
        threadId,
        kind: "task",
        title: "Mastra",
        body: "",
      });
      for (const notification of scheduled ?? []) publishDesktopNotification(notification);
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
  const threadId = parsed.data[1];
  // Mastra's downstream handler clones the raw request, so leave its body unread.
  const body = c.req.raw.body
    ? z.record(z.string(), z.unknown()).parse(await c.req.raw.clone().json())
    : undefined;
  const messageContext = z
    .object({
      [WORK_MESSAGE_OPTIONS_CONTEXT_KEY]: workbenchMessageOptionsSchema.optional(),
    })
    .strict()
    .parse(body?.requestContext ?? {});
  const runsAgent = [
    "/messages",
    "/steer",
    "/follow-up",
    "/tool-approval",
    "/tool-suspension",
  ].includes(operation);
  const result = runsAgent
    ? await prepareWorkbenchMessage(
        c,
        threadId,
        resourceId,
        messageContext[WORK_MESSAGE_OPTIONS_CONTEXT_KEY],
      )
    : await sessionFor(c, { resourceId, threadId, scope: parsed.data[0] });
  if (["/messages", "/steer", "/follow-up"].includes(operation) && c.req.method === "POST") {
    await assertNoActiveConversationRun(resourceId, threadId);
    const profile = await getAgentProfile(
      c.get("requestContext").get(AGENT_PROFILE_CONTEXT_KEY) as string | undefined,
      resourceId,
    );
    const selection = await resolveModelSelection(result.controllerSession.model.get(), resourceId);
    if (
      operation !== "/messages" &&
      (profile.workflow?.strategy === "workflow" || selection?.model.kind !== "language")
    )
      throw workError("VALIDATION_FAILED", {
        text: "生成或团队流程进行中请先停止，再发送新的请求",
      });
  }
  if (operation === "/messages" && c.req.method === "POST") {
    const text = z.string().max(100_000).parse(body?.message);
    const options = messageContext[WORK_MESSAGE_OPTIONS_CONTEXT_KEY] ?? {};
    if (!(text.trim() || options.files?.length || options.skillNames?.length))
      throw workError("SESSION_INPUT_REQUIRED");
    const selection = await resolveModelSelection(result.controllerSession.model.get(), resourceId);
    const profile = await getAgentProfile(
      result.thread.metadata?.agentProfileId as string | undefined,
      resourceId,
    );
    if (selection?.model.kind !== "language" || profile.workflow?.strategy === "workflow") {
      if (options.goal)
        throw workError("VALIDATION_FAILED", { text: "生成和显式团队流程不使用目标模式" });
      c.res = await startConversationRun(c, result, text);
      return;
    }
    if (options.goal) {
      const objective = z.string().trim().min(1).max(20_000).parse(text);
      await result.agent.setObjective(objective, { threadId, resourceId });
    }
    const sent = result.controllerSession.sendSignal(createWorkMessageSignal(text, options), {
      requestContext: c.get("requestContext"),
      requireDelivery: true,
    });
    observeSessionWork(c, result.controllerSession, sent.accepted);
    c.res = c.json({ ok: true, messageId: sent.id });
    return;
  }
  if (operation === "/model" && c.req.method === "POST") {
    const selection = z
      .object({
        modelId: z.string().min(1),
      })
      .parse(body);
    if (!(await resolveModelSelection(selection.modelId, resourceId))) {
      throw workError("MODEL_NOT_CONFIGURED");
    }
  }
  if (
    operation === "/tool-suspension" &&
    typeof body?.toolCallId === "string" &&
    !result.controllerSession.suspensions.has({ toolCallId: body.toolCallId })
  ) {
    const { runs } = await listPendingAgentRuns(result);
    for (const run of runs) {
      const tool = run.toolCalls.find(
        (call) => call.toolCallId === body.toolCallId && !call.requiresApproval,
      );
      if (!tool?.toolCallId || !tool.toolName) continue;
      result.controllerSession.suspensions.register({
        toolCallId: tool.toolCallId,
        runId: run.runId,
        toolName: tool.toolName,
        threadId,
        resourceId,
      });
      break;
    }
    const manager = c.get("mastra").backgroundTaskManager;
    if (manager) {
      const { tasks } = await manager.listTasks({
        threadId,
        resourceId,
        toolCallId: body.toolCallId,
        status: "suspended",
      });
      const task = tasks.find((task) => task.agentId === result.agent.id);
      if (task) {
        await ensureTaskExecutorAvailable(manager, task);
        if (!result.controllerSession.suspensions.has({ toolCallId: task.toolCallId })) {
          result.controllerSession.suspensions.register({
            toolCallId: task.toolCallId,
            runId: task.runId,
            toolName: task.toolName,
            threadId,
            resourceId,
          });
        }
      }
    }
  }
  await next();
  // Core persists only thinkingLevel/notifications from Session.state. The host
  // owns durable permissions, including changes made through the native API.
  if (
    c.res.ok &&
    c.req.method !== "GET" &&
    (operation.startsWith("/permissions/") || operation === "/state")
  ) {
    await persistSessionPermissions(result.controllerSession);
  }
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

async function persistSessionPermissions(session: ControllerSession): Promise<void> {
  const rules = parsePermissionRules(session.permissions.getRules());
  const yolo =
    TOOL_CATEGORIES.every((category) => rules.categories[category] === "allow") &&
    Object.values(rules.tools).every((policy) => policy === "allow");
  await session.state.set({ permissionRules: rules, yolo });
  await session.thread.setSetting({ key: "permissionRules", value: rules });
}

async function persistentDisplayState(c: ContextWithMastra, result: SessionRouteResult) {
  const displayState = structuredClone(result.controllerSession.displayState.get());
  const threadState = await appStorage.getStore("threadState");
  const tasks = await threadState?.getState<TaskItem[]>({
    threadId: result.threadId,
    type: TASK_STATE_TYPE,
  });
  const agent = result.agent;
  const { runs } = await listPendingAgentRuns(result);
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
  const workflowRuns = await listThreadWorkflowRuns(result.resourceId, result.threadId);
  const backgroundSuspended = backgroundTasks.some((task) => task.status === "suspended");
  const workflowSuspended = workflowRuns.some((run) =>
    ["suspended", "paused"].includes(run.status ?? ""),
  );
  const workflowRunning =
    Boolean(activeThreadWorkflow(result.resourceId, result.threadId)) ||
    workflowRuns.some((run) => ["pending", "running", "waiting"].includes(run.status ?? ""));
  const activeMediaGeneration = activeThreadMediaGeneration(result.resourceId, result.threadId);
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
  for (const task of backgroundTasks) {
    if (
      task.status !== "suspended" ||
      task.agentId !== result.agent.id ||
      suspendedRuns.some((run) => run.toolCalls.some((tool) => tool.toolCallId === task.toolCallId))
    )
      continue;
    const approval = z
      .object({
        requireToolApproval: z.object({ toolName: z.string(), args: z.unknown().optional() }),
      })
      .safeParse(task.suspendPayload);
    const target = approval.success ? approval.data.requireToolApproval : task;
    suspendedRuns.push({
      runId: task.runId,
      toolCalls: [
        {
          toolCallId: task.toolCallId,
          toolName: target.toolName,
          args: target.args,
          suspendPayload: task.suspendPayload,
          requiresApproval: false,
          category: toolCategoryOf(target.toolName),
          policy: result.controllerSession.resolveToolApproval(target.toolName),
        },
      ],
    });
  }
  const objective = await agent.getObjective({ threadId: result.threadId });
  const teamInvocations = await listTeamInvocations(result.resourceId, result.threadId);
  const registeredAgents = [result.agent, ...Object.values(c.get("mastra").listAgents())];
  const parentActive = Boolean(
    result.agent.getActiveThreadRunId(result) ||
      result.controllerSession.stream.isActive() ||
      result.controllerSession.run.getRunId(),
  );
  await Promise.all(
    teamInvocations
      .filter((call) => call.status === "running" || call.status === "suspended")
      .map(async (call) => {
        const previousStatus = call.status;
        const task = backgroundTasks.find((task) => task.toolCallId === call.toolCallId);
        // Terminal task state wins over an old suspended child snapshot after a restart.
        if (task && ["failed", "cancelled", "timed_out"].includes(task.status)) {
          call.status = "error";
          call.error = task.error?.message ?? `Background task ${task.status}`;
          call.endedAt = task.completedAt?.toISOString() ?? new Date().toISOString();
          await finishTeamInvocation(
            call.id,
            { status: call.status, error: call.error, endedAt: call.endedAt },
            undefined,
            undefined,
            previousStatus,
          );
          return;
        }
        const member = registeredAgents.find((candidate) => candidate.id === call.agentId);
        const parked =
          member && call.memoryThreadId && call.memoryResourceId
            ? (
                await listPendingAgentRuns({
                  agent: member,
                  threadId: call.memoryThreadId,
                  resourceId: call.memoryResourceId,
                })
              ).runs.length > 0
            : false;
        const waiting =
          parked ||
          task?.status === "suspended" ||
          suspendedRuns.some((run) =>
            run.toolCalls.some((tool) => tool.toolCallId === call.toolCallId),
          );
        if (waiting) {
          call.status = "suspended";
          await finishTeamInvocation(
            call.id,
            { status: "suspended" },
            undefined,
            undefined,
            previousStatus,
          );
        } else if (
          parentActive ||
          workflowRunning ||
          backgroundTasks.some((task) => task.status === "pending" || task.status === "running")
        ) {
          call.status = "running";
        } else {
          call.status = "error";
          call.error = "Execution stopped before an invocation result was recorded";
          await finishTeamInvocation(
            call.id,
            { status: call.status, error: call.error, endedAt: new Date().toISOString() },
            undefined,
            undefined,
            previousStatus,
          );
        }
      }),
  );
  return {
    ...displayState,
    isRunning:
      displayState.isRunning ||
      Boolean(
        result.agent.getActiveThreadRunId(result) || result.controllerSession.stream.isActive(),
      ),
    queuedRequests: getSessionMessageQueue(result.controllerSession),
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
            workflowRunning ||
            activeMediaGeneration
          ? "running"
          : "idle",
    tasks: Array.isArray(tasks) ? tasks : [],
    objective: objective
      ? {
          ...objective,
          activeDurationMs: getGoalActivityDurationMs({
            agentId: agent.id,
            threadId: result.threadId,
            objectiveId: objective.id ?? objective.objective,
            activeDurationMs: objective.activeDurationMs,
          }),
        }
      : null,
    suspendedRuns,
    backgroundTasks,
    workflowRuns,
    teamInvocations,
    handoff: await getTeamHandoffState(
      await getAgentProfile(
        result.thread.metadata?.agentProfileId as string | undefined,
        result.resourceId,
      ),
      result.resourceId,
      result.threadId,
    ),
    activeWorkflow: activeThreadWorkflow(result.resourceId, result.threadId),
    activeMediaGeneration,
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

const sessionAbortRoute = registerApiRoute("/work/sessions/:scope/threads/:threadId/abort", {
  method: "POST",
  handler: async (c) => {
    const result = await sessionFor(c);
    const objective = await result.agent.getObjective({ threadId: result.threadId });
    if (objective?.status === "active")
      await result.agent.updateObjectiveOptions({ threadId: result.threadId, status: "paused" });
    await cancelConversationRuns(c, result);
    await abortWorkbenchSession(result.controllerSession);
    await cancelThreadBackgroundTasks(c.get("mastra").backgroundTaskManager, result);
    if (objective?.status === "active")
      await result.agent.updateObjectiveOptions({ threadId: result.threadId, status: "paused" });
    return c.json({ aborted: true });
  },
});

/** Native HTTP approval accepts a boolean only; retain the user's rejection reason. */
const declineSessionToolRoute = registerApiRoute(
  "/work/sessions/:scope/threads/:threadId/tool-decline",
  {
    method: "POST",
    handler: async (c) => {
      const body = z
        .object({
          toolCallId: z.string().min(1),
          reason: z.string().trim().min(1),
          options: workbenchMessageOptionsSchema.optional(),
        })
        .parse(await c.req.json());
      const resourceId = c.get("requestContext").get(MASTRA_RESOURCE_ID_KEY) as string;
      const result = await prepareWorkbenchMessage(
        c,
        c.req.param("threadId"),
        resourceId,
        body.options,
      );
      const session = result.controllerSession;
      const requestContext = c.get("requestContext");
      const declineContext = { message: body.reason };
      if (session.approval.isArmed({ toolCallId: body.toolCallId })) {
        const response = session.respondToToolApproval({
          toolCallId: body.toolCallId,
          decision: "decline",
          declineContext,
          requestContext,
        });
        if (!response.accepted)
          throw workError("SESSION_MESSAGE_REJECTED", { text: response.reason });
      } else {
        const { runs } = await listPendingAgentRuns(result);
        const run = runs.find((candidate) =>
          candidate.toolCalls.some(
            (tool) => tool.toolCallId === body.toolCallId && tool.requiresApproval,
          ),
        );
        if (!run)
          throw workError("VALIDATION_FAILED", { text: "Tool approval is no longer pending" });
        if (!session.claimToolResponse(body.toolCallId))
          throw workError("SESSION_MESSAGE_REJECTED");
        observeSessionWork(
          c,
          session,
          session
            .declineToolCall({
              toolCallId: body.toolCallId,
              runId: run.runId,
              threadId: result.threadId,
              resourceId,
              requestContext,
              declineContext,
            })
            .finally(() => session.releaseToolResponse(body.toolCallId)),
        );
      }
      return c.json({ ok: true });
    },
  },
);

/** Save the thread model and reasoning preference in one product request. */
const sessionModelRoute = registerApiRoute("/work/sessions/:scope/threads/:threadId/model", {
  method: "PATCH",
  handler: async (c) => {
    const result = await sessionFor(c);
    const body = z
      .object({
        selection: z.object({
          providerId: z.string().trim().min(1),
          modelId: z.string().trim().min(1),
          reasoningEffort: z.string().optional(),
        }),
      })
      .parse(await c.req.json());
    const { providerId, modelId, reasoningEffort = "off" } = body.selection;
    if (!(await resolveModelSelection(`${providerId}/${modelId}`, result.resourceId))) {
      throw workError("MODEL_NOT_CONFIGURED");
    }
    await result.controllerSession.model.switch(`${providerId}/${modelId}`);
    await result.controllerSession.thread.setSetting({
      key: "reasoningEffort",
      value: reasoningEffort,
    });
    const thread = await result.memory.getThreadById({ threadId: result.threadId });
    return c.json({ modelId: result.controllerSession.model.get(), thread });
  },
});

const sessionDisplayStateRoute = registerApiRoute(
  "/work/sessions/:scope/threads/:threadId/display-state",
  {
    method: "GET",
    handler: async (c) => {
      const result = await sessionFor(c);
      const history =
        c.req.query("includeMessages") === "true"
          ? (
              await result.memory.recall({
                threadId: result.threadId,
                resourceId: result.resourceId,
                perPage: false,
              })
            ).messages
          : undefined;
      if (history) await reconcileMediaMessages(result, history);
      const displayState = await persistentDisplayState(c, result);
      return c.json({
        displayState,
        // Live snapshots travel in displayState; they are not necessarily persisted message rows.
        ...(history ? { messages: workbenchMessages(history) } : {}),
      });
    },
  },
);

/**
 * 工作台状态上报(state lane 的生产者入口)。
 *
 * 渲染进程各面板把自己那一份 PUT 上来 —— 编辑器打开了什么、终端跑完了什么、
 * 哪些面板可见。官方 sendStateSignal 持久化并按 cacheKey 去重，
 * 活跃与空闲分支都只持久化，留给后续正常请求读取。
 * 活跃分支若使用默认 deliver，未消费的状态会在本轮结束后触发新一轮回复。
 */
const updateSessionWorkbenchStateRoute = registerApiRoute(
  "/work/sessions/:scope/threads/:threadId/workbench-state",
  {
    method: "PUT",
    handler: (c) =>
      withThreadWrite(
        c.get("requestContext").get(MASTRA_RESOURCE_ID_KEY) as string,
        c.req.param("threadId"),
        async () => {
          if (c.req.raw.signal.aborted) return c.body(null, 204);
          const result = await sessionFor(c);
          const parsed = workbenchStateSchema.safeParse(await c.req.json());
          if (!parsed.success) {
            throw workError("VALIDATION_FAILED", {
              text: "Invalid workbench state",
              details: { issues: parsed.error.issues },
            });
          }
          for (const [id, value] of Object.entries(parsed.data)) {
            if (c.req.raw.signal.aborted) break;
            if (value === undefined) continue;
            const contents = JSON.stringify(value);
            const delivery = await result.agent.sendStateSignal(
              { id, mode: "snapshot", cacheKey: contents, contents, value },
              {
                threadId: result.threadId,
                resourceId: result.resourceId,
                ifActive: { behavior: "persist" },
                ifIdle: {
                  behavior: "persist",
                  streamOptions: { requestContext: c.get("requestContext") },
                },
              },
            );
            if (!delivery.skipped) {
              await delivery.accepted;
              await delivery.persisted;
            }
          }
          return c.json({ state: parsed.data });
        },
      ),
  },
);

/**
 * 需要 Agent 处理的外部事件 → 通知收件箱。普通面板和终端生命周期仅走状态上报。
 * 投递时机与是否攒成 summary 由 agent 的默认投递策略决定,这里只负责落库。
 */
const sessionNotificationRoute = registerApiRoute(
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

/** Goal storage, judging and evaluation budgets belong to Mastra's native objective API. */
const sessionGoalRoute = registerApiRoute("/work/sessions/:scope/threads/:threadId/goal", {
  method: "POST",
  handler: async (c) => {
    const body = z
      .object({
        action: z.enum(["pause", "resume", "clear", "update"]),
        objective: z.string().trim().min(1).max(20_000).optional(),
        maxRuns: z.number().int().min(1).max(500).optional(),
        options: workbenchMessageOptionsSchema.optional(),
      })
      .strict()
      .parse(await c.req.json());
    const resourceId = c.get("requestContext").get(MASTRA_RESOURCE_ID_KEY) as string;
    const threadId = c.req.param("threadId");
    const result = await sessionFor(c, { threadId, resourceId, scope: "workbench" });
    const target = { threadId };
    const current = await result.agent.getObjective(target);
    if (!current) throw workError("VALIDATION_FAILED", { text: "当前会话没有目标" });
    if (body.action === "resume") {
      if (
        result.controllerSession.stream.isActive() ||
        result.controllerSession.run.getRunId() !== null
      ) {
        throw workError("VALIDATION_FAILED", { text: "请等待当前运行结束后再继续目标" });
      }
      await assertNoActiveConversationRun(resourceId, threadId);
      await prepareWorkbenchMessage(c, threadId, resourceId, body.options);
      const profile = await getAgentProfile(
        c.get("requestContext").get(AGENT_PROFILE_CONTEXT_KEY) as string | undefined,
        resourceId,
      );
      if (profile.workflow?.strategy === "workflow")
        throw workError("VALIDATION_FAILED", {
          text: "目标模式用于 Agent 和主管团队，显式流程请从团队入口运行",
        });
      const maxRuns = body.maxRuns ?? current.maxRuns ?? 50;
      if (current.runsUsed >= maxRuns)
        throw workError("VALIDATION_FAILED", { text: "目标评估次数已用完，请先提高次数上限" });
      await result.agent.updateObjectiveOptions({
        ...target,
        status: "active",
        maxRuns,
      });
      observeSessionWork(
        c,
        result.controllerSession,
        result.controllerSession.sendMessage({
          content: "继续完成当前目标。",
          requestContext: c.get("requestContext"),
          untilIdle: true,
        }),
      );
    } else {
      if (body.action === "update" && !body.objective)
        throw workError("VALIDATION_FAILED", { text: "目标不能为空" });
      await result.agent.updateObjectiveOptions({ ...target, status: "paused" });
      await abortWorkbenchSession(result.controllerSession);
      await cancelThreadBackgroundTasks(c.get("mastra").backgroundTaskManager, result);
      if (body.action === "clear") await result.agent.clearObjective(target);
      else if (body.action === "update" && body.objective) {
        if (body.objective !== current.objective) {
          await result.agent.setObjective(body.objective, {
            ...target,
            resourceId,
            maxRuns: body.maxRuns ?? current.maxRuns ?? 50,
          });
        }
        await result.agent.updateObjectiveOptions({
          ...target,
          status: "paused",
          maxRuns: body.maxRuns ?? current.maxRuns ?? 50,
        });
      } else await result.agent.updateObjectiveOptions({ ...target, status: "paused" });
    }
    return c.json({ objective: (await result.agent.getObjective(target)) ?? null });
  },
});

const teamInvocationDetailRoute = registerApiRoute(
  "/work/sessions/:scope/threads/:threadId/invocations/:invocationId",
  {
    method: "GET",
    handler: async (c) => {
      const resourceId = c.get("requestContext").get(MASTRA_RESOURCE_ID_KEY) as string;
      const result = await sessionFor(c, {
        threadId: c.req.param("threadId"),
        resourceId,
        scope: "workbench",
      });
      const detail = await getTeamInvocationDetail(
        resourceId,
        result.threadId,
        c.req.param("invocationId"),
      );
      if (!detail) throw workError("MESSAGE_NOT_FOUND");
      const { memoryThreadId, memoryResourceId } = detail.invocation;
      if (memoryThreadId && memoryResourceId && memoryThreadId !== result.threadId) {
        const recalled = await result.memory.recall({
          threadId: memoryThreadId,
          resourceId: memoryResourceId,
          perPage: false,
        });
        // Step snapshots include output that has not reached memory yet.
        const messages = new Map(recalled.messages.map((message) => [message.id, message]));
        for (const message of detail.messages) messages.set(message.id, message);
        detail.messages = [...messages.values()].sort(
          (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
        );
      }
      return c.json({ ...detail, messages: workbenchMessages(detail.messages) });
    },
  },
);

const sessionHandoffRoute = registerApiRoute("/work/sessions/:scope/threads/:threadId/handoff", {
  method: "POST",
  handler: async (c) => {
    const resourceId = c.get("requestContext").get(MASTRA_RESOURCE_ID_KEY) as string;
    const result = await sessionFor(c, {
      threadId: c.req.param("threadId"),
      resourceId,
      scope: "workbench",
    });
    const body = handoffInputSchema.parse(await c.req.json());
    const state = await persistentDisplayState(c, result);
    if (
      state.status !== "idle" ||
      result.controllerSession.stream.isActive() ||
      result.controllerSession.run.getRunId()
    )
      throw workError("VALIDATION_FAILED", { text: "请等待当前运行或审批结束后交接" });
    const profile = await getAgentProfile(
      result.thread.metadata?.agentProfileId as string | undefined,
      resourceId,
    );
    try {
      await transferTeamHandoff(profile, resourceId, result.threadId, body);
    } catch (cause) {
      throw workError("VALIDATION_FAILED", { text: errorText(cause), cause });
    }
    return c.json({ handoff: await getTeamHandoffState(profile, resourceId, result.threadId) });
  },
});

export const sessionRoutes = [
  sessionHandoffRoute,
  teamInvocationDetailRoute,
  desktopNotificationsRoute,
  sessionGoalRoute,
  sessionAbortRoute,
  declineSessionToolRoute,
  updateSessionWorkbenchStateRoute,
  sessionNotificationRoute,
  sessionModelRoute,
  sessionDisplayStateRoute,
];
