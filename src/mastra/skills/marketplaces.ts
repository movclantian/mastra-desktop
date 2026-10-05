/**
 * 技能市场(docs/en/docs/skills.mdx):GitHub 仓库形式的技能来源,
 * 配置存 app_config(key = "skill-marketplaces"),安装 = 检出 SKILL.md 目录。
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { validateSkillContent } from "@mastra/core/skills";
import matter from "gray-matter";
import { getAppConfig, setAppConfig } from "../storage/database";
import { getManagedSkillsDirectory } from "../workspace/workspace-manager";

export function categorizeSkillResources(resources: string[]) {
  const references: string[] = [];
  const scripts: string[] = [];
  const assets: string[] = [];

  const scriptExts = new Set([
    ".py",
    ".sh",
    ".bash",
    ".js",
    ".ts",
    ".mjs",
    ".cjs",
    ".ps1",
    ".bat",
    ".cmd",
    ".rb",
    ".go",
    ".rs",
    ".lua",
    ".php",
  ]);
  const docExts = new Set([
    ".md",
    ".txt",
    ".pdf",
    ".rst",
    ".doc",
    ".docx",
    ".html",
    ".htm",
    ".markdown",
  ]);
  const assetExts = new Set([
    ".png",
    ".jpg",
    ".jpeg",
    ".svg",
    ".gif",
    ".webp",
    ".json",
    ".yaml",
    ".yml",
    ".toml",
    ".csv",
    ".tsv",
    ".xml",
    ".css",
  ]);

  for (const item of resources) {
    const normalized = item.replaceAll("\\", "/").replace(/^\/+/, "");
    if (!normalized || normalized.toUpperCase() === "SKILL.MD") continue;
    const lower = normalized.toLowerCase();
    const ext = extname(lower);

    if (
      lower.startsWith("references/") ||
      lower.startsWith("docs/") ||
      lower.startsWith("reference/") ||
      lower.startsWith("doc/")
    ) {
      references.push(normalized);
    } else if (
      lower.startsWith("scripts/") ||
      lower.startsWith("script/") ||
      lower.startsWith("bin/") ||
      lower.startsWith("tools/") ||
      scriptExts.has(ext)
    ) {
      scripts.push(normalized);
    } else if (
      lower.startsWith("assets/") ||
      lower.startsWith("asset/") ||
      lower.startsWith("images/") ||
      lower.startsWith("image/") ||
      lower.startsWith("templates/") ||
      lower.startsWith("template/") ||
      assetExts.has(ext)
    ) {
      assets.push(normalized);
    } else if (docExts.has(ext)) {
      references.push(normalized);
    } else {
      assets.push(normalized);
    }
  }

  return {
    references: Array.from(new Set(references)),
    scripts: Array.from(new Set(scripts)),
    assets: Array.from(new Set(assets)),
  };
}

interface SkillMarketplace {
  id: string;
  name: string;
  url: string;
  branch: string;
  path?: string;
  enabled: boolean;
}

export interface MarketplaceSkill {
  name: string;
  path: string;
  description: string;
  license?: string;
  metadata?: Record<string, unknown>;
  marketplaceId: string;
  marketplaceName: string;
  sourceUrl: string;
  sourcePath: string;
  branch: string;
}

export interface SkillAuditItem {
  provider: string;
  slug: string;
  status: "pass" | "warn" | "fail" | string;
  summary: string;
  auditedAt?: string;
  riskLevel?: "NONE" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" | string;
  categories?: string[];
}

export interface SkillAuditResponse {
  id: string;
  source: string;
  slug: string;
  audits: SkillAuditItem[];
}

export interface CuratedOwner {
  owner: string;
  totalInstalls: number;
  featuredRepo?: string;
  featuredSkill?: string;
  skills: SkillsShSkill[];
}

export interface CuratedResponse {
  data: CuratedOwner[];
  totalOwners: number;
  totalSkills: number;
  generatedAt?: string;
}

export interface SkillsShSkill {
  id: string;
  slug: string;
  name: string;
  source: string;
  installs: number;
  sourceType: "github" | "well-known";
  installUrl?: string | null;
  url?: string;
  isDuplicate?: boolean;
  description?: string;
  change?: number;
  installsYesterday?: number;
  isOfficial?: boolean;
  owner?: string;
}

export interface SkillsShSkillDetail extends SkillsShSkill {
  hash?: string;
  files: Array<{ path: string; contents: Buffer }>;
  instructions: string;
  references: string[];
  scripts: string[];
  assets: string[];
  sourceUrl: string;
  audits?: SkillAuditItem[];
}

export interface SkillsShQueryOptions {
  view?: "all-time" | "trending" | "hot";
  curated?: boolean;
  owner?: string;
  page?: number;
  perPage?: number;
  query?: string;
  force?: boolean;
}

export interface SkillsShListResult {
  skills: SkillsShSkill[];
  total: number;
  page: number;
  perPage: number;
  hasMore: boolean;
  view?: string;
  curatedOwners?: CuratedOwner[];
}

const MARKETPLACES_KEY = "skill-marketplaces";
const DEFAULT_BRANCH = "main";
/**
 * skills.sh 列表缓存有效期。
 *
 * 取 24 小时:社区技能目录不是高频变动的数据,而这份列表要打一次远端往返,
 * 短 TTL 只是在反复付延迟。代价是新技能上架当天可能看不到 —— 所以技能中心的
 * 刷新按钮走 force 路径直接穿透缓存(见 listSkillsShSkills 的 force 参数)。
 */
const SKILLS_SH_CACHE_TTL = 24 * 60 * 60 * 1000;
const SKILLS_SH_MAX_RETRIES = 3;
const SKILLS_SH_MAX_FILES = 2_000;
const SKILLS_SH_MAX_BYTES = 25 * 1024 * 1024;

interface CacheEntry<T> {
  expiresAt: number;
  value: T;
}

function createCachedFetcher<TInput, TResult>(
  loader: (input: TInput) => Promise<TResult>,
  keyOf: (input: TInput) => string,
  options: { ttl: number },
): (input: TInput, force?: boolean) => Promise<TResult> {
  const cache = new Map<string, CacheEntry<TResult>>();
  const inFlight = new Map<string, Promise<TResult>>();
  return async (input, force = false) => {
    const cacheKey = keyOf(input);
    const cached = cache.get(cacheKey);
    if (!force && cached && cached.expiresAt > Date.now()) return cached.value;

    const pending = inFlight.get(cacheKey);
    if (pending) return pending;

    const request = loader(input).then((value) => {
      const entry = { expiresAt: Date.now() + options.ttl, value };
      cache.set(cacheKey, entry);
      return value;
    });

    inFlight.set(cacheKey, request);
    try {
      return await request;
    } finally {
      if (inFlight.get(cacheKey) === request) inFlight.delete(cacheKey);
    }
  };
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function parseGithubRepository(value: string): {
  owner: string;
  repo: string;
  branch: string;
  path: string;
} {
  const trimmed = value.trim().replace(/\.git$/, "");
  const ssh = trimmed.match(/^git@github\.com:([^/]+)\/([^/]+)$/i);
  if (ssh) return { owner: ssh[1], repo: ssh[2], branch: DEFAULT_BRANCH, path: "" };
  const url = new URL(trimmed);
  if (url.hostname.toLowerCase() !== "github.com")
    throw new Error("技能市场目前只支持 GitHub 仓库地址");
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 2) throw new Error("GitHub 地址必须包含 owner/repository");
  let branch = DEFAULT_BRANCH;
  let path = "";
  if (parts[2] === "tree" && parts[3]) {
    branch = parts[3];
    path = parts.slice(4).join("/");
  }
  return { owner: parts[0], repo: parts[1], branch, path };
}

function repositoryUrl(marketplace: SkillMarketplace) {
  const repository = parseGithubRepository(marketplace.url);
  return { ...repository, path: marketplace.path ?? repository.path };
}

function normalizeRepositoryPath(value: string): string {
  const normalized = value
    .trim()
    .replaceAll("\\", "/")
    .replace(/^\/+|\/+$/g, "");
  if (normalized.split("/").includes("..")) throw new Error("技能市场路径无效");
  return normalized;
}

function validateSkillPath(sourcePath: string, configuredPath?: string): string {
  const normalized = normalizeRepositoryPath(sourcePath);
  if (!normalized || !/(^|\/)SKILL\.md$/i.test(normalized)) {
    throw new Error("市场技能必须指向 SKILL.md");
  }
  if (
    configuredPath &&
    normalized !== configuredPath &&
    !normalized.startsWith(`${configuredPath}/`)
  ) {
    throw new Error("技能路径不属于配置的技能市场目录");
  }
  return normalized;
}

export function normalizeMarketplace(input: unknown): SkillMarketplace {
  if (!input || typeof input !== "object") throw new Error("技能市场配置无效");
  const raw = input as Record<string, unknown>;
  const url = typeof raw.url === "string" ? raw.url.trim() : "";
  const repository = parseGithubRepository(url);
  const name =
    typeof raw.name === "string" && raw.name.trim()
      ? raw.name.trim()
      : `${repository.owner}/${repository.repo}`;
  const id =
    typeof raw.id === "string" && raw.id.trim()
      ? slug(raw.id)
      : slug(`${repository.owner}-${repository.repo}`);
  if (!id) throw new Error("技能市场 ID 无效");
  return {
    id,
    name,
    url: `https://github.com/${repository.owner}/${repository.repo}`,
    branch:
      typeof raw.branch === "string" && raw.branch.trim() ? raw.branch.trim() : repository.branch,
    path:
      typeof raw.path === "string" && raw.path.trim()
        ? normalizeRepositoryPath(raw.path)
        : repository.path || undefined,
    enabled: raw.enabled !== false,
  };
}

export async function getSkillMarketplaces(resourceId?: string): Promise<SkillMarketplace[]> {
  const raw = await getAppConfig(MARKETPLACES_KEY, resourceId);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as { marketplaces?: unknown };
    if (!Array.isArray(parsed.marketplaces)) return [];
    return parsed.marketplaces.map(normalizeMarketplace);
  } catch {
    return [];
  }
}

export async function saveSkillMarketplaces(
  marketplaces: SkillMarketplace[],
  resourceId?: string,
): Promise<void> {
  const normalized = marketplaces.map(normalizeMarketplace);
  if (new Set(normalized.map((marketplace) => marketplace.id)).size !== normalized.length) {
    throw new Error("技能市场 ID 不能重复");
  }
  await setAppConfig(
    MARKETPLACES_KEY,
    JSON.stringify({ marketplaces: normalized }, null, 2),
    resourceId,
  );
}

export function parseSkillMarkdown(content: string, directoryName?: string) {
  const result = validateSkillContent({ content, directoryName });
  const fields = result.metadata ?? {};
  return {
    name: typeof fields.name === "string" ? fields.name : (directoryName ?? ""),
    description: typeof fields.description === "string" ? fields.description : "未提供描述",
    enabled: result.valid && matter(content).data.enabled !== false,
    license: typeof fields.license === "string" ? fields.license : undefined,
    metadata:
      fields.metadata && typeof fields.metadata === "object" && !Array.isArray(fields.metadata)
        ? (fields.metadata as Record<string, unknown>)
        : undefined,
    instructions: result.instructions ?? content,
    validationErrors: result.errors,
  };
}

const GITHUB_JSON_HEADERS = {
  Accept: "application/vnd.github+json",
  "User-Agent": "MastraWork-Skill-Marketplace",
};
const GITHUB_TEXT_HEADERS = {
  Accept: "application/vnd.github.raw",
  "User-Agent": "MastraWork-Skill-Marketplace",
};
const PUBLIC_SKILL_HEADERS = {
  Accept: "text/markdown, text/plain;q=0.9",
  "User-Agent": "MastraWork-Skill-Marketplace",
};
const SKILLS_SH_HEADERS = {
  Accept: "application/json",
  "User-Agent": "MastraWork-Skill-Marketplace",
};

interface FetchWithRetryOptions {
  headers: Record<string, string>;
  responseType: "json" | "text" | "bytes";
  retries?: number;
  retryOn?: (response: Response) => boolean;
  retryDelay?: (response: Response, attempt: number) => number;
  errorMessage: (status: number) => string;
}

const SKILLS_SH_JSON_OPTIONS: FetchWithRetryOptions = {
  headers: SKILLS_SH_HEADERS,
  responseType: "json",
  retries: SKILLS_SH_MAX_RETRIES,
  retryOn: (response) => response.status === 429,
  retryDelay: (response, attempt) => {
    const retryAfter = Number(response.headers.get("Retry-After"));
    return Number.isFinite(retryAfter) && retryAfter > 0
      ? Math.min(30_000, retryAfter * 1_000)
      : Math.min(8_000, 500 * 2 ** attempt);
  },
  errorMessage: (status) =>
    status === 429
      ? "skills.sh 公共目录请求被限流，请稍后重试"
      : `skills.sh 公共目录请求失败（${status}）`,
};

async function fetchWithRetry<T>(url: string, options: FetchWithRetryOptions): Promise<T> {
  const retries = options.retries ?? 0;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const response = await fetch(url, {
      headers: options.headers,
      signal: AbortSignal.timeout(10_000),
    });
    if (response.ok) {
      if (options.responseType === "bytes") {
        const chunks: Uint8Array[] = [];
        let size = 0;
        if (!response.body) throw new Error("技能文件响应为空");
        for await (const chunk of response.body) {
          size += chunk.byteLength;
          if (size > SKILLS_SH_MAX_BYTES) throw new Error("技能文件过大");
          chunks.push(chunk);
        }
        return Buffer.concat(chunks) as T;
      }
      return (options.responseType === "json" ? await response.json() : await response.text()) as T;
    }
    if (!options.retryOn?.(response) || attempt === retries) {
      throw new Error(options.errorMessage(response.status));
    }
    const delayMs = options.retryDelay?.(response, attempt) ?? 500 * 2 ** attempt;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error(options.errorMessage(500));
}

function normalizeSkillsShCoordinate(value: string, label: string): string {
  const normalized = value
    .trim()
    .replaceAll("\\", "/")
    .replace(/^\/+|\/+$/g, "");
  const pattern =
    label === "source"
      ? /^[a-zA-Z0-9][a-zA-Z0-9._-]*(?:\/[a-zA-Z0-9][a-zA-Z0-9._-]*)?$/
      : /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
  if (!normalized || normalized.length > 180 || !pattern.test(normalized)) {
    throw new Error(`skills.sh ${label} 无效`);
  }
  return normalized;
}

const KNOWN_OFFICIAL_OWNERS = new Set([
  "anthropics",
  "vercel-labs",
  "supabase",
  "prisma",
  "cloudflare",
  "expo",
  "open.feishu.cn",
  "heygen-com",
  "binance",
  "duckdb",
  "resend",
  "triggerdotdev",
  "mastra-ai",
  "modelcontextprotocol",
  "docker",
  "stripe",
  "redis",
  "mongodb",
  "google-deepmind",
  "github",
  "huggingface",
  "openai",
  "skills-101",
]);

function normalizeSkillsShEntry(input: unknown): SkillsShSkill | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as Record<string, unknown>;
  const source = typeof raw.source === "string" ? raw.source.trim() : "";
  const slugValue =
    typeof raw.slug === "string"
      ? raw.slug.trim()
      : typeof raw.skillId === "string"
        ? raw.skillId.trim()
        : "";
  if (!source || !slugValue) return null;
  try {
    const normalizedSource = normalizeSkillsShCoordinate(source, "source");
    const normalizedSlug = normalizeSkillsShCoordinate(slugValue, "skill");
    const installs = Number(raw.installs);
    const validInstalls = Number.isFinite(installs) ? Math.max(0, Math.round(installs)) : 0;
    const sourceType =
      raw.sourceType === "well-known" || !normalizedSource.includes("/") ? "well-known" : "github";

    const owner =
      typeof raw.owner === "string" && raw.owner.trim()
        ? raw.owner.trim()
        : normalizedSource.split("/")[0] || undefined;
    const isOfficial =
      raw.isOfficial === true || (owner ? KNOWN_OFFICIAL_OWNERS.has(owner.toLowerCase()) : false);
    return {
      id:
        typeof raw.id === "string" && raw.id.trim()
          ? raw.id.trim()
          : `${normalizedSource}/${normalizedSlug}`,
      slug: normalizedSlug,
      name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : normalizedSlug,
      source: normalizedSource,
      installs: validInstalls,
      sourceType,
      installUrl:
        typeof raw.installUrl === "string"
          ? raw.installUrl
          : normalizedSource.includes("/")
            ? `https://github.com/${normalizedSource}`
            : null,
      url: typeof raw.url === "string" ? raw.url : undefined,
      isDuplicate: raw.isDuplicate === true,
      description: typeof raw.description === "string" ? raw.description : undefined,
      change:
        typeof raw.change === "number" && Number.isFinite(raw.change) ? raw.change : undefined,
      installsYesterday:
        typeof raw.installsYesterday === "number" && Number.isFinite(raw.installsYesterday)
          ? raw.installsYesterday
          : undefined,
      owner,
      isOfficial,
    };
  } catch {
    return null;
  }
}

let curatedCacheData: CuratedResponse | null = null;
let curatedCacheExpiresAt = 0;

export async function getSkillsShCurated(force = false): Promise<CuratedResponse> {
  if (!force && curatedCacheData && curatedCacheExpiresAt > Date.now()) {
    return curatedCacheData;
  }

  // 1. 并发拉取前 4 页基础全时榜，筛选其中的官方技能与创作者
  const pages = await Promise.all(
    [0, 1, 2, 3].map((page) => fetchSkillsShLeaderboardPage("all-time", page, 50)),
  );
  const baseSkills = pages.flatMap((page) => page.skills);

  // 2. 统计/聚合官方及知名厂商
  const ownerMap = new Map<string, { totalInstalls: number; skills: SkillsShSkill[] }>();
  for (const skill of baseSkills) {
    const ownerName = skill.owner || skill.source.split("/")[0];
    if (!ownerName) continue;
    const entry = ownerMap.get(ownerName) || { totalInstalls: 0, skills: [] };
    entry.totalInstalls += skill.installs || 0;
    entry.skills.push(skill);
    ownerMap.set(ownerName, entry);
  }

  const owners: CuratedOwner[] = Array.from(ownerMap.entries())
    .map(([owner, info]) => {
      const isOfficial = KNOWN_OFFICIAL_OWNERS.has(owner.toLowerCase());
      const sortedSkills = info.skills.sort((a, b) => b.installs - a.installs);
      return {
        owner,
        totalInstalls: info.totalInstalls,
        featuredSkill: sortedSkills[0]?.name,
        featuredRepo: sortedSkills[0]?.source,
        skills: sortedSkills.map((s) => ({
          ...s,
          isOfficial: s.isOfficial || isOfficial,
          owner,
        })),
      };
    })
    .filter((o) => KNOWN_OFFICIAL_OWNERS.has(o.owner.toLowerCase()) || o.skills.length > 1)
    .sort((a, b) => {
      const aOfficial = KNOWN_OFFICIAL_OWNERS.has(a.owner.toLowerCase());
      const bOfficial = KNOWN_OFFICIAL_OWNERS.has(b.owner.toLowerCase());
      if (aOfficial && !bOfficial) return -1;
      if (!aOfficial && bOfficial) return 1;
      return b.totalInstalls - a.totalInstalls;
    });

  const result: CuratedResponse = {
    data: owners,
    totalOwners: owners.length,
    totalSkills: owners.reduce((acc, o) => acc + o.skills.length, 0),
    generatedAt: new Date().toISOString(),
  };

  curatedCacheData = result;
  curatedCacheExpiresAt = Date.now() + SKILLS_SH_CACHE_TTL;
  return result;
}

export async function getSkillsShAudit(source: string, slug: string): Promise<SkillAuditItem[]> {
  const normalizedSource = normalizeSkillsShCoordinate(source, "source");
  const normalizedSlug = normalizeSkillsShCoordinate(slug, "skill");
  const endpoints = [
    `https://skills.sh/api/v1/skills/audit/${normalizedSource}/${normalizedSlug}`,
    `https://skills.sh/api/skills/audit/${normalizedSource}/${normalizedSlug}`,
  ];
  for (const endpoint of endpoints) {
    try {
      const res = await fetchWithRetry<SkillAuditResponse>(endpoint, SKILLS_SH_JSON_OPTIONS);
      if (res && Array.isArray(res.audits)) {
        return res.audits;
      }
    } catch {
      // try next
    }
  }
  return [];
}

function getSkillsShQueryCacheKey(options: SkillsShQueryOptions): string {
  const view = options.view || "all-time";
  const curated = options.curated ? "1" : "0";
  const owner = (options.owner || "").toLowerCase();
  const page = options.page || 0;
  const perPage = options.perPage || 50;
  const query = (options.query || "").trim().toLowerCase();
  return `${view}:${curated}:${owner}:${page}:${perPage}:${query}`;
}

function filterSkills(skills: SkillsShSkill[], owner?: string, query?: string): SkillsShSkill[] {
  const normalizedOwner = owner?.trim().toLowerCase();
  const normalizedQuery = query?.trim().toLowerCase();
  return skills.filter((skill) => {
    if (
      normalizedOwner &&
      skill.owner?.toLowerCase() !== normalizedOwner &&
      !skill.source.toLowerCase().startsWith(`${normalizedOwner}/`)
    ) {
      return false;
    }
    if (!normalizedQuery) return true;
    return (
      skill.name.toLowerCase().includes(normalizedQuery) ||
      skill.source.toLowerCase().includes(normalizedQuery) ||
      (skill.description ?? "").toLowerCase().includes(normalizedQuery)
    );
  });
}

function sortSkills(view: SkillsShQueryOptions["view"], skills: SkillsShSkill[]): SkillsShSkill[] {
  return [...skills].sort((a, b) => {
    if (view === "trending") return (b.change ?? 0) - (a.change ?? 0);
    if (view === "hot") return (b.installsYesterday ?? 0) - (a.installsYesterday ?? 0);
    return b.installs - a.installs;
  });
}

function paginateSkills(
  skills: SkillsShSkill[],
  page: number,
  perPage: number,
  view: string,
  curatedOwners?: CuratedOwner[],
): SkillsShListResult {
  const total = skills.length;
  const start = page * perPage;
  return {
    skills: skills.slice(start, start + perPage),
    total,
    page,
    perPage,
    hasMore: start + perPage < total,
    view,
    ...(curatedOwners ? { curatedOwners } : {}),
  };
}

interface SkillsShFetchedPage {
  skills: SkillsShSkill[];
  total?: number;
  page?: number;
  perPage?: number;
  hasMore?: boolean;
}

async function fetchSkillsShLeaderboardPage(
  view: string,
  page: number,
  perPage: number,
): Promise<SkillsShFetchedPage> {
  const result = await fetchWithRetry<{
    data?: unknown[];
    pagination?: { page: number; perPage: number; total: number; hasMore: boolean };
  }>(
    `https://skills.sh/api/v1/skills?view=${view}&page=${page}&per_page=${perPage}`,
    SKILLS_SH_JSON_OPTIONS,
  );
  if (!Array.isArray(result.data)) throw new Error("skills.sh 榜单响应无效");
  return {
    skills: result.data
      .map(normalizeSkillsShEntry)
      .filter((skill): skill is SkillsShSkill => Boolean(skill)),
    ...result.pagination,
  };
}

async function executeListSkillsShSkillsWithOptions(
  options: SkillsShQueryOptions = {},
): Promise<SkillsShListResult> {
  const { view = "all-time", curated = false, owner, page = 0, perPage = 50, query = "" } = options;

  const normalizedQuery = query.trim();

  // 1. 如果请求的是官方精选 (Curated / Official)
  if (curated) {
    if (owner) {
      // 指定具体厂商: 优先走官方 search API 直接查询该厂商全量技能
      const searchUrl = `https://skills.sh/api/search?q=${encodeURIComponent(owner)}&limit=100`;
      const payload = await fetchWithRetry<{ skills?: unknown[] }>(
        searchUrl,
        SKILLS_SH_JSON_OPTIONS,
      );
      const skills = filterSkills(
        (payload.skills ?? [])
          .map(normalizeSkillsShEntry)
          .filter((s): s is SkillsShSkill => Boolean(s)),
        owner,
        normalizedQuery,
      );
      return paginateSkills(sortSkills("all-time", skills), page, perPage, "curated");
    }

    // 未指定具体厂商 (即点击 "⭐ 原厂认证" 根分类):
    const curatedData = await getSkillsShCurated(options.force);
    const allOfficialSkills = curatedData.data.flatMap((o) => o.skills);
    const filtered = filterSkills(allOfficialSkills, undefined, normalizedQuery);
    const seen = new Set<string>();
    const deduped: SkillsShSkill[] = [];
    for (const skill of filtered) {
      if (!seen.has(skill.id)) {
        seen.add(skill.id);
        deduped.push(skill);
      }
    }
    return paginateSkills(
      sortSkills("all-time", deduped),
      page,
      perPage,
      "curated",
      curatedData.data,
    );
  }

  // 2. 如果包含搜索关键词
  if (normalizedQuery.length >= 2) {
    const searchUrl = `https://skills.sh/api/search?q=${encodeURIComponent(normalizedQuery)}&limit=200${owner ? `&owner=${encodeURIComponent(owner)}` : ""}`;
    const payload = await fetchWithRetry<{ skills?: unknown[] }>(searchUrl, SKILLS_SH_JSON_OPTIONS);
    const skills = filterSkills(
      (payload.skills ?? [])
        .map(normalizeSkillsShEntry)
        .filter((skill): skill is SkillsShSkill => Boolean(skill)),
      owner,
      normalizedQuery,
    );
    return paginateSkills(skills, page, perPage, view);
  }

  // 3. 榜单查询 (view: all-time | trending | hot)
  const viewPath = view === "trending" ? "trending" : view === "hot" ? "hot" : "all-time";
  const fetchedPage = await fetchSkillsShLeaderboardPage(viewPath, page, perPage);
  const skills = filterSkills(fetchedPage.skills, owner, normalizedQuery);
  return {
    skills,
    total: fetchedPage.total ?? skills.length,
    page: fetchedPage.page ?? page,
    perPage: fetchedPage.perPage ?? perPage,
    hasMore: fetchedPage.hasMore ?? skills.length >= perPage,
    view,
  };
}

const cachedSkillsShOptions = createCachedFetcher(
  executeListSkillsShSkillsWithOptions,
  getSkillsShQueryCacheKey,
  { ttl: SKILLS_SH_CACHE_TTL },
);

export async function listSkillsShSkillsWithOptions(
  options: SkillsShQueryOptions = {},
): Promise<SkillsShListResult> {
  return cachedSkillsShOptions(options, options.force);
}

export async function listSkillsShSkills(query = "", force = false): Promise<SkillsShSkill[]> {
  return (await listSkillsShSkillsWithOptions({ query: query.trim(), perPage: 200, force })).skills;
}

function normalizeSkillsShFilePath(path: string): string {
  const normalized = path.trim().replaceAll("\\", "/");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    normalized.includes(":") ||
    normalized.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error("skills.sh 技能文件路径无效");
  }
  return normalized;
}

function skillsShSourceUrl(source: string, slugValue: string): string {
  return `https://skills.sh/${source}/${slugValue}`;
}

function parseSkillsShSnapshot(
  source: string,
  slugValue: string,
  payload: unknown,
): SkillsShSkillDetail {
  const base = normalizeSkillsShEntry({
    ...(payload as Record<string, unknown>),
    source,
    slug: slugValue,
  });
  if (!base) throw new Error("skills.sh 技能元数据无效");
  const raw = payload as Record<string, unknown>;
  const files = Array.isArray(raw.files)
    ? raw.files.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const file = item as Record<string, unknown>;
        if (
          typeof file.path !== "string" ||
          (!Buffer.isBuffer(file.contents) && typeof file.contents !== "string")
        )
          return [];
        return [
          {
            path: normalizeSkillsShFilePath(file.path),
            contents: Buffer.isBuffer(file.contents)
              ? file.contents
              : Buffer.from(file.contents, "utf8"),
          },
        ];
      })
    : [];
  if (files.length === 0 || files.length > SKILLS_SH_MAX_FILES) {
    throw new Error("skills.sh 技能文件数量无效");
  }
  const totalBytes = files.reduce((sum, file) => sum + file.contents.byteLength, 0);
  if (totalBytes > SKILLS_SH_MAX_BYTES) throw new Error("skills.sh 技能包过大");
  const skillFiles = files.filter((file) => basename(file.path).toUpperCase() === "SKILL.MD");
  if (skillFiles.length !== 1) throw new Error("skills.sh 技能必须恰好包含一个 SKILL.md");
  const skillFile = skillFiles[0];
  const parent = dirname(skillFile.path).replaceAll("\\", "/");
  const prefix = parent === "." ? "" : `${parent}/`;
  const resources = files
    .filter((file) => file.path !== skillFile.path && (!prefix || file.path.startsWith(prefix)))
    .map((file) => file.path.slice(prefix.length))
    .filter((file) => Boolean(file) && basename(file).toUpperCase() !== "SKILL.MD");
  const markdown = skillFile.contents.toString("utf8");
  const parsed = parseSkillMarkdown(markdown);
  const { references, scripts, assets } = categorizeSkillResources(resources);
  return {
    ...base,
    hash: typeof raw.hash === "string" ? raw.hash : undefined,
    files,
    references,
    scripts,
    assets,
    sourceUrl: skillsShSourceUrl(source, slugValue),
    ...parsed,
  };
}

export async function getSkillsShSkillDetail(
  source: string,
  slugValue: string,
): Promise<SkillsShSkillDetail> {
  const normalizedSource = normalizeSkillsShCoordinate(source, "source");
  const normalizedSlug = normalizeSkillsShCoordinate(slugValue, "skill");
  const auditsPromise = getSkillsShAudit(normalizedSource, normalizedSlug).catch(() => []);
  if (!normalizedSource.includes("/")) {
    const baseUrl = `https://${normalizedSource}`;
    let instructions: string | undefined;
    for (const path of [
      `/.well-known/agent-skills/${encodeURIComponent(normalizedSlug)}/SKILL.md`,
      `/.well-known/skills/${encodeURIComponent(normalizedSlug)}/SKILL.md`,
    ]) {
      try {
        instructions = await fetchWithRetry<string>(`${baseUrl}${path}`, {
          headers: PUBLIC_SKILL_HEADERS,
          responseType: "text",
          errorMessage: (status) => `读取远程技能文件失败（${status}）`,
        });
        break;
      } catch {
        // Try the other well-known convention before reporting an unavailable skill.
      }
    }
    if (instructions === undefined) throw new Error("无法读取该 well-known 技能的 SKILL.md");
    const detail = parseSkillsShSnapshot(normalizedSource, normalizedSlug, {
      source: normalizedSource,
      slug: normalizedSlug,
      sourceType: "well-known",
      installUrl: baseUrl,
      files: [{ path: "SKILL.md", contents: instructions }],
    });
    detail.audits = await auditsPromise;
    return detail;
  }
  if (normalizedSource.split("/").length !== 2) {
    throw new Error("该 skills.sh 技能没有可用的公开 GitHub 快照");
  }
  const [owner, repo] = normalizedSource.split("/");
  const { default_branch: branch } = await fetchWithRetry<{ default_branch: string }>(
    `https://api.github.com/repos/${owner}/${repo}`,
    {
      headers: GITHUB_JSON_HEADERS,
      responseType: "json",
      errorMessage: (status) => `GitHub 请求失败（${status}）`,
    },
  );
  const tree = await fetchWithRetry<{ tree?: GitTreeItem[]; truncated?: boolean }>(
    `https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
    {
      headers: GITHUB_JSON_HEADERS,
      responseType: "json",
      errorMessage: (status) => `GitHub 请求失败（${status}）`,
    },
  );
  if (tree.truncated) throw new Error("GitHub 技能目录不完整，无法安装");
  const candidates = (tree.tree ?? []).filter(
    (item) => item.type === "blob" && /(^|\/)SKILL\.md$/i.test(item.path),
  );
  const matching = candidates.filter(
    (item) => basename(dirname(item.path)).toLowerCase() === normalizedSlug.toLowerCase(),
  );
  const selected = matching.length
    ? matching
    : candidates.filter((item) => item.path.toUpperCase() === "SKILL.MD");
  if (selected.length !== 1) throw new Error("无法唯一确定 GitHub 技能目录");
  const skillPath = selected[0].path;
  const files = await downloadGithubSkillFiles(owner, repo, branch, skillPath, tree.tree ?? []);
  const detail = parseSkillsShSnapshot(normalizedSource, normalizedSlug, {
    source: normalizedSource,
    slug: normalizedSlug,
    sourceType: "github",
    installUrl: `https://github.com/${normalizedSource}`,
    files,
  });
  detail.audits = await auditsPromise;
  return detail;
}

export async function installSkillsShSkill(
  source: string,
  slugValue: string,
  resourceId?: string,
): Promise<string> {
  const detail = await getSkillsShSkillDetail(source, slugValue);
  return installSkillFiles(detail.name, detail.files, resourceId);
}

async function installSkillFiles(
  name: string,
  files: SkillsShSkillDetail["files"],
  resourceId?: string,
): Promise<string> {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64)
    throw new Error(`技能名称无效：${name}`);
  const skillFile = files.find((file) => file.path.toUpperCase() === "SKILL.MD");
  if (!skillFile) throw new Error("未发现 SKILL.md");
  const validation = validateSkillContent({
    content: skillFile.contents.toString("utf8"),
    directoryName: name,
  });
  if (!validation.valid) throw new Error(validation.errors.join("\n"));
  const managed = resolve(getManagedSkillsDirectory(resourceId));
  const root = resolve(managed, name);
  if (dirname(root) !== managed) throw new Error("技能目录越界");
  await mkdir(managed, { recursive: true });
  // Exclusive creation prevents concurrent installs from deleting another request's files.
  await mkdir(root);
  try {
    for (const file of files) {
      const target = resolve(root, normalizeSkillsShFilePath(file.path));
      const within = relative(root, target);
      if (!within || isAbsolute(within) || within === ".." || within.startsWith(`..${sep}`))
        throw new Error("技能文件路径越界");
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.contents, { flag: "wx" });
    }
    return root;
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

async function downloadGithubSkillFiles(
  owner: string,
  repo: string,
  branch: string,
  skillPath: string,
  tree: GitTreeItem[],
): Promise<SkillsShSkillDetail["files"]> {
  const prefix = skillPath.slice(0, -"SKILL.md".length);
  const entries = tree.filter((item) => item.type === "blob" && item.path.startsWith(prefix));
  if (!entries.length || entries.length > SKILLS_SH_MAX_FILES) throw new Error("技能文件数量无效");
  const files: SkillsShSkillDetail["files"] = [];
  let totalBytes = 0;
  for (const entry of entries) {
    const contents = await fetchWithRetry<Buffer>(
      `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(branch)}/${entry.path.split("/").map(encodeURIComponent).join("/")}`,
      {
        headers: GITHUB_TEXT_HEADERS,
        responseType: "bytes",
        errorMessage: (status) => `读取技能文件失败（${status}）`,
      },
    );
    totalBytes += contents.byteLength;
    if (totalBytes > SKILLS_SH_MAX_BYTES) throw new Error("技能包过大");
    files.push({ path: normalizeSkillsShFilePath(entry.path.slice(prefix.length)), contents });
  }
  return files;
}

interface GitTreeItem {
  path: string;
  type: string;
}

export async function listMarketplaceSkills(
  marketplace: SkillMarketplace,
  query = "",
): Promise<MarketplaceSkill[]> {
  if (!marketplace.enabled) return [];
  const { owner, repo, branch, path: configuredPath } = repositoryUrl(marketplace);
  const effectiveBranch = marketplace.branch || branch;
  const tree = await fetchWithRetry<{ tree?: GitTreeItem[] }>(
    `https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(effectiveBranch)}?recursive=1`,
    {
      headers: GITHUB_JSON_HEADERS,
      responseType: "json",
      errorMessage: (status) => `GitHub 请求失败（${status}）`,
    },
  );
  const skillFiles = (tree.tree ?? []).filter(
    (item) =>
      item.type === "blob" &&
      /(^|\/)SKILL\.md$/i.test(item.path) &&
      (!configuredPath || item.path.startsWith(`${configuredPath}/`)),
  );
  const needle = query.trim().toLocaleLowerCase();
  const skills = await Promise.all(
    skillFiles.map(async (file) => {
      const parent = file.path.split("/").at(-2) || basename(file.path, ".md");
      const sourcePath = validateSkillPath(file.path, configuredPath);
      const raw = await fetchWithRetry<string>(
        `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(effectiveBranch)}/${sourcePath.split("/").map(encodeURIComponent).join("/")}`,
        {
          headers: GITHUB_TEXT_HEADERS,
          responseType: "text",
          errorMessage: (status) => `读取技能文件失败（${status}）`,
        },
      );
      const parsed = parseSkillMarkdown(raw, parent);
      return {
        ...parsed,
        path: `marketplace:${marketplace.id}:${file.path}`,
        marketplaceId: marketplace.id,
        marketplaceName: marketplace.name,
        sourceUrl: marketplace.url,
        sourcePath,
        branch: effectiveBranch,
      } satisfies MarketplaceSkill;
    }),
  );
  return skills.filter(
    (skill) =>
      !needle ||
      `${skill.name} ${skill.description} ${skill.marketplaceName}`
        .toLocaleLowerCase()
        .includes(needle),
  );
}

export async function getMarketplaceSkillDetail(
  marketplaceId: string,
  sourcePath: string,
  resourceId?: string,
) {
  const marketplace = (await getSkillMarketplaces(resourceId)).find(
    (item) => item.id === marketplaceId,
  );
  if (!marketplace) throw new Error("技能市场不存在");
  const { owner, repo, path: configuredPath } = repositoryUrl(marketplace);
  const branch = marketplace.branch || DEFAULT_BRANCH;
  const normalizedSourcePath = validateSkillPath(sourcePath, configuredPath);
  const raw = await fetchWithRetry<string>(
    `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(branch)}/${normalizedSourcePath.split("/").map(encodeURIComponent).join("/")}`,
    {
      headers: GITHUB_TEXT_HEADERS,
      responseType: "text",
      errorMessage: (status) => `读取技能文件失败（${status}）`,
    },
  );
  const parent = normalizedSourcePath.split("/").at(-2) || basename(normalizedSourcePath, ".md");
  const parsed = parseSkillMarkdown(raw, parent);
  const prefix = normalizedSourcePath.slice(0, -"SKILL.md".length);
  const tree = await fetchWithRetry<{ tree?: GitTreeItem[] }>(
    `https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
    {
      headers: GITHUB_JSON_HEADERS,
      responseType: "json",
      errorMessage: (status) => `GitHub 请求失败（${status}）`,
    },
  );
  const resources = (tree.tree ?? [])
    .filter(
      (item) =>
        item.type === "blob" && item.path.startsWith(prefix) && item.path !== normalizedSourcePath,
    )
    .map((item) => item.path.slice(prefix.length))
    .filter((file) => Boolean(file) && basename(file).toUpperCase() !== "SKILL.MD");
  const { references, scripts, assets } = categorizeSkillResources(resources);
  return {
    ...parsed,
    path: `marketplace:${marketplace.id}:${normalizedSourcePath}`,
    references,
    scripts,
    assets,
    marketplaceId: marketplace.id,
    marketplaceName: marketplace.name,
    sourceUrl: marketplace.url,
    sourcePath: normalizedSourcePath,
    branch,
  };
}

export async function installMarketplaceSkill(
  marketplaceId: string,
  skillPath: string,
  resourceId?: string,
): Promise<string> {
  const marketplaces = await getSkillMarketplaces(resourceId);
  const marketplace = marketplaces.find((item) => item.id === marketplaceId);
  if (!marketplace) throw new Error("技能市场不存在或已被删除");
  const { owner, repo, path: configuredPath } = repositoryUrl(marketplace);
  const branch = marketplace.branch || DEFAULT_BRANCH;
  const sourcePath = validateSkillPath(skillPath, configuredPath);
  const tree = await fetchWithRetry<{ tree?: GitTreeItem[]; truncated?: boolean }>(
    `https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
    {
      headers: GITHUB_JSON_HEADERS,
      responseType: "json",
      errorMessage: (status) => `GitHub 请求失败（${status}）`,
    },
  );
  if (tree.truncated) throw new Error("GitHub 技能目录不完整，无法安装");
  const files = await downloadGithubSkillFiles(owner, repo, branch, sourcePath, tree.tree ?? []);
  const skillFile = files.find((file) => file.path.toUpperCase() === "SKILL.MD");
  if (!skillFile) throw new Error("未发现 SKILL.md");
  const metadata = parseSkillMarkdown(
    skillFile.contents.toString("utf8"),
    basename(dirname(sourcePath)),
  );
  return installSkillFiles(metadata.name, files, resourceId);
}
