/**
 * 资料库全局检索与索引配置:写入 app_config 表(key = "library_settings"),
 * 损坏或缺失回落默认值;字段语义见 docs/en/reference/rag/*.mdx。
 */
import { getAppConfig, setAppConfig } from "../storage";
import {
  DEFAULT_LIBRARY_SETTINGS,
  type LibrarySettings,
  type LibrarySettingsUpdate,
  VALID_CHUNK_STRATEGIES,
} from "./types";

/**
 * 资料库全局检索与索引配置 (docs/en/reference/rag/):
 * 写入 app_config 表(key = "library_settings"),损坏或缺失回落默认值。
 */

const SETTINGS_KEY = "library_settings";
let cachedSettings: LibrarySettings | null = null;

/** 落库前的唯一归一化入口:枚举字段校验取值,数值字段收敛到合法区间。 */
function normalizeSettings(parsed: Partial<LibrarySettings>): LibrarySettings {
  const merged = { ...DEFAULT_LIBRARY_SETTINGS, ...parsed };
  const finite = (value: number | undefined, fallback: number) =>
    typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return {
    ...merged,
    chunkStrategy: VALID_CHUNK_STRATEGIES.includes(
      parsed.chunkStrategy as LibrarySettings["chunkStrategy"],
    )
      ? (parsed.chunkStrategy as LibrarySettings["chunkStrategy"])
      : DEFAULT_LIBRARY_SETTINGS.chunkStrategy,
    chunkSize: Math.max(
      1,
      Math.round(finite(merged.chunkSize, DEFAULT_LIBRARY_SETTINGS.chunkSize)),
    ),
    chunkOverlap: Math.max(
      0,
      Math.round(finite(merged.chunkOverlap, DEFAULT_LIBRARY_SETTINGS.chunkOverlap)),
    ),
    topK: Math.max(1, Math.round(finite(merged.topK, DEFAULT_LIBRARY_SETTINGS.topK))),
    minScore: finite(merged.minScore, DEFAULT_LIBRARY_SETTINGS.minScore),
    graphThreshold: finite(merged.graphThreshold, DEFAULT_LIBRARY_SETTINGS.graphThreshold),
    graphRandomWalkSteps: Math.round(
      finite(merged.graphRandomWalkSteps, DEFAULT_LIBRARY_SETTINGS.graphRandomWalkSteps),
    ),
    graphRestartProb: finite(merged.graphRestartProb, DEFAULT_LIBRARY_SETTINGS.graphRestartProb),
    rerankSemanticWeight: finite(
      merged.rerankSemanticWeight,
      DEFAULT_LIBRARY_SETTINGS.rerankSemanticWeight,
    ),
    rerankVectorWeight: finite(
      merged.rerankVectorWeight,
      DEFAULT_LIBRARY_SETTINGS.rerankVectorWeight,
    ),
    rerankPositionWeight: finite(
      merged.rerankPositionWeight,
      DEFAULT_LIBRARY_SETTINGS.rerankPositionWeight,
    ),
  };
}

export async function getLibrarySettings(): Promise<LibrarySettings> {
  if (cachedSettings) return cachedSettings;
  const raw = await getAppConfig(SETTINGS_KEY);
  if (!raw) {
    cachedSettings = { ...DEFAULT_LIBRARY_SETTINGS };
    return cachedSettings;
  }
  try {
    cachedSettings = normalizeSettings(JSON.parse(raw) as Partial<LibrarySettings>);
  } catch {
    cachedSettings = { ...DEFAULT_LIBRARY_SETTINGS };
  }
  return cachedSettings;
}

export async function saveLibrarySettings(update: LibrarySettingsUpdate): Promise<LibrarySettings> {
  const next = normalizeSettings({ ...(await getLibrarySettings()), ...update });
  await setAppConfig(SETTINGS_KEY, JSON.stringify(next, null, 2));
  cachedSettings = next;
  return next;
}
