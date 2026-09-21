import { apiFetch, MASTRA_SERVER_URL } from "@/shared/api";
import type { BackgroundTaskState } from "./types";
import { asRecord } from "./types";

const BACKGROUND_TASK_EVENTS = [
  "background-task-started",
  "background-task-running",
  "background-task-completed",
  "background-task-failed",
  "background-task-cancelled",
  "background-task-output",
  "background-task-suspended",
  "background-task-resumed",
  "background-task-timed-out",
] as const;

const STATUS_BY_EVENT: Record<
  (typeof BACKGROUND_TASK_EVENTS)[number],
  BackgroundTaskState["status"]
> = {
  "background-task-started": "running",
  "background-task-running": "running",
  "background-task-output": "running",
  "background-task-completed": "completed",
  "background-task-failed": "failed",
  "background-task-cancelled": "cancelled",
  "background-task-suspended": "suspended",
  "background-task-resumed": "running",
  "background-task-timed-out": "timed_out",
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

  if (
    chunkType === "background-task-started" ||
    chunkType === "background-task-running" ||
    chunkType === "background-task-resumed"
  ) {
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
  const tasks = new Map<string, BackgroundTaskState>();
  const controller = new AbortController();
  let stopped = false;
  let activeReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let retryTimer: number | undefined;
  let finishRetry: (() => void) | undefined;
  let retryDelay = 1000;

  const handleEvent = (data: string) => {
    if (stopped) return;
    try {
      const chunk = JSON.parse(data) as BackgroundTaskChunk;
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

  const consume = async () => {
    const url = `${MASTRA_SERVER_URL}/work/background-tasks/stream?threadId=${encodeURIComponent(threadId)}&resourceId=${encodeURIComponent(resourceId)}`;
    while (!stopped) {
      try {
        const response = await apiFetch(url, { signal: controller.signal });
        if (stopped) {
          await response.body?.cancel().catch(() => undefined);
          return;
        }
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          if (response.status !== 408 && response.status !== 429 && response.status < 500) return;
          throw new Error(`Background task stream HTTP ${response.status}`);
        }
        if (!response.body) return;
        const reader = response.body.getReader();
        activeReader = reader;
        const decoder = new TextDecoder();
        let buffer = "";
        try {
          while (!stopped) {
            const { value, done } = await reader.read();
            if (done || stopped) break;
            retryDelay = 1000;
            buffer += decoder.decode(value, { stream: true });
            const frames = buffer.split(/\r?\n\r?\n/);
            buffer = frames.pop() ?? "";
            for (const frame of frames) {
              const data = frame
                .split(/\r?\n/)
                .filter((line) => line.startsWith("data:"))
                .map((line) => line.slice(5).trimStart())
                .join("\n");
              if (data) handleEvent(data);
            }
          }
        } finally {
          reader.releaseLock();
          activeReader = undefined;
        }
      } catch {
        if (stopped) return;
      }
      if (!stopped) {
        await new Promise<void>((resolve) => {
          finishRetry = resolve;
          retryTimer = window.setTimeout(resolve, retryDelay);
        });
        retryTimer = undefined;
        finishRetry = undefined;
        retryDelay = Math.min(retryDelay * 2, 30_000);
      }
    }
  };
  void consume();
  return () => {
    stopped = true;
    controller.abort();
    void activeReader?.cancel().catch(() => undefined);
    if (retryTimer !== undefined) window.clearTimeout(retryTimer);
    finishRetry?.();
    tasks.clear();
  };
}
