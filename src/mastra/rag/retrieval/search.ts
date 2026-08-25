/**
 * 资料库语义检索:查询嵌入 → LibSQLVector topK*4 召回 → 可选重排 → 可选 GraphRAG。
 * 官方文档:docs/en/reference/rag/retrieval.mdx、rerank.mdx、rerankWithScorer.mdx、
 * graph-rag.mdx;返回带 citationId 的条目供前端 / 工具引用。
 */
import type { MastraLanguageModel } from "@mastra/core/agent";
import { GraphRAG, MastraAgentRelevanceScorer, rerank, rerankWithScorer } from "@mastra/rag";
import { embed } from "ai";
import { resolveDefaultLanguageModel } from "../../models";
import {
  getVector,
  libraryEmbedder,
  libraryIndexName,
  observedEmbeddingDimension,
} from "../document/indexing";
import { getLibrarySettings } from "../settings";
import { ensureLibrarySchema, withClient } from "../storage/db";

export async function searchLibrary(options: {
  resourceId: string;
  query: string;
  threadId?: string;
  rerankModel?: MastraLanguageModel;
  graphRag?: boolean;
}) {
  const { resourceId, query, threadId, rerankModel, graphRag: graphRagOverride } = options;
  await ensureLibrarySchema();
  const settings = await getLibrarySettings(resourceId);
  const vector = await getVector();
  const { embedding } = await embed({ model: libraryEmbedder(), value: query });
  const dimension = observedEmbeddingDimension([embedding]);
  const indexName = libraryIndexName();
  const graphRag = graphRagOverride ?? settings.graphRag;
  const indexes = await vector.listIndexes();
  if (!indexes.includes(indexName)) return [];
  const results = await vector.query({
    indexName,
    queryVector: embedding,
    topK: settings.topK * 4,
    minScore: settings.minScore,
    filter: { resourceId },
    includeVector: graphRag,
  });
  const refs = await withClient((client) =>
    client.execute({
      sql: `SELECT DISTINCT r.asset_id
        FROM library_asset_refs r
        JOIN library_assets a ON a.id = r.asset_id AND a.resource_id = r.resource_id
        WHERE r.resource_id = ?
          AND a.status = 'ready'
          AND (? IS NULL OR r.thread_id = '' OR r.thread_id = ?)`,
      args: [resourceId, threadId ?? null, threadId ?? ""],
    }),
  );
  const allowedAssetIds = new Set(refs.rows.map((row) => String(row.asset_id)));
  let allowed = results.filter(
    (item) => item.metadata?.assetId && allowedAssetIds.has(String(item.metadata.assetId)),
  );
  if (settings.rerank && allowed.length > 0) {
    if (rerankModel) {
      const rerankResult = await rerankWithScorer({
        results: allowed,
        query,
        scorer: new MastraAgentRelevanceScorer("rag-reranker", rerankModel as never),
        options: { topK: settings.topK },
      });
      allowed = rerankResult.map((entry) => ({ ...entry.result, score: entry.score }));
    } else {
      const defaultModel = await resolveDefaultLanguageModel(resourceId);
      if (defaultModel) {
        const rerankResult = await rerank(allowed, query, defaultModel as never, {
          topK: settings.topK,
          weights: {
            semantic: settings.rerankSemanticWeight,
            vector: settings.rerankVectorWeight,
            position: settings.rerankPositionWeight,
          },
        });
        allowed = rerankResult.map((entry) => ({ ...entry.result, score: entry.score }));
      }
    }
  }
  if (graphRag && allowed.length > 0) {
    const graph = new GraphRAG(dimension, settings.graphThreshold);
    const chunks = allowed.map((item) => ({
      text: String(item.metadata?.text ?? ""),
      metadata: item.metadata ?? {},
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
    if (rankedNodes.length > 0) {
      const rankedMap = new Map(rankedNodes.map((node) => [node.content, node.score]));
      allowed.sort(
        (a, b) =>
          (rankedMap.get(String(b.metadata?.text ?? "")) ?? 0) -
          (rankedMap.get(String(a.metadata?.text ?? "")) ?? 0),
      );
    }
  }
  const sliced = allowed.slice(0, settings.topK);
  return sliced.map((item, index) => ({
    assetId: String(item.metadata?.assetId ?? ""),
    citationId: `library-${index + 1}`,
    filename: String(item.metadata?.filename ?? "未命名附件"),
    text: String(item.metadata?.text ?? ""),
    score: item.score,
  }));
}
