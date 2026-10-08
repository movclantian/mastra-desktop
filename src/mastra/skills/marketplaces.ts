/**
 * skills.sh discovery, audits and source acquisition. Package lifecycle lives in plugins/.
 */
import { z } from "zod";
import {
  GITHUB_ORIGIN,
  SKILLS_SH_ORIGIN,
  SKILLS_SH_PUBLIC_BASE,
} from "../../shared/plugin-contract";
import {
  archiveFiles,
  type PackageFiles,
  pluginHash,
  selectPackageRoot,
} from "../plugins/packages";

export interface SkillAuditItem {
  provider: string;
  slug: string;
  status: "pass" | "warn" | "fail" | string;
  summary: string;
  auditedAt?: string;
  riskLevel?: "NONE" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" | string;
  categories?: string[];
}

interface SkillAuditResponse {
  id: string;
  source: string;
  slug: string;
  audits: SkillAuditItem[];
}

interface CuratedOwner {
  owner: string;
  totalInstalls: number;
  featuredRepo?: string;
  featuredSkill?: string;
  skills: SkillsShSkill[];
}

interface CuratedResponse {
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

/**
 * skills.sh 列表缓存有效期。
 *
 * 取 24 小时:社区技能目录不是高频变动的数据,而这份列表要打一次远端往返,
 * 短 TTL 只是在反复付延迟。代价是新技能上架当天可能看不到 —— 所以技能中心的
 * 刷新按钮走 force 路径直接穿透缓存(见 listSkillsShSkillsWithOptions 的 force 参数)。
 */
const SKILLS_SH_CACHE_TTL = 24 * 60 * 60 * 1000;
const SKILLS_SH_MAX_RETRIES = 3;
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
            ? `${GITHUB_ORIGIN}/${normalizedSource}`
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
  const searchUrl = `${SKILLS_SH_ORIGIN}/api/search?q=${encodeURIComponent(owner)}&limit=100`;
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

function getSkillsShCurated(force = false): Promise<CuratedResponse> {
  return cachedSkillsShCurated(undefined, force);
}

export async function getSkillsShAudit(source: string, slug: string): Promise<SkillAuditItem[]> {
  const normalizedSource = normalizeSkillsShCoordinate(source, "source");
  const normalizedSlug = normalizeSkillsShCoordinate(slug, "skill");
  const result = await fetchWithRetry<SkillAuditResponse>(
    `${SKILLS_SH_ORIGIN}/api/v1/skills/audit/${normalizedSource}/${normalizedSlug}`,
    skillsShJsonOptions(skillsShOidcToken()),
  );
  if (!Array.isArray(result.audits))
    throw new Error("skills.sh returned an invalid audit response");
  return result.audits;
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
      `${SKILLS_SH_ORIGIN}/api/v1/skills?view=${view}&page=${page}&per_page=${perPage}`,
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
  if (normalizedQuery.length > 0) {
    const searchUrl = `${SKILLS_SH_ORIGIN}/api/search?q=${encodeURIComponent(normalizedQuery)}&limit=200${owner ? `&owner=${encodeURIComponent(owner)}` : ""}`;
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

/** Source acquisition only; Git discovery and package writes use the unified plugin pipeline. */
export async function getSkillsShPackage(source: string, slugValue: string, signal?: AbortSignal) {
  const normalizedSource = normalizeSkillsShCoordinate(source, "source");
  const normalizedSlug = normalizeSkillsShCoordinate(slugValue, "skill");
  const base = normalizeSkillsShEntry({ source: normalizedSource, slug: normalizedSlug });
  if (!base) throw new Error("skills.sh 技能元数据无效");
  if (base.sourceType === "github") {
    const { fetchGitPackage } = await import("../plugins/registry");
    return fetchGitPackage(
      { kind: "git", url: `${GITHUB_ORIGIN}/${normalizedSource}`, ref: "HEAD", path: "" },
      signal,
      normalizedSlug,
    );
  }
  let files: PackageFiles;
  const { downloadPackage } = await import("../plugins/registry");
  const indexUrl = `https://${normalizedSource}/.well-known/agent-skills/index.json`;
  const index = z
    .object({
      $schema: z.literal("https://schemas.agentskills.io/discovery/0.2.0/schema.json"),
      skills: z
        .array(
          z.object({
            name: z.string(),
            type: z.enum(["skill-md", "archive"]),
            url: z.string(),
            digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
          }),
        )
        .max(5000),
    })
    .safeParse(JSON.parse((await downloadPackage(indexUrl, signal)).toString("utf8")));
  if (!index.success)
    throw new Error(
      "Unsupported well-known discovery index; a valid discovery/0.2.0 index is required",
    );
  const entries = index.data.skills.filter((skill) => skill.name === normalizedSlug);
  if (entries.length !== 1)
    throw new Error("The well-known skill must have exactly one index entry");
  const entry = entries[0];
  const url = new URL(entry.url, indexUrl);
  if (url.protocol !== "https:") throw new Error("Well-known skill artifacts require HTTPS");
  const artifact = await downloadPackage(url.href, signal);
  if (`sha256:${pluginHash(artifact)}` !== entry.digest)
    throw new Error("Well-known skill artifact digest mismatch");
  if (entry.type === "archive") {
    if (artifact.length < 4 || artifact.readUInt16LE(0) !== 0x4b50)
      throw new Error("Only ZIP well-known skill archives are supported");
    files = selectPackageRoot(archiveFiles(artifact));
    if (!files.has("SKILL.md")) throw new Error("The skill archive must contain a root SKILL.md");
  } else files = new Map([["SKILL.md", artifact]]);
  return { files };
}
