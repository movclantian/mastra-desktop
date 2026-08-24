import { MASTRA_SERVER_URL } from "@/api/client";
import type { BackgroundTaskState } from "./types";
import { asRecord } from "./types";

const BACKGROUND_TASK_EVENTS = [
  "background-task-running",
  "background-task-completed",
  "background-task-failed",
  "background-task-cancelled",
  "background-task-output",
  "background-task-suspended",
  "background-task-resumed",
] as const;

const STATUS_BY_EVENT: Record<
  (typeof BACKGROUND_TASK_EVENTS)[number],
  BackgroundTaskState["status"]
> = {
  "background-task-running": "running",
  "background-task-output": "running",
  "background-task-completed": "completed",
  "background-task-failed": "failed",
  "background-task-cancelled": "cancelled",
  "background-task-suspended": "suspended",
  "background-task-resumed": "running",
};

interface BackgroundTaskChunk {
  type?: unknown;
  payload?: unknown;
}

function taskFromChunk(
  chunkType: (typeof BACKGROUND_TASK_EVENTS)[number],
  chunk: BackgroundTaskChunk,
  previous?: BackgroundTaskState,
): BackgroundTaskState | null {
  const payload = asRecord(chunk.payload);
  if (!payload || typeof payload.taskId !== "string") return null;

  const task: BackgroundTaskState = {
    ...(previous ?? {}),
    id: payload.taskId,
    status: STATUS_BY_EVENT[chunkType],
    toolName:
      typeof payload.toolName === "string"
        ? payload.toolName
        : (previous?.toolName ?? "background task"),
    toolCallId:
      typeof payload.toolCallId === "string"
        ? payload.toolCallId
        : (previous?.toolCallId ?? payload.taskId),
    agentId: typeof payload.agentId === "string" ? payload.agentId : (previous?.agentId ?? ""),
    runId: typeof payload.runId === "string" ? payload.runId : (previous?.runId ?? ""),
    ...(payload.result !== undefined ? { result: payload.result } : {}),
    ...(payload.error && typeof payload.error === "object"
      ? { error: payload.error as BackgroundTaskState["error"] }
      : {}),
    ...(payload.suspendPayload !== undefined ? { suspendPayload: payload.suspendPayload } : {}),
    ...(typeof payload.retryCount === "number" ? { retryCount: payload.retryCount } : {}),
    ...(typeof payload.maxRetries === "number" ? { maxRetries: payload.maxRetries } : {}),
    ...(typeof payload.timeoutMs === "number" ? { timeoutMs: payload.timeoutMs } : {}),
    ...(typeof payload.startedAt === "string" ? { startedAt: payload.startedAt } : {}),
    ...(typeof payload.suspendedAt === "string" ? { suspendedAt: payload.suspendedAt } : {}),
    ...(typeof payload.completedAt === "string" ? { completedAt: payload.completedAt } : {}),
    ...(chunkType === "background-task-output" && payload.payload !== undefined
      ? { output: asRecord(payload.payload)?.payload ?? payload.payload }
      : {}),
  };

  if (chunkType === "background-task-running" || chunkType === "background-task-resumed") {
    task.error = undefined;
    task.suspendPayload = undefined;
  } else if (chunkType === "background-task-completed") {
    task.error = undefined;
    task.suspendPayload = undefined;
  } else if (chunkType === "background-task-failed" || chunkType === "background-task-cancelled") {
    task.result = undefined;
  }

  return task;
}

export function subscribeBackgroundTaskStream(
  threadId: string,
  resourceId: string,
  onEvent: (task: BackgroundTaskState) => void,
): () => void {
  const source = new EventSource(
    `${MASTRA_SERVER_URL}/work/background-tasks/stream?threadId=${encodeURIComponent(threadId)}&resourceId=${encodeURIComponent(resourceId)}`,
  );
  const tasks = new Map<string, BackgroundTaskState>();

  const handleEvent = (event: Event) => {
    try {
      const chunk = JSON.parse((event as MessageEvent).data) as BackgroundTaskChunk;
      const chunkType = typeof chunk.type === "string" ? chunk.type : "";
      if (!(BACKGROUND_TASK_EVENTS as readonly string[]).includes(chunkType)) return;
      const task = taskFromChunk(
        chunkType as (typeof BACKGROUND_TASK_EVENTS)[number],
        chunk,
        asRecord(chunk.payload)?.taskId
          ? tasks.get(asRecord(chunk.payload)?.taskId as string)
          : undefined,
      );
      if (!task) return;
      tasks.set(task.id, task);
      onEvent(task);
    } catch {
      // The display-state snapshot remains authoritative after malformed events.
    }
  };

  for (const eventType of BACKGROUND_TASK_EVENTS) source.addEventListener(eventType, handleEvent);
  return () => {
    for (const eventType of BACKGROUND_TASK_EVENTS) {
      source.removeEventListener(eventType, handleEvent);
    }
    source.close();
  };
}
