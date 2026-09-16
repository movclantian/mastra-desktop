import { requestJson } from "@/shared/api";

export interface AgentSchedule {
  id: string;
  agentId: string;
  name?: string;
  threadId?: string;
  resourceId?: string;
  prompt: string;
  cron: string;
  timezone?: string;
  status: "active" | "paused";
  nextFireAt: number;
  lastFireAt?: number;
  lastRunId?: string;
  metadata?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

type ScheduleInput = {
  agentId: string;
  prompt: string;
  name?: string;
  cron: string;
  timezone?: string;
  threadId?: string;
};

export async function fetchSchedules(): Promise<AgentSchedule[]> {
  const payload = await requestJson<{ schedules?: AgentSchedule[] }>(
    "/work/schedules",
    {},
    "加载已安排任务失败",
  );
  return Array.isArray(payload.schedules) ? payload.schedules : [];
}

export async function createSchedule(input: ScheduleInput): Promise<AgentSchedule> {
  const payload = await requestJson<{ schedule: AgentSchedule }>(
    "/work/schedules",
    { method: "POST", body: input },
    "创建安排失败",
  );
  return payload.schedule;
}

export async function updateSchedule(
  id: string,
  input: Partial<Omit<ScheduleInput, "agentId" | "threadId">>,
): Promise<AgentSchedule> {
  const payload = await requestJson<{ schedule: AgentSchedule }>(
    `/work/schedules/${encodeURIComponent(id)}`,
    { method: "PATCH", body: input },
    "更新安排失败",
  );
  return payload.schedule;
}

async function scheduleAction(id: string, action: "pause" | "resume" | "run") {
  const payload = await requestJson<{ schedule?: AgentSchedule } | { scheduleId: string }>(
    `/work/schedules/${encodeURIComponent(id)}/${action}`,
    { method: "POST" },
    action === "run" ? "立即运行失败" : "更新安排状态失败",
  );
  return "schedule" in payload ? payload.schedule : undefined;
}

export async function pauseSchedule(id: string): Promise<AgentSchedule> {
  const schedule = await scheduleAction(id, "pause");
  if (!schedule) throw new Error("服务端未返回安排");
  return schedule;
}

export async function resumeSchedule(id: string): Promise<AgentSchedule> {
  const schedule = await scheduleAction(id, "resume");
  if (!schedule) throw new Error("服务端未返回安排");
  return schedule;
}

export async function runSchedule(id: string): Promise<void> {
  await scheduleAction(id, "run");
}

export async function deleteSchedule(id: string): Promise<void> {
  await requestJson(
    `/work/schedules/${encodeURIComponent(id)}`,
    { method: "DELETE" },
    "删除安排失败",
  );
}
