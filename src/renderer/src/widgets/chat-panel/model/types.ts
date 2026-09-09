import {
  type FileUIPart,
  getToolName as getAISDKToolName,
  isToolUIPart,
  type LanguageModelUsage,
  type UIMessage,
} from "ai";
import type { PermissionPolicy, ToolCategory } from "@/entities/workbench";
import type { ToolPart } from "@/shared/ui/ai-elements/tool";

/**
 * 本项目的助手消息 metadata:与服务端 chat 路由的 messageMetadata 一一对应
 * (src/mastra/routes/chat.ts 的 WorkMessageMetadata)。
 * 给 Chat / useChat 传这个泛型,读 usage 就不再需要类型断言。
 */
export interface WorkMessageMetadata {
  /** 助手消息:本轮真实 token 用量,上下文水位据此显示 */
  usage?: LanguageModelUsage;
  /** 用户消息:本条消息选中的 skills(发送时随 metadata 附带) */
  skillNames?: string[];
  /** 用户消息:通过 @ 显式引用的资料库文件,发送后在气泡中保留徽章 */
  fileReferences?: MessageFileReference[];
}

export interface MessageFileReference {
  id: string;
  filename: string;
  url: string;
}

export interface WorkspaceLogData {
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

export type ReferenceBadgeKind = "skill" | "file";

const REFERENCE_BADGE_COLORS = [
  "border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-300",
  "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300",
  "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300",
  "border-violet-200 bg-violet-50 text-violet-700 dark:border-violet-800 dark:bg-violet-950/40 dark:text-violet-300",
  "border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-300",
  "border-cyan-200 bg-cyan-50 text-cyan-700 dark:border-cyan-800 dark:bg-cyan-950/40 dark:text-cyan-300",
];

const referenceBadgeColorCache = new Map<string, string>();

/** Assign a random color once per reference so input badges and message echoes match. */
export function referenceBadgeClass(kind: ReferenceBadgeKind, value: string): string {
  const cacheKey = `${kind}:${value}`;
  const cachedColor = referenceBadgeColorCache.get(cacheKey);
  if (cachedColor) return cachedColor;

  const color =
    REFERENCE_BADGE_COLORS[Math.floor(Math.random() * REFERENCE_BADGE_COLORS.length)] ??
    REFERENCE_BADGE_COLORS[0];
  referenceBadgeColorCache.set(cacheKey, color);
  return color;
}

export type WorkUIMessage = UIMessage<
  WorkMessageMetadata,
  {
    "task-update": { tasks: unknown[] };
    "library-sources": unknown[];
    "workspace-log": WorkspaceLogData;
  }
>;

export interface AgentSubagentState {
  agentType: string;
  displayName?: string;
  task: string;
  status: "running" | "completed" | "error";
  textDelta?: string;
}

export interface AgentToolState {
  toolCallId: string;
  name: string;
  status: "streaming_input" | "running" | "completed" | "error";
}

export type MessagePart = UIMessage["parts"][number];
export type TracePart = Extract<MessagePart, { type: "reasoning" }> | ToolPart;

export type AssistantSegment =
  | { key: string; text: string; type: "text" }
  | { key: string; parts: TracePart[]; type: "trace" }
  | { key: string; interaction: AgentInteraction; type: "interaction" };

export type JsonRecord = Record<string, unknown>;

export interface AgentTask {
  id: string;
  content: string;
  activeForm: string;
  status: "pending" | "in_progress" | "completed";
}

export interface QueuedRequest {
  id: string;
  text: string;
  files: FileUIPart[];
  skills?: string[];
  fileReferences?: MessageFileReference[];
  /** Server session queue id; its run is consumed through AI SDK resumeStream(). */
  followUpId?: string;
}

export type LibraryFilePart = FileUIPart & { byteSize?: number };

export interface PlanDraft {
  path?: string;
  title: string;
  plan: string;
}

export interface AgentInteraction {
  key: string;
  runId: string;
  toolCallId?: string;
  toolName: string;
  args?: unknown;
  input?: unknown;
  output?: unknown;
  requiresApproval: boolean;
  suspendPayload?: JsonRecord;
  plan?: PlanDraft;
  completed?: boolean;
  /**
   * 该工具的权限类别与生效策略,由服务端算好后随会话 display-state
   * 下发(类别映射只在 src/mastra/agents/permissions.ts 保留一份)。
   * 流式期间出现的审批还没有这两个字段,等本轮结束读取挂起列表时合并进来 ——
   * 审批按钮在流结束前本就是禁用态,不影响操作。
   */
  category?: ToolCategory;
  policy?: PermissionPolicy;
}

export interface WorkDisplayState {
  status: "idle" | "running" | "suspended";
  threadId: string;
  activeRunId: string | null;
  modeId: string;
  followUpCount: number;
  grants: { categories: ToolCategory[]; tools: string[] };
  state: Record<string, unknown>;
  tasks: AgentTask[];
  suspendedRuns: AgentInteraction[];
  backgroundTasks?: BackgroundTaskState[];
  workflowRuns?: WorkflowRunSummaryState[];
}

export interface BackgroundTaskState {
  id: string;
  status: "pending" | "running" | "suspended" | "completed" | "failed" | "cancelled" | "timed_out";
  toolName: string;
  toolCallId: string;
  agentId: string;
  runId: string;
  threadId?: string;
  result?: unknown;
  error?: { message?: string };
  output?: unknown;
  suspendPayload?: unknown;
  progress?: { runningCount?: number; elapsedMs?: number };
  retryCount?: number;
  maxRetries?: number;
  timeoutMs?: number;
  startedAt?: string;
  suspendedAt?: string;
  createdAt?: string;
  completedAt?: string;
}

export interface WorkflowRunSummaryState {
  workflowName: string;
  runId: string;
  resourceId?: string;
  status?: string;
  snapshot?: unknown;
  createdAt?: string;
  updatedAt?: string;
}

export interface WorkflowRuntimeStep {
  id: string;
  label?: string;
  status: "running" | "success" | "failed" | "suspended" | "waiting" | "skipped" | "paused";
  input?: unknown;
  resumePayload?: unknown;
  /** Mastra persists epoch-millisecond timestamps for step results. */
  startedAt?: string;
  endedAt?: string;
  suspendedAt?: string;
  error?: string;
  output?: unknown;
  suspendPayload?: unknown;
  progress?: { completedCount: number; totalCount: number; currentIndex: number };
}

export interface WorkflowRuntimeEvent {
  id: number;
  type: string;
  at: string;
  runId: string;
  stepId?: string;
  status?: string;
  message?: string;
  metadata?: Record<string, unknown>;
}

export interface WorkflowRuntimeRun {
  runId: string;
  workflowId: string;
  threadId: string;
  resourceId: string;
  status: string;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  error?: string;
  output?: unknown;
  steps: WorkflowRuntimeStep[];
  events: WorkflowRuntimeEvent[];
}

export interface WorkflowRuntimeState {
  active: WorkflowRuntimeRun | null;
  runs: WorkflowRuntimeRun[];
}

function workflowSnapshotToRuntime(run: WorkflowRunSummaryState): WorkflowRuntimeRun {
  const snapshot = parseJsonRecord(run.snapshot);
  const persistedSteps = asRecord(snapshot?.steps);
  const persistedContext = asRecord(snapshot?.context);
  // Storage snapshots use `context` for the authoritative step results. Some
  // adapters also expose a derived `steps` object; prefer it only when it has
  // entries so an empty derived value cannot hide the persisted context.
  const context =
    persistedSteps && Object.keys(persistedSteps).length > 0
      ? persistedSteps
      : persistedContext
        ? Object.fromEntries(
            Object.entries(persistedContext).filter(([id]) => id !== "input" && id !== "__state"),
          )
        : undefined;
  const steps = context
    ? Object.entries(context).flatMap(([id, value]) => {
        // A foreach step is persisted as an array of official step results.
        // Keep each item visible instead of assuming a synthetic retry field.
        const results = Array.isArray(value) ? value : [value];
        return results.flatMap((entry, index) => {
          const step = asRecord(entry);
          if (!step || typeof step.status !== "string") return [];
          const stepId = results.length > 1 ? `${id}[${index}]` : id;
          return [
            {
              id: stepId,
              label: asString(step.name) ?? stepId,
              status: step.status as WorkflowRuntimeStep["status"],
              ...(step.input !== undefined || step.payload !== undefined
                ? { input: step.input ?? step.payload }
                : {}),
              ...(step.resumePayload !== undefined ? { resumePayload: step.resumePayload } : {}),
              startedAt: workflowTimestamp(step.startedAt),
              endedAt: workflowTimestamp(step.endedAt),
              suspendedAt: workflowTimestamp(step.suspendedAt),
              output: step.output,
              ...(step.suspendPayload !== undefined ? { suspendPayload: step.suspendPayload } : {}),
              ...(workflowErrorText(step.error) ? { error: workflowErrorText(step.error) } : {}),
            },
          ];
        });
      })
    : [];
  const status = run.status ?? asString(snapshot?.status) ?? "running";
  const startedAt = run.createdAt ?? workflowTimestamp(snapshot?.timestamp) ?? "";
  const updatedAt = run.updatedAt ?? startedAt;
  const eventDrafts: Array<Omit<WorkflowRuntimeEvent, "id">> = [];
  const addEvent = (event: Omit<WorkflowRuntimeEvent, "id">) => {
    if (event.at || event.type === "workflow-status") eventDrafts.push(event);
  };
  if (startedAt) {
    addEvent({
      type: "workflow-start",
      at: startedAt,
      runId: run.runId,
      status: "running",
      message: "Workflow 开始运行",
    });
  }
  for (const step of steps) {
    if (step.startedAt) {
      addEvent({
        type: "step-start",
        at: step.startedAt,
        runId: run.runId,
        stepId: step.id,
        status: "running",
        message: "步骤开始",
      });
    }
    if (step.suspendedAt) {
      addEvent({
        type: "step-suspended",
        at: step.suspendedAt,
        runId: run.runId,
        stepId: step.id,
        status: "suspended",
        message: "步骤已挂起",
      });
    }
    if (step.endedAt) {
      addEvent({
        type: "step-finish",
        at: step.endedAt,
        runId: run.runId,
        stepId: step.id,
        status: step.status,
        message: `步骤 ${step.status}`,
      });
    }
  }
  addEvent({
    type: "workflow-status",
    at: updatedAt,
    runId: run.runId,
    status,
    message: `Workflow ${status}`,
  });
  const events = eventDrafts
    .sort((left, right) => {
      const leftTime = left.at ? Date.parse(left.at) : Number.POSITIVE_INFINITY;
      const rightTime = right.at ? Date.parse(right.at) : Number.POSITIVE_INFINITY;
      return (
        (Number.isNaN(leftTime) ? Number.POSITIVE_INFINITY : leftTime) -
        (Number.isNaN(rightTime) ? Number.POSITIVE_INFINITY : rightTime)
      );
    })
    .map((event, index) => ({ ...event, id: index + 1 }));
  const error = workflowErrorText(snapshot?.error);
  return {
    runId: run.runId,
    workflowId: run.workflowName,
    threadId: "",
    resourceId: run.resourceId ?? "",
    status,
    startedAt,
    updatedAt,
    steps,
    events,
    output: snapshot?.result,
    ...(error ? { error } : {}),
    ...(!["pending", "running", "waiting", "suspended", "paused"].includes(status)
      ? { finishedAt: updatedAt }
      : {}),
  };
}

function workflowTimestamp(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
  if (typeof value === "string" && value.trim()) return value;
  return undefined;
}

function workflowErrorText(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value;
  return asString(asRecord(value)?.message);
}

function parseJsonRecord(value: unknown): JsonRecord | undefined {
  if (typeof value === "string") {
    try {
      return asRecord(JSON.parse(value));
    } catch {
      return undefined;
    }
  }
  return asRecord(value);
}

export function getWorkflowStateFromDisplayState(
  runs: WorkflowRunSummaryState[] | undefined,
): WorkflowRuntimeState | null {
  if (!runs || runs.length === 0) return null;
  const normalized = runs.map(workflowSnapshotToRuntime);
  const active = normalized.find((run) =>
    ["pending", "running", "suspended", "waiting", "paused"].includes(run.status),
  );
  return { active: active ?? null, runs: normalized };
}

/**
 * Merge live AI SDK parts with the persisted run snapshot. Live parts provide
 * the current status and event order; the snapshot is authoritative for the
 * final result and fills fields that the aggregate workflow part omits.
 */
export function mergeWorkflowRuntimeStates(
  live: WorkflowRuntimeState | null,
  persisted: WorkflowRuntimeState | null,
): WorkflowRuntimeState | null {
  if (!live) return persisted;
  if (!persisted) return live;
  const persistedById = new Map(persisted.runs.map((run) => [run.runId, run]));
  const mergedRuns = live.runs.map((liveRun) => {
    const snapshotRun = persistedById.get(liveRun.runId);
    if (!snapshotRun) return liveRun;
    const snapshotSteps = new Map(snapshotRun.steps.map((step) => [step.id, step]));
    const steps = liveRun.steps.map((liveStep) => {
      const snapshotStep = snapshotSteps.get(liveStep.id);
      if (!snapshotStep) return liveStep;
      return {
        ...snapshotStep,
        ...liveStep,
        input: liveStep.input ?? snapshotStep.input,
        resumePayload: liveStep.resumePayload ?? snapshotStep.resumePayload,
        startedAt: liveStep.startedAt ?? snapshotStep.startedAt,
        endedAt: liveStep.endedAt ?? snapshotStep.endedAt,
        suspendedAt: liveStep.suspendedAt ?? snapshotStep.suspendedAt,
        error: liveStep.error ?? snapshotStep.error,
        output: liveStep.output ?? snapshotStep.output,
        suspendPayload: liveStep.suspendPayload ?? snapshotStep.suspendPayload,
      };
    });
    for (const snapshotStep of snapshotRun.steps) {
      if (!steps.some((step) => step.id === snapshotStep.id)) steps.push(snapshotStep);
    }
    const eventKeys = new Set<string>();
    const events = [...snapshotRun.events, ...liveRun.events]
      .filter((event) => {
        const key = [event.type, event.at, event.stepId ?? "", event.status ?? ""].join("|");
        if (eventKeys.has(key)) return false;
        eventKeys.add(key);
        return true;
      })
      .sort((left, right) => {
        const leftTime = left.at ? Date.parse(left.at) : Number.POSITIVE_INFINITY;
        const rightTime = right.at ? Date.parse(right.at) : Number.POSITIVE_INFINITY;
        return (
          (Number.isNaN(leftTime) ? Number.POSITIVE_INFINITY : leftTime) -
          (Number.isNaN(rightTime) ? Number.POSITIVE_INFINITY : rightTime)
        );
      })
      .map((event, index) => ({ ...event, id: index + 1 }));
    return {
      ...snapshotRun,
      ...liveRun,
      resourceId: liveRun.resourceId || snapshotRun.resourceId,
      startedAt: liveRun.startedAt || snapshotRun.startedAt,
      updatedAt: liveRun.updatedAt || snapshotRun.updatedAt,
      finishedAt: liveRun.finishedAt ?? snapshotRun.finishedAt,
      error: liveRun.error ?? snapshotRun.error,
      output: liveRun.output ?? snapshotRun.output,
      steps,
      events,
    };
  });
  const liveIds = new Set(live.runs.map((run) => run.runId));
  mergedRuns.push(...persisted.runs.filter((run) => !liveIds.has(run.runId)));
  const persistedOnlyActive = persisted.runs.find(
    (run) =>
      !liveIds.has(run.runId) &&
      ["pending", "running", "suspended", "waiting", "paused"].includes(run.status),
  );
  const activeRunId = live.active?.runId ?? persistedOnlyActive?.runId;
  const active = mergedRuns.find((run) => run.runId === activeRunId) ?? null;
  return { active, runs: mergedRuns };
}

function updateWorkflowRunTimes(run: WorkflowRuntimeRun): void {
  const timestamps = run.steps
    .flatMap((step) => [step.startedAt, step.suspendedAt, step.endedAt])
    .filter((value): value is string => Boolean(value))
    .map((value) => ({ value, time: Date.parse(value) }))
    .filter(({ time }) => !Number.isNaN(time))
    .sort((left, right) => left.time - right.time);
  if (!run.startedAt && timestamps[0]) run.startedAt = timestamps[0].value;
  if (timestamps.at(-1)) run.updatedAt = timestamps.at(-1)?.value ?? run.updatedAt;
}

/** Convert Mastra's official data-workflow parts into the panel's view model. */
export function getWorkflowStateFromMessages(messages: UIMessage[]): WorkflowRuntimeState | null {
  const runs = new Map<string, WorkflowRuntimeRun>();
  let eventId = 0;
  for (const message of messages) {
    for (const part of message.parts) {
      const raw = part as unknown as {
        type?: unknown;
        id?: unknown;
        data?: unknown;
      };
      if (
        raw.type !== "data-workflow" &&
        raw.type !== "data-tool-workflow" &&
        raw.type !== "data-workflow-step" &&
        raw.type !== "data-tool-workflow-step"
      ) {
        continue;
      }
      const data = asRecord(raw.data);
      if (!data) continue;
      const runId = asString(raw.id)?.split(":")[0];
      if (!runId) continue;
      const current =
        runs.get(runId) ??
        ({
          runId,
          workflowId: asString(data.name) ?? "workflow",
          threadId: "",
          resourceId: "",
          status: "running",
          startedAt: "",
          updatedAt: "",
          steps: [],
          events: [],
        } satisfies WorkflowRuntimeRun);
      const previousStatus = current.status;
      const status = asString(data.status) ?? current.status;
      current.status = status;
      if (status !== previousStatus || current.events.length === 0) {
        current.events.push({
          id: ++eventId,
          type: raw.type,
          at: current.updatedAt,
          runId,
          status,
          message: `Workflow ${status}`,
        });
      }
      if (raw.type === "data-workflow" || raw.type === "data-tool-workflow") {
        const steps = asRecord(data.steps);
        if (steps) {
          current.steps = Object.entries(steps).map(([id, value]) => {
            const step = asRecord(value);
            return {
              id,
              label: asString(step?.name) ?? id,
              status: (asString(step?.status) ?? "waiting") as WorkflowRuntimeStep["status"],
              ...(step?.input !== undefined || step?.payload !== undefined
                ? { input: step.input ?? step.payload }
                : {}),
              ...(step?.resumePayload !== undefined ? { resumePayload: step.resumePayload } : {}),
              startedAt: workflowTimestamp(step?.startedAt),
              endedAt: workflowTimestamp(step?.endedAt),
              suspendedAt: workflowTimestamp(step?.suspendedAt),
              output: step?.output,
              ...(step?.suspendPayload !== undefined
                ? { suspendPayload: step.suspendPayload }
                : {}),
              ...(workflowErrorText(step?.error) || asString(asRecord(step?.output)?.error)
                ? {
                    error:
                      workflowErrorText(step?.error) ?? asString(asRecord(step?.output)?.error),
                  }
                : {}),
            };
          });
        }
        updateWorkflowRunTimes(current);
        // The official workflow data part exposes aggregate token usage under
        // `output`, not the workflow's final result. The actual result is
        // available from the persisted snapshot and step outputs.
        const output = asRecord(data.output);
        if (data.output !== undefined && data.output !== null && !output?.usage) {
          current.output = data.output;
        }
      } else {
        const stepData = asRecord(data.step);
        const stepId = asString(data.stepId) ?? asString(stepData?.name);
        if (stepId) {
          const index = current.steps.findIndex((step) => step.id === stepId);
          const next = {
            id: stepId,
            label: asString(stepData?.name) ?? stepId,
            status: (asString(stepData?.status) ??
              asString(data.status) ??
              "running") as WorkflowRuntimeStep["status"],
            ...(stepData?.input !== undefined || stepData?.payload !== undefined
              ? { input: stepData.input ?? stepData.payload }
              : {}),
            ...(stepData?.resumePayload !== undefined
              ? { resumePayload: stepData.resumePayload }
              : {}),
            startedAt: workflowTimestamp(stepData?.startedAt),
            endedAt: workflowTimestamp(stepData?.endedAt),
            suspendedAt: workflowTimestamp(stepData?.suspendedAt),
            output: stepData?.output,
            ...(stepData?.suspendPayload !== undefined
              ? { suspendPayload: stepData.suspendPayload }
              : {}),
            ...(workflowErrorText(stepData?.error)
              ? { error: workflowErrorText(stepData?.error) }
              : {}),
          };
          if (index >= 0) current.steps[index] = { ...current.steps[index], ...next };
          else current.steps.push(next);
          updateWorkflowRunTimes(current);
          current.events.push({
            id: ++eventId,
            type: raw.type,
            at: current.updatedAt,
            runId,
            stepId,
            status: next.status,
          });
        }
      }
      runs.set(runId, current);
    }
  }
  if (runs.size === 0) return null;
  const ordered = [...runs.values()].reverse();
  const active = ordered.find((run) =>
    ["pending", "running", "suspended", "waiting", "paused"].includes(run.status),
  );
  return { active: active ?? null, runs: ordered };
}

export function getBackgroundTasksFromMessages(messages: UIMessage[]): BackgroundTaskState[] {
  const tasks = new Map<string, BackgroundTaskState>();
  const statusMap: Record<string, BackgroundTaskState["status"]> = {
    started: "pending",
    running: "running",
    progress: "running",
    output: "running",
    completed: "completed",
    failed: "failed",
    cancelled: "cancelled",
    suspended: "suspended",
    resumed: "running",
  };
  for (const message of messages) {
    for (const part of message.parts) {
      const raw = part as unknown as { type?: unknown; id?: unknown; data?: unknown };
      if (typeof raw.type !== "string" || !raw.type.startsWith("data-background-task-")) continue;
      const data = asRecord(raw.data);
      const suffix = raw.type.slice("data-background-task-".length);
      // Mastra's AI SDK transformer places the official chunk payload under
      // `data`; manager SSE consumers may expose the same object as `payload`.
      // Normalize both without inventing a second lifecycle protocol.
      const payload = asRecord(data?.payload) ?? data;
      const taskIds =
        suffix === "progress" && Array.isArray(payload?.taskIds)
          ? payload.taskIds.filter((value): value is string => typeof value === "string")
          : [asString(payload?.taskId) ?? asString(raw.id)].filter((value): value is string =>
              Boolean(value),
            );
      for (const taskId of taskIds) {
        const previous = tasks.get(taskId);
        const next: BackgroundTaskState = {
          ...(previous ?? {}),
          id: taskId,
          status: statusMap[suffix] ?? previous?.status ?? "running",
          toolName: asString(payload?.toolName) ?? previous?.toolName ?? "background task",
          toolCallId: asString(payload?.toolCallId) ?? previous?.toolCallId ?? taskId,
          agentId: asString(payload?.agentId) ?? previous?.agentId ?? "",
          runId: asString(payload?.runId) ?? previous?.runId ?? "",
        };
        if (payload?.result !== undefined) next.result = payload.result;
        if (suffix === "output" && payload?.payload !== undefined) {
          const outputChunk = asRecord(payload.payload);
          next.output = outputChunk?.payload ?? payload.payload;
        }
        const error = asRecord(payload?.error);
        if (error) {
          const errorMessage = asString(error.message);
          next.error = errorMessage ? { message: errorMessage } : {};
        }
        if (payload?.suspendPayload !== undefined) next.suspendPayload = payload.suspendPayload;
        if (typeof payload?.startedAt === "string") next.startedAt = payload.startedAt;
        if (typeof payload?.suspendedAt === "string") next.suspendedAt = payload.suspendedAt;
        if (typeof payload?.completedAt === "string") next.completedAt = payload.completedAt;
        if (typeof payload?.retryCount === "number") next.retryCount = payload.retryCount;
        if (typeof payload?.maxRetries === "number") next.maxRetries = payload.maxRetries;
        if (typeof payload?.timeoutMs === "number") next.timeoutMs = payload.timeoutMs;
        if (suffix === "progress") {
          next.progress = {
            ...(typeof payload?.runningCount === "number"
              ? { runningCount: payload.runningCount }
              : {}),
            ...(typeof payload?.elapsedMs === "number" ? { elapsedMs: payload.elapsedMs } : {}),
          };
        }
        if (suffix === "running" || suffix === "resumed") {
          next.error = undefined;
          next.suspendPayload = undefined;
        } else if (suffix === "completed") {
          next.error = undefined;
          next.suspendPayload = undefined;
        } else if (suffix === "failed" || suffix === "cancelled") {
          next.result = undefined;
        }
        tasks.set(taskId, next);
      }
    }
  }
  return [...tasks.values()];
}

/** 折叠历史精简记录(服务端压缩时存入摘要消息 metadata.compactedHistory) */
export interface CompactedHistoryEntry {
  id: string;
  role: string;
  text: string;
  createdAt: string;
  compactionId?: string;
}

/** 手动压缩结果(服务端 summarize 路由返回 / 线程 metadata.compaction 回看) */
export interface CompressResult {
  summary: string;
  extracted?: Record<string, unknown>;
  extractionFailures?: Array<{ slug: string; error: string }>;
  inputTokens?: number;
  outputTokens?: number;
  estimatedContextTokens?: number;
  deletedMessages?: number;
}

export const TASK_TOOL_NAMES = new Set([
  "task_write",
  "task_update",
  "task_complete",
  "task_check",
]);
export const PROMPT_MANAGED_TOOL_NAMES = new Set(["ask_user", "submit_plan", "write_plan_draft"]);

export function isTaskToolName(toolName: string | undefined): boolean {
  return toolName !== undefined && TASK_TOOL_NAMES.has(toolName);
}

export function isPromptManagedToolName(toolName: string | undefined): boolean {
  return toolName !== undefined && PROMPT_MANAGED_TOOL_NAMES.has(toolName);
}

export function asRecord(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function parseSuspendedRuns(value: unknown): AgentInteraction[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((run) => {
    const record = asRecord(run);
    const runId = asString(record?.runId);
    const toolCalls = record?.toolCalls;
    if (!runId || !Array.isArray(toolCalls)) return [];
    return toolCalls.flatMap((call) => {
      const toolCall = asRecord(call);
      const toolName = asString(toolCall?.toolName);
      if (!toolName) return [];
      return [
        {
          key: `${runId}:${asString(toolCall?.toolCallId) ?? toolName}`,
          runId,
          toolCallId: asString(toolCall?.toolCallId),
          toolName,
          args: toolCall?.args,
          requiresApproval: toolCall?.requiresApproval === true,
          suspendPayload: asRecord(toolCall?.suspendPayload),
          category: asString(toolCall?.category) as ToolCategory | undefined,
          policy: asString(toolCall?.policy) as PermissionPolicy | undefined,
        },
      ];
    });
  });
}

export function getToolName(part: MessagePart): string | undefined {
  return isToolUIPart(part) ? getAISDKToolName(part) : undefined;
}

export function getPlanDraft(messages: UIMessage[], path?: string): PlanDraft | undefined {
  for (const message of messages) {
    for (const part of message.parts) {
      if (!isToolUIPart(part) || getToolName(part) !== "write_plan_draft") continue;
      const output = asRecord("output" in part ? part.output : undefined);
      if (!output) continue;
      const outputPath = asString(output.path);
      if (path && outputPath && outputPath !== path) continue;
      const title = asString(output.title);
      const plan = asString(output.plan);
      if (title && plan) return { path: outputPath, title, plan };
    }
  }
  return undefined;
}

export function getMessageInteractions(messages: UIMessage[]): AgentInteraction[] {
  const interactions: AgentInteraction[] = [];
  const completedToolCalls = new Set<string>();

  for (const message of messages) {
    for (const part of message.parts) {
      if (!isToolUIPart(part)) continue;
      if (
        part.state === "output-available" ||
        part.state === "output-error" ||
        part.state === "output-denied"
      ) {
        completedToolCalls.add(part.toolCallId);
      }
    }
  }

  for (const message of messages) {
    for (const part of message.parts) {
      const raw = part as unknown as JsonRecord;
      const data = asRecord(raw.data);
      if (!data) continue;
      const type = asString(raw.type);
      if (type !== "data-tool-call-suspended" && type !== "data-tool-call-approval") continue;
      if (data.resumed === true) continue;

      const runId = asString(data.runId);
      const toolName = asString(data.toolName);
      if (!runId || !toolName) continue;
      const toolCallId = asString(data.toolCallId) ?? asString(raw.id);
      if (toolCallId && completedToolCalls.has(toolCallId)) continue;
      interactions.push({
        key: `${runId}:${toolCallId ?? toolName}`,
        runId,
        toolCallId,
        toolName,
        args: data.args,
        requiresApproval: type === "data-tool-call-approval",
        suspendPayload: asRecord(data.suspendPayload),
      });
    }
  }

  return interactions;
}

export function hasPendingInteraction(
  messages: UIMessage[],
  interaction: AgentInteraction,
): boolean {
  if (!interaction.toolCallId) return false;
  return messages.some(
    (message) =>
      message.role === "assistant" &&
      message.parts.some((part) => {
        if (isToolUIPart(part)) {
          return (
            part.toolCallId === interaction.toolCallId &&
            (interaction.requiresApproval
              ? part.state === "approval-requested"
              : part.state !== "output-available" &&
                part.state !== "output-error" &&
                part.state !== "output-denied")
          );
        }
        const raw = part as unknown as JsonRecord;
        const data = asRecord(raw.data);
        return (
          (raw.type === "data-tool-call-suspended" || raw.type === "data-tool-call-approval") &&
          data?.runId === interaction.runId &&
          data.toolCallId === interaction.toolCallId &&
          data.resumed !== true
        );
      }),
  );
}

function parseTaskItems(value: unknown): AgentTask[] | undefined {
  let candidate = value;
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      return undefined;
    }
  }

  const record = asRecord(candidate);
  const rawTasks = Array.isArray(candidate) ? candidate : record?.tasks;
  if (!Array.isArray(rawTasks)) return undefined;

  const tasks = rawTasks.flatMap((task) => {
    const item = asRecord(task);
    const id = asString(item?.id);
    const content = asString(item?.content);
    const status = item?.status;
    if (
      !id ||
      !content ||
      (status !== "pending" && status !== "in_progress" && status !== "completed")
    ) {
      return [];
    }
    return [
      {
        id,
        content,
        activeForm: asString(item?.activeForm) ?? "进行中",
        status,
      } satisfies AgentTask,
    ];
  });
  return tasks;
}

function isTaskUpdatePart(raw: JsonRecord): boolean {
  const type = asString(raw.type);
  return (
    type === "task_update" ||
    type === "task_updated" ||
    type === "data-task-update" ||
    type === "data-task_update" ||
    type === "data-task_updated" ||
    type === "data-task-list-update" ||
    type === "data-current-task-list"
  );
}

export function getTasksFromMessages(messages: UIMessage[]): AgentTask[] | undefined {
  let latestTasks: AgentTask[] | undefined;

  for (const message of messages) {
    for (const part of message.parts) {
      const raw = part as unknown as JsonRecord;
      if (isToolUIPart(part) && isTaskToolName(getToolName(part))) {
        const nextTasks = parseTaskItems("output" in part ? part.output : undefined);
        if (nextTasks) latestTasks = nextTasks;
        continue;
      }

      // 工作台路由将 task 工具结果投影为 data-task-update。
      if (!isTaskUpdatePart(raw)) continue;
      const data = asRecord(raw.data);
      const nextTasks =
        parseTaskItems(data) ??
        parseTaskItems(raw.value) ??
        parseTaskItems(raw.tasks) ??
        parseTaskItems(raw.data);
      if (nextTasks) latestTasks = nextTasks;
    }
  }

  return latestTasks;
}

export function getActiveToolsFromMessages(messages: UIMessage[]): AgentToolState[] {
  const tools = new Map<string, AgentToolState>();
  for (const message of messages) {
    for (const part of message.parts) {
      if (!isToolUIPart(part)) continue;
      const toolName = getToolName(part);
      if (!toolName || toolName.startsWith("agent-")) continue;
      if (part.state === "input-streaming") {
        tools.set(part.toolCallId, {
          toolCallId: part.toolCallId,
          name: toolName,
          status: "streaming_input",
        });
      } else if (part.state === "input-available" || part.state === "approval-requested") {
        tools.set(part.toolCallId, {
          toolCallId: part.toolCallId,
          name: toolName,
          status: "running",
        });
      } else {
        tools.delete(part.toolCallId);
      }
    }
  }
  return [...tools.values()];
}

export function getSubagentsFromMessages(messages: UIMessage[]): AgentSubagentState[] {
  const runs = new Map<string, AgentSubagentState>();
  for (const message of messages) {
    let latestDelegation:
      | {
          agentType: string;
          displayName: string;
          task: string;
        }
      | undefined;
    for (const part of message.parts) {
      if (isToolUIPart(part)) {
        const toolName = getToolName(part);
        if (toolName?.startsWith("agent-")) {
          const agentType = toolName.slice("agent-".length);
          const input = asRecord("input" in part ? part.input : undefined);
          latestDelegation = {
            agentType,
            displayName:
              agentType === "explorer"
                ? "Explorer"
                : agentType === "reviewer"
                  ? "Reviewer"
                  : agentType,
            task: asString(input?.prompt) ?? "委托任务",
          };
        }
        continue;
      }

      const raw = part as unknown as JsonRecord;
      if (raw.type !== "data-tool-agent" && raw.type !== "data-tool-agent-step") continue;
      const data = asRecord(raw.data);
      const runId = asString(raw.id);
      if (!runId) continue;
      const step = asRecord(data?.step);
      const previous = runs.get(runId);
      const agentId = asString(data?.id);
      const agentType =
        latestDelegation?.agentType ??
        (agentId?.startsWith("mastra-work-") ? agentId.slice("mastra-work-".length) : agentId) ??
        previous?.agentType ??
        "subagent";
      const status = raw.type === "data-tool-agent-step" ? step?.status : data?.status;
      const textDelta = asString(data?.text) ?? asString(step?.text) ?? previous?.textDelta;
      runs.set(runId, {
        ...previous,
        agentType,
        displayName: latestDelegation?.displayName ?? previous?.displayName,
        task: latestDelegation?.task ?? previous?.task ?? "委托任务",
        status:
          status === "finished"
            ? "completed"
            : status === "error" || data?.finishReason === "error"
              ? "error"
              : previous?.status === "completed" || previous?.status === "error"
                ? previous.status
                : "running",
        ...(textDelta ? { textDelta } : {}),
      });
    }
  }
  return [...runs.values()];
}

export function areTasksEqual(left: AgentTask[], right: AgentTask[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((task, index) => {
    const other = right[index];
    return (
      task.id === other.id &&
      task.content === other.content &&
      task.activeForm === other.activeForm &&
      task.status === other.status
    );
  });
}

export function getCompletedInteraction(
  messageId: string,
  part: ToolPart,
): AgentInteraction | undefined {
  const toolName = getToolName(part);
  if (toolName !== "ask_user" && toolName !== "submit_plan") return undefined;
  if (part.state !== "output-available") return undefined;

  const input = "input" in part ? part.input : undefined;
  const inputRecord = asRecord(input);
  const output = "output" in part ? part.output : undefined;
  const outputRecord = asRecord(output);
  const suspendPayload =
    toolName === "ask_user"
      ? inputRecord
      : toolName === "submit_plan"
        ? {
            ...(inputRecord ?? {}),
            ...(asString(outputRecord?.title) ? { title: outputRecord?.title } : {}),
            ...(asString(outputRecord?.plan) ? { plan: outputRecord?.plan } : {}),
          }
        : undefined;

  return {
    key: `history:${messageId}:${part.toolCallId}`,
    runId: `history:${messageId}`,
    toolCallId: part.toolCallId,
    toolName,
    input,
    output,
    requiresApproval: false,
    suspendPayload,
    completed: true,
  };
}

export function mergeInteractions(
  messageInteractions: AgentInteraction[],
  persistedInteractions: AgentInteraction[],
): AgentInteraction[] {
  const merged = new Map<string, AgentInteraction>();
  for (const interaction of [...messageInteractions, ...persistedInteractions]) {
    const previous = merged.get(interaction.key);
    merged.set(interaction.key, {
      ...previous,
      ...interaction,
      toolCallId: interaction.toolCallId ?? previous?.toolCallId,
      args: interaction.args ?? previous?.args,
      suspendPayload: interaction.suspendPayload ?? previous?.suspendPayload,
    });
  }
  return [...merged.values()];
}

/**
 * 文本是助手可见回复的边界。两个文本块之间紧邻的推理与工具调用属于同一条执行轨迹,
 * 既保留服务端发送顺序,也不会把最终文本塞进 ChainOfThoughtStep。
 */
export function getAssistantSegments(
  parts: UIMessage["parts"],
  messageId: string,
): AssistantSegment[] {
  const segments: AssistantSegment[] = [];
  let traceParts: TracePart[] = [];

  const flushTrace = () => {
    if (traceParts.length > 0) {
      segments.push({ key: `trace-${segments.length}`, parts: traceParts, type: "trace" });
      traceParts = [];
    }
  };

  parts.forEach((part, index) => {
    const raw = part as unknown as JsonRecord;
    // data-structured-output(联网检索报告)已随服务端 structuredOutput 一并移除,
    // 旧消息里残留的该类 part 直接忽略
    if (raw.type === "data-structured-output") return;

    if (part.type === "text") {
      flushTrace();
      if (part.text) {
        segments.push({ key: `text-${index}`, text: part.text, type: "text" });
      }
      return;
    }

    if (part.type === "reasoning") {
      // 流式进行中、已完成、或有文本内容均纳入 traceParts
      if (part.text || part.state === "done" || part.state === "streaming") {
        traceParts.push(part);
      }
      return;
    }

    if (isToolUIPart(part)) {
      const interaction = getCompletedInteraction(messageId, part);
      if (interaction) {
        flushTrace();
        segments.push({ key: `interaction-${index}`, interaction, type: "interaction" });
        return;
      }
    }

    // task_* 的结果已经实时显示在 PromptInput 上方的 Queue 中,
    // 不再重复塞进消息里的 ChainOfThoughtStep;已完成的 ask_user / submit_plan
    // 通过上方的 interaction segment 在当前助手消息中只读回显。
    if (
      isToolUIPart(part) &&
      !isTaskToolName(getToolName(part)) &&
      !isPromptManagedToolName(getToolName(part))
    ) {
      traceParts.push(part);
    }
  });
  flushTrace();

  return segments;
}

export function getTraceStepStatus(part: TracePart): "active" | "complete" {
  if (part.type === "reasoning") {
    return part.state === "streaming" ? "active" : "complete";
  }

  return part.state === "input-streaming" ||
    part.state === "input-available" ||
    part.state === "approval-requested" ||
    part.state === "approval-responded"
    ? "active"
    : "complete";
}
