import { requestJson } from "@/shared/api";
import i18n from "@/shared/i18n";

export interface AgentSchedule {
  id: string;
  agentId: string;
  name?: string;
  threadId?: string;
  resourceId?: string;
  prompt: string;
  cron: string;
  timezone?: string;
  signalType?: "user" | "state" | "reactive" | "notification" | "user-message" | "system-reminder";
  tagName?: string;
  attributes?: Record<string, string | number | boolean | null>;
  providerOptions?: Record<string, unknown>;
  ifActive?: { behavior?: "deliver" | "discard" | "persist" };
  ifIdle?: { behavior?: "discard" | "persist" | "wake" };
  status: "active" | "paused";
  nextFireAt: number;
  lastFireAt?: number;
  lastRunId?: string;
  metadata?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export type ScheduleInput = {
  agentId: string;
  prompt: string;
  name?: string;
  cron: string;
  timezone?: string;
  threadId?: string;
  signalType?: AgentSchedule["signalType"];
  tagName?: string;
  ifActive?: AgentSchedule["ifActive"];
  ifIdle?: AgentSchedule["ifIdle"];
  attributes?: AgentSchedule["attributes"];
  providerOptions?: AgentSchedule["providerOptions"];
};

export type ScheduleUpdateInput = Partial<Omit<ScheduleInput, "agentId" | "threadId">>;

export async function fetchSchedules(): Promise<AgentSchedule[]> {
  const payload = await requestJson<{ schedules?: AgentSchedule[] }>(
    "/work/schedules",
    {},
    i18n.t("schedules:loadFailed"),
  );
  return Array.isArray(payload.schedules) ? payload.schedules : [];
}

export async function createSchedule(input: ScheduleInput): Promise<AgentSchedule> {
  const payload = await requestJson<{ schedule: AgentSchedule }>(
    "/work/schedules",
    { method: "POST", body: input },
    i18n.t("schedules:createFailed"),
  );
  return payload.schedule;
}

export async function updateSchedule(
  id: string,
  input: ScheduleUpdateInput,
): Promise<AgentSchedule> {
  const payload = await requestJson<{ schedule: AgentSchedule }>(
    `/work/schedules/${encodeURIComponent(id)}`,
    { method: "PATCH", body: input },
    i18n.t("schedules:updateFailed"),
  );
  return payload.schedule;
}

async function scheduleAction(id: string, action: "pause" | "resume" | "run") {
  const payload = await requestJson<{ schedule?: AgentSchedule } | { scheduleId: string }>(
    `/work/schedules/${encodeURIComponent(id)}/${action}`,
    { method: "POST" },
    action === "run" ? i18n.t("schedules:runFailed") : i18n.t("schedules:statusUpdateFailed"),
  );
  return "schedule" in payload ? payload.schedule : undefined;
}

export async function pauseSchedule(id: string): Promise<AgentSchedule> {
  const schedule = await scheduleAction(id, "pause");
  if (!schedule) throw new Error(i18n.t("schedules:noScheduleReturned"));
  return schedule;
}

export async function resumeSchedule(id: string): Promise<AgentSchedule> {
  const schedule = await scheduleAction(id, "resume");
  if (!schedule) throw new Error(i18n.t("schedules:noScheduleReturned"));
  return schedule;
}

export async function runSchedule(id: string): Promise<void> {
  await scheduleAction(id, "run");
}

export async function deleteSchedule(id: string): Promise<void> {
  await requestJson(
    `/work/schedules/${encodeURIComponent(id)}`,
    { method: "DELETE" },
    i18n.t("schedules:deleteFailed"),
  );
}
