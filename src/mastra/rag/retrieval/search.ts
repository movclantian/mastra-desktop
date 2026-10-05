/**
 * 资料库语义检索:允许的就绪资产 → LibSQLVector 过滤召回 → 可选重排 / GraphRAG。
 * 官方文档:docs/en/reference/rag/retrieval.mdx、rerank.mdx、rerankWithScorer.mdx、
 * graph-rag.mdx;返回带 citationId 的条目供前端 / 工具引用。
 */
import type { GatewayLanguageModel } from "@mastra/core/llm";
import { GraphRAG, MastraAgentRelevanceScorer, rerank, rerankWithScorer } from "@mastra/rag";
import { embed } from "ai";
import { resolveDefaultLanguageModel } from "../../models/providers";
import {
  getVector,
  libraryEmbedder,
  libraryIndexName,
  observedEmbeddingDimension,
} from "../document/indexing";
import { ensureLibrarySchema, getLibrarySettings, withClient } from "../storage/db";
import type { LibrarySearchResult } from "../types";

export async function searchLibrary(options: {
  resourceId: string;
  origin: string;
  query: string;
  threadId?: string;
  rerankModel?: GatewayLanguageModel;
  graphRag?: boolean;
}): Promise<LibrarySearchResult[]> {
  const { resourceId, origin, query, threadId, rerankModel, graphRag: graphRagOverride } = options;
  await ensureLibrarySchema();
  const settings = await getLibrarySettings(resourceId);
  const vector = await getVector();
  const { embedding } = await embed({ model: libraryEmbedder(), value: query });
  const dimension = observedEmbeddingDimension([embedding]);
  const indexName = libraryIndexName();
  const graphRag = graphRagOverride ?? settings.graphRag;
  const indexes = await vector.listIndexes();
  if (!indexes.includes(indexName)) return [];
  const refs = await withClient((client) =>
    client.execute({
      sql: `SELECT DISTINCT r.asset_id
        FROM library_asset_refs r
        JOIN library_assets a ON a.id = r.asset_id AND a.resource_id = r.resource_id
        WHERE r.resource_id = ?
          AND a.status = 'ready'
          AND (r.thread_id = '' OR r.thread_id = ?)`,
      args: [resourceId, threadId ?? ""],
    }),
  );
  const allowedAssetIds = refs.rows.map((row) => String(row.asset_id));
  if (allowedAssetIds.length === 0) return [];
  let allowed = await vector.query({
    indexName,
    queryVector: embedding,
    topK: settings.topK * (settings.rerank || graphRag ? 4 : 1),
    minScore: settings.minScore,
    filter: { resourceId, assetId: { $in: allowedAssetIds } },
    includeVector: graphRag,
  });
  if (settings.rerank && allowed.length > 0) {
    // The installed gateway's v2 declaration disagrees with RAG's provider types.
    // Keep that package boundary conversion here for every retrieval caller.
    const model = (rerankModel ?? (await resolveDefaultLanguageModel(resourceId))) as unknown as
      | Parameters<typeof rerank>[2]
      | undefined;
    if (model) {
      const rerankOptions = {
        topK: settings.topK,
        weights: {
          semantic: settings.rerankSemanticWeight,
          vector: settings.rerankVectorWeight,
          position: settings.rerankPositionWeight,
        },
      };
      const rerankResult =
        settings.rerankScorer === "mastra-agent"
          ? await rerankWithScorer({
              results: allowed,
              query,
              scorer: new MastraAgentRelevanceScorer("rag-reranker", model),
              options: rerankOptions,
            })
          : await rerank(allowed, query, model, rerankOptions);
      allowed = rerankResult.map((entry) => ({ ...entry.result, score: entry.score }));
    }
  }
  if (graphRag && allowed.length > 0) {
    const graph = new GraphRAG(dimension, settings.graphThreshold);
    const chunks = allowed.map((item) => ({
      text: String(item.metadata?.text ?? ""),
      metadata: { ...item.metadata, libraryChunkId: item.id },
    }));
    const embeddings = allowed.map((item) => ({
      vector: item.vector ?? [],
    }));
    graph.createGraph(chunks, embeddings);
    const rankedNodes = graph.query({
      query: embedding,
      topK: settings.topK,
      randomWalkSteps: settings.graphRandomWalkSteps,
      restartProb: settings.graphRestartProb,
    });
    // Identical text can belong to different chunks; preserve native IDs, order, and scores.
    const byId = new Map(allowed.map((item) => [item.id, item]));
    allowed = rankedNodes.map((node) => {
      const item = byId.get(node.metadata?.libraryChunkId);
      if (!item) throw new Error("GraphRAG returned an unknown library chunk");
      return { ...item, score: node.score };
    });
  }
  const sliced = allowed.slice(0, settings.topK);
  return sliced.map((item) => ({
    assetId: String(item.metadata?.assetId ?? ""),
    citationId: `library-${item.id}`,
    url: new URL(
      `/work/library/assets/${encodeURIComponent(String(item.metadata?.assetId ?? ""))}/content?resourceId=${encodeURIComponent(resourceId)}`,
      origin,
    ).href,
    filename: String(item.metadata?.filename ?? "未命名附件"),
    text: String(item.metadata?.text ?? ""),
    score: item.score,
  }));
}
