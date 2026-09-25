/**
 * 资料库工具(docs/en/docs/agents/tools.mdx + docs/en/reference/tools/):
 * - library_vector_search:向量召回与重排
 * - library_graph_search:GraphRAG 图谱随机游走检索
 * - library_document_chunker:MDocument 分块(调试 / 预处理用)
 */
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { chunkDocument, createDocument } from "./document/indexing";
import { searchLibrary } from "./retrieval/search";
import { getLibrarySettings } from "./settings";
import {
  LIBRARY_GRAPH_SEARCH_TOOL_ID,
  LIBRARY_RESOURCE_CONTEXT_KEY,
  LIBRARY_THREAD_CONTEXT_KEY,
  LIBRARY_VECTOR_SEARCH_TOOL_ID,
  type LibrarySettings,
  VALID_CHUNK_STRATEGIES,
} from "./types";

export function resolveChunkerSettings(
  defaults: LibrarySettings,
  overrides: {
    strategy?: LibrarySettings["chunkStrategy"];
    chunkSize?: number;
    chunkOverlap?: number;
  },
): LibrarySettings {
  const chunkSize = overrides.chunkSize ?? defaults.chunkSize;
  const chunkOverlap =
    overrides.chunkOverlap ??
    (defaults.chunkOverlap < chunkSize ? defaults.chunkOverlap : Math.floor(chunkSize / 5));
  if (!Number.isInteger(chunkSize) || chunkSize < 1) throw new Error("chunkSize 必须为正整数");
  if (!Number.isInteger(chunkOverlap) || chunkOverlap < 0 || chunkOverlap >= chunkSize) {
    throw new Error("chunkOverlap 必须为非负整数且小于 chunkSize");
  }
  return {
    ...defaults,
    chunkStrategy: overrides.strategy ?? defaults.chunkStrategy,
    chunkSize,
    chunkOverlap,
  };
}

export const libraryVectorSearchTool = createTool({
  id: LIBRARY_VECTOR_SEARCH_TOOL_ID,
  description:
    "在当前会话与全局资料库附件中进行向量语义检索。适用于检索用户上传的文档、代码、说明书或历史材料。",
  inputSchema: z.object({
    query: z.string().min(1).describe("检索查询词或自然语言问题"),
  }),
  outputSchema: z.object({
    results: z.array(
      z.object({
        citationId: z.string(),
        assetId: z.string(),
        filename: z.string(),
        text: z.string(),
        score: z.number().optional(),
      }),
    ),
  }),
  execute: async ({ query }, context) => {
    const resourceId =
      (context?.requestContext?.get(LIBRARY_RESOURCE_CONTEXT_KEY) as string) || "workbench";
    const threadIdValue = context?.requestContext?.get(LIBRARY_THREAD_CONTEXT_KEY);
    const threadId = typeof threadIdValue === "string" && threadIdValue ? threadIdValue : undefined;
    const results = await searchLibrary({ resourceId, query, threadId, graphRag: false });
    return { results };
  },
});

export const libraryGraphSearchTool = createTool({
  id: LIBRARY_GRAPH_SEARCH_TOOL_ID,
  description:
    "在当前会话与全局资料库中使用 GraphRAG 图谱随机游走检索。适用于复杂跨文档关联分析和实体跳转。",
  inputSchema: z.object({
    query: z.string().min(1).describe("关系检索或实体分析问题"),
  }),
  outputSchema: z.object({
    results: z.array(
      z.object({
        citationId: z.string(),
        assetId: z.string(),
        filename: z.string(),
        text: z.string(),
        score: z.number().optional(),
      }),
    ),
  }),
  execute: async ({ query }, context) => {
    const resourceId =
      (context?.requestContext?.get(LIBRARY_RESOURCE_CONTEXT_KEY) as string) || "workbench";
    const threadIdValue = context?.requestContext?.get(LIBRARY_THREAD_CONTEXT_KEY);
    const threadId = typeof threadIdValue === "string" && threadIdValue ? threadIdValue : undefined;
    const results = await searchLibrary({ resourceId, query, threadId, graphRag: true });
    return { results };
  },
});

export const libraryDocumentChunkerTool = createTool({
  id: "library-document-chunker",
  description:
    "使用 Mastra MDocument 引擎把长文本按照指定策略切分成片段,用于测试或预处理文档切块效果。",
  inputSchema: z.object({
    text: z.string().min(1).describe("待切分的纯文本或 Markdown 内容"),
    strategy: z
      .enum(VALID_CHUNK_STRATEGIES)
      .optional()
      .describe("切分策略 (recursive | markdown | html | character | token 等)"),
    chunkSize: z.number().int().positive().optional().describe("分块大小 (字符数或 token 数)"),
    chunkOverlap: z.number().int().nonnegative().optional().describe("相邻分块重叠大小"),
  }),
  outputSchema: z.object({
    chunks: z.array(
      z.object({
        index: z.number(),
        text: z.string(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      }),
    ),
  }),
  execute: async ({ text, strategy, chunkSize, chunkOverlap }, context) => {
    const resourceId = context?.requestContext?.get(LIBRARY_RESOURCE_CONTEXT_KEY) as
      | string
      | undefined;
    const defaultSettings = await getLibrarySettings(resourceId);
    const settings = resolveChunkerSettings(defaultSettings, { strategy, chunkSize, chunkOverlap });
    const format =
      strategy === "markdown"
        ? "text/markdown"
        : strategy === "html"
          ? "text/html"
          : strategy === "json"
            ? "application/json"
            : "";
    const doc = createDocument(text, "", format);
    const chunks = await chunkDocument(doc, settings);
    return {
      chunks: chunks.map((chunk, index) => ({
        index,
        text: chunk.text,
        metadata: chunk.metadata as Record<string, unknown> | undefined,
      })),
    };
  },
});
