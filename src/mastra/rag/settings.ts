import { getAppConfig, setAppConfig } from "../storage";
import { recoverInterruptedLibraryIndexes } from "./document/indexing";
import { ensureLibrarySchema } from "./storage/db";
import {
  DEFAULT_LIBRARY_SETTINGS,
  type LibrarySettings,
  type LibrarySettingsUpdate,
  VALID_CHUNK_STRATEGIES,
} from "./types";

/**
 * 资料库全局检索与索引配置 (docs/en/reference/rag/):
 * 写入 app_config 并触发未完成索引的恢复。
 */

const SETTINGS_KEY = "library_settings";
let cachedSettings: LibrarySettings | null = null;

export async function getLibrarySettings(): Promise<LibrarySettings> {
  if (cachedSettings) return cachedSettings;
  await ensureLibrarySchema();
  const raw = await getAppConfig(SETTINGS_KEY);
  if (!raw) {
    cachedSettings = { ...DEFAULT_LIBRARY_SETTINGS };
    return cachedSettings;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<LibrarySettings>;
    cachedSettings = {
      embeddingModel:
        typeof parsed.embeddingModel === "string" && parsed.embeddingModel
          ? parsed.embeddingModel
          : DEFAULT_LIBRARY_SETTINGS.embeddingModel,
      chunkStrategy: VALID_CHUNK_STRATEGIES.includes(
        parsed.chunkStrategy as LibrarySettings["chunkStrategy"],
      )
        ? (parsed.chunkStrategy as LibrarySettings["chunkStrategy"])
        : DEFAULT_LIBRARY_SETTINGS.chunkStrategy,
      chunkSize:
        typeof parsed.chunkSize === "number" && parsed.chunkSize > 0
          ? parsed.chunkSize
          : DEFAULT_LIBRARY_SETTINGS.chunkSize,
      chunkOverlap:
        typeof parsed.chunkOverlap === "number" && parsed.chunkOverlap >= 0
          ? parsed.chunkOverlap
          : DEFAULT_LIBRARY_SETTINGS.chunkOverlap,
      topK:
        typeof parsed.topK === "number" && parsed.topK > 0
          ? parsed.topK
          : DEFAULT_LIBRARY_SETTINGS.topK,
      minScore:
        typeof parsed.minScore === "number" ? parsed.minScore : DEFAULT_LIBRARY_SETTINGS.minScore,
      rerank: typeof parsed.rerank === "boolean" ? parsed.rerank : DEFAULT_LIBRARY_SETTINGS.rerank,
      rerankScorer:
        parsed.rerankScorer === "mastra-agent"
          ? "mastra-agent"
          : DEFAULT_LIBRARY_SETTINGS.rerankScorer,
      rerankSemanticWeight:
        typeof parsed.rerankSemanticWeight === "number"
          ? parsed.rerankSemanticWeight
          : DEFAULT_LIBRARY_SETTINGS.rerankSemanticWeight,
      rerankVectorWeight:
        typeof parsed.rerankVectorWeight === "number"
          ? parsed.rerankVectorWeight
          : DEFAULT_LIBRARY_SETTINGS.rerankVectorWeight,
      rerankPositionWeight:
        typeof parsed.rerankPositionWeight === "number"
          ? parsed.rerankPositionWeight
          : DEFAULT_LIBRARY_SETTINGS.rerankPositionWeight,
      graphRag:
        typeof parsed.graphRag === "boolean" ? parsed.graphRag : DEFAULT_LIBRARY_SETTINGS.graphRag,
      graphThreshold:
        typeof parsed.graphThreshold === "number"
          ? parsed.graphThreshold
          : DEFAULT_LIBRARY_SETTINGS.graphThreshold,
      graphRandomWalkSteps:
        typeof parsed.graphRandomWalkSteps === "number"
          ? parsed.graphRandomWalkSteps
          : DEFAULT_LIBRARY_SETTINGS.graphRandomWalkSteps,
      graphRestartProb:
        typeof parsed.graphRestartProb === "number"
          ? parsed.graphRestartProb
          : DEFAULT_LIBRARY_SETTINGS.graphRestartProb,
      extractTitle:
        typeof parsed.extractTitle === "boolean"
          ? parsed.extractTitle
          : DEFAULT_LIBRARY_SETTINGS.extractTitle,
      extractSummary:
        typeof parsed.extractSummary === "boolean"
          ? parsed.extractSummary
          : DEFAULT_LIBRARY_SETTINGS.extractSummary,
      extractQuestions:
        typeof parsed.extractQuestions === "boolean"
          ? parsed.extractQuestions
          : DEFAULT_LIBRARY_SETTINGS.extractQuestions,
      extractKeywords:
        typeof parsed.extractKeywords === "boolean"
          ? parsed.extractKeywords
          : DEFAULT_LIBRARY_SETTINGS.extractKeywords,
    };
    return cachedSettings;
  } catch {
    cachedSettings = { ...DEFAULT_LIBRARY_SETTINGS };
    return cachedSettings;
  }
}

export async function saveLibrarySettings(update: LibrarySettingsUpdate): Promise<LibrarySettings> {
  const current = await getLibrarySettings();
  const next: LibrarySettings = {
    ...current,
    ...(update.embeddingModel !== undefined ? { embeddingModel: update.embeddingModel } : {}),
    ...(update.chunkStrategy !== undefined ? { chunkStrategy: update.chunkStrategy } : {}),
    ...(update.chunkSize !== undefined ? { chunkSize: update.chunkSize } : {}),
    ...(update.chunkOverlap !== undefined ? { chunkOverlap: update.chunkOverlap } : {}),
    ...(update.topK !== undefined ? { topK: update.topK } : {}),
    ...(update.minScore !== undefined ? { minScore: update.minScore } : {}),
    ...(update.rerank !== undefined ? { rerank: update.rerank } : {}),
    ...(update.rerankScorer !== undefined ? { rerankScorer: update.rerankScorer } : {}),
    ...(update.rerankSemanticWeight !== undefined
      ? { rerankSemanticWeight: update.rerankSemanticWeight }
      : {}),
    ...(update.rerankVectorWeight !== undefined
      ? { rerankVectorWeight: update.rerankVectorWeight }
      : {}),
    ...(update.rerankPositionWeight !== undefined
      ? { rerankPositionWeight: update.rerankPositionWeight }
      : {}),
    ...(update.graphRag !== undefined ? { graphRag: update.graphRag } : {}),
    ...(update.graphThreshold !== undefined ? { graphThreshold: update.graphThreshold } : {}),
    ...(update.graphRandomWalkSteps !== undefined
      ? { graphRandomWalkSteps: update.graphRandomWalkSteps }
      : {}),
    ...(update.graphRestartProb !== undefined ? { graphRestartProb: update.graphRestartProb } : {}),
    ...(update.extractTitle !== undefined ? { extractTitle: update.extractTitle } : {}),
    ...(update.extractSummary !== undefined ? { extractSummary: update.extractSummary } : {}),
    ...(update.extractQuestions !== undefined ? { extractQuestions: update.extractQuestions } : {}),
    ...(update.extractKeywords !== undefined ? { extractKeywords: update.extractKeywords } : {}),
  };
  await setAppConfig(SETTINGS_KEY, JSON.stringify(next, null, 2));
  cachedSettings = next;
  return next;
}

export async function initLibraryBackgroundTasks(): Promise<void> {
  const settings = await getLibrarySettings();
  void recoverInterruptedLibraryIndexes(settings).catch(() => undefined);
}
