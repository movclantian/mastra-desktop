/**
 * 资料库全局检索与索引配置:写入 app_config 表(key = "library_settings"),
 * 损坏或缺失回落默认值;字段语义见 docs/en/reference/rag/*.mdx。
 */
import { z } from "zod";
import { clampIntSchema, clampNumberSchema } from "../config/normalize";
import { getAppConfig, setAppConfig } from "../storage";
import {
  DEFAULT_LIBRARY_SETTINGS,
  type LibrarySettings,
  type LibrarySettingsUpdate,
  VALID_CHUNK_STRATEGIES,
} from "./types";

const SETTINGS_KEY = "library_settings";
const cachedSettingsByScope = new Map<string, LibrarySettings>();

function scopeKey(resourceId?: string): string {
  return resourceId?.trim() || "__system__";
}

/**
 * 落库前的唯一归一化入口(zod schema):枚举字段校验取值,数值字段收敛到
 * 合法区间,非法字段回落默认值,未知字段被剥离(等价原先的白名单过滤)。
 * 每个字段都带 .catch,保证单个字段损坏不会拖垮整份配置。
 */
const librarySettingsSchema = z.object({
  chunkSize: clampIntSchema(DEFAULT_LIBRARY_SETTINGS.chunkSize, 1, Number.POSITIVE_INFINITY),
  chunkOverlap: clampIntSchema(DEFAULT_LIBRARY_SETTINGS.chunkOverlap, 0, Number.POSITIVE_INFINITY),
  chunkStrategy: z.enum([...VALID_CHUNK_STRATEGIES]).catch(DEFAULT_LIBRARY_SETTINGS.chunkStrategy),
  topK: clampIntSchema(DEFAULT_LIBRARY_SETTINGS.topK, 1, Number.POSITIVE_INFINITY),
  minScore: clampNumberSchema(DEFAULT_LIBRARY_SETTINGS.minScore),
  graphRag: z.boolean().catch(DEFAULT_LIBRARY_SETTINGS.graphRag),
  graphThreshold: clampNumberSchema(DEFAULT_LIBRARY_SETTINGS.graphThreshold),
  graphRandomWalkSteps: clampIntSchema(
    DEFAULT_LIBRARY_SETTINGS.graphRandomWalkSteps,
    0,
    Number.POSITIVE_INFINITY,
  ),
  graphRestartProb: clampNumberSchema(DEFAULT_LIBRARY_SETTINGS.graphRestartProb),
  rerank: z.boolean().catch(DEFAULT_LIBRARY_SETTINGS.rerank),
  rerankScorer: z.enum(["model", "mastra-agent"]).catch(DEFAULT_LIBRARY_SETTINGS.rerankScorer),
  rerankSemanticWeight: clampNumberSchema(DEFAULT_LIBRARY_SETTINGS.rerankSemanticWeight),
  rerankVectorWeight: clampNumberSchema(DEFAULT_LIBRARY_SETTINGS.rerankVectorWeight),
  rerankPositionWeight: clampNumberSchema(DEFAULT_LIBRARY_SETTINGS.rerankPositionWeight),
  extractTitle: z.boolean().catch(DEFAULT_LIBRARY_SETTINGS.extractTitle),
  extractSummary: z.boolean().catch(DEFAULT_LIBRARY_SETTINGS.extractSummary),
  extractQuestions: z.boolean().catch(DEFAULT_LIBRARY_SETTINGS.extractQuestions),
  extractKeywords: z.boolean().catch(DEFAULT_LIBRARY_SETTINGS.extractKeywords),
});

function normalizeSettings(parsed: unknown): LibrarySettings {
  const normalized = librarySettingsSchema.parse({
    ...DEFAULT_LIBRARY_SETTINGS,
    ...(parsed as object),
  });
  return {
    ...normalized,
    // MDocument.chunk requires overlap < chunk size. Keep persisted settings
    // usable even when an older client saved an invalid combination.
    chunkOverlap: Math.min(normalized.chunkOverlap, Math.max(0, normalized.chunkSize - 1)),
  };
}

export async function getLibrarySettings(resourceId?: string): Promise<LibrarySettings> {
  const scope = scopeKey(resourceId);
  const cachedSettings = cachedSettingsByScope.get(scope);
  if (cachedSettings) return cachedSettings;
  const raw = await getAppConfig(SETTINGS_KEY, resourceId);
  if (!raw) {
    const next = { ...DEFAULT_LIBRARY_SETTINGS };
    cachedSettingsByScope.set(scope, next);
    return next;
  }
  let next: LibrarySettings;
  try {
    next = normalizeSettings(JSON.parse(raw));
  } catch {
    next = { ...DEFAULT_LIBRARY_SETTINGS };
  }
  cachedSettingsByScope.set(scope, next);
  return next;
}

export async function saveLibrarySettings(
  update: LibrarySettingsUpdate,
  resourceId?: string,
): Promise<LibrarySettings> {
  const next = normalizeSettings({ ...(await getLibrarySettings(resourceId)), ...update });
  await setAppConfig(SETTINGS_KEY, JSON.stringify(next, null, 2), resourceId);
  cachedSettingsByScope.set(scopeKey(resourceId), next);
  return next;
}
