import { DEFAULT_MASTRA_PORT } from "../../shared/proxy-contract";
/**
 * 持久化 Agent 定时任务路由。
 * 使用官方 schedules.prepare 在触发时创建执行会话；指定会话的安排继续复用该会话。
 */

import type { Mastra } from "@mastra/core/mastra";
import { MASTRA_RESOURCE_ID_KEY, RequestContext } from "@mastra/core/request-context";
import type { SchedulePrepareContext, SchedulePrepareResult } from "@mastra/core/schedules";
import { type ContextWithMastra, registerApiRoute } from "@mastra/core/server";
import { z } from "zod";
import { workbenchSessionId } from "../../shared/agent-contract";
import {
  AGENT_PROFILE_CONTEXT_KEY,
  DEFAULT_AGENT_PROFILE_ID,
  listAgentProfiles,
} from "../agents/custom";
import {
  MODE_ID_CONTEXT_KEY,
  PERMISSION_RULES_CONTEXT_KEY,
  parsePermissionRules,
  resolveMode,
} from "../agents/permissions";
import { SESSION_EXECUTION_CONTEXT_KEY } from "../agents/work-agent";
import { workError } from "../errors";
import {
  createOwnedSchedule,
  isOwnedSchedule,
  readOwnedSchedule,
  scheduleInputSchema,
  updateOwnedSchedule,
  updateScheduleSchema,
} from "../harness/schedule-operations";
import {
  getProvidersConfig,
  REQUEST_MODEL_ID_CONTEXT_KEY,
  resolveDefaultModelId,
  resolveModelSelection,
  splitRouterId,
} from "../models/providers";
import { resolveLibraryFolderScope } from "../rag/storage/folders";
import {
  LIBRARY_FOLDER_CONTEXT_KEY,
  LIBRARY_ORIGIN_CONTEXT_KEY,
  LIBRARY_RESOURCE_CONTEXT_KEY,
  LIBRARY_THREAD_CONTEXT_KEY,
} from "../rag/types";
import { AUTHENTICATED_USER_ID_CONTEXT_KEY } from "../storage/database";
import {
  ensureDirectory,
  implicitThreadWorkspacePath,
  SCHEDULE_RUN_CONTEXT_KEY,
  WORKSPACE_PATH_CONTEXT_KEY,
  WORKSPACE_RESOURCE_ID_CONTEXT_KEY,
  WORKSPACE_THREAD_ID_CONTEXT_KEY,
} from "../workspace/workspace-manager";
import type { ThreadMetadata } from "./threads/shared";

/** Resolve the current thread settings at fire time; persisted schedules contain no runtime handles. */
export async function prepareScheduledRun({
  mastra,
  schedule,
}: Pick<SchedulePrepareContext<Mastra>, "mastra" | "schedule">): Promise<
  SchedulePrepareResult | undefined
> {
  const stored = await mastra.schedules.get(schedule.id);
  if (
    !stored ||
    stored.workflowId !== undefined ||
    typeof stored.metadata?.profileId !== "string"
  ) {
    return undefined;
  }
  const resourceId =
    stored.resourceId ??
    (typeof stored.metadata?.ownerResourceId === "string"
      ? stored.metadata.ownerResourceId
      : undefined);
  if (!resourceId) throw workError("SCHEDULE_INVALID");
  const profileId = stored.metadata.profileId;
  const profile = (await listAgentProfiles(resourceId)).find((item) => item.id === profileId);
  if (!profile?.enabled)
    throw workError("SCHEDULE_INVALID", { text: "安排关联的 Agent 不存在或已停用" });
  const requestContext = new RequestContext();
  requestContext.set(AUTHENTICATED_USER_ID_CONTEXT_KEY, resourceId);
  requestContext.set(MASTRA_RESOURCE_ID_KEY, resourceId);
  const memory = await mastra.getAgentById(DEFAULT_AGENT_PROFILE_ID).getMemory({ requestContext });
  if (!memory) throw new Error("Agent memory is not configured");
  let thread = stored.threadId ? await memory.getThreadById({ threadId: stored.threadId }) : null;
  if (stored.threadId && (!thread || thread.resourceId !== resourceId))
    throw workError("SCHEDULE_THREAD_NOT_FOUND");
  const metadata = (thread?.metadata ?? { currentModeId: "build" }) as ThreadMetadata;
  const folderScope = z.string().min(1).nullish().parse(metadata.libraryFolderId);
  if (folderScope) await resolveLibraryFolderScope(resourceId, folderScope);
  const mode = resolveMode(metadata.currentModeId);
  const modelId = metadata.currentModelId ?? (await resolveDefaultModelId(resourceId, "language"));
  if (!modelId || (await resolveModelSelection(modelId, resourceId))?.model.kind !== "language")
    throw workError("MODEL_NOT_CONFIGURED", { text: "Agent 定时任务需要可用的对话模型" });
  const { providerId } = splitRouterId(modelId);
  const provider = (await getProvidersConfig(resourceId)).providers.find(
    (item) => item.id === providerId,
  );
  const family = provider?.registryId ?? provider?.protocol;
  const effort = metadata.reasoningEffort;
  const reasoning = z
    .enum(["provider-default", "none", "minimal", "low", "medium", "high", "xhigh"])
    .safeParse(effort);
  const execution =
    effort === "max"
      ? family === "anthropic"
        ? { providerOptions: { anthropic: { effort: "max" } } }
        : family === "openai"
          ? { providerOptions: { openai: { reasoningEffort: "max" } } }
          : { modelSettings: { reasoning: "xhigh" } }
      : reasoning.success
        ? { modelSettings: { reasoning: reasoning.data } }
        : {};
  if (!thread) {
    thread = await memory.createThread({
      resourceId,
      title: stored.name?.trim() || "已安排任务",
      metadata: {
        draft: false,
        currentModeId: mode.id,
        currentModelId: modelId,
        agentProfileId: profile.id,
        scheduleId: stored.id,
      },
    });
  }
  const threadId = thread.id;
  const workspacePath =
    metadata.workspacePath ?? (await implicitThreadWorkspacePath(threadId, resourceId));
  ensureDirectory(workspacePath);
  if (!thread.metadata?.workspacePath) {
    await memory.updateThread({
      id: threadId,
      title: thread.title,
      metadata: { ...thread.metadata, workspacePath, workspaceExplicit: false },
    });
  }
  await mastra.schedules.update(stored.id, {
    metadata: { ...stored.metadata, lastThreadId: threadId },
  });
  return {
    threadId,
    resourceId,
    ifIdle: {
      ...stored.ifIdle,
      streamOptions: {
        requestContext: {
          [AUTHENTICATED_USER_ID_CONTEXT_KEY]: resourceId,
          [MASTRA_RESOURCE_ID_KEY]: resourceId,
          [AGENT_PROFILE_CONTEXT_KEY]: profile.id,
          [REQUEST_MODEL_ID_CONTEXT_KEY]: modelId,
          [MODE_ID_CONTEXT_KEY]: mode.id,
          [PERMISSION_RULES_CONTEXT_KEY]: parsePermissionRules(metadata.permissionRules),
          [WORKSPACE_PATH_CONTEXT_KEY]: workspacePath,
          [WORKSPACE_THREAD_ID_CONTEXT_KEY]: threadId,
          [WORKSPACE_RESOURCE_ID_CONTEXT_KEY]: resourceId,
          sessionId: workbenchSessionId(resourceId, threadId),
          [LIBRARY_RESOURCE_CONTEXT_KEY]: resourceId,
          [LIBRARY_THREAD_CONTEXT_KEY]: threadId,
          [LIBRARY_FOLDER_CONTEXT_KEY]: folderScope ?? undefined,
          [LIBRARY_ORIGIN_CONTEXT_KEY]: `http://localhost:${mastra.getServer()?.port ?? DEFAULT_MASTRA_PORT}`,
          [SCHEDULE_RUN_CONTEXT_KEY]: true,
          [SESSION_EXECUTION_CONTEXT_KEY]: execution,
        },
      },
    },
  };
}

function resourceIdFor(c: ContextWithMastra): string {
  const value = c.get("requestContext").get(MASTRA_RESOURCE_ID_KEY);
  if (typeof value !== "string" || !value.trim()) throw workError("AUTH_REQUIRED");
  return value.trim();
}

async function ownedSchedule(c: ContextWithMastra, scheduleId: string) {
  return readOwnedSchedule(c.get("mastra"), resourceIdFor(c), scheduleId);
}

const schedulesListRoute = registerApiRoute("/work/schedules", {
  method: "GET",
  handler: async (c) => {
    const resourceId = resourceIdFor(c);
    const schedules = (await c.get("mastra").schedules.list()).filter((schedule) =>
      isOwnedSchedule(schedule, resourceId),
    );
    return c.json({ schedules });
  },
});

const schedulesCreateRoute = registerApiRoute("/work/schedules", {
  method: "POST",
  handler: async (c) => {
    const resourceId = resourceIdFor(c);
    const parsed = scheduleInputSchema.safeParse(await c.req.json());
    if (!parsed.success) throw workError("SCHEDULE_INVALID");
    const input = parsed.data;
    const schedule = await createOwnedSchedule(
      c.get("mastra"),
      resourceId,
      input,
      c.get("requestContext"),
    );
    return c.json({ schedule }, 201);
  },
});

const schedulesGetRoute = registerApiRoute("/work/schedules/:scheduleId", {
  method: "GET",
  handler: async (c) => c.json({ schedule: await ownedSchedule(c, c.req.param("scheduleId")) }),
});

const schedulesUpdateRoute = registerApiRoute("/work/schedules/:scheduleId", {
  method: "PATCH",
  handler: async (c) => {
    const current = await ownedSchedule(c, c.req.param("scheduleId"));
    const parsed = updateScheduleSchema.safeParse(await c.req.json());
    if (!parsed.success) throw workError("SCHEDULE_INVALID");
    return c.json({
      schedule: await updateOwnedSchedule(
        c.get("mastra"),
        resourceIdFor(c),
        current.id,
        parsed.data,
      ),
    });
  },
});

const schedulesDeleteRoute = registerApiRoute("/work/schedules/:scheduleId", {
  method: "DELETE",
  handler: async (c) => {
    const current = await ownedSchedule(c, c.req.param("scheduleId"));
    await c.get("mastra").schedules.delete(current.id);
    return c.json({ ok: true });
  },
});

const schedulesPauseRoute = registerApiRoute("/work/schedules/:scheduleId/pause", {
  method: "POST",
  handler: async (c) => {
    const current = await ownedSchedule(c, c.req.param("scheduleId"));
    return c.json({ schedule: await c.get("mastra").schedules.pause(current.id) });
  },
});

const schedulesResumeRoute = registerApiRoute("/work/schedules/:scheduleId/resume", {
  method: "POST",
  handler: async (c) => {
    const current = await ownedSchedule(c, c.req.param("scheduleId"));
    return c.json({ schedule: await c.get("mastra").schedules.resume(current.id) });
  },
});

const schedulesRunRoute = registerApiRoute("/work/schedules/:scheduleId/run", {
  method: "POST",
  handler: async (c) => {
    const current = await ownedSchedule(c, c.req.param("scheduleId"));
    const mastra = c.get("mastra");
    // The worker prepares exactly one execution conversation per trigger.
    return c.json(await mastra.schedules.run(current.id));
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
