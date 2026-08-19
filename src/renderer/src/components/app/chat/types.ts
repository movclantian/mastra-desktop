import type { FileUIPart, LanguageModelUsage, UIMessage } from "ai";
import type { ToolPart } from "@/components/ai-elements/tool";
import type { PermissionPolicy, ToolCategory } from "@/lib/session-policy";

/**
 * 本项目的助手消息 metadata:与服务端 chat 路由的 messageMetadata 一一对应
 * (src/mastra/server/routes/chat.ts 的 WorkMessageMetadata)。
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

export type WorkUIMessage = UIMessage<WorkMessageMetadata>;

export interface MessageBranchVersion {
  id: string;
  role: "user" | "assistant";
  createdAt: string;
  message: WorkUIMessage;
  /** 父子配对版本 id:切换本侧分支时,另一侧分支同步切到该版本。 */
  pairVersionId?: string;
}

export interface MessageBranchRecord {
  rootId: string;
  currentVersionId: string;
  versions: MessageBranchVersion[];
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
  /** true when the text was accepted by Agent.queueMessage */
  signalAccepted?: boolean;
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
   * 该工具的权限类别与生效策略,由服务端算好后随 /work/threads/:id/suspended-runs
   * 下发(类别映射只在 src/mastra/agents/permissions.ts 保留一份)。
   * 流式期间出现的审批还没有这两个字段,等本轮结束读取挂起列表时合并进来 ——
   * 审批按钮在流结束前本就是禁用态,不影响操作。
   */
  category?: ToolCategory;
  policy?: PermissionPolicy;
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

export function getToolName(part: MessagePart): string | undefined {
  if (part.type === "dynamic-tool") return part.toolName;
  return part.type.startsWith("tool-") ? part.type.slice("tool-".length) : undefined;
}

export function getPlanDraft(messages: UIMessage[], path?: string): PlanDraft | undefined {
  for (const message of messages) {
    for (const part of message.parts) {
      if (!isToolPart(part) || getToolName(part) !== "write_plan_draft") continue;
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
      if (!isToolPart(part)) continue;
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
      if (isToolPart(part) && isTaskToolName(getToolName(part))) {
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

export function isToolPart(part: MessagePart): part is ToolPart {
  return part.type === "dynamic-tool" || part.type.startsWith("tool-");
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
      // 持久化后的 Responses reasoning 可能只有加密 provider metadata,
      // text 为空；仍保留这一步，ReasoningContent 会明确提示摘要不可显示，
      // 不把数据库里真实存在的 reasoning 静默丢掉。
      if (part.text || part.state === "done") traceParts.push(part);
      return;
    }

    if (isToolPart(part)) {
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
      isToolPart(part) &&
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
    part.state === "approval-requested"
    ? "active"
    : "complete";
}
