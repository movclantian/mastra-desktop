import type { BackgroundTask, BackgroundTaskManager } from "@mastra/core/background-tasks";
import { type ContextWithMastra, registerApiRoute } from "@mastra/core/server";
import { streamSSE } from "hono/streaming";
import { workError } from "../../errors";

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
