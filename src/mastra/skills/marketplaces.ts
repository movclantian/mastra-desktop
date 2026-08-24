/**
 * 技能市场(docs/en/docs/skills.mdx):GitHub 仓库形式的技能来源,
 * 配置存 app_config(key = "skill-marketplaces"),安装 = 检出 SKILL.md 目录。
 */
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  DEFAULT_MASTRA_DATA_DIRECTORY,
  getAppConfig,
  getStorageDirectory,
  setAppConfig,
} from "../storage";

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
  files: Array<{ path: string; contents: string }>;
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
const skillsShCache = new Map<string, { expiresAt: number; skills: SkillsShSkill[] }>();
const skillsShInFlight = new Map<string, Promise<SkillsShSkill[]>>();

/**
 * skills.sh 无查询列表的磁盘副本。
 *
 * 内存缓存只活一个进程,重启后首屏又要等一次网络往返 —— 渲染进程曾为此把整份列表
 * 塞进 localStorage,但那是几百 KB 的远端数据,localStorage 只有 5MB 且写入同步阻塞
 * 主线程,超限还会静默失败。远端数据的缓存本就该留在取数的那一侧,所以落到
 * data/cache/ 下的普通文件:大小无实际上限、异步读写、和 observability 同级。
 *
 * 只缓存 "__all__"(无查询)这一条:它是首屏唯一需要的,带 query 的结果留在内存即可。
 */
const SKILLS_SH_CACHE_KEY = "__all__";
function getSkillsShCacheFile(): string {
  return join(getStorageDirectory() || DEFAULT_MASTRA_DATA_DIRECTORY, "cache", "skills-sh.json");
}

async function readSkillsShDiskCache(): Promise<void> {
  try {
    const raw = await readFile(getSkillsShCacheFile(), "utf-8");
    const parsed = JSON.parse(raw) as { expiresAt?: number; skills?: SkillsShSkill[] };
    if (!Array.isArray(parsed.skills) || typeof parsed.expiresAt !== "number") return;
    // 过期的副本仍然装载:下面的 stale-while-revalidate 会在网络失败时用它兜底,
    // 比让用户对着空列表干等强。
    skillsShCache.set(SKILLS_SH_CACHE_KEY, {
      expiresAt: parsed.expiresAt,
      skills: parsed.skills,
    });
  } catch {
    // 首次运行没有这个文件,或内容损坏 —— 都按「无缓存」处理
  }
}
/** 进程内只装载一次;listSkillsShSkills 首次调用时等它完成 */
const skillsShDiskCacheReady = readSkillsShDiskCache();

async function writeSkillsShDiskCache(entry: {
  expiresAt: number;
  skills: SkillsShSkill[];
}): Promise<void> {
  try {
    const cacheFile = getSkillsShCacheFile();
    await mkdir(dirname(cacheFile), { recursive: true });
    await writeFile(cacheFile, JSON.stringify(entry), "utf-8");
  } catch {
    // 磁盘不可写时退化为纯内存缓存,不影响功能
  }
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

export async function getSkillMarketplaces(): Promise<SkillMarketplace[]> {
  const raw = await getAppConfig(MARKETPLACES_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as { marketplaces?: unknown };
    if (!Array.isArray(parsed.marketplaces)) return [];
    return parsed.marketplaces.map(normalizeMarketplace);
  } catch {
    return [];
  }
}

export async function saveSkillMarketplaces(marketplaces: SkillMarketplace[]): Promise<void> {
  const normalized = marketplaces.map(normalizeMarketplace);
  if (new Set(normalized.map((marketplace) => marketplace.id)).size !== normalized.length) {
    throw new Error("技能市场 ID 不能重复");
  }
  await setAppConfig(MARKETPLACES_KEY, JSON.stringify({ marketplaces: normalized }, null, 2));
}

export function parseSkillMarkdown(content: string, fallbackName: string) {
  const match = content.match(/^---\s*([\s\S]*?)\s*---/);
  const fields: Record<string, string> = {};
  for (const line of (match?.[1] ?? "").split(/\r?\n/)) {
    const field = line.match(/^([\w-]+):\s*["']?(.+?)["']?\s*$/);
    if (field) fields[field[1]] = field[2].trim();
  }
  return {
    name: fields.name || fallbackName,
    description: fields.description || "未提供描述",
    license: fields.license,
    metadata:
      fields.category || fields.icon
        ? {
            ...(fields.category ? { category: fields.category } : {}),
            ...(fields.icon ? { icon: fields.icon } : {}),
          }
        : undefined,
  };
}

async function githubJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "MastraWork-Skill-Marketplace",
    },
  });
  if (!response.ok) throw new Error(`GitHub 请求失败（${response.status}）`);
  return (await response.json()) as T;
}

async function githubText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: { Accept: "application/vnd.github.raw", "User-Agent": "MastraWork-Skill-Marketplace" },
  });
  if (!response.ok) throw new Error(`读取技能文件失败（${response.status}）`);
  return response.text();
}

async function publicSkillText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      Accept: "text/markdown, text/plain;q=0.9",
      "User-Agent": "MastraWork-Skill-Marketplace",
    },
  });
  if (!response.ok) throw new Error(`读取远程技能文件失败（${response.status}）`);
  return response.text();
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

async function skillsShPublicJson<T>(url: string): Promise<T> {
  for (let attempt = 0; attempt <= SKILLS_SH_MAX_RETRIES; attempt += 1) {
    const response = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "MastraWork-Skill-Marketplace" },
    });
    if (response.ok) return (await response.json()) as T;
    if (response.status !== 429 || attempt === SKILLS_SH_MAX_RETRIES) {
      if (response.status === 429) {
        throw new Error("skills.sh 公共目录请求被限流，请稍后重试");
      }
      throw new Error(`skills.sh 公共目录请求失败（${response.status}）`);
    }
    const retryAfter = Number(response.headers.get("Retry-After"));
    const delayMs =
      Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(30_000, retryAfter * 1_000)
        : Math.min(8_000, 500 * 2 ** attempt);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error("skills.sh 公共目录请求失败");
}

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
    const sourceType =
      raw.sourceType === "well-known" || !normalizedSource.includes("/") ? "well-known" : "github";
    const change = typeof raw.change === "number" ? raw.change : undefined;
    const installsYesterday =
      typeof raw.installsYesterday === "number" ? raw.installsYesterday : undefined;
    const owner =
      typeof raw.owner === "string" && raw.owner.trim()
        ? raw.owner.trim()
        : normalizedSource.split("/")[0] || undefined;
    const isOfficial =
      raw.isOfficial === true ||
      owner === "anthropics" ||
      owner === "vercel-labs" ||
      owner === "supabase";
    return {
      id:
        typeof raw.id === "string" && raw.id.trim()
          ? raw.id.trim()
          : `${normalizedSource}/${normalizedSlug}`,
      slug: normalizedSlug,
      name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : normalizedSlug,
      source: normalizedSource,
      installs: Number.isFinite(installs) ? Math.max(0, Math.round(installs)) : 0,
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
      change,
      installsYesterday,
      owner,
      isOfficial,
    };
  } catch {
    return null;
  }
}

interface SkillsShPublicPage {
  skills: unknown[];
  total?: number;
}

export async function getSkillsShCurated(): Promise<CuratedResponse> {
  const endpoints = [
    "https://skills.sh/api/v1/skills/curated",
    "https://skills.sh/api/skills/curated",
    "https://skills.sh/api/curated",
  ];
  for (const endpoint of endpoints) {
    try {
      const res = await skillsShPublicJson<{
        data?: Array<{
          owner: string;
          totalInstalls: number;
          featuredRepo?: string;
          featuredSkill?: string;
          skills?: unknown[];
        }>;
        totalOwners?: number;
        totalSkills?: number;
        generatedAt?: string;
      }>(endpoint);
      if (res && Array.isArray(res.data) && res.data.length > 0) {
        const owners: CuratedOwner[] = res.data.map((item) => ({
          owner: item.owner,
          totalInstalls: item.totalInstalls,
          featuredRepo: item.featuredRepo,
          featuredSkill: item.featuredSkill,
          skills: (item.skills ?? [])
            .map(normalizeSkillsShEntry)
            .filter((s): s is SkillsShSkill => Boolean(s))
            .map((s) => ({ ...s, isOfficial: true, owner: item.owner })),
        }));
        return {
          data: owners,
          totalOwners: res.totalOwners ?? owners.length,
          totalSkills: res.totalSkills ?? owners.reduce((sum, o) => sum + o.skills.length, 0),
          generatedAt: res.generatedAt,
        };
      }
    } catch {
      // try next fallback
    }
  }
  return { data: [], totalOwners: 0, totalSkills: 0 };
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
      const res = await skillsShPublicJson<SkillAuditResponse>(endpoint);
      if (res && Array.isArray(res.audits)) {
        return res.audits;
      }
    } catch {
      // try next
    }
  }
  return [];
}

export async function listSkillsShSkillsWithOptions(
  options: SkillsShQueryOptions = {},
): Promise<SkillsShListResult> {
  const { view = "all-time", curated = false, owner, page = 0, perPage = 50, query = "" } = options;

  const normalizedQuery = query.trim();

  // 1. 如果请求的是官方精选 (Curated / Official)
  if (curated) {
    const curatedData = await getSkillsShCurated();
    let owners = curatedData.data;
    if (owner) {
      owners = owners.filter((o) => o.owner.toLowerCase() === owner.toLowerCase());
    }
    const allCuratedSkills = owners.flatMap((o) => o.skills);
    let filtered = allCuratedSkills;
    if (normalizedQuery) {
      const q = normalizedQuery.toLowerCase();
      filtered = filtered.filter(
        (s) =>
          s.name.toLowerCase().includes(q) ||
          s.source.toLowerCase().includes(q) ||
          s.description?.toLowerCase().includes(q),
      );
    }
    const total = filtered.length;
    const start = page * perPage;
    const paginated = filtered.slice(start, start + perPage);
    return {
      skills: paginated,
      total,
      page,
      perPage,
      hasMore: start + perPage < total,
      view: "curated",
      curatedOwners: owners,
    };
  }

  // 2. 如果包含搜索关键词
  if (normalizedQuery.length >= 2) {
    const searchUrl = `https://skills.sh/api/search?q=${encodeURIComponent(normalizedQuery)}&limit=200${owner ? `&owner=${encodeURIComponent(owner)}` : ""}`;
    const payload = await skillsShPublicJson<{ skills?: unknown[] }>(searchUrl).catch(() => ({
      skills: [],
    }));
    const skills = (payload.skills ?? [])
      .map(normalizeSkillsShEntry)
      .filter((skill): skill is SkillsShSkill => Boolean(skill));
    const total = skills.length;
    const start = page * perPage;
    return {
      skills: skills.slice(start, start + perPage),
      total,
      page,
      perPage,
      hasMore: start + perPage < total,
      view,
    };
  }

  // 3. 榜单查询 (view: all-time | trending | hot)
  const viewPath = view === "trending" ? "trending" : view === "hot" ? "hot" : "all-time";
  try {
    const v1Res = await skillsShPublicJson<{
      data?: unknown[];
      pagination?: { page: number; perPage: number; total: number; hasMore: boolean };
    }>(`https://skills.sh/api/v1/skills?view=${viewPath}&page=${page}&per_page=${perPage}`);
    if (v1Res && Array.isArray(v1Res.data) && v1Res.data.length > 0) {
      const skills = v1Res.data
        .map(normalizeSkillsShEntry)
        .filter((skill): skill is SkillsShSkill => Boolean(skill));
      return {
        skills,
        total: v1Res.pagination?.total ?? skills.length,
        page: v1Res.pagination?.page ?? page,
        perPage: v1Res.pagination?.perPage ?? perPage,
        hasMore: v1Res.pagination?.hasMore ?? skills.length >= perPage,
        view,
      };
    }
  } catch {
    // fallback
  }

  const fallbackPage = await skillsShPublicJson<SkillsShPublicPage>(
    `https://skills.sh/api/skills/${viewPath}/${page}`,
  ).catch((): SkillsShPublicPage => ({ skills: [] }));

  const skills = (fallbackPage.skills ?? [])
    .map(normalizeSkillsShEntry)
    .filter((skill): skill is SkillsShSkill => Boolean(skill));

  return {
    skills,
    total: fallbackPage.total ?? (page + 1) * perPage + (skills.length >= perPage ? perPage : 0),
    page,
    perPage,
    hasMore: skills.length >= perPage,
    view,
  };
}

async function listSkillsShPublicSkills(query: string): Promise<SkillsShSkill[]> {
  const result = await listSkillsShSkillsWithOptions({ query, perPage: 200 });
  if (result.skills.length > 0) return result.skills;

  // 并发拉取 skills.sh 全时榜前 4 页兜底
  const pagesToFetch = [0, 1, 2, 3];
  const pages = await Promise.all(
    pagesToFetch.map((p) =>
      skillsShPublicJson<SkillsShPublicPage>(`https://skills.sh/api/skills/all-time/${p}`).catch(
        () => ({ skills: [] }),
      ),
    ),
  );
  const skills = pages
    .flatMap((p) => p.skills ?? [])
    .map(normalizeSkillsShEntry)
    .filter((skill): skill is SkillsShSkill => Boolean(skill));
  return skills;
}

export async function listSkillsShSkills(query = "", force = false): Promise<SkillsShSkill[]> {
  await skillsShDiskCacheReady;
  const normalizedQuery = query.trim();
  const cacheKey = normalizedQuery.toLocaleLowerCase() || SKILLS_SH_CACHE_KEY;
  const cached = skillsShCache.get(cacheKey);
  if (!force && cached && cached.expiresAt > Date.now()) return cached.skills;

  const pending = skillsShInFlight.get(cacheKey);
  if (pending) return pending;

  const request = listSkillsShPublicSkills(normalizedQuery)
    .then((skills) => {
      const entry = { expiresAt: Date.now() + SKILLS_SH_CACHE_TTL, skills };
      skillsShCache.set(cacheKey, entry);
      if (cacheKey === SKILLS_SH_CACHE_KEY) void writeSkillsShDiskCache(entry);
      return skills;
    })
    .catch((error) => {
      if (cached) return cached.skills;
      throw error;
    });
  skillsShInFlight.set(cacheKey, request);
  try {
    return await request;
  } finally {
    if (skillsShInFlight.get(cacheKey) === request) skillsShInFlight.delete(cacheKey);
  }
}

function normalizeSkillsShFilePath(path: string): string {
  const normalized = path.trim().replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").includes("..")) {
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
        if (typeof file.path !== "string" || typeof file.contents !== "string") return [];
        return [{ path: normalizeSkillsShFilePath(file.path), contents: file.contents }];
      })
    : [];
  if (files.length === 0 || files.length > SKILLS_SH_MAX_FILES) {
    throw new Error("skills.sh 技能文件数量无效");
  }
  const totalBytes = files.reduce((sum, file) => sum + Buffer.byteLength(file.contents, "utf8"), 0);
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
  const parsed = parseSkillMarkdown(skillFile.contents, basename(parent || slugValue));
  const { references, scripts, assets } = categorizeSkillResources(resources);
  return {
    ...base,
    hash: typeof raw.hash === "string" ? raw.hash : undefined,
    files,
    instructions: skillFile.contents.replace(/^---\s*[\s\S]*?\s*---\s*/, "").trim(),
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
        instructions = await publicSkillText(`${baseUrl}${path}`);
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
  let tree: { tree?: Array<{ path: string; type: string }> } | undefined;
  let branch = "main";
  for (const candidate of ["main", "master"]) {
    try {
      tree = await githubJson<{ tree?: Array<{ path: string; type: string }> }>(
        `https://api.github.com/repos/${owner}/${repo}/git/trees/${candidate}?recursive=1`,
      );
      branch = candidate;
      break;
    } catch {
      // Try the conventional fallback branch before reporting an unavailable skill.
    }
  }
  if (!tree) throw new Error("无法读取 skills.sh 技能对应的 GitHub 仓库");
  const skillPath = tree.tree
    ?.filter((item) => item.type === "blob" && /(^|\/)SKILL\.md$/i.test(item.path))
    .sort((left, right) => {
      const leftMatch = left.path
        .toLowerCase()
        .endsWith(`/${normalizedSlug.toLowerCase()}/skill.md`);
      const rightMatch = right.path
        .toLowerCase()
        .endsWith(`/${normalizedSlug.toLowerCase()}/skill.md`);
      return Number(rightMatch) - Number(leftMatch);
    })[0]?.path;
  if (!skillPath) throw new Error("GitHub 仓库中未找到 SKILL.md");
  const prefix = dirname(skillPath).replaceAll("\\", "/");
  const skillPrefix = prefix === "." ? "" : prefix;
  const files = await Promise.all(
    (tree.tree ?? [])
      .filter(
        (item) =>
          item.type === "blob" &&
          (item.path === skillPath || (skillPrefix && item.path.startsWith(`${skillPrefix}/`))),
      )
      .slice(0, SKILLS_SH_MAX_FILES)
      .map(async (item) => ({
        path: item.path.slice(skillPrefix ? skillPrefix.length + 1 : 0),
        contents: await githubText(
          `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(branch)}/${item.path
            .split("/")
            .map(encodeURIComponent)
            .join("/")}`,
        ),
      })),
  );
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

export async function installSkillsShSkill(source: string, slugValue: string): Promise<string> {
  const detail = await getSkillsShSkillDetail(source, slugValue);
  const skillName = detail.name.trim();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skillName)) {
    throw new Error(`技能名称无效：${skillName}`);
  }
  const root = join(getStorageDirectory() || DEFAULT_MASTRA_DATA_DIRECTORY, "skills", skillName);
  if (
    await access(root).then(
      () => true,
      () => false,
    )
  )
    throw new Error("该技能已经安装");
  const skillFile = detail.files.find((file) => basename(file.path).toUpperCase() === "SKILL.MD");
  if (!skillFile) throw new Error("安装后未发现有效技能");
  const parent = dirname(skillFile.path).replaceAll("\\", "/");
  const prefix = parent === "." ? "" : `${parent}/`;
  await mkdir(root, { recursive: true });
  try {
    for (const file of detail.files) {
      if (prefix && !file.path.startsWith(prefix)) continue;
      const relativePath = prefix ? file.path.slice(prefix.length) : file.path;
      const target = resolve(root, relativePath);
      const within = relative(root, target);
      if (isAbsolute(within) || within === ".." || within.startsWith(`..${sep}`)) {
        throw new Error("skills.sh 技能文件路径越界");
      }
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.contents, "utf8");
    }
    return root;
  } catch (error) {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
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
  const tree = await githubJson<{ tree?: GitTreeItem[] }>(
    `https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(effectiveBranch)}?recursive=1`,
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
      const raw = await githubText(
        `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(effectiveBranch)}/${sourcePath.split("/").map(encodeURIComponent).join("/")}`,
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

export async function getMarketplaceSkillDetail(marketplaceId: string, sourcePath: string) {
  const marketplace = (await getSkillMarketplaces()).find((item) => item.id === marketplaceId);
  if (!marketplace) throw new Error("技能市场不存在");
  const { owner, repo, path: configuredPath } = repositoryUrl(marketplace);
  const branch = marketplace.branch || DEFAULT_BRANCH;
  const normalizedSourcePath = validateSkillPath(sourcePath, configuredPath);
  const raw = await githubText(
    `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(branch)}/${normalizedSourcePath.split("/").map(encodeURIComponent).join("/")}`,
  );
  const parent = normalizedSourcePath.split("/").at(-2) || basename(normalizedSourcePath, ".md");
  const parsed = parseSkillMarkdown(raw, parent);
  const prefix = normalizedSourcePath.slice(0, -"SKILL.md".length);
  const tree = await githubJson<{ tree?: GitTreeItem[] }>(
    `https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
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
    instructions: raw.replace(/^---\s*[\s\S]*?\s*---\s*/, "").trim(),
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

export async function installMarketplaceSkill(skill: MarketplaceSkill): Promise<string> {
  const marketplaces = await getSkillMarketplaces();
  const marketplace = marketplaces.find((item) => item.id === skill.marketplaceId);
  if (!marketplace) throw new Error("技能市场不存在或已被删除");
  const { owner, repo, path: configuredPath } = repositoryUrl(marketplace);
  const branch = marketplace.branch || DEFAULT_BRANCH;
  const sourcePath = validateSkillPath(skill.sourcePath, configuredPath);
  const root = join(
    getStorageDirectory() || DEFAULT_MASTRA_DATA_DIRECTORY,
    "skills",
    slug(skill.name),
  );
  if (
    await access(root).then(
      () => true,
      () => false,
    )
  )
    throw new Error("该技能已经安装");
  await mkdir(root, { recursive: true });
  try {
    const raw = await githubText(
      `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(branch)}/${sourcePath.split("/").map(encodeURIComponent).join("/")}`,
    );
    await writeFile(join(root, "SKILL.md"), raw, "utf8");
    const fileBase = sourcePath.slice(0, -"SKILL.md".length);
    const tree = await githubJson<{ tree?: GitTreeItem[] }>(
      `https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
    );
    for (const item of tree.tree ?? []) {
      if (item.type !== "blob" || !item.path.startsWith(fileBase) || item.path === sourcePath)
        continue;
      const relativePath = item.path.slice(fileBase.length);
      if (!relativePath || relativePath.includes("..")) continue;
      const target = join(root, relativePath);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(
        target,
        await githubText(
          `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(branch)}/${item.path.split("/").map(encodeURIComponent).join("/")}`,
        ),
      );
    }
    return root;
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
