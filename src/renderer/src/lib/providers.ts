/**
 * BYOK 模型供应商管理。
 * - 模型能力目录来自 models.dev(Mastra 官方 logo/模型数据源,见
 *   docs/en/models/index.mdx:开发环境每小时自动刷新本地模型列表)
 * - reasoning 参数写法参考 docs/en/models/providers/{openai,anthropic,google}.mdx
 */

export const MASTRA_SERVER_URL = import.meta.env.VITE_MASTRA_SERVER_URL ?? "http://localhost:4111";

// ---------------------------------------------------------------------------
// 供应商类型与内置端点(OpenAI compatible / OpenAI responses / Anthropic / Gemini)
// ---------------------------------------------------------------------------

export type ProviderType = "openai-compatible" | "openai-responses" | "anthropic" | "gemini";

export interface ProviderPreset {
  type: ProviderType;
  label: string;
  /** 供应商接口 URL 下拉框预置列表 */
  urls: string[];
  /** model router 的 provider 前缀(docs/en/models/index.mdx 的 provider/model 格式) */
  providerId: string;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    type: "openai-compatible",
    label: "OpenAI Compatible (Chat Completions)",
    urls: [
      "https://api.openai.com/v1",
      "https://api.deepseek.com/v1",
      "https://open.bigmodel.cn/api/paas/v4",
      "https://dashscope.aliyuncs.com/compatible-mode/v1",
      "https://api.moonshot.cn/v1",
      "http://localhost:11434/v1",
    ],
    providerId: "custom",
  },
  {
    type: "openai-responses",
    label: "OpenAI (Responses API)",
    urls: ["https://api.openai.com/v1"],
    providerId: "openai",
  },
  {
    type: "anthropic",
    label: "Anthropic",
    urls: ["https://api.anthropic.com/v1"],
    providerId: "anthropic",
  },
  {
    type: "gemini",
    label: "Google Gemini",
    urls: ["https://generativelanguage.googleapis.com/v1beta/openai"],
    providerId: "google",
  },
];

// ---------------------------------------------------------------------------
// 用户供应商配置(localStorage 持久化,按用户隔离)
// ---------------------------------------------------------------------------

export interface EnabledModel {
  id: string;
  name: string;
}

export interface ProviderConfig {
  id: string;
  name: string;
  type: ProviderType;
  url: string;
  apiKey: string;
  /** 用户启用的模型列表 */
  enabledModels: EnabledModel[];
}

// ---------------------------------------------------------------------------
// models.dev 模型能力目录(缓存 1 小时,对齐 Mastra 每小时自动刷新策略)
// ---------------------------------------------------------------------------

export interface CatalogModel {
  id: string;
  name: string;
  reasoning: boolean;
  tools: boolean;
  vision: boolean;
  audio: boolean;
  contextWindow: number;
}

export interface CatalogProvider {
  id: string;
  name: string;
  models: CatalogModel[];
}

const CATALOG_CACHE_KEY = "mastra-work:models-dev-catalog";
const CATALOG_TTL_MS = 60 * 60 * 1000;

interface CatalogCache {
  fetchedAt: number;
  providers: CatalogProvider[];
}

export async function loadModelCatalog(force = false): Promise<CatalogProvider[]> {
  if (!force) {
    const cached = localStorage.getItem(CATALOG_CACHE_KEY);
    if (cached) {
      try {
        const parsed = JSON.parse(cached) as CatalogCache;
        if (Date.now() - parsed.fetchedAt < CATALOG_TTL_MS) {
          return parsed.providers;
        }
      } catch {
        // 缓存损坏则重新拉取
      }
    }
  }
  // 通过 Mastra 服务端代理拉取(渲染进程 CSP 禁止直连外网,且服务端已缓存 1 小时)
  const response = await fetch(`${MASTRA_SERVER_URL}/api/work/providers/catalog`);
  if (!response.ok) {
    throw new Error(`拉取模型目录失败 (${response.status})`);
  }
  const raw = (await response.json()) as Record<
    string,
    {
      name: string;
      models: Record<
        string,
        {
          name?: string;
          reasoning?: boolean;
          tools?: boolean;
          vision?: boolean;
          audio?: boolean;
          limit?: { context?: number };
        }
      >;
    }
  >;
  const providers: CatalogProvider[] = Object.entries(raw).map(([id, p]) => ({
    id,
    name: p.name ?? id,
    models: Object.entries(p.models ?? {}).map(([modelId, m]) => ({
      id: modelId,
      name: m.name ?? modelId,
      reasoning: Boolean(m.reasoning),
      tools: Boolean(m.tools),
      vision: Boolean(m.vision),
      audio: Boolean(m.audio),
      contextWindow: m.limit?.context ?? 0,
    })),
  }));
  const cache: CatalogCache = { fetchedAt: Date.now(), providers };
  localStorage.setItem(CATALOG_CACHE_KEY, JSON.stringify(cache));
  return providers;
}

// ---------------------------------------------------------------------------
// 供应商模型列表拉取(服务端代理,缓存到 localStorage)
// ---------------------------------------------------------------------------

const MODEL_LIST_CACHE_PREFIX = "mastra-work:provider-models:";

export async function fetchProviderModels(provider: ProviderConfig): Promise<EnabledModel[]> {
  const cacheKey = `${MODEL_LIST_CACHE_PREFIX}${provider.id}`;
  const response = await fetch(`${MASTRA_SERVER_URL}/api/work/providers/models`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: provider.type, url: provider.url, apiKey: provider.apiKey }),
  });
  if (!response.ok) {
    throw new Error(`拉取模型列表失败 (${response.status})`);
  }
  const { models } = (await response.json()) as { models: EnabledModel[] };
  localStorage.setItem(cacheKey, JSON.stringify({ fetchedAt: Date.now(), models }));
  return models;
}

export function getCachedProviderModels(providerId: string): EnabledModel[] | null {
  const cached = localStorage.getItem(`${MODEL_LIST_CACHE_PREFIX}${providerId}`);
  if (!cached) return null;
  try {
    return (JSON.parse(cached) as { models: EnabledModel[] }).models;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 能力徽章
// ---------------------------------------------------------------------------

export interface ModelCapabilities {
  reasoning: boolean;
  vision: boolean;
  audio: boolean;
  tools: boolean;
}

/** 合并 models.dev 目录数据;目录缺失时保守返回全 false(不影响选择,仅不展示徽章) */
export function getModelCapabilities(
  providerType: ProviderType,
  modelId: string,
  catalog: CatalogProvider[],
): ModelCapabilities {
  const preset = PROVIDER_PRESETS.find((p) => p.type === providerType);
  const catalogProvider = preset ? catalog.find((p) => p.id === preset.providerId) : undefined;
  const model = catalogProvider?.models.find((m) => m.id === modelId);
  return {
    reasoning: model?.reasoning ?? false,
    vision: model?.vision ?? false,
    audio: model?.audio ?? false,
    tools: model?.tools ?? false,
  };
}

// ---------------------------------------------------------------------------
// 思考等级(reasoning effort)— 按 provider 类型给出可选档位
// 写法来源:docs/en/models/providers/openai.mdx(reasoningEffort)、
// anthropic.mdx(thinking/effort)、google.mdx(thinkingConfig.thinkingLevel)
// ---------------------------------------------------------------------------

export type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export const REASONING_EFFORTS: Partial<Record<ProviderType, ReasoningEffort[]>> = {
  "openai-compatible": ["minimal", "low", "medium", "high"],
  "openai-responses": ["minimal", "low", "medium", "high"],
  anthropic: ["low", "medium", "high", "xhigh", "max"],
  gemini: ["minimal", "low", "medium", "high"],
};

/**
 * 生成调用级 providerOptions(参考各 provider 官方文档的确切写法)。
 */
export function buildReasoningProviderOptions(
  providerType: ProviderType,
  effort: ReasoningEffort,
): Record<string, unknown> {
  switch (providerType) {
    case "openai-responses":
      return { openai: { reasoningEffort: effort } };
    case "openai-compatible":
      // OpenAI 兼容端点统一走 openai providerOptions 透传 reasoning_effort
      return { openai: { reasoningEffort: effort } };
    case "anthropic":
      return {
        anthropic: effort === "max" ? { thinking: { type: "enabled" } } : { effort },
      };
    case "gemini":
      return {
        google: {
          thinkingConfig: {
            thinkingLevel:
              effort === "minimal" || effort === "low" || effort === "medium" || effort === "high"
                ? effort
                : "high",
          },
        },
      };
  }
}

// ---------------------------------------------------------------------------
// BYOK → Mastra model router 对象形式
// 参考 docs/en/models/index.mdx:自定义 OpenAI 兼容端点用 { id, url, apiKey }
// ---------------------------------------------------------------------------

export function buildModelRouterObject(
  provider: ProviderConfig,
  modelId: string,
): { id: string; url: string; apiKey: string } | { id: string; apiKey: string } {
  const preset = PROVIDER_PRESETS.find((p) => p.type === provider.type);
  // 官方 provider(openai/anthropic/google)走已知 baseURL,只需 apiKey;
  // 自定义兼容端点必须带 url(base URL,非具体 chat 端点)
  if (preset?.providerId === "custom") {
    return {
      id: `${provider.id}/${modelId}`,
      url: provider.url,
      apiKey: provider.apiKey,
    };
  }
  return {
    id: `${preset?.providerId ?? "custom"}/${modelId}`,
    apiKey: provider.apiKey,
  };
}
