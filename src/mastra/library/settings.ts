import { getProvidersConfig } from "../agents/llm";
import { getAppConfig, setAppConfig } from "../storage";
import { ensureLibrarySchema, now, rowToAsset, withClient } from "./db";
import { queueAssetIndex } from "./indexing";
import { DEFAULT_LIBRARY_SETTINGS, type LibrarySettings } from "./types";

/**
 * 资料库设置(app_config 表 key = "library"):分块 / 检索 / GraphRAG / 重排 /
 * 嵌入模型 / 元数据抽取。设置面板「知识库」写入;分块或嵌入相关字段变化时,
 * 触发已存档资产的按新参数重建索引。
 */

const LIBRARY_SETTINGS_KEY = "library";

function finiteNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const CHUNK_STRATEGIES = new Set<LibrarySettings["chunkStrategy"]>([
  "recursive",
  "character",
  "token",
  "markdown",
  "html",
  "json",
  "latex",
  "sentence",
  "semantic-markdown",
]);

function parseLibrarySettings(
  value: Partial<LibrarySettings>,
  current = DEFAULT_LIBRARY_SETTINGS,
): LibrarySettings {
  const semantic = Math.max(
    0,
    finiteNumber(value.rerankSemanticWeight, current.rerankSemanticWeight),
  );
  const vector = Math.max(0, finiteNumber(value.rerankVectorWeight, current.rerankVectorWeight));
  const position = Math.max(
    0,
    finiteNumber(value.rerankPositionWeight, current.rerankPositionWeight),
  );
  const weightTotal = semantic + vector + position || 1;
  return {
    chunkSize: Math.min(4000, Math.max(300, finiteNumber(value.chunkSize, current.chunkSize))),
    chunkOverlap: Math.min(
      800,
      Math.max(0, finiteNumber(value.chunkOverlap, current.chunkOverlap)),
    ),
    chunkStrategy: CHUNK_STRATEGIES.has(value.chunkStrategy ?? current.chunkStrategy)
      ? (value.chunkStrategy ?? current.chunkStrategy)
      : current.chunkStrategy,
    topK: Math.min(30, Math.max(1, finiteNumber(value.topK, current.topK))),
    minScore: Math.min(1, Math.max(0, finiteNumber(value.minScore, current.minScore))),
    graphRag: value.graphRag === undefined ? current.graphRag : value.graphRag === true,
    graphThreshold: Math.min(
      0.9,
      Math.max(0.4, finiteNumber(value.graphThreshold, current.graphThreshold)),
    ),
    graphRandomWalkSteps: Math.min(
      500,
      Math.max(
        10,
        Math.floor(finiteNumber(value.graphRandomWalkSteps, current.graphRandomWalkSteps)),
      ),
    ),
    graphRestartProb: Math.min(
      0.9,
      Math.max(0.01, finiteNumber(value.graphRestartProb, current.graphRestartProb)),
    ),
    rerank: value.rerank === undefined ? current.rerank : value.rerank === true,
    rerankScorer:
      value.rerankScorer === "mastra-agent"
        ? "mastra-agent"
        : value.rerankScorer === "model"
          ? "model"
          : current.rerankScorer,
    rerankSemanticWeight: semantic / weightTotal,
    rerankVectorWeight: vector / weightTotal,
    rerankPositionWeight: position / weightTotal,
    embeddingModel:
      typeof value.embeddingModel === "string" &&
      (value.embeddingModel === "small" ||
        value.embeddingModel === "base" ||
        /^[^/\s]+\/[^/\s]+$/.test(value.embeddingModel))
        ? value.embeddingModel
        : current.embeddingModel,
    extractTitle:
      value.extractTitle === undefined ? current.extractTitle : value.extractTitle === true,
    extractSummary:
      value.extractSummary === undefined ? current.extractSummary : value.extractSummary === true,
    extractQuestions:
      value.extractQuestions === undefined
        ? current.extractQuestions
        : value.extractQuestions === true,
    extractKeywords:
      value.extractKeywords === undefined
        ? current.extractKeywords
        : value.extractKeywords === true,
  };
}

export async function getLibrarySettings(): Promise<LibrarySettings> {
  const raw = await getAppConfig(LIBRARY_SETTINGS_KEY);
  if (!raw) return DEFAULT_LIBRARY_SETTINGS;
  try {
    const value = JSON.parse(raw) as Partial<LibrarySettings>;
    return parseLibrarySettings(value);
  } catch {
    return DEFAULT_LIBRARY_SETTINGS;
  }
}

export async function saveLibrarySettings(
  input: Partial<LibrarySettings>,
): Promise<LibrarySettings> {
  const current = await getLibrarySettings();
  if (typeof input.embeddingModel === "string" && input.embeddingModel.includes("/")) {
    const separator = input.embeddingModel.indexOf("/");
    const providerId = input.embeddingModel.slice(0, separator);
    const modelId = input.embeddingModel.slice(separator + 1);
    const providers = await getProvidersConfig();
    const provider = providers.providers.find(
      (candidate) =>
        candidate.id === providerId || (candidate.registryId ?? candidate.id) === providerId,
    );
    const enabled = provider?.enabledModels.some(
      (model) => model.id === modelId && (model as { embedding?: boolean }).embedding === true,
    );
    if (!provider || provider.disabled || !enabled) {
      throw new Error("请选择已在模型供应商中启用的 embedding 模型");
    }
  }
  const settings = parseLibrarySettings(input, current);
  if (settings.chunkOverlap >= settings.chunkSize)
    settings.chunkOverlap = Math.floor(settings.chunkSize / 4);
  await setAppConfig(LIBRARY_SETTINGS_KEY, JSON.stringify(settings));
  if (
    settings.chunkSize !== current.chunkSize ||
    settings.chunkOverlap !== current.chunkOverlap ||
    settings.chunkStrategy !== current.chunkStrategy ||
    settings.embeddingModel !== current.embeddingModel ||
    settings.extractTitle !== current.extractTitle ||
    settings.extractSummary !== current.extractSummary ||
    settings.extractQuestions !== current.extractQuestions ||
    settings.extractKeywords !== current.extractKeywords
  ) {
    void reindexStoredAssets(settings).catch(() => undefined);
  }
  return settings;
}

/** 按给定(通常是刚保存的)设置重建所有已抽取文本资产的向量索引 */
async function reindexStoredAssets(settings: LibrarySettings): Promise<void> {
  await ensureLibrarySchema();
  const result = await withClient((client) =>
    client.execute({
      sql: "SELECT * FROM library_assets WHERE extracted_text IS NOT NULL AND extracted_text != ''",
      args: [],
    }),
  );
  for (const row of result.rows) {
    const asset = rowToAsset(row);
    await withClient((client) =>
      client.execute({
        sql: "UPDATE library_assets SET status = ?, updated_at = ? WHERE id = ? AND resource_id = ?",
        args: ["indexing", now(), asset.id, asset.resourceId],
      }),
    );
    void queueAssetIndex(asset, asset.extractedText ?? "", settings).catch(() => undefined);
  }
}
