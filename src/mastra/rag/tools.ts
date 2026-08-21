import { createTool } from "@mastra/core/tools";
import { MDocument } from "@mastra/rag";
import { z } from "zod";
import { chunkDocument } from "./document/indexing";
import { searchLibrary } from "./retrieval/search";
import { getLibrarySettings } from "./settings";
import {
  LIBRARY_GRAPH_SEARCH_TOOL_ID,
  LIBRARY_VECTOR_SEARCH_TOOL_ID,
  VALID_CHUNK_STRATEGIES,
} from "./types";

/**
 * 资料库工具 (docs/en/reference/tools/, docs/en/reference/rag/):
 * - library_vector_search: 向量召回与重排 (默认支持)
 * - library_graph_search: 显式开启 GraphRAG 游走检索
 * - library_document_chunker: 文档分块实验工具
 */

export const libraryVectorSearchTool = createTool({
  id: LIBRARY_VECTOR_SEARCH_TOOL_ID,
  description:
    "在当前工作区与当前会话的知识库附件中进行向量语义检索。适用于检索用户上传的文档、代码、说明书或历史材料。",
  inputSchema: z.object({
    query: z.string().min(1).describe("检索查询词或自然语言问题"),
    threadId: z.string().optional().describe("限定会话 ID (可选,默认包含当前会话和全局附件)"),
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
  execute: async ({ query, threadId }, context) => {
    const resourceId = (context?.requestContext?.get("resourceId") as string) || "workbench";
    const results = await searchLibrary(resourceId, query, threadId, undefined, false);
    return { results };
  },
});

export const libraryGraphSearchTool = createTool({
  id: LIBRARY_GRAPH_SEARCH_TOOL_ID,
  description:
    "在知识库中使用 GraphRAG 图谱随机游走检索。适用于复杂跨文档关联分析、实体跳转和全局拓扑理解。",
  inputSchema: z.object({
    query: z.string().min(1).describe("关系检索或实体分析问题"),
    threadId: z.string().optional().describe("限定会话 ID (可选)"),
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
  execute: async ({ query, threadId }, context) => {
    const resourceId = (context?.requestContext?.get("resourceId") as string) || "workbench";
    const results = await searchLibrary(resourceId, query, threadId, undefined, true);
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
  execute: async ({ text, strategy, chunkSize, chunkOverlap }) => {
    const defaultSettings = await getLibrarySettings();
    const settings = {
      ...defaultSettings,
      ...(strategy ? { chunkStrategy: strategy } : {}),
      ...(chunkSize ? { chunkSize } : {}),
      ...(chunkOverlap !== undefined ? { chunkOverlap } : {}),
    };
    const doc = MDocument.fromText(text);
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
