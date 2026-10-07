import { useQuery } from "@tanstack/react-query";
import { apiFetch, MASTRA_SERVER_URL, requestJson } from "@/shared/api";
import i18n from "@/shared/i18n";
import { apiError, type WorkErrorPayload } from "@/shared/lib";
import type { PluginSkill } from "../../../../../shared/plugin-contract";
import type { CuratedOwner, McpFormServer, McpSummary, SkillMetadata } from "../model/types";

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

export async function fetchCuratedSkillOwners(): Promise<CuratedOwner[]> {
  const response = await apiFetch(`${MASTRA_SERVER_URL}/work/plugins/skills-sh/curated`);
  if (!response.ok) return [];
  const payload = (await response.json()) as { data?: CuratedOwner[] };
  return Array.isArray(payload.data) ? payload.data : [];
}

export interface FetchSkillsShListOptions {
  view?: "all-time" | "trending" | "hot";
  curated?: boolean;
  owner?: string;
  page?: number;
  perPage?: number;
  query?: string;
  refresh?: boolean;
}

export async function fetchSkillsShList(options: FetchSkillsShListOptions = {}): Promise<{
  skills: SkillMetadata[];
  total: number;
  page: number;
  perPage: number;
  hasMore: boolean;
  view?: string;
  curatedOwners?: CuratedOwner[];
}> {
  const params = new URLSearchParams();
  if (options.view) params.set("view", options.view);
  if (options.curated) params.set("curated", "1");
  if (options.owner) params.set("owner", options.owner);
  if (options.page !== undefined) params.set("page", String(options.page));
  if (options.perPage !== undefined) params.set("perPage", String(options.perPage));
  if (options.query) params.set("query", options.query);
  if (options.refresh) params.set("refresh", "1");

  const response = await apiFetch(
    `${MASTRA_SERVER_URL}/work/plugins/skills-sh/list?${params.toString()}`,
  );
  return await readPayload(response, i18n.t("skills:readLeaderboardFailed"));
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
