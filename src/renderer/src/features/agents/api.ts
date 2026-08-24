import { requestJson } from "@/api/client";
import type { AgentProfile } from "@/features/workbench/types";

export async function fetchAgents(): Promise<AgentProfile[]> {
  const payload = await requestJson<{ agents?: AgentProfile[] }>(
    "/work/agents",
    {},
    "加载专家失败",
  );
  return Array.isArray(payload.agents) ? payload.agents : [];
}

export interface AgentAssistDraft {
  displayName?: unknown;
  profession?: unknown;
  description?: unknown;
  instructions?: unknown;
  members?: unknown;
  workflow?: { strategy?: unknown; steps?: unknown };
}

export async function generateAgentAssist(
  type: "agent" | "team",
  description: string,
): Promise<AgentAssistDraft> {
  const payload = await requestJson<{ draft: AgentAssistDraft }>(
    "/work/agents/assist",
    { method: "POST", body: { type, description } },
    "AI 创建失败",
  );
  return payload.draft;
}

export async function saveAgent(payload: Record<string, unknown>): Promise<AgentProfile | null> {
  const result = await requestJson<{ agent?: AgentProfile }>(
    "/work/agents",
    { method: "POST", body: payload },
    "保存 Agent 失败",
  );
  return result.agent ?? null;
}

export async function deleteAgent(id: string): Promise<void> {
  await requestJson<void>(
    `/work/agents/${encodeURIComponent(id)}`,
    { method: "DELETE" },
    "删除 Agent 失败",
  );
}
