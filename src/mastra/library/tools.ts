import type { MastraLanguageModel } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { MDocument } from "@mastra/rag";
import { z } from "zod";
import { chunkDocument } from "./indexing";
import { searchLibrary } from "./search";
import { getLibrarySettings } from "./settings";
import {
  LIBRARY_ORIGIN_CONTEXT_KEY,
  LIBRARY_RERANK_MODEL_CONTEXT_KEY,
  LIBRARY_RESOURCE_CONTEXT_KEY,
  LIBRARY_THREAD_CONTEXT_KEY,
  type LibrarySettings,
} from "./types";

/**
 * 暴露给 Agent 的资料库工具(docs/en/docs/agents/tools.mdx):
 * 向量检索 / GraphRAG 检索 / 文档分块。资源与线程边界由 RequestContext 固定,
 * 模型只能指定查询内容,不能越权检索其他用户的资料。
 */

const librarySearchOutputSchema = z.object({
  results: z.array(
    z.object({
      assetId: z.string(),
      citationId: z.string(),
      filename: z.string(),
      text: z.string(),
      score: z.number(),
      url: z.string().url().optional(),
    }),
  ),
});

function requestLibraryScope(
  context: { requestContext?: { get: (key: string) => unknown } } | undefined,
) {
  const resourceId = context?.requestContext?.get(LIBRARY_RESOURCE_CONTEXT_KEY);
  if (typeof resourceId !== "string" || !resourceId) {
    throw new Error("当前请求没有资料库资源边界");
  }
  const threadId = context?.requestContext?.get(LIBRARY_THREAD_CONTEXT_KEY);
  const origin = context?.requestContext?.get(LIBRARY_ORIGIN_CONTEXT_KEY);
  const rerankModel = context?.requestContext?.get(LIBRARY_RERANK_MODEL_CONTEXT_KEY);
  return {
    resourceId,
    threadId: typeof threadId === "string" ? threadId : undefined,
    origin: typeof origin === "string" ? origin : undefined,
    rerankModel: rerankModel as MastraLanguageModel | undefined,
  };
}

function addLibraryResultUrls(
  results: Awaited<ReturnType<typeof searchLibrary>>,
  origin: string | undefined,
  resourceId: string,
) {
  return results.map((result) => ({
    ...result,
    ...(origin
      ? {
          url: new URL(
            `/work/library/assets/${encodeURIComponent(result.assetId)}/content?resourceId=${encodeURIComponent(resourceId)}`,
            origin,
          ).href,
        }
      : {}),
  }));
}

export const libraryVectorSearchTool = createTool({
  id: "library-vector-search",
  description: "使用 FastEmbed 与 LibSQL 向量索引检索当前用户资料库。用户和会话过滤由系统固定。",
  inputSchema: z.object({
    query: z.string().min(1).describe("要在资料库中查找的信息"),
  }),
  outputSchema: librarySearchOutputSchema,
  execute: async ({ query }, context) => {
    const scope = requestLibraryScope(context);
    return {
      results: addLibraryResultUrls(
        await searchLibrary(scope.resourceId, query, scope.threadId, scope.rerankModel, false),
        scope.origin,
        scope.resourceId,
      ),
    };
  },
});

export const libraryGraphSearchTool = createTool({
  id: "library-graph-search",
  description:
    "使用 GraphRAG 检索当前用户资料库，适合关系理解、跨分块关联与多跳问题。用户和会话过滤由系统固定。",
  inputSchema: z.object({
    query: z.string().min(1).describe("需要关系扩展检索的问题"),
  }),
  outputSchema: librarySearchOutputSchema,
  execute: async ({ query }, context) => {
    const scope = requestLibraryScope(context);
    return {
      results: addLibraryResultUrls(
        await searchLibrary(scope.resourceId, query, scope.threadId, scope.rerankModel, true),
        scope.origin,
        scope.resourceId,
      ),
    };
  },
});

export const libraryDocumentChunkerTool = createTool({
  id: "library-document-chunker",
  description: "按资料库当前分块配置切分一段文本，返回可用于后续分析的结构化分块。",
  inputSchema: z.object({
    text: z.string().min(1).max(200_000),
    strategy: z
      .enum([
        "recursive",
        "character",
        "token",
        "markdown",
        "html",
        "json",
        "latex",
        "sentence",
        "semantic-markdown",
      ])
      .optional(),
  }),
  outputSchema: z.object({
    chunks: z.array(z.object({ text: z.string(), metadata: z.record(z.string(), z.unknown()) })),
  }),
  execute: async ({ text, strategy }) => {
    const current = await getLibrarySettings();
    const settings: LibrarySettings = {
      ...current,
      chunkStrategy: strategy ?? current.chunkStrategy,
      extractTitle: false,
      extractSummary: false,
      extractQuestions: false,
      extractKeywords: false,
    };
    const chunks = await chunkDocument(MDocument.fromText(text), settings);
    return {
      chunks: chunks.map((chunk) => ({ text: chunk.text, metadata: chunk.metadata ?? {} })),
    };
  },
});
