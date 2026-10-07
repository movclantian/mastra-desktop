/**
 * 联网检索工具模块。
 * 官方文档:docs/en/integrations/tools/tavily.mdx(createTavilySearchTool /
 * createTavilyExtractTool)、firecrawl.mdx(Firecrawl SDK)。
 * webFetchTool 负责网页读取；AnySearch 通过官方 MCPClient 发现和调用远程工具。
 * MCP:docs/en/reference/tools/mcp-client.mdx；AnySearch 协议:
 * https://github.com/anysearch-ai/anysearch-mcp-server#mcp-transport
 * 引擎 + 强度档(fast/balanced/deep)经 RequestContext 传入,由 Agent 的动态
 * tools / instructions 消费(见 src/mastra/agents/work-agent.ts)。
 */
import { randomUUID } from "node:crypto";
import type { ToolsInput } from "@mastra/core/agent";
import type { Processor } from "@mastra/core/processors";
import { createTool, webFetchTool } from "@mastra/core/tools";
import { getMcpCallToolContent } from "@mastra/mcp";
import { createTavilyExtractTool, createTavilySearchTool } from "@mastra/tavily";
import { Firecrawl } from "firecrawl";
import { z } from "zod";
import {
  CredentialPointerSchema,
  CredentialStateSchema,
  searchCredentialPurpose,
} from "../../shared/credential-contract";
import { getConfiguredMcpTools, getMcpConfig } from "../connections/mcp";
import { deleteCredential, resolveCredential } from "../credential-broker";
import {
  archiveTextContent,
  contentObjectReference,
  contentReferenceText,
  contentSummary,
} from "../storage/content-objects";
import { getAppConfig, setAppConfig } from "../storage/database";

export const SEARCH_ENGINES = ["tavily", "firecrawl", "anysearch"] as const;
export type SearchEngine = (typeof SEARCH_ENGINES)[number];

export const SEARCH_DEPTHS = ["fast", "balanced", "deep"] as const;
export type SearchDepth = (typeof SEARCH_DEPTHS)[number];

interface WebSearchSelection {
  engine: SearchEngine;
  depth: SearchDepth;
}

export const WEB_SEARCH_CONTEXT_KEY = "webSearch";

export type ToolsUserConfig = z.infer<typeof toolsConfigSchema>;

const TOOLS_CONFIG_KEY = "web-search";

const DEFAULT_TOOLS_CONFIG: ToolsUserConfig = {
  tavily: { hasCredential: false },
  firecrawl: { hasCredential: false, apiUrl: "" },
};

export const toolsConfigSchema = z
  .object({
    tavily: CredentialStateSchema,
    firecrawl: z.union([
      CredentialPointerSchema.extend({ apiUrl: z.string().max(2_048) }),
      z.object({ hasCredential: z.literal(false), apiUrl: z.string().max(2_048) }).strict(),
    ]),
  })
  .strict();

export async function getToolsConfig(resourceId?: string) {
  const [raw, mcp] = await Promise.all([
    getAppConfig(TOOLS_CONFIG_KEY, resourceId),
    getMcpConfig(resourceId),
  ]);
  const config = raw ? toolsConfigSchema.parse(JSON.parse(raw)) : DEFAULT_TOOLS_CONFIG;
  const anysearch = mcp.servers.find((server) => server.builtin === "anysearch");
  return {
    ...config,
    anysearch: { enabled: anysearch?.enabled === true, connectionId: anysearch?.id },
  };
}

export async function saveToolsConfig(config: unknown, resourceId?: string): Promise<void> {
  const next = toolsConfigSchema.parse(config);
  const current = await getToolsConfig(resourceId);
  await Promise.all(
    (["tavily", "firecrawl"] as const).map((engine) =>
      next[engine].hasCredential
        ? resolveCredential(next[engine].credentialRef, searchCredentialPurpose(engine))
        : undefined,
    ),
  );
  await setAppConfig(TOOLS_CONFIG_KEY, JSON.stringify(next, null, 2), resourceId);
  await Promise.all(
    (["tavily", "firecrawl"] as const).map(async (engine) => {
      const oldConfig = current[engine];
      const newConfig = next[engine];
      if (
        oldConfig.hasCredential &&
        (!newConfig.hasCredential || oldConfig.credentialRef !== newConfig.credentialRef)
      ) {
        await deleteCredential(oldConfig.credentialRef, searchCredentialPurpose(engine)).catch(
          () => undefined,
        );
      }
    }),
  );
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
  contentObject: z
    .object({
      objectId: z.string(),
      sha256: z.string(),
      byteSize: z.number(),
      workspacePath: z.string(),
    })
    .optional(),
});

const MAX_RAW_LENGTH = 12_000;

function clamp(text: string): string {
  return text.length > MAX_RAW_LENGTH ? `${text.slice(0, MAX_RAW_LENGTH)}\n…[已截断]` : text;
}

async function archiveWebText(
  text: string,
  context: { requestContext?: { get?: (key: string) => unknown } },
  options: { source: string; contentType: string },
) {
  const metadata = await archiveTextContent(text, context, {
    kind: "web",
    source: options.source,
    contentType: options.contentType,
  });
  return {
    summary: contentSummary(text),
    contentObject: contentObjectReference(metadata),
    readHint: contentReferenceText(metadata),
    characterCount: metadata.characterCount ?? text.length,
    byteSize: metadata.byteSize,
  };
}

const archivedFetchOutput = z.object({
  content: z.string(),
  contentObject: z.object({
    objectId: z.string(),
    sha256: z.string(),
    byteSize: z.number(),
    workspacePath: z.string(),
  }),
  readHint: z.string(),
  characterCount: z.number(),
  byteSize: z.number(),
  url: z.string().optional(),
  status: z.number().optional(),
  ok: z.boolean().optional(),
  isError: z.boolean().optional(),
});

function createArchivedWebFetchTool() {
  return createTool({
    id: "web_fetch",
    description:
      "读取一个公开网页并将完整正文保存为当前用户的内容对象。返回摘要和引用；使用返回的 workspacePath 调用官方 mastra_workspace_read_file 或 mastra_workspace_grep 获取全文。",
    inputSchema: z.object({ url: z.url().describe("要读取的公开网页地址") }),
    outputSchema: archivedFetchOutput,
    execute: async ({ url }, context) => {
      if (!webFetchTool.execute) throw new Error("Web fetch tool is unavailable");
      const result = (await webFetchTool.execute({ url }, context)) as {
        content?: string;
        contentType?: string | null;
        url?: string;
        status?: number;
        ok?: boolean;
        isError?: boolean;
      };
      const content =
        typeof result?.content === "string" ? result.content : JSON.stringify(result ?? "");
      const archived = await archiveWebText(content, context, {
        source: url,
        contentType: result?.contentType ?? "text/plain; charset=utf-8",
      });
      return {
        content: archived.summary,
        contentObject: archived.contentObject,
        readHint: archived.readHint,
        characterCount: archived.characterCount,
        byteSize: archived.byteSize,
        ...(result?.url ? { url: result.url } : {}),
        ...(typeof result?.status === "number" ? { status: result.status } : {}),
        ...(typeof result?.ok === "boolean" ? { ok: result.ok } : {}),
        ...(typeof result?.isError === "boolean" ? { isError: result.isError } : {}),
      };
    },
  });
}

/** Archive full pages before native tool results reach memory, streams, or the next model call. */
export const webSearchArchiveProcessor = {
  id: "web-search-content-archive",
  async processToolResult({ toolName, toolCallId, args, result, messageList, requestContext }) {
    if (toolName === "anysearch_extract" || toolName === "anysearch_batch_search") {
      const content =
        getMcpCallToolContent(result) ??
        (result && typeof result === "object" && "content" in result ? result.content : undefined);
      const text = Array.isArray(content)
        ? content
            .flatMap((part: unknown) =>
              part &&
              typeof part === "object" &&
              "type" in part &&
              part.type === "text" &&
              "text" in part &&
              typeof part.text === "string"
                ? [part.text]
                : [],
            )
            .join("\n")
        : typeof result === "string"
          ? result
          : JSON.stringify(result);
      if (!text) return;
      const source =
        args && typeof args === "object" && "url" in args && typeof args.url === "string"
          ? args.url
          : `anysearch:${toolName}`;
      const archived = await archiveWebText(
        text,
        { requestContext },
        {
          source,
          contentType: "text/markdown; charset=utf-8",
        },
      );
      messageList.updateToolInvocation({
        type: "tool-invocation",
        toolInvocation: {
          state: "result",
          toolCallId,
          toolName,
          args,
          result: { content: [{ type: "text", text: archived.summary }], ...archived },
        },
      });
      return;
    }
    if (toolName !== "tavily_search" && toolName !== "tavily_extract") return;
    if (
      !result ||
      typeof result !== "object" ||
      !("results" in result) ||
      !Array.isArray(result.results)
    )
      return;
    const plainText =
      args &&
      typeof args === "object" &&
      (("format" in args && args.format === "text") ||
        ("includeRawContent" in args && args.includeRawContent === "text"));
    const results = await Promise.all(
      result.results.map(async (item: unknown) => {
        if (
          !item ||
          typeof item !== "object" ||
          !("rawContent" in item) ||
          typeof item.rawContent !== "string" ||
          !("url" in item) ||
          typeof item.url !== "string"
        )
          return item;
        const archived = await archiveWebText(
          item.rawContent,
          { requestContext },
          {
            source: item.url,
            contentType: plainText ? "text/plain; charset=utf-8" : "text/markdown; charset=utf-8",
          },
        );
        return {
          ...item,
          rawContent: archived.summary,
          contentObject: archived.contentObject,
          characterCount: archived.characterCount,
          readHint: archived.readHint,
        };
      }),
    );
    messageList.updateToolInvocation({
      type: "tool-invocation",
      toolInvocation: {
        state: "result",
        toolCallId,
        toolName,
        args,
        result: { ...result, results },
      },
    });
  },
} satisfies Processor;

async function createAnySearchTools(preset: DepthPreset, resourceId?: string): Promise<ToolsInput> {
  const tools = await getConfiguredMcpTools(resourceId, "anysearch");
  const enabled = new Set([
    "anysearch_search",
    "anysearch_get_sub_domains",
    ...(preset.allowDeepFetch ? ["anysearch_batch_search", "anysearch_extract"] : []),
  ]);
  return Object.fromEntries(Object.entries(tools).filter(([name]) => enabled.has(name)));
}

function createFirecrawlTools(
  config: { apiKey: string; apiUrl: string },
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
      outputSchema: z.object({
        markdown: z.string(),
        contentObject: z.object({
          objectId: z.string(),
          sha256: z.string(),
          byteSize: z.number(),
          workspacePath: z.string(),
        }),
        characterCount: z.number(),
        readHint: z.string(),
      }),
      execute: async ({ url, onlyMainContent }, context) => {
        const result = await firecrawl.scrape(url, {
          formats: ["markdown"],
          onlyMainContent: onlyMainContent ?? true,
        });
        const markdown = result.markdown ?? "";
        const metadata = await archiveTextContent(markdown, context, {
          kind: "web",
          source: url,
          contentType: "text/markdown; charset=utf-8",
        });
        return {
          markdown: contentSummary(markdown),
          contentObject: contentObjectReference(metadata),
          characterCount: metadata.characterCount ?? markdown.length,
          readHint: contentReferenceText(metadata),
        };
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
  resourceId?: string,
): Promise<ToolsInput> {
  if (!selection) return {};
  const preset = DEPTH_PRESETS[selection.depth];

  const config = await getToolsConfig(resourceId);

  if (selection.engine === "tavily") {
    if (!config.tavily.hasCredential) return {};
    const apiKey = await resolveCredential(
      config.tavily.credentialRef,
      searchCredentialPurpose("tavily"),
    );
    return {
      web_fetch: createArchivedWebFetchTool(),
      tavily_search: createTavilySearchTool({ apiKey }),
      ...(preset.allowDeepFetch ? { tavily_extract: createTavilyExtractTool({ apiKey }) } : {}),
    };
  }

  if (selection.engine === "firecrawl") {
    if (!config.firecrawl.hasCredential) return {};
    const apiKey = await resolveCredential(
      config.firecrawl.credentialRef,
      searchCredentialPurpose("firecrawl"),
    );
    return {
      web_fetch: createArchivedWebFetchTool(),
      ...createFirecrawlTools({ apiKey, apiUrl: config.firecrawl.apiUrl }, preset),
    };
  }

  if (!config.anysearch.enabled) return {};
  return {
    web_fetch: createArchivedWebFetchTool(),
    ...(await createAnySearchTools(preset, resourceId)),
  };
}

const ENGINE_LABELS: Record<SearchEngine, string> = {
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
    return `Web search was requested (${ENGINE_LABELS[selection.engine]}) but the connection is unavailable, so no search tool is available. Tell the user to check ${selection.engine === "anysearch" ? "MCP management → AnySearch" : "Settings → 工具"}, then answer from your own knowledge and mark it as possibly outdated.`;
  }
  const engineHint =
    selection.engine === "tavily"
      ? `Call tavily_search with searchDepth='${preset.tavilySearchDepth}' and maxResults=${preset.maxResults}.`
      : selection.engine === "firecrawl"
        ? `Call firecrawl-search with limit=${preset.maxResults} by default; narrow results with sources (news), categories (github/research/pdf/developer), tbs time filters or domain filters when the query calls for it.`
        : `Call anysearch_search with max_results=${preset.maxResults}; for specialized queries, call anysearch_get_sub_domains first and use its domain, sub_domain and sub_domain_params.`;
  const deepHint = preset.allowDeepFetch
    ? selection.engine === "anysearch"
      ? "Use anysearch_batch_search to run up to 5 independent queries in parallel, and anysearch_extract to archive the 1-3 most promising pages as Markdown. Use the official workspace read_file or grep tool with the returned workspacePath when details are needed."
      : "After searching, archive the 1-3 most promising pages with the engine's extract/scrape tool, then use the official workspace read_file or grep tool with the returned workspacePath when details are needed."
    : "Rely on result snippets; do not fetch full pages at this strength.";
  return `Web search is ON for this request (engine: ${ENGINE_LABELS[selection.engine]}, strength: ${selection.depth}).
- Any question that depends on current facts, prices, releases, docs or news MUST be answered from search results, never from memory alone.
- ${engineHint}
- ${deepHint}
- web_fetch reads one URL, saves the complete response as a user-scoped content object, and returns only a summary plus objectId/workspacePath. Use the official mastra_workspace_read_file for line ranges or mastra_workspace_grep for keyword/regex matches. It cannot reach localhost or private addresses, and returns isError instead of throwing — if it fails, say so rather than guessing the page content.
- Cite with GitHub-flavored Markdown footnotes. Put the marker immediately after the claim it supports, e.g. "Node 24 became LTS in October 2025[^1]."
- Define every marker you used at the very end of your reply, one per line, in this exact shape:
  [^1]: [Page title](https://exact-url-from-the-tool) — one short sentence on what this source says.
- Number markers 1, 2, 3… in order of first use, and reuse the same number when you cite the same source again. When one claim rests on several sources, put several links in one definition: [^2]: [A](https://a.example) [B](https://b.example) — what they jointly show.
- Only use URLs a tool actually returned; never invent a URL, and never leave a marker without its definition.`;
}
