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
 * 刷新按钮走 force 路径直接穿透缓存(见 listSkillsShSkillsWithOptions 的 force 参数)。
 */
const SKILLS_SH_CACHE_TTL = 24 * 60 * 60 * 1000;
const SKILLS_SH_MAX_RETRIES = 3;
const SKILLS_SH_MAX_FILES = 2_000;
const SKILLS_SH_MAX_BYTES = 25 * 1024 * 1024;

type SkillFile = { path: string; contents: Buffer };

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
      for (const [key, cachedEntry] of cache) {
        if (cachedEntry.expiresAt <= Date.now()) cache.delete(key);
      }
      cache.delete(cacheKey);
      while (cache.size >= 32) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        cache.delete(oldest);
      }
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
    // Passing options disables gray-matter's unbounded cache of whole Markdown documents.
    enabled: result.valid && matter(content, {}).data.enabled !== false,
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
/** 公共榜单页面(www.skills.sh)走浏览器 UA,避免被边缘 bot 策略拦。 */
const SKILLS_SH_HTML_HEADERS = {
  Accept: "text/html,application/xhtml+xml",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
};

interface FetchWithRetryOptions {
  headers: Record<string, string>;
  responseType: "json" | "text" | "bytes";
  retries?: number;
  retryOn?: (response: Response) => boolean;
  retryDelay?: (response: Response, attempt: number) => number;
  errorMessage: (status: number) => string;
  maxBytes?: number;
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

/**
 * skills.sh 自 2026-10 起对 /api/v1/* 全系端点强制 Vercel OIDC 鉴权
 * (401 authentication_required,见 skills.sh/docs/api#authentication)。
 * 桌面端正常拿不到该 token;保留 SKILLS_SH_OIDC_TOKEN / VERCEL_OIDC_TOKEN
 * 环境变量通道,供部署在 Vercel 或本地 vercel link 的场景使用。
 * 无 token 时:搜索走公开的 /api/search,榜单走官网页面内嵌的 initialSkills 数据。
 */
function skillsShOidcToken(): string | undefined {
  const token = (process.env.SKILLS_SH_OIDC_TOKEN || process.env.VERCEL_OIDC_TOKEN)?.trim();
  return token || undefined;
}

function skillsShJsonOptions(token?: string): FetchWithRetryOptions {
  if (!token) return SKILLS_SH_JSON_OPTIONS;
  return {
    ...SKILLS_SH_JSON_OPTIONS,
    headers: { ...SKILLS_SH_HEADERS, Authorization: `Bearer ${token}` },
  };
}

async function fetchWithRetry<T>(url: string, options: FetchWithRetryOptions): Promise<T> {
  const retries = options.retries ?? 0;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const response = await fetch(url, {
      headers: options.headers,
      signal: AbortSignal.timeout(10_000),
    });
    if (response.ok) {
      const limit =
        options.maxBytes ??
        (options.responseType === "bytes"
          ? SKILLS_SH_MAX_BYTES
          : options.responseType === "json"
            ? 8 * 1024 * 1024
            : 1024 * 1024);
      if (Number(response.headers.get("content-length")) > limit) {
        await response.body?.cancel();
        throw new Error("技能响应过大");
      }
      if (!response.body) throw new Error("技能响应为空");
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.byteLength;
        if (size > limit) throw new Error("技能响应过大");
        chunks.push(chunk);
      }
      const bytes = Buffer.concat(chunks, size);
      if (options.responseType === "bytes") return bytes as T;
      const text = bytes.toString("utf8");
      return (options.responseType === "json" ? JSON.parse(text) : text) as T;
    }
    await response.body?.cancel();
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

/** 单次 fan-out 的并发上限:24 个 owner 全并行对单一源站不礼貌,分批打。 */
const SKILLS_SH_CURATED_CONCURRENCY = 6;

/**
 * 拉取指定 owner 名下的全部技能(跨仓库)。
 * 走公开的 /api/search(Algolia,免鉴权),q=owner 再按 owner 精确过滤 ——
 * 与 skills.sh 官方 API 文档中 owner 参数的语义一致。
 */
async function fetchSkillsShOwnerSkills(owner: string): Promise<SkillsShSkill[]> {
  const searchUrl = `https://skills.sh/api/search?q=${encodeURIComponent(owner)}&limit=100`;
  const payload = await fetchWithRetry<{ skills?: unknown[] }>(searchUrl, SKILLS_SH_JSON_OPTIONS);
  return filterSkills(
    (payload.skills ?? [])
      .map(normalizeSkillsShEntry)
      .filter((s): s is SkillsShSkill => Boolean(s)),
    owner,
  );
}

async function loadSkillsShCurated(): Promise<CuratedResponse> {
  // skills.sh 已锁死 /api/v1 总榜(401),无法再"拉总榜筛官方";
  // 改为按已知官方 owner 并发 fan-out 公共搜索接口,再按 owner 聚合。
  // 单个 owner 失败(超时/限流)不拖垮整体,allSettled 容错。
  const owners = Array.from(KNOWN_OFFICIAL_OWNERS);
  const results: PromiseSettledResult<SkillsShSkill[]>[] = [];
  for (let i = 0; i < owners.length; i += SKILLS_SH_CURATED_CONCURRENCY) {
    const batch = owners.slice(i, i + SKILLS_SH_CURATED_CONCURRENCY);
    results.push(...(await Promise.allSettled(batch.map(fetchSkillsShOwnerSkills))));
  }

  const ownerMap = new Map<string, { totalInstalls: number; skills: SkillsShSkill[] }>();
  results.forEach((result, index) => {
    if (result.status !== "fulfilled" || result.value.length === 0) return;
    const ownerName = owners[index];
    ownerMap.set(ownerName, {
      totalInstalls: result.value.reduce((acc, skill) => acc + (skill.installs || 0), 0),
      skills: result.value,
    });
  });

  if (ownerMap.size === 0) throw new Error("skills.sh 官方目录请求失败");

  const curatedOwners: CuratedOwner[] = Array.from(ownerMap.entries())
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
    data: curatedOwners,
    totalOwners: curatedOwners.length,
    totalSkills: curatedOwners.reduce((acc, o) => acc + o.skills.length, 0),
    generatedAt: new Date().toISOString(),
  };

  return result;
}

const cachedSkillsShCurated = createCachedFetcher(loadSkillsShCurated, () => "curated", {
  ttl: SKILLS_SH_CACHE_TTL,
});

export function getSkillsShCurated(force = false): Promise<CuratedResponse> {
  return cachedSkillsShCurated(undefined, force);
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
      const res = await fetchWithRetry<SkillAuditResponse>(
        endpoint,
        skillsShJsonOptions(skillsShOidcToken()),
      );
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

/**
 * skills.sh 官网榜单页(SSR)在 RSC payload 里内嵌了完整的 initialSkills 数组
 * (每视图 600 条,含 installs/weeklyInstalls/isOfficial/change/installsYesterday),
 * 是当前唯一免鉴权的榜单数据源。字段与 normalizeSkillsShEntry 兼容。
 */
const SKILLS_SH_PUBLIC_BASE = "https://www.skills.sh";
const SKILLS_SH_PUBLIC_LEADERBOARD_PATHS: Record<string, string> = {
  "all-time": "/",
  trending: "/trending",
  hot: "/hot",
};
const SKILLS_SH_PUBLIC_PAGE_MAX_BYTES = 8 * 1024 * 1024;
const SKILLS_SH_PUBLIC_SKILLS_KEY = 'initialSkills\\":[';

/**
 * 从 RSC HTML 中提取 initialSkills JSON 数组。
 * 该数组里所有 JSON 引号都以 \" 转义、括号不转义,所以按 \" 配对切换字符串态、
 * 非字符串态做括号深度匹配即可定位数组边界;取到原文后反转义再 JSON.parse。
 */
function extractInitialSkillsFromHtml(html: string): unknown[] {
  const keyIndex = html.indexOf(SKILLS_SH_PUBLIC_SKILLS_KEY);
  if (keyIndex < 0) throw new Error("skills.sh 公共榜单响应无效");
  const arrayStart = keyIndex + SKILLS_SH_PUBLIC_SKILLS_KEY.length - 1; // 指向 '['
  let depth = 0;
  let inString = false;
  for (let i = arrayStart; i < html.length; i += 1) {
    const ch = html[i];
    if (ch === "\\") {
      if (html[i + 1] === '"') inString = !inString;
      i += 1; // 跳过被转义字符
      continue;
    }
    if (inString) continue;
    if (ch === "[") {
      depth += 1;
    } else if (ch === "]") {
      depth -= 1;
      if (depth === 0) {
        const raw = html
          .slice(arrayStart, i + 1)
          .replaceAll('\\"', '"')
          .replaceAll("\\\\", "\\");
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) throw new Error("skills.sh 公共榜单响应无效");
        return parsed;
      }
    }
  }
  throw new Error("skills.sh 公共榜单响应无效");
}

/** 按视图缓存公共榜单整表(600 条),翻页在本地切片,避免每页重新抓 HTML。 */
const cachedPublicLeaderboard = createCachedFetcher(
  async (view: string): Promise<SkillsShSkill[]> => {
    const path =
      SKILLS_SH_PUBLIC_LEADERBOARD_PATHS[view] ?? SKILLS_SH_PUBLIC_LEADERBOARD_PATHS["all-time"];
    const html = await fetchWithRetry<string>(`${SKILLS_SH_PUBLIC_BASE}${path}`, {
      headers: SKILLS_SH_HTML_HEADERS,
      responseType: "text",
      maxBytes: SKILLS_SH_PUBLIC_PAGE_MAX_BYTES,
      retries: SKILLS_SH_MAX_RETRIES,
      retryOn: (response) => response.status === 429,
      errorMessage: (status) => `skills.sh 公共榜单请求失败（${status}）`,
    });
    return extractInitialSkillsFromHtml(html)
      .map(normalizeSkillsShEntry)
      .filter((skill): skill is SkillsShSkill => Boolean(skill));
  },
  (view) => view,
  { ttl: SKILLS_SH_CACHE_TTL },
);

async function fetchSkillsShLeaderboardPage(
  view: string,
  page: number,
  perPage: number,
  force = false,
): Promise<SkillsShFetchedPage> {
  const token = skillsShOidcToken();
  if (token) {
    const result = await fetchWithRetry<{
      data?: unknown[];
      pagination?: { page: number; perPage: number; total: number; hasMore: boolean };
    }>(
      `https://skills.sh/api/v1/skills?view=${view}&page=${page}&per_page=${perPage}`,
      skillsShJsonOptions(token),
    );
    if (!Array.isArray(result.data)) throw new Error("skills.sh 榜单响应无效");
    return {
      skills: result.data
        .map(normalizeSkillsShEntry)
        .filter((skill): skill is SkillsShSkill => Boolean(skill)),
      ...result.pagination,
    };
  }
  // 无 OIDC token:/api/v1 必 401,改走官网页面内嵌的公共榜单数据。
  const skills = await cachedPublicLeaderboard(view, force);
  const start = page * perPage;
  return {
    skills: skills.slice(start, start + perPage),
    total: skills.length,
    page,
    perPage,
    hasMore: start + perPage < skills.length,
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
      // 指定具体厂商: 走公开 search API 拉取该厂商全量技能
      const skills = filterSkills(
        await fetchSkillsShOwnerSkills(owner),
        undefined,
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
  const fetchedPage = await fetchSkillsShLeaderboardPage(viewPath, page, perPage, options.force);
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

/** Preview reads only SKILL.md and resource paths; binary files are downloaded on install. */
async function loadSkillsShSkill(source: string, slugValue: string) {
  const normalizedSource = normalizeSkillsShCoordinate(source, "source");
  const normalizedSlug = normalizeSkillsShCoordinate(slugValue, "skill");
  const base = normalizeSkillsShEntry({ source: normalizedSource, slug: normalizedSlug });
  if (!base) throw new Error("skills.sh 技能元数据无效");
  let content: string | undefined;
  let resources: string[] = [];
  let github:
    | { owner: string; repo: string; branch: string; skillPath: string; tree: GitTreeItem[] }
    | undefined;
  if (base.sourceType === "well-known") {
    for (const path of [
      `/.well-known/agent-skills/${encodeURIComponent(normalizedSlug)}/SKILL.md`,
      `/.well-known/skills/${encodeURIComponent(normalizedSlug)}/SKILL.md`,
    ]) {
      try {
        content = await fetchWithRetry<string>(`https://${normalizedSource}${path}`, {
          headers: PUBLIC_SKILL_HEADERS,
          responseType: "text",
          errorMessage: (status) => `读取远程技能文件失败（${status}）`,
        });
        break;
      } catch {
        // Both well-known skill discovery conventions are supported.
      }
    }
    if (content === undefined) throw new Error("无法读取该 well-known 技能的 SKILL.md");
  } else {
    const [owner, repo] = normalizedSource.split("/");
    const { default_branch: branch } = await fetchWithRetry<{ default_branch: string }>(
      `https://api.github.com/repos/${owner}/${repo}`,
      {
        headers: GITHUB_JSON_HEADERS,
        responseType: "json",
        errorMessage: (status) => `GitHub 请求失败（${status}）`,
      },
    );
    const result = await fetchWithRetry<{ tree?: GitTreeItem[]; truncated?: boolean }>(
      `https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
      {
        headers: GITHUB_JSON_HEADERS,
        responseType: "json",
        errorMessage: (status) => `GitHub 请求失败（${status}）`,
      },
    );
    if (result.truncated) throw new Error("GitHub 技能目录不完整");
    const tree = result.tree ?? [];
    const candidates = tree.filter(
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
    const prefix = skillPath.slice(0, -"SKILL.md".length);
    resources = tree
      .filter(
        (item) => item.type === "blob" && item.path.startsWith(prefix) && item.path !== skillPath,
      )
      .map((item) => item.path.slice(prefix.length));
    content = await fetchWithRetry<string>(
      `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(branch)}/${skillPath.split("/").map(encodeURIComponent).join("/")}`,
      {
        headers: GITHUB_TEXT_HEADERS,
        responseType: "text",
        errorMessage: (status) => `读取技能文件失败（${status}）`,
      },
    );
    github = { owner, repo, branch, skillPath, tree };
  }
  const detail: SkillsShSkillDetail = {
    ...base,
    ...parseSkillMarkdown(content),
    ...categorizeSkillResources(resources),
    sourceUrl: skillsShSourceUrl(normalizedSource, normalizedSlug),
  };
  return { detail, content, github };
}

export async function getSkillsShSkillDetail(
  source: string,
  slugValue: string,
): Promise<SkillsShSkillDetail> {
  const [{ detail }, audits] = await Promise.all([
    loadSkillsShSkill(source, slugValue),
    getSkillsShAudit(source, slugValue).catch(() => []),
  ]);
  return { ...detail, audits };
}

export async function installSkillsShSkill(
  source: string,
  slugValue: string,
  resourceId?: string,
): Promise<string> {
  const { detail, content, github } = await loadSkillsShSkill(source, slugValue);
  const files = github
    ? await downloadGithubSkillFiles(
        github.owner,
        github.repo,
        github.branch,
        github.skillPath,
        github.tree,
      )
    : [{ path: "SKILL.md", contents: Buffer.from(content, "utf8") }];
  return installSkillFiles(detail.name, files, resourceId);
}

async function installSkillFiles(
  name: string,
  files: SkillFile[],
  resourceId?: string,
): Promise<string> {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64)
    throw new Error(`技能名称无效：${name}`);
  if (files.filter((file) => basename(file.path).toUpperCase() === "SKILL.MD").length !== 1)
    throw new Error("技能必须恰好包含一个 SKILL.md");
  const skillFile = files.find((file) => file.path.toUpperCase() === "SKILL.MD");
  if (!skillFile) throw new Error("未发现 SKILL.md");
  if (skillFile.contents.byteLength > 1024 * 1024) throw new Error("SKILL.md 不能超过 1 MB");
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
): Promise<SkillFile[]> {
  const prefix = skillPath.slice(0, -"SKILL.md".length);
  const entries = tree.filter((item) => item.type === "blob" && item.path.startsWith(prefix));
  if (!entries.length || entries.length > SKILLS_SH_MAX_FILES) throw new Error("技能文件数量无效");
  const files: SkillFile[] = [];
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
  if (skillFiles.length > SKILLS_SH_MAX_FILES)
    throw new Error("市场技能数量超过 2,000，请限定仓库目录");
  const skills: MarketplaceSkill[] = [];
  for (let offset = 0; offset < skillFiles.length; offset += 4) {
    const batch = await Promise.all(
      skillFiles.slice(offset, offset + 4).map(async (file) => {
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
          name: parsed.name,
          description: parsed.description,
          license: parsed.license,
          path: `marketplace:${marketplace.id}:${file.path}`,
          marketplaceId: marketplace.id,
          marketplaceName: marketplace.name,
          sourceUrl: marketplace.url,
          sourcePath,
          branch: effectiveBranch,
        };
      }),
    );
    skills.push(...batch);
  }
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
  if (skillFile.contents.byteLength > 1024 * 1024) throw new Error("SKILL.md 不能超过 1 MB");
  const metadata = parseSkillMarkdown(
    skillFile.contents.toString("utf8"),
    basename(dirname(sourcePath)),
  );
  return installSkillFiles(metadata.name, files, resourceId);
}
