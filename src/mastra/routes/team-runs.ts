import { randomUUID } from "node:crypto";
import { toAISdkStream, workflowSnapshotToStream } from "@mastra/ai-sdk";
import type { MastraDBMessage } from "@mastra/core/agent";
import type { Mastra } from "@mastra/core/mastra";
import { MASTRA_RESOURCE_ID_KEY } from "@mastra/core/request-context";
import { type ContextWithMastra, registerApiRoute } from "@mastra/core/server";
import type { WorkflowRunOutput } from "@mastra/core/stream";
import {
  type AnyWorkflow,
  createWorkflowStateReader,
  type WorkflowState,
} from "@mastra/core/workflows";
import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import { z } from "zod";
import {
  AGENT_PROFILE_CONTEXT_KEY,
  type AgentProfile,
  ensureProfileAgentsRegistered,
  getAgentProfile,
} from "../agents/custom";
import { WORK_MESSAGE_OPTIONS_CONTEXT_KEY, workMessageMetadataSchema } from "../agents/processors";
import { TEAM_CONVERSATION_CONTEXT_KEY, TEAM_PROFILE_CONTEXT_KEY } from "../agents/team-workflow";
import { workError } from "../errors";
import { appStorage } from "../storage/database";
import { WORKSPACE_THREAD_ID_CONTEXT_KEY } from "../workspace/workspace-manager";
import { prepareWorkbenchMessage, type SessionRouteResult, sessionFor } from "./session-context";
import { normalizeChatHistoryMessages } from "./threads/shared";

const runningThreads = new Map<string, Promise<void> | undefined>();
const threadKey = (resourceId: string, threadId: string) => JSON.stringify([resourceId, threadId]);

export async function listTeamWorkflowRuns(resourceId: string, threadId: string) {
  const storage = await appStorage.getStore("workflows");
  const listing = await storage?.listWorkflowRuns({ resourceId, perPage: false });
  return (listing?.runs ?? [])
    .filter((run) => {
      const snapshot = workflowSnapshotRecord(run.snapshot);
      const context = snapshot?.requestContext as Record<string, unknown> | undefined;
      return (
        run.workflowName.startsWith("team-") &&
        context?.[WORKSPACE_THREAD_ID_CONTEXT_KEY] === threadId &&
        Boolean(context[TEAM_PROFILE_CONTEXT_KEY])
      );
    })
    .map((run) => ({
      ...run,
      status: String(workflowSnapshotRecord(run.snapshot)?.status ?? "pending"),
    }))
    .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime());
}

export async function assertNoActiveTeamRun(resourceId: string, threadId: string) {
  if (
    runningThreads.has(threadKey(resourceId, threadId)) ||
    (await listTeamWorkflowRuns(resourceId, threadId)).some((run) =>
      ["pending", "running", "waiting", "suspended", "paused"].includes(run.status),
    )
  ) {
    throw workError("SESSION_MESSAGE_REJECTED", { text: "请先完成、恢复或取消当前团队流程" });
  }
}

/** The frozen profile belongs to this run, so editing a team cannot change a suspended graph. */
async function restoreWorkflow(
  c: ContextWithMastra,
  session: SessionRouteResult,
  workflowId: string,
  runId: string,
) {
  const storage = await appStorage.getStore("workflows");
  const row = await storage?.getWorkflowRunById({ workflowName: workflowId, runId });
  const snapshot = workflowSnapshotRecord(row?.snapshot);
  const context = snapshot?.requestContext as Record<string, unknown> | undefined;
  if (
    row?.resourceId !== session.resourceId ||
    context?.[WORKSPACE_THREAD_ID_CONTEXT_KEY] !== session.threadId
  )
    throw workError("WORKFLOW_RUN_NOT_FOUND");
  const profile = context[TEAM_PROFILE_CONTEXT_KEY] as AgentProfile | undefined;
  if (!profile) throw workError("WORKFLOW_RUN_NOT_FOUND");
  const workflow = ensureProfileAgentsRegistered(
    c.get("mastra"),
    profile,
    session.resourceId,
  ).workflow;
  if (!workflow || workflow.id !== workflowId) throw workError("WORKFLOW_NOT_FOUND");
  return { workflow, context, profile };
}

export async function cancelTeamRuns(c: ContextWithMastra, session: SessionRouteResult) {
  for (const item of await listTeamWorkflowRuns(session.resourceId, session.threadId)) {
    if (!["pending", "running", "waiting", "paused", "suspended"].includes(item.status)) continue;
    const { workflow } = await restoreWorkflow(c, session, item.workflowName, item.runId);
    await (
      await workflow.createRun({ runId: item.runId, resourceId: session.resourceId })
    ).cancel();
  }
  await runningThreads.get(threadKey(session.resourceId, session.threadId));
}

/** Drain actual native runs and their final message writes before closing storage. */
export async function drainTeamRuns(mastra: Mastra) {
  for (const workflow of Object.values(mastra.listWorkflows())) {
    if (!workflow.id.startsWith("team-")) continue;
    for (const run of workflow.runs.values()) {
      if (!["pending", "running", "waiting"].includes(run.workflowRunStatus)) continue;
      await run.cancel();
      await run.streamOutput?.result;
    }
  }
  await Promise.all(runningThreads.values());
}

function workflowResponse(session: SessionRouteResult, output: WorkflowRunOutput) {
  const key = threadKey(session.resourceId, session.threadId);
  let finish!: () => void;
  runningThreads.set(
    key,
    new Promise<void>((resolve) => {
      finish = resolve;
    }),
  );
  return createUIMessageStreamResponse({
    stream: createUIMessageStream({
      execute: async ({ writer }) => {
        try {
          const messageId = `workflow-${output.runId}`;
          writer.write({ type: "start", messageId });
          for await (const chunk of toAISdkStream(output, { from: "workflow", version: "v7" })) {
            if (chunk.type !== "start" && chunk.type !== "finish") writer.write(chunk);
          }
          const result = await output.result;
          if (result.status === "failed") throw new Error(result.error.message);
          if (result.status === "tripwire") throw new Error(result.tripwire.reason);
          if (result.status === "success") {
            const text = z.object({ text: z.string() }).parse(result.result).text;
            const message: MastraDBMessage = {
              id: messageId,
              role: "assistant",
              createdAt: new Date(),
              threadId: session.threadId,
              resourceId: session.resourceId,
              content: {
                format: 2,
                parts: [{ type: "text", text }],
                metadata: { workflowId: output.workflowId, runId: output.runId },
              },
            };
            await session.memory.saveMessages({ messages: [message] });
            writer.write({ type: "text-start", id: messageId });
            writer.write({ type: "text-delta", id: messageId, delta: text });
            writer.write({ type: "text-end", id: messageId });
          }
          writer.write({ type: "finish" });
        } finally {
          runningThreads.delete(key);
          finish();
        }
      },
      onError: (error) => (error instanceof Error ? error.message : String(error)),
    }),
  });
}

export async function startTeamWorkflow(
  c: ContextWithMastra,
  result: SessionRouteResult,
  content: string,
) {
  const { resourceId, threadId } = result;
  await assertNoActiveTeamRun(resourceId, threadId);
  const key = threadKey(resourceId, threadId);
  if (runningThreads.has(key) || result.controllerSession.displayState.get().isRunning)
    throw workError("SESSION_MESSAGE_REJECTED");
  runningThreads.set(key, undefined);
  try {
    const profile = await getAgentProfile(
      c.get("requestContext").get(AGENT_PROFILE_CONTEXT_KEY) as string,
      resourceId,
    );
    if (profile.workflow?.strategy !== "workflow")
      throw workError("VALIDATION_FAILED", { text: "该团队没有选择显式流程" });
    const workflow = ensureProfileAgentsRegistered(c.get("mastra"), profile, resourceId).workflow;
    if (!workflow) throw workError("WORKFLOW_NOT_FOUND");
    const options = workMessageMetadataSchema.parse(
      c.get("requestContext").get(WORK_MESSAGE_OPTIONS_CONTEXT_KEY) ?? {},
    );
    const history = await result.memory.recall({
      threadId,
      resourceId,
      perPage: 20,
      includeTotal: false,
      orderBy: { field: "createdAt", direction: "DESC" },
    });
    c.get("requestContext").set(
      TEAM_CONVERSATION_CONTEXT_KEY,
      normalizeChatHistoryMessages(history.messages)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .flatMap((message) => {
          const content = message.content.parts
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n");
          return content ? [{ role: message.role === "user" ? "user" : "assistant", content }] : [];
        }),
    );
    await result.memory.saveMessages({
      messages: [
        {
          id: randomUUID(),
          role: "user",
          createdAt: new Date(),
          threadId,
          resourceId,
          content: {
            format: 2,
            parts: [
              { type: "text", text: content },
              ...(options.files ?? []).map((file) => ({
                type: "file" as const,
                data: file.url,
                mimeType: file.mediaType,
                filename: file.filename,
              })),
            ],
            metadata: { skillNames: options.skillNames, fileReferences: options.fileReferences },
          },
        },
      ],
    });
    const run = await workflow.createRun({ resourceId });
    return workflowResponse(
      result,
      run.stream({ inputData: { request: content }, requestContext: c.get("requestContext") }),
    );
  } catch (error) {
    runningThreads.delete(key);
    throw error;
  }
}

const startTeamRunRoute = registerApiRoute("/work/sessions/:scope/threads/:threadId/team-runs", {
  method: "POST",
  handler: async (c) => {
    const body = z
      .object({ content: z.string().min(1), options: z.unknown().optional() })
      .strict()
      .parse(await c.req.json());
    const resourceId = c.get("requestContext").get(MASTRA_RESOURCE_ID_KEY) as string;
    const result = await prepareWorkbenchMessage(
      c,
      c.req.param("threadId"),
      resourceId,
      body.options,
    );
    return startTeamWorkflow(c, result, body.content);
  },
});

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

  const { workflow } = await restoreWorkflow(c, session, workflowId, runId);

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

async function prepareWorkflowResume(c: ContextWithMastra, result: WorkflowRouteResult) {
  const profile = result.state.requestContext?.[TEAM_PROFILE_CONTEXT_KEY] as
    | AgentProfile
    | undefined;
  if (profile?.workflow?.strategy !== "workflow") {
    throw workError("VALIDATION_FAILED", { text: "主管委派的流程请通过主管的工具交互恢复" });
  }
  await prepareWorkbenchMessage(
    c,
    result.threadId,
    result.resourceId,
    result.state.requestContext?.[WORK_MESSAGE_OPTIONS_CONTEXT_KEY],
  );
  c.get("requestContext").set(
    TEAM_PROFILE_CONTEXT_KEY,
    result.state.requestContext?.[TEAM_PROFILE_CONTEXT_KEY],
  );
  c.get("requestContext").set(
    TEAM_CONVERSATION_CONTEXT_KEY,
    result.state.requestContext?.[TEAM_CONVERSATION_CONTEXT_KEY],
  );
  const key = threadKey(result.resourceId, result.threadId);
  if (runningThreads.has(key) || result.controllerSession.displayState.get().isRunning)
    throw workError("SESSION_MESSAGE_REJECTED");
  runningThreads.set(key, undefined);
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
  const suspended = reader.getSuspendedStep();
  if (state.status !== "suspended") throw workError("WORKFLOW_RUN_INVALID_STATE");
  const defaultLabel = suspended?.suspendPayload?.resumeLabel;
  const labeled = reader.getResumeLabel(label || defaultLabel);
  if (label && !labeled) throw workError("WORKFLOW_RUN_INVALID_STATE");
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
      await prepareWorkflowResume(c, result);
      try {
        const run = await result.workflow.createRun({
          runId: result.state.runId,
          resourceId: result.resourceId,
        });
        return workflowResponse(
          result,
          run.resumeStream({
            step: target.step,
            resumeData: body.resumeData,
            requestContext: c.get("requestContext"),
            ...(target.forEachIndex === undefined ? {} : { forEachIndex: target.forEachIndex }),
          }),
        );
      } catch (error) {
        runningThreads.delete(threadKey(result.resourceId, result.threadId));
        throw error;
      }
    },
  },
);

const rerunWorkflowRoute = registerApiRoute(
  "/work/sessions/:scope/threads/:threadId/workflows/:workflowId/runs/:runId/rerun",
  {
    method: "POST",
    handler: async (c) => {
      const result = await workflowRouteFor(c);
      await assertNoActiveTeamRun(result.resourceId, result.threadId);
      await prepareWorkflowResume(c, result);
      try {
        const run = await result.workflow.createRun({ resourceId: result.resourceId });
        return workflowResponse(
          result,
          run.stream({ inputData: result.state.payload, requestContext: c.get("requestContext") }),
        );
      } catch (error) {
        runningThreads.delete(threadKey(result.resourceId, result.threadId));
        throw error;
      }
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

export const teamWorkflowRoutes = [
  startTeamRunRoute,
  workflowRunDetailRoute,
  workflowRunReplayRoute,
  workflowRunResumeRoute,
  rerunWorkflowRoute,
  workflowRunCancelRoute,
];
