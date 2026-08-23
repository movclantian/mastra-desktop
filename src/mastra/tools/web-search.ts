/**
 * 联网检索工具模块。
 * 官方文档:docs/en/integrations/tools/tavily.mdx(createTavilySearchTool /
 * createTavilyExtractTool)、firecrawl.mdx(Firecrawl SDK);provider 原生检索用
 * @mastra/core/tools 的 webSearchTool / webFetchTool(仅 OpenAI / Anthropic /
 * Google / xAI 家族可用)。AnySearch 为无官方集成的第三方 REST,走手写 fetch。
 * 引擎 + 强度档(fast/balanced/deep)经 RequestContext 传入,由 Agent 的动态
 * tools / instructions 消费(见 src/mastra/agents/index.ts)。
 */
import type { ToolsInput } from "@mastra/core/agent";
import { createTool, webFetchTool, webSearchTool } from "@mastra/core/tools";
import { createTavilyExtractTool, createTavilySearchTool } from "@mastra/tavily";
import { Firecrawl } from "firecrawl";
import { z } from "zod";
import { getAppConfig, setAppConfig } from "../storage";

export const SEARCH_ENGINES = ["provider", "tavily", "firecrawl", "anysearch"] as const;
export type SearchEngine = (typeof SEARCH_ENGINES)[number];

/** provider 引擎支持的模型家族 */
export const PROVIDER_SEARCH_FAMILIES = ["openai", "anthropic", "google", "xai"] as const;

export const MODEL_FAMILY_CONTEXT_KEY = "modelFamily";

function supportsProviderSearch(family: unknown): boolean {
  if (typeof family !== "string") return false;
  const normalized = family === "gemini" ? "google" : family;
  return (PROVIDER_SEARCH_FAMILIES as readonly string[]).includes(normalized);
}

export const SEARCH_DEPTHS = ["fast", "balanced", "deep"] as const;
export type SearchDepth = (typeof SEARCH_DEPTHS)[number];

interface WebSearchSelection {
  engine: SearchEngine;
  depth: SearchDepth;
}

export const WEB_SEARCH_CONTEXT_KEY = "webSearch";

export interface ToolsUserConfig {
  tavily: { apiKey: string };
  firecrawl: { apiKey: string; apiUrl: string };
  anysearch: { apiKey: string };
}

const TOOLS_CONFIG_KEY = "tools";

const DEFAULT_TOOLS_CONFIG: ToolsUserConfig = {
  tavily: { apiKey: "" },
  firecrawl: { apiKey: "", apiUrl: "" },
  anysearch: { apiKey: "" },
};

export async function getToolsConfig(): Promise<ToolsUserConfig> {
  const raw = await getAppConfig(TOOLS_CONFIG_KEY);
  if (!raw) return DEFAULT_TOOLS_CONFIG;
  try {
    const parsed = JSON.parse(raw) as Partial<ToolsUserConfig>;
    return {
      tavily: { ...DEFAULT_TOOLS_CONFIG.tavily, ...parsed.tavily },
      firecrawl: { ...DEFAULT_TOOLS_CONFIG.firecrawl, ...parsed.firecrawl },
      anysearch: { ...DEFAULT_TOOLS_CONFIG.anysearch, ...parsed.anysearch },
    };
  } catch {
    return DEFAULT_TOOLS_CONFIG;
  }
}

export async function saveToolsConfig(config: ToolsUserConfig): Promise<void> {
  await setAppConfig(TOOLS_CONFIG_KEY, JSON.stringify(config, null, 2));
}

interface DepthPreset {
  maxResults: number;
  tavilySearchDepth: "fast" | "basic" | "advanced";
  allowDeepFetch: boolean;
}

const DEPTH_PRESETS: Record<SearchDepth, DepthPreset> = {
  fast: { maxResults: 3, tavilySearchDepth: "fast", allowDeepFetch: false },
  balanced: { maxResults: 6, tavilySearchDepth: "basic", allowDeepFetch: false },
  deep: { maxResults: 10, tavilySearchDepth: "advanced", allowDeepFetch: true },
};

const searchHitSchema = z.object({
  title: z.string(),
  url: z.string(),
  snippet: z.string(),
  content: z.string().optional(),
});

const MAX_RAW_LENGTH = 12_000;

function clamp(text: string): string {
  return text.length > MAX_RAW_LENGTH ? `${text.slice(0, MAX_RAW_LENGTH)}\n…[已截断]` : text;
}

const ANYSEARCH_API_BASE = "https://api.anysearch.com";

const ANYSEARCH_DOMAINS = [
  "general",
  "resource",
  "social_media",
  "finance",
  "academic",
  "legal",
  "health",
  "business",
  "security",
  "ip",
  "code",
  "energy",
  "environment",
  "agriculture",
  "travel",
  "film",
  "gaming",
] as const;

const MAX_RESULT_CONTENT = 2_000;

/** AnySearch 单次检索 / 子域查询超时(毫秒)。 */
const _ANYSEARCH_SEARCH_TIMEOUT_MS = 30_000;
/** AnySearch 批量检索 / 整页抓取超时(毫秒)——这两类调用耗时显著高于单次检索。 */
const _ANYSEARCH_BATCH_TIMEOUT_MS = 60_000;

function anysearchError(status: number, message: string): Error {
  if (status === 401) {
    return new Error(
      `AnySearch API Key 无效或已过期(${message})。让用户在 设置 → 工具 更换 Key,或清空 Key 改用匿名模式(限额更低)。`,
    );
  }
  if (status === 402) {
    return new Error(`AnySearch 配额已耗尽(${message})。让用户在控制台购买额度或等待额度重置。`);
  }
  if (status === 429) {
    return new Error(`AnySearch 触发限流(${message})。稍后重试,或让用户配置 API Key 提升限额。`);
  }
  return new Error(`AnySearch 请求失败(HTTP ${status}):${message}`);
}

async function anysearchFetch(
  path: string,
  apiKey: string,
  body: unknown,
  timeoutMs: number,
): Promise<unknown> {
  const response = await fetch(`${ANYSEARCH_API_BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Anysearch-Client": "mastra-desktop/1.0",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      typeof json === "object" &&
      json !== null &&
      typeof (json as { message?: unknown }).message === "string"
        ? (json as { message: string }).message
        : "响应不是合法 JSON";
    throw anysearchError(response.status, message);
  }
  return json;
}

interface AnySearchRestResponse {
  code?: number;
  message?: string;
  data?: {
    results?: Array<{ title?: string; url: string; snippet?: string; content?: string }>;
  };
}

async function anysearchToolCall(
  apiKey: string,
  tool: string,
  args: Record<string, unknown>,
  timeoutMs: number,
): Promise<string> {
  const json = (await anysearchFetch(
    "/mcp",
    apiKey,
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } },
    timeoutMs,
  )) as {
    error?: { message?: string };
    result?: { content?: Array<{ type: string; text?: string }> };
  } | null;
  if (!json) throw new Error(`AnySearch ${tool} 返回了无法解析的内容`);
  if (json.error) throw new Error(`AnySearch ${tool} 调用失败:${json.error.message ?? "未知错误"}`);
  const text = json.result?.content?.find((part) => part.type === "text")?.text;
  if (typeof text !== "string" || !text) throw new Error(`AnySearch ${tool} 未返回文本内容`);
  return text;
}

function createAnySearchTools(apiKey: string, preset: DepthPreset): ToolsInput {
  const search = createTool({
    id: "anysearch-search",
    description:
      "AnySearch 统一检索:按查询意图自动路由数据源(通用网页 + 金融/学术/代码/法律等垂直域)并融合排序。垂直话题先调 anysearch_get_sub_domains 拿 tag 与必填 params,再带 tag+params 检索;通用查询只传 query 即可。",
    inputSchema: z.object({
      query: z.string().min(1).describe("检索关键词或自然语言问题"),
      max_results: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .describe(`结果条数(1-20),不传时由当前强度档决定(${preset.maxResults})`),
      tag: z
        .string()
        .optional()
        .describe(
          '垂直域标签 {domain}.{sub_domain},如 "finance.quote"、"code.doc";取自 anysearch_get_sub_domains 返回的 sub_domain 列',
        ),
      zone: z.enum(["cn", "intl"]).optional().describe("地区;中文/国内信息传 cn,国际信息传 intl"),
      language: z.string().optional().describe("偏好语言,如 zh-CN 或 en"),
      params: z
        .record(z.string(), z.unknown())
        .optional()
        .describe(
          '垂直域扩展参数键值对,如 {"type":"stock","symbol":"AAPL"};tag 的必填参数见 anysearch_get_sub_domains',
        ),
    }),
    outputSchema: z.object({ results: z.array(searchHitSchema) }),
    execute: async ({ query, max_results, tag, zone, language, params }) => {
      const json = (await anysearchFetch(
        "/v1/search",
        apiKey,
        {
          query,
          max_results: max_results ?? preset.maxResults,
          ...(tag ? { tag } : {}),
          ...(zone ? { zone } : {}),
          ...(language ? { language } : {}),
          ...(params && Object.keys(params).length > 0 ? { params } : {}),
        },
        30_000,
      )) as AnySearchRestResponse | null;
      if (json?.code !== 0) {
        throw new Error(`AnySearch 检索失败:${json?.message ?? "响应不是合法 JSON"}`);
      }
      return {
        results: (json.data?.results ?? []).map((item) => ({
          title: item.title ?? item.url,
          url: item.url,
          snippet: clamp(item.snippet ?? ""),
          ...(item.content
            ? {
                content:
                  item.content.length > MAX_RESULT_CONTENT
                    ? `${item.content.slice(0, MAX_RESULT_CONTENT)}…[已截断]`
                    : item.content,
              }
            : {}),
        })),
      };
    },
  });

  const getSubDomains = createTool({
    id: "anysearch-get-sub-domains",
    description:
      "查询 AnySearch 垂直域目录:返回各子域的 tag、说明与参数 schema(Markdown 表格)。做垂直检索前先调用它,把返回的 sub_domain 作为 search 的 tag、必填参数作为 params 传入。",
    inputSchema: z.object({
      domains: z
        .array(z.enum(ANYSEARCH_DOMAINS))
        .min(1)
        .max(5)
        .describe("要查询的域(1-5 个),如 ['finance'] 或 ['code','academic']"),
    }),
    outputSchema: z.object({
      report: z.string().describe("子域目录 Markdown 表格:sub_domain | description | params"),
    }),
    execute: async ({ domains }) => ({
      report: await anysearchToolCall(
        apiKey,
        "get_sub_domains",
        domains.length === 1 ? { domain: domains[0] } : { domains },
        30_000,
      ),
    }),
  });

  const base: ToolsInput = { anysearch_search: search, anysearch_get_sub_domains: getSubDomains };
  if (!preset.allowDeepFetch) return base;

  return {
    ...base,
    anysearch_batch_search: createTool({
      id: "anysearch-batch-search",
      description:
        "AnySearch 并行批量检索:一次执行最多 5 条相互独立的查询,单条失败不影响其余。适合多意图问题或横向对比。",
      inputSchema: z.object({
        queries: z
          .array(
            z.object({
              query: z.string().min(1).describe("单条查询语句"),
              sub_domain: z
                .string()
                .optional()
                .describe('垂直 tag(如 "finance.quote"),取自 anysearch_get_sub_domains'),
              params: z
                .record(z.string(), z.unknown())
                .optional()
                .describe("该条查询的垂直域参数键值对"),
              max_results: z
                .number()
                .int()
                .min(1)
                .max(10)
                .optional()
                .describe("该条结果数上限(1-10)"),
            }),
          )
          .min(1)
          .max(5)
          .describe("1-5 条相互独立的查询"),
      }),
      outputSchema: z.object({ report: z.string().describe("各查询结果的合并 Markdown 报告") }),
      execute: async ({ queries }) => {
        const items = queries.map(({ query, sub_domain, params, max_results }) => ({
          query,
          ...(sub_domain
            ? {
                domain: sub_domain.split(".")[0],
                sub_domain,
                ...(params ? { sub_domain_params: params } : {}),
              }
            : {}),
          ...(max_results ? { max_results } : {}),
        }));
        return {
          report: clamp(
            await anysearchToolCall(apiKey, "batch_search", { queries: items }, 60_000),
          ),
        };
      },
    }),
    anysearch_extract: createTool({
      id: "anysearch-extract",
      description: "AnySearch 整页抓取:抓取单个 URL 的完整内容并转为 Markdown。",
      inputSchema: z.object({ url: z.url().describe("待抓取的页面地址") }),
      outputSchema: z.object({ markdown: z.string() }),
      execute: async ({ url }) => ({
        markdown: clamp(await anysearchToolCall(apiKey, "extract", { url }, 60_000)),
      }),
    }),
  };
}

function createFirecrawlTools(
  config: ToolsUserConfig["firecrawl"],
  preset: DepthPreset,
): ToolsInput {
  const firecrawl = new Firecrawl({
    apiKey: config.apiKey,
    ...(config.apiUrl ? { apiUrl: config.apiUrl } : {}),
  });

  const search = createTool({
    id: "firecrawl-search",
    description:
      "Firecrawl 联网检索:返回与查询最相关的网页条目。可用 sources/news、categories(github/research/pdf/developer)、tbs 时间过滤与域名过滤收窄结果。",
    inputSchema: z.object({
      query: z.string().min(1).describe("检索关键词或自然语言问题"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .describe(`结果条数上限,不传时由当前强度档决定(${preset.maxResults})`),
      sources: z
        .array(z.enum(["web", "news", "images"]))
        .optional()
        .describe('结果来源,默认 web;查新闻时传 ["news"]'),
      categories: z
        .array(z.enum(["github", "research", "pdf", "developer"]))
        .optional()
        .describe('按类别收窄网页结果(如代码问题传 ["github"])'),
      tbs: z
        .string()
        .optional()
        .describe(
          'Google 风格时间过滤,如 "qdr:h"(1小时) "qdr:d"(1天) "qdr:w"(1周) "qdr:m"(1月) "qdr:y"(1年)',
        ),
      location: z
        .string()
        .optional()
        .describe("地区定位(如 'us'、'cn'),影响结果的地域偏好;查本地化信息时使用"),
      includeDomains: z.array(z.url()).optional().describe("只保留这些域名的结果"),
      excludeDomains: z.array(z.url()).optional().describe("排除这些域名的结果"),
    }),
    outputSchema: z.object({ results: z.array(searchHitSchema) }),
    execute: async ({
      query,
      limit,
      sources,
      categories,
      tbs,
      location,
      includeDomains,
      excludeDomains,
    }) => {
      const response = await firecrawl.search(query, {
        limit: limit ?? preset.maxResults,
        ...(sources?.length ? { sources } : {}),
        ...(categories?.length ? { categories } : {}),
        ...(tbs ? { tbs } : {}),
        ...(location ? { location } : {}),
        ...(includeDomains?.length ? { includeDomains } : {}),
        ...(excludeDomains?.length ? { excludeDomains } : {}),
      });
      const web = (response.web ?? []) as Array<{
        title?: string | null;
        url: string;
        description?: string | null;
      }>;
      return {
        results: web.map((item) => ({
          title: item.title ?? item.url,
          url: item.url,
          snippet: clamp(item.description ?? ""),
        })),
      };
    },
  });

  if (!preset.allowDeepFetch) return { firecrawl_search: search };

  return {
    firecrawl_search: search,
    firecrawl_scrape: createTool({
      id: "firecrawl-scrape",
      description: "Firecrawl 整页抓取:抓取单个 URL 的主体内容并转为 Markdown。",
      inputSchema: z.object({
        url: z.url().describe("待抓取的页面地址"),
        onlyMainContent: z
          .boolean()
          .optional()
          .describe("仅保留主体内容(去导航/页脚等),默认 true;需要完整页面时传 false"),
      }),
      outputSchema: z.object({ markdown: z.string() }),
      execute: async ({ url, onlyMainContent }) => {
        const result = await firecrawl.scrape(url, {
          formats: ["markdown"],
          onlyMainContent: onlyMainContent ?? true,
        });
        return { markdown: clamp(result.markdown ?? "") };
      },
    }),
  };
}

export function parseWebSearchSelection(value: unknown): WebSearchSelection | null {
  if (typeof value !== "object" || value === null) return null;
  const { engine, depth } = value as { engine?: unknown; depth?: unknown };
  if (!SEARCH_ENGINES.includes(engine as SearchEngine)) return null;
  return {
    engine: engine as SearchEngine,
    depth: SEARCH_DEPTHS.includes(depth as SearchDepth) ? (depth as SearchDepth) : "balanced",
  };
}

export async function resolveWebSearchTools(
  selection: WebSearchSelection | null,
  modelFamily?: unknown,
): Promise<ToolsInput> {
  if (!selection) return {};
  const preset = DEPTH_PRESETS[selection.depth];

  if (selection.engine === "provider") {
    if (!supportsProviderSearch(modelFamily)) return {};
    return { web_search: webSearchTool, web_fetch: webFetchTool };
  }

  const config = await getToolsConfig();

  if (selection.engine === "tavily") {
    if (!config.tavily.apiKey) return {};
    const options = { apiKey: config.tavily.apiKey };
    return {
      web_fetch: webFetchTool,
      tavily_search: createTavilySearchTool(options),
      ...(preset.allowDeepFetch ? { tavily_extract: createTavilyExtractTool(options) } : {}),
    };
  }

  if (selection.engine === "firecrawl") {
    if (!config.firecrawl.apiKey) return {};
    return { web_fetch: webFetchTool, ...createFirecrawlTools(config.firecrawl, preset) };
  }

  return {
    web_fetch: webFetchTool,
    ...createAnySearchTools(config.anysearch.apiKey, preset),
  };
}

const ENGINE_LABELS: Record<SearchEngine, string> = {
  provider: "模型原生检索",
  tavily: "Tavily",
  firecrawl: "Firecrawl",
  anysearch: "AnySearch",
};

export function webSearchInstructions(
  selection: WebSearchSelection,
  toolsAvailable: boolean,
): string {
  const preset = DEPTH_PRESETS[selection.depth];
  if (!toolsAvailable) {
    if (selection.engine === "provider") {
      return `Web search was requested using the model's own native search, but the active model is not from OpenAI, Anthropic, Google or xAI, so no search tool is available. Tell the user to either switch to a model from one of those providers or pick a different search engine in the search menu, then answer from your own knowledge and mark it as possibly outdated.`;
    }
    return `Web search was requested (${ENGINE_LABELS[selection.engine]}) but its API key is missing, so no search tool is available. Tell the user to open Settings → 工具 and fill in the ${ENGINE_LABELS[selection.engine]} API key, then answer from your own knowledge and mark it as possibly outdated.`;
  }
  const engineHint =
    selection.engine === "provider"
      ? "Use web_search (your provider's native search). Result volume is decided by the provider, so make each query specific rather than asking for more results."
      : selection.engine === "tavily"
        ? `Call tavily-search with searchDepth='${preset.tavilySearchDepth}' and maxResults=${preset.maxResults}.`
        : selection.engine === "firecrawl"
          ? `Call firecrawl-search with limit=${preset.maxResults} by default; narrow results with sources (news), categories (github/research/pdf/developer), tbs time filters or domain filters when the query calls for it.`
          : "Prefer anysearch-search with a vertical domain for specialized queries; call anysearch_get_sub_domains first when unsure which domains exist.";
  const deepHint =
    selection.engine === "provider"
      ? "Use web_fetch to read the 1-3 most promising pages in full before concluding."
      : preset.allowDeepFetch
        ? selection.engine === "anysearch"
          ? "Use anysearch_batch_search to run up to 5 independent queries in parallel, and anysearch_extract to read the 1-3 most promising pages in full as Markdown."
          : "After searching, read the 1-3 most promising pages in full with the engine's extract/scrape tool (it renders JS and returns clean Markdown, so prefer it over web_fetch for pages you found via search)."
        : "Rely on result snippets; do not fetch full pages at this strength.";
  return `Web search is ON for this request (engine: ${ENGINE_LABELS[selection.engine]}, strength: ${selection.depth}).
- Any question that depends on current facts, prices, releases, docs or news MUST be answered from search results, never from memory alone.
- ${engineHint}
- ${deepHint}
- web_fetch reads one URL and returns its text. Use it when the user hands you a link directly, or as a fallback when no extract/scrape tool is available. It cannot reach localhost or private addresses, and returns isError instead of throwing — if it fails, say so rather than guessing the page content.
- Cite with GitHub-flavored Markdown footnotes. Put the marker immediately after the claim it supports, e.g. "Node 24 became LTS in October 2025[^1]."
- Define every marker you used at the very end of your reply, one per line, in this exact shape:
  [^1]: [Page title](https://exact-url-from-the-tool) — one short sentence on what this source says.
- Number markers 1, 2, 3… in order of first use, and reuse the same number when you cite the same source again. When one claim rests on several sources, put several links in one definition: [^2]: [A](https://a.example) [B](https://b.example) — what they jointly show.
- Only use URLs a tool actually returned; never invent a URL, and never leave a marker without its definition.`;
}
