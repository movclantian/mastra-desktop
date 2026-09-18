import { apiFetch, MASTRA_SERVER_URL } from "@/shared/api";
import i18n from "@/shared/i18n";
import { apiError, type WorkErrorPayload } from "@/shared/lib";
import type {
  CuratedOwner,
  McpFormServer,
  McpSummary,
  SkillDetail,
  SkillMarketplace,
  SkillMetadata,
} from "../model/types";

async function readPayload<T extends object>(response: Response, fallback: string): Promise<T> {
  const payload = (await response.json().catch(() => ({}))) as T & Partial<WorkErrorPayload>;
  if (!response.ok) throw apiError(payload, fallback);
  return payload;
}

export async function fetchInstalledSkills(): Promise<SkillMetadata[]> {
  const payload = await readPayload<{ skills?: SkillMetadata[] }>(
    await apiFetch(`${MASTRA_SERVER_URL}/work/skills`),
    i18n.t("skills:readInstalledSkillsFailed"),
  );
  return payload.skills ?? [];
}

export async function fetchCuratedSkillOwners(): Promise<CuratedOwner[]> {
  const response = await apiFetch(`${MASTRA_SERVER_URL}/work/skills/skills-sh/curated`);
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
    `${MASTRA_SERVER_URL}/work/skills/skills-sh/list?${params.toString()}`,
  );
  return await readPayload(response, i18n.t("skills:readLeaderboardFailed"));
}

export async function fetchRegistrySkills(
  search: string,
  force = false,
): Promise<{ skills: SkillMetadata[]; skillsShError?: string }> {
  const response = await apiFetch(
    `${MASTRA_SERVER_URL}/work/skills/registry?query=${encodeURIComponent(search)}${force ? "&refresh=1" : ""}`,
  );
  const payload = await readPayload<{
    skills?: SkillMetadata[];
    skillsShError?: string;
  }>(response, i18n.t("skills:marketplaceUnavailable"));
  return { skills: payload.skills ?? [], skillsShError: payload.skillsShError };
}

export async function fetchMcpServers(): Promise<McpSummary[]> {
  const payload = await readPayload<{ servers?: McpSummary[] }>(
    await apiFetch(`${MASTRA_SERVER_URL}/work/mcp`),
    i18n.t("skills:readMcpFailed"),
  );
  return payload.servers ?? [];
}

export async function fetchSkillMarketplaces(): Promise<SkillMarketplace[]> {
  const payload = await readPayload<{ marketplaces?: SkillMarketplace[] }>(
    await apiFetch(`${MASTRA_SERVER_URL}/work/skills/marketplaces`),
    i18n.t("skills:readMarketplacesFailed"),
  );
  return payload.marketplaces ?? [];
}

export async function fetchSkillDetail(skill: SkillMetadata): Promise<SkillDetail> {
  const endpoint =
    skill.origin === "marketplace" && skill.marketplaceId && skill.sourcePath
      ? `${MASTRA_SERVER_URL}/work/skills/marketplaces/${encodeURIComponent(skill.marketplaceId)}/skill?path=${encodeURIComponent(skill.sourcePath)}`
      : skill.origin === "skills-sh" && skill.skillsShSource && skill.skillsShSlug
        ? `${MASTRA_SERVER_URL}/work/skills/skills-sh/skill?source=${encodeURIComponent(skill.skillsShSource)}&slug=${encodeURIComponent(skill.skillsShSlug)}`
        : skill.origin === "builtin"
          ? `${MASTRA_SERVER_URL}/work/skills/registry/${encodeURIComponent(skill.sourcePath || skill.name)}`
          : `${MASTRA_SERVER_URL}/work/skills/${encodeURIComponent(skill.name)}`;
  const payload = await readPayload<{ skill?: SkillDetail }>(
    await apiFetch(endpoint),
    i18n.t("skills:readSkillDetailFailed"),
  );
  if (!payload.skill) throw new Error(i18n.t("skills:readSkillDetailFailed"));
  return payload.skill;
}

export async function uploadSkillArchive(file: File): Promise<SkillMetadata> {
  const form = new FormData();
  form.set("archive", file, file.name);
  const payload = await readPayload<{ skill?: SkillMetadata }>(
    await apiFetch(`${MASTRA_SERVER_URL}/work/skills`, { method: "POST", body: form }),
    i18n.t("skills:addFailed"),
  );
  if (!payload.skill) throw new Error(i18n.t("skills:addFailed"));
  return payload.skill;
}

export async function importSkill(source: string): Promise<SkillMetadata> {
  const payload = await readPayload<{ skill?: SkillMetadata }>(
    await apiFetch(`${MASTRA_SERVER_URL}/work/skills/import`, {
      method: "POST",
      body: { source },
    }),
    i18n.t("skills:importFailed"),
  );
  if (!payload.skill) throw new Error(i18n.t("skills:importFailed"));
  return payload.skill;
}

export async function installSkill(skill: SkillMetadata): Promise<SkillMetadata> {
  const response =
    skill.origin === "marketplace" && skill.marketplaceId && skill.sourcePath
      ? await apiFetch(
          `${MASTRA_SERVER_URL}/work/skills/marketplaces/${encodeURIComponent(skill.marketplaceId)}/install`,
          { method: "POST", body: { path: skill.sourcePath } },
        )
      : skill.origin === "skills-sh" && skill.skillsShSource && skill.skillsShSlug
        ? await apiFetch(`${MASTRA_SERVER_URL}/work/skills/skills-sh/install`, {
            method: "POST",
            body: { source: skill.skillsShSource, slug: skill.skillsShSlug },
          })
        : await apiFetch(
            `${MASTRA_SERVER_URL}/work/skills/registry/${encodeURIComponent(skill.sourcePath || skill.name)}/install`,
            { method: "POST" },
          );
  const payload = await readPayload<{ skill?: SkillMetadata }>(
    response,
    i18n.t("skills:installFailed"),
  );
  if (!payload.skill) throw new Error(i18n.t("skills:installFailed"));
  return payload.skill;
}

export async function deleteSkill(name: string): Promise<void> {
  await readPayload(
    await apiFetch(`${MASTRA_SERVER_URL}/work/skills/${encodeURIComponent(name)}`, {
      method: "DELETE",
    }),
    i18n.t("skills:deleteFailed"),
  );
}

export async function updateSkill(
  name: string,
  patch: { description?: string; instructions?: string; enabled?: boolean },
): Promise<SkillDetail> {
  const payload = await readPayload<{ skill?: SkillDetail }>(
    await apiFetch(`${MASTRA_SERVER_URL}/work/skills/${encodeURIComponent(name)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }),
    i18n.t("skills:saveFailed"),
  );
  if (!payload.skill) throw new Error(i18n.t("skills:saveFailed"));
  return payload.skill;
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

export async function saveSkillMarketplace(input: {
  id?: string;
  name: string;
  url: string;
  branch: string;
  enabled: boolean;
}): Promise<void> {
  await readPayload(
    await apiFetch(`${MASTRA_SERVER_URL}/work/skills/marketplaces`, {
      method: "POST",
      body: input,
    }),
    i18n.t("skills:saveMarketplaceFailed"),
  );
}

export async function deleteSkillMarketplace(id: string): Promise<void> {
  await readPayload(
    await apiFetch(`${MASTRA_SERVER_URL}/work/skills/marketplaces/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
    i18n.t("skills:deleteMarketplaceFailed"),
  );
}
