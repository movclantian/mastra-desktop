import type { BackgroundTask, BackgroundTaskManager } from "@mastra/core/background-tasks";
import { type ContextWithMastra, registerApiRoute } from "@mastra/core/server";
import { streamSSE } from "hono/streaming";
import { workError } from "../errors";

function managerFor(c: ContextWithMastra): BackgroundTaskManager {
  const manager = c.get("mastra").backgroundTaskManager;
  if (!manager) throw workError("BACKGROUND_TASKS_DISABLED");
  return manager;
}

function resourceIdFor(c: ContextWithMastra): string {
  const resourceId = c.get("requestContext").get("userId");
  if (typeof resourceId !== "string" || !resourceId) throw workError("AUTH_REQUIRED");
  return resourceId;
}

const BACKGROUND_TASK_STATUSES = new Set<BackgroundTask["status"]>([
  "pending",
  "running",
  "suspended",
  "completed",
  "failed",
  "cancelled",
  "timed_out",
]);

function taskStatus(value: string | undefined): BackgroundTask["status"] | undefined {
  return value && BACKGROUND_TASK_STATUSES.has(value as BackgroundTask["status"])
    ? (value as BackgroundTask["status"])
    : undefined;
}

const INTERRUPTED_TASK_MESSAGE =
  "服务已重启，原任务的请求上下文不能安全恢复。为避免使用错误账户、模型或工作区执行，任务已停止；请重新提交。";

async function markInterruptedTaskFailed(
  manager: BackgroundTaskManager,
  task: BackgroundTask,
): Promise<void> {
  if (!["pending", "running", "suspended"].includes(task.status)) return;
  const now = new Date();
  const storage = await manager.getStorage();
  const changed = await storage.updateTask(
    task.id,
    {
      status: "failed",
      error: { message: INTERRUPTED_TASK_MESSAGE },
      completedAt: now,
    },
    { expectedStatus: task.status },
  );
  if (!changed) return;

  manager.deregisterTaskContext(task.id);
  await manager
    .publishLifecycleEvent("task.failed", {
      ...task,
      status: "failed",
      error: { message: INTERRUPTED_TASK_MESSAGE },
      completedAt: now,
    })
    .catch((error) => {
      console.warn("[background-tasks] failed to publish interrupted-task state", {
        taskId: task.id,
        error,
      });
    });
}

/**
 * Mastra persists task payloads, but not the original per-request executor,
 * model selection, workspace, or result-injection callbacks. A registered
 * static executor is not an equivalent replacement for those closures.
 */
export async function ensureTaskExecutorAvailable(
  manager: BackgroundTaskManager,
  task: BackgroundTask,
): Promise<void> {
  if (!["pending", "running", "suspended"].includes(task.status)) return;
  if (manager.taskContexts.has(task.id)) return;
  await markInterruptedTaskFailed(manager, task);
  throw workError("BACKGROUND_TASK_EXECUTOR_UNAVAILABLE", {
    details: { taskId: task.id, toolName: task.toolName, agentId: task.agentId },
  });
}

/** Mark tasks left by a previous process as failed instead of auto-dispatching
 * them through Mastra's context-free static executor registry. */
export async function failInterruptedBackgroundTasksOnStartup(
  manager: BackgroundTaskManager,
): Promise<number> {
  const tasks: BackgroundTask[] = [];
  let page = 0;
  let total = 0;
  do {
    const result = await manager.listTasks({
      status: ["pending", "running", "suspended"],
      page,
      perPage: 100,
    });
    tasks.push(...result.tasks);
    total = result.total;
    page += 1;
  } while (tasks.length < total);

  let failedCount = 0;
  for (const task of tasks) {
    const before = await manager.getTask(task.id);
    if (!before || !["pending", "running", "suspended"].includes(before.status)) continue;
    await markInterruptedTaskFailed(manager, before);
    if ((await manager.getTask(task.id))?.status === "failed") failedCount += 1;
  }
  return failedCount;
}

async function ownedTask(
  c: ContextWithMastra,
  manager: BackgroundTaskManager,
): Promise<BackgroundTask> {
  const taskId = c.req.param("taskId");
  const task = taskId ? await manager.getTask(taskId) : null;
  if (!task || task.resourceId !== resourceIdFor(c)) {
    throw workError("BACKGROUND_TASK_NOT_FOUND");
  }
  return task;
}

export const backgroundTaskListRoute = registerApiRoute("/work/background-tasks", {
  method: "GET",
  handler: async (c) => {
    const manager = managerFor(c);
    const resourceId = resourceIdFor(c);
    const threadId = c.req.query("threadId");
    const rawStatus = c.req.query("status");
    const status = taskStatus(rawStatus);
    if (rawStatus && !status) {
      throw workError("VALIDATION_FAILED", {
        text: `Unsupported background task status: ${rawStatus}`,
      });
    }
    const result = await manager.listTasks({
      resourceId,
      ...(threadId ? { threadId } : {}),
      ...(status ? { status } : {}),
      orderBy: "createdAt",
      orderDirection: "desc",
      perPage: 100,
    });
    return c.json(result);
  },
});

export const backgroundTaskStreamRoute = registerApiRoute("/work/background-tasks/stream", {
  method: "GET",
  handler: async (c) => {
    const manager = managerFor(c);
    const resourceId = resourceIdFor(c);
    const controller = new AbortController();
    const events = manager.stream({
      resourceId,
      threadId: c.req.query("threadId") || undefined,
      abortSignal: controller.signal,
    });
    return streamSSE(c as unknown as Parameters<typeof streamSSE>[0], async (stream) => {
      stream.onAbort(() => controller.abort());
      for await (const event of events) {
        const type = typeof event.type === "string" ? event.type : "background-task";
        await stream.writeSSE({ event: type, data: JSON.stringify(event) });
      }
    });
  },
});

export const backgroundTaskGetRoute = registerApiRoute("/work/background-tasks/:taskId", {
  method: "GET",
  handler: async (c) => c.json(await ownedTask(c, managerFor(c))),
});

export const backgroundTaskResumeRoute = registerApiRoute("/work/background-tasks/:taskId/resume", {
  method: "POST",
  handler: async (c) => {
    const manager = managerFor(c);
    const task = await ownedTask(c, manager);
    await ensureTaskExecutorAvailable(manager, task);
    const body = (await c.req.json().catch(() => ({}))) as { resumeData?: unknown };
    return c.json(await manager.resume(task.id, body.resumeData));
  },
});

export const backgroundTaskRestartRoute = registerApiRoute(
  "/work/background-tasks/:taskId/restart",
  {
    method: "POST",
    handler: async (c) => {
      const manager = managerFor(c);
      const task = await ownedTask(c, manager);
      await ensureTaskExecutorAvailable(manager, task);
      return c.json(await manager.restart(task.id));
    },
  },
);

export const backgroundTaskCancelRoute = registerApiRoute("/work/background-tasks/:taskId/cancel", {
  method: "POST",
  handler: async (c) => {
    const manager = managerFor(c);
    const task = await ownedTask(c, manager);
    await manager.cancel(task.id);
    return c.json({ ok: true, taskId: task.id });
  },
});

export const backgroundTaskRoutes = [
  backgroundTaskStreamRoute,
  backgroundTaskListRoute,
  backgroundTaskResumeRoute,
  backgroundTaskRestartRoute,
  backgroundTaskCancelRoute,
  backgroundTaskGetRoute,
];
