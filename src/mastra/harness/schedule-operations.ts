import type { Mastra } from "@mastra/core/mastra";
import type { RequestContext } from "@mastra/core/request-context";
import type { AgentSchedule } from "@mastra/core/schedules";
import type { SignalProviderTarget, SignalSubscription } from "@mastra/core/signals";
import { z } from "zod";
import { DEFAULT_AGENT_PROFILE_ID, listAgentProfiles } from "../agents/custom";
import { errorText, WorkApiError, workError } from "../errors";
import { applicationTool } from "../tools/application";
import {
  WORKSPACE_RESOURCE_ID_CONTEXT_KEY,
  WORKSPACE_THREAD_ID_CONTEXT_KEY,
} from "../workspace/workspace-manager";
import { workPollingSignals, workWebhookSignals } from "./signals";

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

export const scheduleInputSchema = z.object({
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
    })
    .optional(),
  status: z.enum(["active", "paused"]).optional(),
});

export const updateScheduleSchema = scheduleInputSchema
  .omit({ id: true, agentId: true, threadId: true })
  .partial();

type Host = Pick<Mastra, "schedules" | "getAgentById">;
export function isOwnedSchedule(schedule: unknown, resourceId: string): schedule is AgentSchedule {
  if (!schedule || typeof schedule !== "object" || !("agentId" in schedule)) return false;
  const item = schedule as AgentSchedule;
  return item.resourceId
    ? item.resourceId === resourceId
    : item.metadata?.ownerResourceId === resourceId;
}
export async function readOwnedSchedule(mastra: Host, resourceId: string, id: string) {
  const schedule = await mastra.schedules.get(id);
  if (!isOwnedSchedule(schedule, resourceId)) throw workError("SCHEDULE_NOT_FOUND");
  return schedule;
}
export async function createOwnedSchedule(
  mastra: Host,
  resourceId: string,
  value: z.infer<typeof scheduleInputSchema>,
  requestContext?: RequestContext,
) {
  const input = scheduleInputSchema.parse(value);
  const profile = (await listAgentProfiles(resourceId)).find((item) => item.id === input.agentId);
  if (!profile?.enabled) throw workError("SCHEDULE_INVALID", { text: "Agent not found" });
  if (input.threadId) {
    const memory = await mastra
      .getAgentById(DEFAULT_AGENT_PROFILE_ID)
      .getMemory({ requestContext });
    const thread = await memory?.getThreadById({ threadId: input.threadId });
    if (!thread || thread.resourceId !== resourceId) throw workError("THREAD_NOT_FOUND");
  }
  const { signalType, ifActive, ifIdle, ...scheduleInput } = input;
  try {
    return await mastra.schedules.create({
      ...scheduleInput,
      agentId: DEFAULT_AGENT_PROFILE_ID,
      ...(input.threadId ? { resourceId, signalType, ifActive, ifIdle } : {}),
      metadata: { profileId: profile.id, ownerResourceId: resourceId },
    });
  } catch (error) {
    if (error instanceof WorkApiError) throw error;
    throw workError("SCHEDULE_INVALID", {
      text: errorText(error, "Invalid schedule"),
      cause: error,
    });
  }
}
export async function updateOwnedSchedule(
  mastra: Host,
  resourceId: string,
  id: string,
  value: z.infer<typeof updateScheduleSchema>,
) {
  const current = await readOwnedSchedule(mastra, resourceId, id);
  const patch = updateScheduleSchema.parse(value);
  try {
    return await mastra.schedules.update(current.id, patch);
  } catch (error) {
    throw workError("SCHEDULE_INVALID", {
      text: errorText(error, "Invalid schedule update"),
      cause: error,
    });
  }
}
const target = z.object({ scheduleId: z.string().trim().min(1) }).strict();
const tools = [
  applicationTool({
    id: "app_read_schedules",
    domain: "schedules",
    description:
      "List your recurring schedules or read one by ID, including status and execution metadata. Read before creating, changing or retrying an operation.",
    inputSchema: z.object({ scheduleId: z.string().min(1).optional() }).strict(),
    execute: async ({ scheduleId }, { mastra, resourceId }) => {
      if (!mastra) throw new Error("Mastra execution context is unavailable");
      return {
        schedules: scheduleId
          ? [await readOwnedSchedule(mastra, resourceId, scheduleId)]
          : (await mastra.schedules.list()).filter((item) => isOwnedSchedule(item, resourceId)),
      };
    },
  }),
  applicationTool({
    id: "app_manage_schedule_create",
    domain: "schedules",
    description:
      "Create an Agent recurring schedule, optionally bound to an owned conversation. List first to avoid duplicates; use an explicit IANA timezone. The schedule will execute its prompt later; creation is not execution.",
    inputSchema: scheduleInputSchema.omit({ providerOptions: true }),
    execute: async (input, { mastra, resourceId, requestContext }) => {
      if (!mastra) throw new Error("Mastra execution context is unavailable");
      return createOwnedSchedule(mastra, resourceId, input, requestContext);
    },
  }),
  applicationTool({
    id: "app_manage_schedule_update",
    domain: "schedules",
    description:
      "Update an existing owned schedule's name, prompt, timing or paused/active status. Read it first; only supplied fields change.",
    inputSchema: target.extend({ patch: updateScheduleSchema.omit({ providerOptions: true }) }),
    execute: async ({ scheduleId, patch }, { mastra, resourceId }) => {
      if (!mastra) throw new Error("Mastra execution context is unavailable");
      return updateOwnedSchedule(mastra, resourceId, scheduleId, patch);
    },
  }),
  applicationTool({
    id: "app_manage_schedule_control",
    domain: "schedules",
    description:
      "Pause, resume or immediately run an owned schedule. A run may start background work; inspect results rather than claiming it has finished.",
    inputSchema: target.extend({ action: z.enum(["pause", "resume", "run"]) }),
    execute: async ({ scheduleId, action }, { mastra, resourceId }) => {
      if (!mastra) throw new Error("Mastra execution context is unavailable");
      await readOwnedSchedule(mastra, resourceId, scheduleId);
      return mastra.schedules[action](scheduleId);
    },
  }),
  applicationTool({
    id: "app_delete_schedule",
    domain: "schedules",
    description:
      "Delete an owned schedule when explicitly requested. Pause it instead if the user only wants to stop future runs temporarily.",
    inputSchema: target,
    execute: async ({ scheduleId }, { mastra, resourceId }) => {
      if (!mastra) throw new Error("Mastra execution context is unavailable");
      await readOwnedSchedule(mastra, resourceId, scheduleId);
      await mastra.schedules.delete(scheduleId);
      return { deleted: true, scheduleId };
    },
  }),
];
export const scheduleApplicationTools = Object.fromEntries(tools.map((tool) => [tool.id, tool]));

function publicSubscription(subscription: SignalSubscription): SignalSubscription {
  const metadata = subscription.metadata as { url?: unknown; headers?: unknown };
  return {
    ...subscription,
    metadata: {
      ...(typeof metadata.url === "string" ? { url: metadata.url } : {}),
      ...(metadata.headers &&
      typeof metadata.headers === "object" &&
      !Array.isArray(metadata.headers)
        ? { headerKeys: Object.keys(metadata.headers as Record<string, unknown>) }
        : {}),
    },
  };
}

function signalTarget(context: {
  requestContext?: { get(key: string): unknown };
}): SignalProviderTarget {
  const resourceId = context.requestContext?.get(WORKSPACE_RESOURCE_ID_CONTEXT_KEY);
  const threadId = context.requestContext?.get(WORKSPACE_THREAD_ID_CONTEXT_KEY);
  if (typeof resourceId !== "string" || typeof threadId !== "string")
    throw new Error("Signal subscriptions require an active thread and resource");
  return { resourceId, threadId };
}

export const signalApplicationTools = {
  app_manage_signal_subscribe: applicationTool({
    domain: "schedules",
    id: "app_manage_signal_subscribe",
    description: "Subscribe the current Agent thread to a webhook or polling signal source.",
    inputSchema: z.object({
      provider: z.enum(["webhook", "polling"]).default("webhook"),
      externalResourceId: z.string().min(1),
      pollUrl: z.string().url().optional(),
    }),
    execute: async ({ provider, externalResourceId, pollUrl }, context) => {
      const target = signalTarget(context);
      if (provider === "polling") {
        if (!pollUrl) throw new Error("pollUrl is required for polling subscriptions");
        return {
          subscription: publicSubscription(
            await workPollingSignals.subscribePersistent(target, externalResourceId, {
              url: pollUrl,
            }),
          ),
        };
      }
      return {
        subscription: publicSubscription(
          await workWebhookSignals.subscribePersistent(target, externalResourceId),
        ),
      };
    },
  }),
  app_manage_signal_unsubscribe: applicationTool({
    domain: "schedules",
    id: "app_manage_signal_unsubscribe",
    description: "Remove a webhook or polling signal subscription from the current thread.",
    inputSchema: z.object({
      provider: z.enum(["webhook", "polling"]).default("webhook"),
      externalResourceId: z.string().min(1),
    }),
    execute: async ({ provider, externalResourceId }, context) => {
      const target = signalTarget(context);
      return {
        removed:
          provider === "polling"
            ? await workPollingSignals.unsubscribePersistent(target, externalResourceId)
            : await workWebhookSignals.unsubscribePersistent(target, externalResourceId),
      };
    },
  }),
  app_read_signal_subscriptions: applicationTool({
    domain: "schedules",
    id: "app_read_signal_subscriptions",
    description: "List signal subscriptions for the current Agent resource.",
    inputSchema: z.object({ provider: z.enum(["webhook", "polling"]).default("webhook") }),
    execute: async ({ provider }, context) => {
      const { resourceId } = signalTarget(context);
      return {
        subscriptions:
          provider === "polling"
            ? (await workPollingSignals.listPersistent(resourceId)).map(publicSubscription)
            : (await workWebhookSignals.listPersistent(resourceId)).map(publicSubscription),
      };
    },
  }),
};
