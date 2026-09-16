/**
 * 持久化 Agent 定时任务路由。
 * 直接调用官方 `mastra.schedules` 服务。安排始终绑定用户线程，
 * 这样每次触发都能继承用户模型、Workspace 和护栏 RequestContext。
 */

import { MASTRA_RESOURCE_ID_KEY } from "@mastra/core/request-context";
import type {
  AgentSchedule,
  CreateAgentScheduleInput,
  UpdateAgentScheduleInput,
} from "@mastra/core/schedules";
import { type ContextWithMastra, registerApiRoute } from "@mastra/core/server";
import { z } from "zod";
import {
  DEFAULT_AGENT_PROFILE_ID,
  ensureProfileAgentsRegistered,
  listAgentProfiles,
} from "../agents/custom";
import { errorText, workError } from "../errors";
import {
  ensureDirectory,
  implicitThreadWorkspacePath,
  WORKSPACE_PATH_CONTEXT_KEY,
  WORKSPACE_RESOURCE_ID_CONTEXT_KEY,
  WORKSPACE_THREAD_ID_CONTEXT_KEY,
} from "../workspace";
import { getOwnedThread, getWorkMemoryForThread } from "./threads/shared";

const signalTypes = [
  "user",
  "state",
  "reactive",
  "notification",
  "user-message",
  "system-reminder",
] as const;

const attributesSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean(), z.null()]),
);

const scheduleInputSchema = z.object({
  id: z.string().trim().min(1).max(120).optional(),
  agentId: z.string().trim().min(1).max(160),
  prompt: z.string().trim().min(1).max(20_000),
  name: z.string().trim().max(120).optional(),
  cron: z.string().trim().min(1).max(120),
  timezone: z.string().trim().max(120).optional(),
  threadId: z.string().trim().min(1).optional(),
  signalType: z.enum(signalTypes).optional(),
  tagName: z.string().trim().max(80).optional(),
  attributes: attributesSchema.optional(),
  providerOptions: z.record(z.string(), z.unknown()).optional(),
  ifActive: z
    .object({
      behavior: z.enum(["deliver", "discard", "persist"]).optional(),
      attributes: attributesSchema.optional(),
    })
    .optional(),
  ifIdle: z
    .object({
      behavior: z.enum(["discard", "persist", "wake"]).optional(),
      attributes: attributesSchema.optional(),
      streamOptions: z
        .object({ requestContext: z.record(z.string(), z.unknown()).optional() })
        .optional(),
    })
    .optional(),
  status: z.enum(["active", "paused"]).optional(),
});

const updateScheduleSchema = scheduleInputSchema
  .omit({ id: true, agentId: true, threadId: true })
  .partial();

type ScheduleView = AgentSchedule;

function resourceIdFor(c: ContextWithMastra): string {
  const value = c.get("requestContext").get(MASTRA_RESOURCE_ID_KEY);
  if (typeof value !== "string" || !value.trim()) throw workError("AUTH_REQUIRED");
  return value.trim();
}

function isOwnedSchedule(schedule: unknown, resourceId: string): schedule is ScheduleView {
  if (!schedule || typeof schedule !== "object" || !("agentId" in schedule)) return false;
  const candidate = schedule as ScheduleView;
  const owner = candidate.metadata?.ownerResourceId;
  return candidate.resourceId === resourceId || owner === resourceId;
}

async function resolveAgentId(c: ContextWithMastra, requestedId: string, resourceId: string) {
  const mastra = c.get("mastra");
  const profile = (await listAgentProfiles(resourceId)).find((item) => item.id === requestedId);
  if (!profile) throw workError("SCHEDULE_INVALID", { text: "Agent not found" });
  if (profile.id === DEFAULT_AGENT_PROFILE_ID) return DEFAULT_AGENT_PROFILE_ID;
  const registration = await ensureProfileAgentsRegistered(mastra, profile, resourceId);
  return registration.profile.id;
}

async function ownedSchedule(c: ContextWithMastra, scheduleId: string): Promise<ScheduleView> {
  const schedule = await c.get("mastra").schedules.get(scheduleId);
  if (!isOwnedSchedule(schedule, resourceIdFor(c))) throw workError("SCHEDULE_NOT_FOUND");
  return schedule;
}

export const schedulesListRoute = registerApiRoute("/work/schedules", {
  method: "GET",
  handler: async (c) => {
    const resourceId = resourceIdFor(c);
    const schedules = (await c.get("mastra").schedules.list()).filter((schedule) =>
      isOwnedSchedule(schedule, resourceId),
    );
    return c.json({ schedules });
  },
});

export const schedulesCreateRoute = registerApiRoute("/work/schedules", {
  method: "POST",
  handler: async (c) => {
    const resourceId = resourceIdFor(c);
    const parsed = scheduleInputSchema.safeParse(await c.req.json());
    if (!parsed.success) throw workError("SCHEDULE_INVALID");
    const input = parsed.data;
    const memory = await getWorkMemoryForThread(
      c.get("requestContext"),
      input.threadId ?? "",
      resourceId,
    );
    let createdThread = false;
    const thread = input.threadId
      ? await getOwnedThread(memory, input.threadId, resourceId)
      : await memory.createThread({
          resourceId,
          title: input.name?.trim() || "已安排任务",
          metadata: { draft: false },
        });
    createdThread = !input.threadId;
    if (!thread) throw workError("THREAD_NOT_FOUND");
    const threadId = thread.id;
    const workspacePath =
      typeof thread.metadata?.workspacePath === "string" && thread.metadata.workspacePath.trim()
        ? thread.metadata.workspacePath.trim()
        : implicitThreadWorkspacePath(threadId, resourceId);
    ensureDirectory(workspacePath);
    const agentId = await resolveAgentId(c, input.agentId, resourceId);
    const metadata = { profileId: input.agentId };
    const ifIdle = {
      ...(input.ifIdle ?? {}),
      streamOptions: {
        ...(input.ifIdle?.streamOptions ?? {}),
        requestContext: {
          ...(input.ifIdle?.streamOptions?.requestContext ?? {}),
          [WORKSPACE_PATH_CONTEXT_KEY]: workspacePath,
          [WORKSPACE_THREAD_ID_CONTEXT_KEY]: threadId,
          [WORKSPACE_RESOURCE_ID_CONTEXT_KEY]: resourceId,
          [MASTRA_RESOURCE_ID_KEY]: resourceId,
        },
      },
    };
    try {
      const schedule = await c.get("mastra").schedules.create({
        ...input,
        agentId,
        threadId,
        resourceId,
        metadata,
        ...(input.ifActive ? { ifActive: input.ifActive } : {}),
        ifIdle,
      } satisfies CreateAgentScheduleInput);
      return c.json({ schedule }, 201);
    } catch (error) {
      if (createdThread) await memory.deleteThread(thread.id).catch(() => undefined);
      throw workError("SCHEDULE_INVALID", {
        text: errorText(error, "创建定时任务失败"),
        cause: error,
      });
    }
  },
});

export const schedulesGetRoute = registerApiRoute("/work/schedules/:scheduleId", {
  method: "GET",
  handler: async (c) => c.json({ schedule: await ownedSchedule(c, c.req.param("scheduleId")) }),
});

export const schedulesUpdateRoute = registerApiRoute("/work/schedules/:scheduleId", {
  method: "PATCH",
  handler: async (c) => {
    const current = await ownedSchedule(c, c.req.param("scheduleId"));
    const parsed = updateScheduleSchema.safeParse(await c.req.json());
    if (!parsed.success) throw workError("SCHEDULE_INVALID");
    const patch = parsed.data;
    if (current.threadId) {
      const storedPath =
        current.ifIdle?.streamOptions?.requestContext?.[WORKSPACE_PATH_CONTEXT_KEY];
      const workspacePath =
        typeof storedPath === "string" && storedPath.trim()
          ? storedPath.trim()
          : implicitThreadWorkspacePath(current.threadId, current.resourceId);
      ensureDirectory(workspacePath);
      const requestedIfIdle = patch.ifIdle ?? current.ifIdle ?? {};
      patch.ifIdle = {
        ...requestedIfIdle,
        streamOptions: {
          ...(requestedIfIdle.streamOptions ?? {}),
          requestContext: {
            ...(requestedIfIdle.streamOptions?.requestContext ?? {}),
            [WORKSPACE_PATH_CONTEXT_KEY]: workspacePath,
            [WORKSPACE_THREAD_ID_CONTEXT_KEY]: current.threadId,
            [WORKSPACE_RESOURCE_ID_CONTEXT_KEY]: current.resourceId,
          },
        },
      };
    }
    try {
      const schedule = await c
        .get("mastra")
        .schedules.update(current.id, patch satisfies UpdateAgentScheduleInput);
      return c.json({ schedule });
    } catch (error) {
      throw workError("SCHEDULE_INVALID", {
        text: errorText(error, "更新定时任务失败"),
        cause: error,
      });
    }
  },
});

export const schedulesDeleteRoute = registerApiRoute("/work/schedules/:scheduleId", {
  method: "DELETE",
  handler: async (c) => {
    const current = await ownedSchedule(c, c.req.param("scheduleId"));
    await c.get("mastra").schedules.delete(current.id);
    return c.json({ ok: true });
  },
});

export const schedulesPauseRoute = registerApiRoute("/work/schedules/:scheduleId/pause", {
  method: "POST",
  handler: async (c) => {
    const current = await ownedSchedule(c, c.req.param("scheduleId"));
    return c.json({ schedule: await c.get("mastra").schedules.pause(current.id) });
  },
});

export const schedulesResumeRoute = registerApiRoute("/work/schedules/:scheduleId/resume", {
  method: "POST",
  handler: async (c) => {
    const current = await ownedSchedule(c, c.req.param("scheduleId"));
    return c.json({ schedule: await c.get("mastra").schedules.resume(current.id) });
  },
});

export const schedulesRunRoute = registerApiRoute("/work/schedules/:scheduleId/run", {
  method: "POST",
  handler: async (c) => {
    const current = await ownedSchedule(c, c.req.param("scheduleId"));
    return c.json(await c.get("mastra").schedules.run(current.id));
  },
});

export const scheduleRoutes = [
  schedulesListRoute,
  schedulesCreateRoute,
  schedulesGetRoute,
  schedulesUpdateRoute,
  schedulesDeleteRoute,
  schedulesPauseRoute,
  schedulesResumeRoute,
  schedulesRunRoute,
];
