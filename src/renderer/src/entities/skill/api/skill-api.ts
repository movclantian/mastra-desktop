import { useQuery } from "@tanstack/react-query";
import { apiFetch, MASTRA_SERVER_URL, requestJson } from "@/shared/api";
import i18n from "@/shared/i18n";
import { apiError, type WorkErrorPayload } from "@/shared/lib";
import type { PluginSkill } from "../../../../../shared/plugin-contract";
import type { McpFormServer, McpSummary } from "../model/types";

export function usePluginSkills(userId?: string) {
  return useQuery({
    queryKey: ["plugin-skills", userId],
    enabled: !!userId,
    queryFn: () =>
      requestJson<{ skills: PluginSkill[] }>(
        "/work/plugins/skills",
        {},
        i18n.t("chat:api.loadSkillsFailed"),
      ).then((result) => result.skills),
  });
}

async function readPayload<T extends object>(response: Response, fallback: string): Promise<T> {
  const payload = (await response.json().catch(() => ({}))) as T & Partial<WorkErrorPayload>;
  if (!response.ok) throw apiError(payload, fallback);
  return payload;
}

export async function fetchMcpServers(): Promise<McpSummary[]> {
  const payload = await readPayload<{ servers?: McpSummary[] }>(
    await apiFetch(`${MASTRA_SERVER_URL}/work/mcp`),
    i18n.t("skills:readMcpFailed"),
  );
  return payload.servers ?? [];
}

export async function setMcpServerEnabled(id: string, enabled: boolean): Promise<void> {
  const server = await getMcpServer(id);
  await readPayload(
    await apiFetch(`${MASTRA_SERVER_URL}/work/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ server: { ...server, enabled } }),
    }),
    i18n.t("skills:updateMcpStatusFailed"),
  );
}

export async function getMcpServer(id: string): Promise<McpFormServer> {
  const payload = await readPayload<{ server?: McpFormServer }>(
    await apiFetch(`${MASTRA_SERVER_URL}/work/mcp/${encodeURIComponent(id)}`),
    i18n.t("skills:getMcpConfigFailed"),
  );
  if (!payload.server) throw new Error(i18n.t("skills:getMcpConfigFailed"));
  return payload.server;
}

export async function deleteMcpServer(id: string): Promise<void> {
  await readPayload(
    await apiFetch(`${MASTRA_SERVER_URL}/work/mcp/${encodeURIComponent(id)}`, { method: "DELETE" }),
    i18n.t("skills:removeMcpFailed"),
  );
}

export async function authenticateMcpServer(id: string): Promise<{
  authorizationUrl?: string;
  authenticated?: boolean;
}> {
  const payload = await readPayload<{
    authorizationUrl?: string;
    authenticated?: boolean;
  }>(
    await apiFetch(`${MASTRA_SERVER_URL}/work/mcp/${encodeURIComponent(id)}/authenticate`, {
      method: "POST",
    }),
    i18n.t("skills:mcpOAuthFailed"),
  );
  return payload;
}
