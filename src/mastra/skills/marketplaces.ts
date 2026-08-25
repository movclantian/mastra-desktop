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
import { getManagedSkillsDirectory } from "../workspace";

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

interface CacheEntry<T> {
  expiresAt: number;
  value: T;
}

interface DiskCache<T> {
  key: string;
  read: () => Promise<CacheEntry<T> | null>;
  write: (entry: CacheEntry<T>) => Promise<void>;
}

function createCachedFetcher<TInput, TResult>(
  loader: (input: TInput) => Promise<TResult>,
  keyOf: (input: TInput) => string,
  options: { ttl: number; disk?: DiskCache<TResult> },
): (input: TInput, force?: boolean) => Promise<TResult> {
  const cache = new Map<string, CacheEntry<TResult>>();
  const inFlight = new Map<string, Promise<TResult>>();
  const disk = options.disk;
  const diskReady = disk
    ? disk.read().then((entry) => {
        if (entry) cache.set(disk.key, entry);
      })
    : Promise.resolve();

  return async (input, force = false) => {
    await diskReady;
    const cacheKey = keyOf(input);
    const cached = cache.get(cacheKey);
    if (!force && cached && cached.expiresAt > Date.now()) return cached.value;

    const pending = inFlight.get(cacheKey);
    if (pending) return pending;

    const request = loader(input)
      .then((value) => {
        const entry = { expiresAt: Date.now() + options.ttl, value };
        cache.set(cacheKey, entry);
        if (disk?.key === cacheKey) void disk.write(entry);
        return value;
      })
      .catch((error) => {
        if (cached) return cached.value;
        throw error;
      });

    inFlight.set(cacheKey, request);
    try {
      return await request;
    } finally {
      if (inFlight.get(cacheKey) === request) inFlight.delete(cacheKey);
    }
  };
}

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

async function readSkillsShDiskCache(): Promise<CacheEntry<SkillsShSkill[]> | null> {
  try {
    const raw = await readFile(getSkillsShCacheFile(), "utf-8");
    const parsed = JSON.parse(raw) as { expiresAt?: number; skills?: SkillsShSkill[] };
    if (!Array.isArray(parsed.skills) || typeof parsed.expiresAt !== "number") return null;
    // 过期的副本仍然装载:下面的 stale-while-revalidate 会在网络失败时用它兜底,
    // 比让用户对着空列表干等强。
    return {
      expiresAt: parsed.expiresAt,
      value: parsed.skills,
    };
  } catch {
    // 首次运行没有这个文件,或内容损坏 —— 都按「无缓存」处理
    return null;
  }
}

async function writeSkillsShDiskCache(entry: CacheEntry<SkillsShSkill[]>): Promise<void> {
  try {
    const cacheFile = getSkillsShCacheFile();
    await mkdir(dirname(cacheFile), { recursive: true });
    await writeFile(
      cacheFile,
      JSON.stringify({ expiresAt: entry.expiresAt, skills: entry.value }),
      "utf-8",
    );
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
  responseType: "json" | "text";
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
    const response = await fetch(url, { headers: options.headers });
    if (response.ok) {
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

interface SkillsShPublicPage {
  skills: unknown[];
  total?: number;
}

let curatedCacheData: CuratedResponse | null = null;
let curatedCacheExpiresAt = 0;

export async function getSkillsShCurated(force = false): Promise<CuratedResponse> {
  if (!force && curatedCacheData && curatedCacheExpiresAt > Date.now()) {
    return curatedCacheData;
  }

  try {
    // 1. 并发拉取前 4 页基础全时榜，筛选其中的官方技能与创作者
    const pages = await Promise.all(
      [0, 1, 2, 3].map((p) =>
        fetchWithRetry<SkillsShPublicPage>(
          `https://skills.sh/api/skills/all-time/${p}`,
          SKILLS_SH_JSON_OPTIONS,
        ).catch(() => ({ skills: [] })),
      ),
    );
    const baseSkills = pages
      .flatMap((p) => p.skills ?? [])
      .map(normalizeSkillsShEntry)
      .filter((s): s is SkillsShSkill => Boolean(s));

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
  } catch {
    return { data: [], totalOwners: 0, totalSkills: 0 };
  }
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
): Promise<SkillsShFetchedPage | null> {
  try {
    const v1Result = await fetchWithRetry<{
      data?: unknown[];
      pagination?: { page: number; perPage: number; total: number; hasMore: boolean };
    }>(
      `https://skills.sh/api/v1/skills?view=${view}&page=${page}&per_page=${perPage}`,
      SKILLS_SH_JSON_OPTIONS,
    );
    if (Array.isArray(v1Result.data) && v1Result.data.length > 0) {
      const pagination = v1Result.pagination;
      return {
        skills: v1Result.data
          .map(normalizeSkillsShEntry)
          .filter((skill): skill is SkillsShSkill => Boolean(skill)),
        total: pagination?.total,
        page: pagination?.page,
        perPage: pagination?.perPage,
        hasMore: pagination?.hasMore,
      };
    }
  } catch {
    // Try the legacy page endpoint below.
  }

  const legacyPage = await fetchWithRetry<SkillsShPublicPage>(
    `https://skills.sh/api/skills/${view}/${page}`,
    SKILLS_SH_JSON_OPTIONS,
  ).catch((): SkillsShPublicPage => ({ skills: [] }));
  const rawSkills = Array.isArray(legacyPage.skills) ? legacyPage.skills : [];
  const skills = rawSkills
    .map(normalizeSkillsShEntry)
    .filter((skill): skill is SkillsShSkill => Boolean(skill));
  if (skills.length === 0) return null;
  return {
    skills,
    total:
      legacyPage.total ??
      (rawSkills.length >= perPage
        ? Math.max(500, (page + 5) * perPage)
        : page * perPage + rawSkills.length),
    page,
    perPage,
    hasMore: skills.length >= perPage,
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
      ).catch(() => ({ skills: [] }));
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
    const curatedData = await getSkillsShCurated();
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
    const payload = await fetchWithRetry<{ skills?: unknown[] }>(
      searchUrl,
      SKILLS_SH_JSON_OPTIONS,
    ).catch(() => ({ skills: [] }));
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
  if (fetchedPage) {
    const skills = sortSkills(view, filterSkills(fetchedPage.skills, owner));
    return {
      skills,
      total: fetchedPage.total ?? skills.length,
      page: fetchedPage.page ?? page,
      perPage: fetchedPage.perPage ?? perPage,
      hasMore: fetchedPage.hasMore ?? skills.length >= perPage,
      view,
    };
  }

  // 若榜单接口均未返回，基于全量技能做过滤、排序和分页。
  const allSkills = filterSkills(await listSkillsShSkills(), owner);
  return paginateSkills(sortSkills(view, allSkills), page, perPage, view);
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

async function listSkillsShPublicSkills(query: string): Promise<SkillsShSkill[]> {
  const result = await listSkillsShSkillsWithOptions({ query, perPage: 200 });
  if (result.skills.length > 0) return result.skills;

  // 并发拉取 skills.sh 全时榜前 10 页兜底 (支持 500+ 个完整技能)
  const pagesToFetch = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  const pages = await Promise.all(
    pagesToFetch.map((p) =>
      fetchWithRetry<SkillsShPublicPage>(
        `https://skills.sh/api/skills/all-time/${p}`,
        SKILLS_SH_JSON_OPTIONS,
      ).catch(() => ({ skills: [] })),
    ),
  );
  const skills = pages
    .flatMap((p) => p.skills ?? [])
    .map(normalizeSkillsShEntry)
    .filter((skill): skill is SkillsShSkill => Boolean(skill));
  return filterSkills(skills, undefined, query);
}

const cachedSkillsShPublicSkills = createCachedFetcher(
  listSkillsShPublicSkills,
  (query) => query.toLocaleLowerCase() || SKILLS_SH_CACHE_KEY,
  {
    ttl: SKILLS_SH_CACHE_TTL,
    disk: {
      key: SKILLS_SH_CACHE_KEY,
      read: readSkillsShDiskCache,
      write: writeSkillsShDiskCache,
    },
  },
);

export async function listSkillsShSkills(query = "", force = false): Promise<SkillsShSkill[]> {
  const normalizedQuery = query.trim();
  return cachedSkillsShPublicSkills(normalizedQuery, force);
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
  let tree: { tree?: Array<{ path: string; type: string }> } | undefined;
  let branch = "main";
  for (const candidate of ["main", "master"]) {
    try {
      tree = await fetchWithRetry<{ tree?: Array<{ path: string; type: string }> }>(
        `https://api.github.com/repos/${owner}/${repo}/git/trees/${candidate}?recursive=1`,
        {
          headers: GITHUB_JSON_HEADERS,
          responseType: "json",
          errorMessage: (status) => `GitHub 请求失败（${status}）`,
        },
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
        contents: await fetchWithRetry<string>(
          `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(branch)}/${item.path
            .split("/")
            .map(encodeURIComponent)
            .join("/")}`,
          {
            headers: GITHUB_TEXT_HEADERS,
            responseType: "text",
            errorMessage: (status) => `读取技能文件失败（${status}）`,
          },
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

export async function installSkillsShSkill(
  source: string,
  slugValue: string,
  resourceId?: string,
): Promise<string> {
  const detail = await getSkillsShSkillDetail(source, slugValue);
  const skillName = detail.name.trim();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skillName)) {
    throw new Error(`技能名称无效：${skillName}`);
  }
  const root = join(getManagedSkillsDirectory(resourceId), skillName);
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

export async function installMarketplaceSkill(
  skill: MarketplaceSkill,
  resourceId?: string,
): Promise<string> {
  const marketplaces = await getSkillMarketplaces(resourceId);
  const marketplace = marketplaces.find((item) => item.id === skill.marketplaceId);
  if (!marketplace) throw new Error("技能市场不存在或已被删除");
  const { owner, repo, path: configuredPath } = repositoryUrl(marketplace);
  const branch = marketplace.branch || DEFAULT_BRANCH;
  const sourcePath = validateSkillPath(skill.sourcePath, configuredPath);
  const root = join(getManagedSkillsDirectory(resourceId), slug(skill.name));
  if (
    await access(root).then(
      () => true,
      () => false,
    )
  )
    throw new Error("该技能已经安装");
  await mkdir(root, { recursive: true });
  try {
    const raw = await fetchWithRetry<string>(
      `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(branch)}/${sourcePath.split("/").map(encodeURIComponent).join("/")}`,
      {
        headers: GITHUB_TEXT_HEADERS,
        responseType: "text",
        errorMessage: (status) => `读取技能文件失败（${status}）`,
      },
    );
    await writeFile(join(root, "SKILL.md"), raw, "utf8");
    const fileBase = sourcePath.slice(0, -"SKILL.md".length);
    const tree = await fetchWithRetry<{ tree?: GitTreeItem[] }>(
      `https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
      {
        headers: GITHUB_JSON_HEADERS,
        responseType: "json",
        errorMessage: (status) => `GitHub 请求失败（${status}）`,
      },
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
        await fetchWithRetry<string>(
          `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(branch)}/${item.path.split("/").map(encodeURIComponent).join("/")}`,
          {
            headers: GITHUB_TEXT_HEADERS,
            responseType: "text",
            errorMessage: (status) => `读取技能文件失败（${status}）`,
          },
        ),
      );
    }
    return root;
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
