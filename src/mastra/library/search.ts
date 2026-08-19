import type { MastraLanguageModel } from "@mastra/core/agent";
import { GraphRAG, MastraAgentRelevanceScorer, rerank, rerankWithScorer } from "@mastra/rag";
import { embed } from "ai";
import { ensureLibrarySchema, withClient } from "./db";
import { embeddingModelFor, getVector, libraryIndexName } from "./indexing";
import { getLibrarySettings } from "./settings";

/**
 * 资料库语义检索:按资料库设置生成查询嵌入 → LibSQLVector topK*4 召回(带资源/线程
 * 过滤)→ 可选重排(rerank 或 MastraAgentRelevanceScorer)→ 可选 GraphRAG
 * 随机游走重排。返回带 citationId 的条目供前端/工具引用。
 */

export async function searchLibrary(
  resourceId: string,
  query: string,
  threadId?: string,
  rerankModel?: MastraLanguageModel,
  graphRagOverride?: boolean,
) {
  await ensureLibrarySchema();
  const settings = await getLibrarySettings();
  const vector = await getVector();
  const indexName = libraryIndexName(settings);
  const embeddingModel = await embeddingModelFor(settings);
  const graphRag = graphRagOverride ?? settings.graphRag;
  const indexes = await vector.listIndexes();
  if (!indexes.includes(indexName)) return [];
  const { embedding } = await embed({ model: embeddingModel, value: query });
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
    (result) =>
      result.metadata?.resourceId === resourceId &&
      allowedAssetIds.has(String(result.metadata?.assetId ?? "")),
  );
  if (settings.rerank && rerankModel && allowed.length > 1) {
    const options = {
      queryEmbedding: embedding,
      topK: Math.min(allowed.length, settings.topK * 2),
      weights: {
        semantic: settings.rerankSemanticWeight,
        vector: settings.rerankVectorWeight,
        position: settings.rerankPositionWeight,
      },
    };
    const reranked =
      settings.rerankScorer === "mastra-agent"
        ? await rerankWithScorer({
            results: allowed,
            query,
            scorer: new MastraAgentRelevanceScorer("library-reranker", rerankModel),
            options,
          })
        : await rerank(allowed, query, rerankModel, options);
    allowed = reranked.map((entry) => ({ ...entry.result, score: entry.score }));
  }
  if (graphRag && allowed.length > 1 && allowed.every((result) => result.vector)) {
    const graph = new GraphRAG(allowed[0].vector?.length ?? 384, settings.graphThreshold);
    graph.createGraph(
      allowed.map((result) => ({
        text: String(result.metadata?.text ?? ""),
        metadata: result.metadata ?? {},
      })),
      allowed.map((result) => ({ vector: result.vector ?? [] })),
    );
    const ranked = graph.query({
      query: embedding,
      topK: settings.topK,
      randomWalkSteps: settings.graphRandomWalkSteps,
      restartProb: settings.graphRestartProb,
      filter: { resourceId },
    });
    return ranked.map((result) => ({
      id: result.id,
      citationId: `library-${result.id}`,
      score: result.score,
      text: String(result.metadata?.text ?? result.content ?? ""),
      assetId: String(result.metadata?.assetId ?? ""),
      filename: String(result.metadata?.filename ?? ""),
    }));
  }
  return allowed.slice(0, settings.topK).map((result) => ({
    id: result.id,
    citationId: `library-${result.id}`,
    score: result.score,
    text: String(result.metadata?.text ?? ""),
    assetId: String(result.metadata?.assetId ?? ""),
    filename: String(result.metadata?.filename ?? ""),
  }));
}
