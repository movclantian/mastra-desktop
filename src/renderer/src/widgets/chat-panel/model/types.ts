import {
  type FileUIPart,
  getToolName as getAISDKToolName,
  isToolUIPart,
  type LanguageModelUsage,
  type UIMessage,
} from "ai";
import type { PermissionPolicy, ToolCategory } from "@/entities/workbench";
import { i18n } from "@/shared/i18n";
import type { ToolPart } from "@/shared/ui/ai-elements/tool";

/**
 * 工作台消息 metadata：用户引用随原生用户 signal 一起保存，
 * 助手用量由原生 Session 与历史投影恢复。
 */
export interface WorkMessageMetadata {
  mediaGeneration?: import("../../../../../shared/agent-contract").MediaGenerationState;
  clientMessageId?: string;
  agentProfileId?: string;
  agentDisplayName?: string;
  createdAt?: string;
  teamMemberId?: string;
  goal?: boolean;
  /** 本轮各步累计用量，仅用于计费，不是当前上下文水位。 */
  usage?: LanguageModelUsage;
  contextUsage?: LanguageModelUsage | null;
  contextUsageVersion?: number;
  /** 用户消息:本条消息选中的 skills(发送时随 metadata 附带) */
  skillNames?: string[];
  /** 用户消息:通过 @ 显式引用的资料库文件,发送后恢复为附件卡片 */
  fileReferences?: MessageFileReference[];
  /** 消息表情反应(官方 BubbleReactions),随消息 metadata 持久化 */
  reactions?: MessageReaction[];
}

export interface MessageReaction {
  emoji: string;
  userIds: string[];
}

/** 切换当前用户在某个 emoji 上的反应:不存在则添加,已存在则移除 */
export function toggleMessageReactions(
  reactions: MessageReaction[] | undefined,
  emoji: string,
  userId: string,
): MessageReaction[] {
  const current = reactions ?? [];
  const existing = current.find((reaction) => reaction.emoji === emoji);
  if (!existing) return [...current, { emoji, userIds: [userId] }];
  const userIds = existing.userIds.includes(userId)
    ? existing.userIds.filter((id) => id !== userId)
    : [...existing.userIds, userId];
  return userIds.length === 0
    ? current.filter((reaction) => reaction.emoji !== emoji)
    : current.map((reaction) => (reaction.emoji === emoji ? { ...reaction, userIds } : reaction));
}

export interface MessageFileReference {
  id: string;
  filename: string;
  url: string;
  mediaType?: string;
}

interface WorkspaceLogData {
  workspacePath: string;
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
    "media-generation": import("../../../../../shared/agent-contract").MediaGenerationState;
  }
>;

export type MessagePart = UIMessage["parts"][number];
export type TracePart = Extract<MessagePart, { type: "reasoning" }> | ToolPart;

/** Resumed tool results can omit inputs; replayed pending states must not erase a result. */
export function mergeToolPart(previous: MessagePart | undefined, incoming: ToolPart): ToolPart {
  if (!previous || !isToolUIPart(previous) || previous.toolCallId !== incoming.toolCallId)
    return incoming;
  const latest =
    previous.state.startsWith("output-") && !incoming.state.startsWith("output-")
      ? previous
      : incoming;
  const input = asRecord(latest.input);
  return {
    ...latest,
    terminal: (latest as ToolPart).terminal ?? (previous as ToolPart).terminal,
    input:
      latest.input === undefined || (input && Object.keys(input).length === 0)
        ? (latest === incoming ? previous : incoming).input
        : latest.input,
  };
}

/**
 * A reconnect can replay several snapshots of one tool invocation into the
 * same assistant message. Keep the first position (so reasoning order stays
 * stable), but render only the latest snapshot for each toolCallId. Adjacent
 * reasoning chunks share one step; a tool invocation always separates them.
 */
function normalizeTraceParts(parts: TracePart[]): TracePart[] {
  const result: TracePart[] = [];
  const toolPositions = new Map<string, number>();
  for (const part of parts) {
    if (!isToolUIPart(part)) {
      const previous = result.at(-1);
      if (previous?.type === "reasoning" && part.type === "reasoning") {
        result[result.length - 1] = {
          ...previous,
          text: [previous.text, part.text].filter(Boolean).join("\n\n"),
          state: part.state,
        };
      } else {
        result.push(part);
      }
      continue;
    }
    const toolCallId =
      typeof part.toolCallId === "string" && part.toolCallId.trim().length > 0
        ? part.toolCallId
        : undefined;
    if (!toolCallId) {
      result.push(part);
      continue;
    }
    const position = toolPositions.get(toolCallId);
    if (position === undefined) {
      toolPositions.set(toolCallId, result.length);
      result.push(part);
    } else {
      result[position] = mergeToolPart(result[position], part);
    }
  }
  return result;
}

export type AssistantSegment =
  | { key: string; text: string; type: "text" }
  | { key: string; parts: TracePart[]; type: "trace" }
  | { key: string; interaction: AgentInteraction; type: "interaction" };
/** 子 Agent 派发/状态转场事件,渲染为 Marker 分隔行(官方 group-chat 模式) */

export type JsonRecord = Record<string, unknown>;

export interface AgentTask {
  id: string;
  content: string;
  activeForm: string;
  status: "pending" | "in_progress" | "completed";
}

export type {
  MessageQueueAction,
  QueuedMessage as QueuedRequest,
} from "../../../../../shared/agent-contract";

export type LibraryFilePart = FileUIPart & { byteSize?: number };

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
  completed?: boolean;
  planDecision?: "approved" | "rejected" | "revision" | "unknown";
  /**
   * 该工具的权限类别与生效策略,由服务端算好后随会话 display-state
   * 下发(类别映射只在 src/mastra/agents/permissions.ts 保留一份)。
   * 原生审批事件触发重新读取该快照，运行未结束时也可响应。
   */
  category?: ToolCategory;
  policy?: PermissionPolicy;
}

export interface GoalObjective {
  id?: string;
  objective: string;
  status: "active" | "paused" | "done";
  runsUsed: number;
  maxRuns?: number;
  activeDurationMs?: number;
  pausedReason?: string;
  startedAt: number;
  updatedAt: number;
}

export interface WorkDisplayState {
  teamInvocations?: import("../../../../../shared/agent-contract").TeamInvocation[];
  objective?: GoalObjective | null;
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
    "timed-out": "timed_out",
    timed_out: "timed_out",
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

const TASK_TOOL_NAMES = new Set(["task_write", "task_update", "task_complete", "task_check"]);
const PROMPT_MANAGED_TOOL_NAMES = new Set(["ask_user", "submit_plan"]);

function isTaskToolName(toolName: string | undefined): boolean {
  return toolName !== undefined && TASK_TOOL_NAMES.has(toolName);
}

function isPromptManagedToolName(toolName: string | undefined): boolean {
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

/**
 * Task snapshots are replaceable state, not an append-only event log.  A
 * reconnect or a duplicated data-task-update may therefore contain the same
 * task id more than once.  Keep the first position (stable layout) and the
 * latest value (current status), so renderers never receive duplicate React
 * keys during a long tool run.
 */
export function normalizeAgentTasks(tasks: AgentTask[]): AgentTask[] {
  const latest = new Map<string, AgentTask>();
  const order: string[] = [];
  for (const task of tasks) {
    if (!latest.has(task.id)) order.push(task.id);
    latest.set(task.id, task);
  }
  return order.flatMap((id) => {
    const task = latest.get(id);
    return task ? [task] : [];
  });
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
        activeForm: asString(item?.activeForm) ?? i18n.t("chat:panels.inProgress"),
        status,
      } satisfies AgentTask,
    ];
  });
  return normalizeAgentTasks(tasks);
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

function getCompletedInteraction(messageId: string, part: ToolPart): AgentInteraction | undefined {
  const toolName = getToolName(part);
  if (toolName !== "ask_user" && toolName !== "submit_plan") return undefined;
  if (part.state !== "output-available") return undefined;

  const input = "input" in part ? part.input : undefined;
  const inputRecord = asRecord(input);
  const output = "output" in part ? part.output : undefined;
  const outputRecord = asRecord(output);
  const submittedPlan = asRecord(outputRecord?.submittedPlan);
  const planContent = asString(outputRecord?.content) ?? "";
  const planDecision =
    planContent === "Plan approved. Proceed with implementation following the approved plan."
      ? "approved"
      : planContent.startsWith("Plan was not approved. The user wants revisions.")
        ? "revision"
        : planContent.startsWith("Plan was not approved.")
          ? "rejected"
          : "unknown";
  const suspendPayload =
    toolName === "ask_user"
      ? inputRecord
      : toolName === "submit_plan"
        ? {
            ...(inputRecord ?? {}),
            ...(submittedPlan ?? {}),
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
    ...(toolName === "submit_plan" ? { planDecision } : {}),
  };
}

/**
 * 文本是助手可见回复的边界。两个文本块之间紧邻的推理与工具调用属于同一条执行轨迹,
 * 既保留服务端发送顺序,也不会把最终文本塞进 ChainOfThoughtStep。
 *
 * 子 Agent 的完整只读会话由成员面板展示,不伪造父消息中的工具输出。
 */
export function getAssistantSegments(
  parts: UIMessage["parts"],
  messageId: string,
): AssistantSegment[] {
  const segments: AssistantSegment[] = [];
  let traceParts: TracePart[] = [];
  const commandExits = new Map(
    parts.flatMap((part) => {
      const record = part as unknown as JsonRecord;
      const data = asRecord(record.data);
      return part.type === "data-workspace-log" &&
        typeof record.id === "string" &&
        typeof data?.exitCode === "number"
        ? [[record.id, data.exitCode] as const]
        : [];
    }),
  );

  const flushTrace = () => {
    if (traceParts.length > 0) {
      segments.push({
        key: `trace-${segments.length}`,
        parts: normalizeTraceParts(traceParts),
        type: "trace",
      });
      traceParts = [];
    }
  };

  parts.forEach((part, index) => {
    if (part.type === "text") {
      if (part.text) {
        flushTrace();
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

    // Queue shows current task state; the trace retains the calls that changed it.
    // Completed prompt interactions are rendered separately above.
    if (
      isToolUIPart(part) &&
      part.state !== "approval-requested" &&
      !isPromptManagedToolName(getToolName(part))
    ) {
      const exitCode = commandExits.get(part.toolCallId);
      traceParts.push(
        exitCode === undefined
          ? part
          : {
              ...part,
              terminal: {
                ...(part as ToolPart).terminal,
                output: (part as ToolPart).terminal?.output ?? "",
                exitCode,
              },
            },
      );
    }
  });
  flushTrace();

  return segments;
}

export function getTraceStepStatus(part: TracePart): "active" | "complete" {
  if (part.type === "reasoning") {
    return part.state === "streaming" ? "active" : "complete";
  }

  if (
    part.state === "output-denied" ||
    (part.state === "approval-responded" && part.approval.approved === false)
  )
    return "complete";

  return (part.state === "output-available" && part.preliminary === true) ||
    part.state === "input-streaming" ||
    part.state === "input-available" ||
    part.state === "approval-requested" ||
    part.state === "approval-responded"
    ? "active"
    : "complete";
}

export function getToolTraceState(part: ToolPart, isStreaming: boolean) {
  const name = getToolName(part);
  const output = "output" in part ? part.output : undefined;
  // Mastra's command tool returns text, with a final exit-code line on failure.
  const exitCode =
    part.terminal?.exitCode ??
    (name === "mastra_workspace_execute_command" && typeof output === "string"
      ? Number(/(?:^|\n)Exit code: (-?\d+)\s*$/.exec(output)?.[1] ?? 0)
      : undefined);
  const denied =
    part.state === "output-denied" ||
    (part.state === "approval-responded" && part.approval.approved === false);
  const pending = getTraceStepStatus(part) === "active";
  const unfinished = !isStreaming && pending && part.state !== "approval-requested";
  const failed =
    part.state === "output-error" ||
    (name === "execute_typescript" && asRecord(output)?.success === false) ||
    (exitCode !== undefined && exitCode !== 0) ||
    (name === "mastra_workspace_execute_command" &&
      part.terminal?.exitCode === undefined &&
      typeof output === "string" &&
      /(?:^|\n)Error: [^\n]+\s*$/.test(output)) ||
    unfinished;
  return { active: isStreaming && pending && !failed, denied, failed, unfinished, exitCode };
}

export function withTerminalEvent(
  parts: WorkUIMessage["parts"],
  event: { toolCallId: string } & (
    | { type: "shell_output"; output: string }
    | { type: "command_exit"; exitCode: number }
  ),
): WorkUIMessage["parts"] {
  return parts.map((part) => {
    if (!isToolUIPart(part) || part.toolCallId !== event.toolCallId) return part;
    const previous = (part as ToolPart).terminal ?? { output: "" };
    // shortcut: preview keeps the last 65536 characters; raise for longer previews, full logs stay archived.
    const terminal =
      event.type === "shell_output"
        ? { ...previous, output: (previous.output + event.output).slice(-64 * 1024) }
        : { ...previous, exitCode: event.exitCode };
    return { ...part, terminal };
  });
}
