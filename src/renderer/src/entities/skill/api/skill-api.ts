import { apiFetch, MASTRA_SERVER_URL } from "@/shared/api";
import { apiError, type WorkErrorPayload } from "@/shared/lib";
import type {
  CuratedOwner,
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
    "读取已安装技能失败",
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
  return await readPayload(response, "读取技能榜单失败");
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
  }>(response, "技能市场暂时不可用");
  return { skills: payload.skills ?? [], skillsShError: payload.skillsShError };
}

export async function fetchMcpServers(): Promise<McpSummary[]> {
  const payload = await readPayload<{ servers?: McpSummary[] }>(
    await apiFetch(`${MASTRA_SERVER_URL}/work/mcp`),
    "读取 MCP 失败",
  );
  return payload.servers ?? [];
}

export async function fetchSkillMarketplaces(): Promise<SkillMarketplace[]> {
  const payload = await readPayload<{ marketplaces?: SkillMarketplace[] }>(
    await apiFetch(`${MASTRA_SERVER_URL}/work/skills/marketplaces`),
    "读取技能市场失败",
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
    "读取技能详情失败",
  );
  if (!payload.skill) throw new Error("读取技能详情失败");
  return payload.skill;
}

export async function uploadSkillArchive(file: File): Promise<SkillMetadata> {
  const form = new FormData();
  form.set("archive", file, file.name);
  const payload = await readPayload<{ skill?: SkillMetadata }>(
    await apiFetch(`${MASTRA_SERVER_URL}/work/skills`, { method: "POST", body: form }),
    "添加技能失败",
  );
  if (!payload.skill) throw new Error("添加技能失败");
  return payload.skill;
}

export async function importSkill(source: string): Promise<SkillMetadata> {
  const payload = await readPayload<{ skill?: SkillMetadata }>(
    await apiFetch(`${MASTRA_SERVER_URL}/work/skills/import`, {
      method: "POST",
      body: { source },
    }),
    "导入技能失败",
  );
  if (!payload.skill) throw new Error("导入技能失败");
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
  const payload = await readPayload<{ skill?: SkillMetadata }>(response, "安装技能失败");
  if (!payload.skill) throw new Error("安装技能失败");
  return payload.skill;
}

export async function deleteSkill(name: string): Promise<void> {
  await readPayload(
    await apiFetch(`${MASTRA_SERVER_URL}/work/skills/${encodeURIComponent(name)}`, {
      method: "DELETE",
    }),
    "删除技能失败",
  );
}

export async function deleteMcpServer(id: string): Promise<void> {
  await readPayload(
    await apiFetch(`${MASTRA_SERVER_URL}/work/mcp/${encodeURIComponent(id)}`, { method: "DELETE" }),
    "移除 MCP 失败",
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
    "MCP OAuth 授权失败",
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
    "保存技能市场失败",
  );
}

export async function deleteSkillMarketplace(id: string): Promise<void> {
  await readPayload(
    await apiFetch(`${MASTRA_SERVER_URL}/work/skills/marketplaces/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
    "删除技能市场失败",
  );
}
