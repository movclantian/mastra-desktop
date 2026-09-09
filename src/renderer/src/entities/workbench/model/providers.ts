// BYOK & Provider Catalog Domain Model
import * as React from "react";
import { toast } from "sonner";
import { apiFetch, MASTRA_SERVER_URL } from "@/shared/api";
import { calculateCostUSD, formatCostUSD, readErrorPayload } from "@/shared/lib";

export { calculateCostUSD, formatCostUSD };

export interface RegistryProvider {
  id: string;
  name: string;
  models: string[];
  apiKeyEnvVar: string;
  docUrl: string;
}

export type GatewayProtocol = "openai" | "anthropic" | "gemini";

export interface EnabledModel {
  id: string;
  name: string;
}

export interface ProviderConfig {
  id: string;
  name: string;
  registryId?: string;
  protocol?: GatewayProtocol;
  baseUrl?: string;
  useResponses?: boolean;
  apiKey: string;
  disabled?: boolean;
  enabledModels: EnabledModel[];
}

export interface CatalogModel {
  id: string;
  name: string;
  reasoning: boolean;
  tools: boolean;
  vision: boolean;
  audio: boolean;
  contextWindow: number;
  cost?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
}

export interface CatalogProvider {
  id: string;
  name: string;
  models: CatalogModel[];
}

export interface ModelCapabilities {
  reasoning: boolean;
  vision: boolean;
  audio: boolean;
  tools: boolean;
}

export type ReasoningEffort =
  | "provider-default"
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export interface RequestModelPayload {
  id: string;
  apiKey: string;
  url?: string;
  protocol?: GatewayProtocol;
  useResponses?: boolean;
}

export const REASONING_EFFORT_LABELS: Record<ReasoningEffort, string> = {
  "provider-default": "自动",
  none: "关闭",
  minimal: "极简",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "超高",
  max: "最大",
};

export function getReasoningEfforts(provider: ProviderConfig): ReasoningEffort[] {
  const family = provider.registryId ?? provider.protocol;
  if (family === "anthropic") {
    return ["provider-default", "low", "medium", "high", "xhigh", "max"];
  }
  if (family === "google" || family === "gemini") {
    return ["provider-default", "minimal", "low", "medium", "high"];
  }
  if (family === "openai") {
    return ["provider-default", "none", "minimal", "low", "medium", "high", "xhigh", "max"];
  }
  return ["provider-default", "none", "minimal", "low", "medium", "high", "xhigh"];
}

function supportsMaxEffort(family: string | undefined): boolean {
  return family === "anthropic" || family === "openai";
}

export function buildReasoningRequest(
  provider: ProviderConfig,
  effort: ReasoningEffort,
): Record<string, unknown> {
  const family = provider.registryId ?? provider.protocol;
  if (effort === "max") {
    if (!supportsMaxEffort(family)) return { modelSettings: { reasoning: "xhigh" } };
    return family === "anthropic"
      ? { providerOptions: { anthropic: { effort: "max" } } }
      : { providerOptions: { openai: { reasoningEffort: "max" } } };
  }
  return { modelSettings: { reasoning: effort } };
}

import * as React from "react";
import { toast } from "sonner";
import { apiFetch, MASTRA_SERVER_URL } from "@/shared/api";
import { readErrorPayload } from "@/shared/lib";

/**
 * BYOK 模型供应商管理。
 * - 内置供应商列表来自 Mastra 随包携带的官方 registry,不依赖外网
 * - 模型能力目录来自 models.dev,仅用于推理/视觉/上下文窗口等可选展示
 * - 自定义网关参考 docs/en/models/gateways/custom-gateways.mdx
 *   (OpenAI Compatible / Anthropic / Gemini 三种协议)
 */

// ---------------------------------------------------------------------------
// Mastra 内置供应商注册表(服务端 /work/providers/registry)。服务端直接读取
// @mastra/core 内置快照,这里仅做会话内 promise memo 去重。
// ---------------------------------------------------------------------------

let registryPromise: Promise<RegistryProvider[]> | null = null;

export function loadRegistry(): Promise<RegistryProvider[]> {
  registryPromise ??= apiFetch(`${MASTRA_SERVER_URL}/work/providers/registry`)
    .then(async (response) => {
      if (!response.ok) {
        throw new Error((await readErrorPayload(response, "拉取内置供应商列表失败")).error);
      }
      const { providers } = (await response.json()) as { providers: RegistryProvider[] };
      return providers;
    })
    .catch((error: unknown) => {
      registryPromise = null; // 失败不缓存,允许下次重试
      throw error;
    });
  return registryPromise;
}

/**
 * 内置供应商下拉的 UI 状态。放在非组件模块可保持 providers-section.tsx 的 Fast
 * Refresh 边界只导出组件,避免 Vite 将 hook 与组件混合导出判定为不兼容。
 */
export function useRegistry(): RegistryProvider[] {
  const [registry, setRegistry] = React.useState<RegistryProvider[]>([]);
  React.useEffect(() => {
    let active = true;
    loadRegistry()
      .then((nextRegistry) => {
        if (active) setRegistry(nextRegistry);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setRegistry([]);
        toast.error(`内置供应商列表加载失败：${(error as Error).message}`);
      });
    return () => {
      active = false;
    };
  }, []);
  return registry;
}

// ---------------------------------------------------------------------------
// 自定义网关协议(docs/en/models/gateways/custom-gateways.mdx)
// ---------------------------------------------------------------------------

export const GATEWAY_PROTOCOLS: { value: GatewayProtocol; label: string }[] = [
  { value: "openai", label: "OpenAI Compatible" },
  { value: "anthropic", label: "Anthropic" },
  { value: "gemini", label: "Google Gemini" },
];

/**
 * 网关 Base URL 归一化(防护性处理 + 协议感知补 /v1):
 * - 去首尾空白与尾部斜杠
 * - 无协议时补 https://
 * - 重复的版本段折叠(/v1/v1 → /v1)
 * - openai / anthropic 协议且路径为空(裸域名/裸 IP)时补 /v1:两家 SDK 的
 *   自定义 baseURL 需含版本段(默认 …/v1,SDK 只追加 /chat/completions、
 *   /messages,不会自行补 /v1;实测 @ai-sdk/anthropic 仅默认 URL 带 /v1)。
 *   业界客户端同样默认裸域名 → /v1。已带路径的端点(如 /api/paas/v4、
 *   /api/coding/v3)原样保留;gemini 协议不补(由 SDK 默认 baseURL 处理)。
 * 后端 create-model.ts 的 normalizeGatewayBaseUrl 同款逻辑,两端保持一致。
 */
export function normalizeGatewayUrl(input: string, protocol?: GatewayProtocol): string {
  let url = input.trim().replace(/[\\/]+$/, "");
  if (!url) return url;
  if (!/^https?:\/\//i.test(url)) {
    url = `https://${url}`;
  }
  // 折叠相邻重复的版本段(/v1/v1 → /v1;版本号不同则不动,如 /v1beta 不受影响)
  url = url.replace(/\/(v\d+)(?:\/\1)+/gi, "/$1");
  if (protocol === "openai" || protocol === "anthropic") {
    try {
      const parsed = new URL(url);
      if (parsed.pathname === "/" || parsed.pathname === "") {
        url = `${parsed.origin}/v1`;
      }
    } catch {
      // 非法 URL 交由保存前的表单校验兜底,归一化不强行处理
    }
  }
  return url;
}

// ---------------------------------------------------------------------------
// 用户供应商配置(由 Workbench 同步到服务端 app_config,按用户隔离)
// ---------------------------------------------------------------------------

/**
 * 模型名称只用于界面展示;当网关把完整路由(provider/model)重复放进 name 时,
 * 退回真实模型 ID,避免把内部路由或 URL 暴露给用户。
 */
export function getModelDisplayName(model: Pick<EnabledModel, "id" | "name">): string {
  const id = model.id.trim();
  const name = model.name?.trim() ?? "";
  if (!name) return id;

  const nameLeaf = name.slice(name.lastIndexOf("/") + 1);
  const idLeaf = id.slice(id.lastIndexOf("/") + 1);
  return name.includes("/") && nameLeaf === idLeaf ? id : name;
}

// ---------------------------------------------------------------------------
// models.dev 模型能力目录(可选元数据)
// 跨会话由服务端代理缓存 1 小时;会话内再缓存解析结果,避免重复解析大 JSON。
import { getUsage, models as tokenlensModels } from "tokenlens";

// 目录不可用时只是不显示能力徽章,不影响供应商和模型本身的使用。
// ---------------------------------------------------------------------------

const CATALOG_TTL_MS = 60 * 60 * 1000;

let catalogCache: CatalogProvider[] | null = null;
let catalogFetchedAt = 0;
let catalogPromise: Promise<CatalogProvider[]> | null = null;

export function loadModelCatalog(): Promise<CatalogProvider[]> {
  if (catalogCache && Date.now() - catalogFetchedAt < CATALOG_TTL_MS) {
    return Promise.resolve(catalogCache);
  }
  catalogPromise ??= (async () => {
    // 通过 Mastra 服务端代理拉取(渲染进程 CSP 禁止直连外网,且服务端已缓存 1 小时)
    const response = await apiFetch(`${MASTRA_SERVER_URL}/work/providers/catalog`);
    if (!response.ok) {
      throw new Error((await readErrorPayload(response, "拉取模型目录失败")).error);
    }
    // models.dev api.json 模型字段:reasoning / tool_call /
    // modalities.input 含 image|audio / limit.context / cost
    const raw = (await response.json()) as Record<
      string,
      {
        name: string;
        models: Record<
          string,
          {
            name?: string;
            reasoning?: boolean;
            tool_call?: boolean;
            modalities?: { input?: string[] | string };
            limit?: { context?: number | string };
            cost?: {
              input?: number;
              output?: number;
              cache_read?: number;
              cache_write?: number;
            };
          }
        >;
      }
    >;
    const providers: CatalogProvider[] = Object.entries(raw).map(([id, p]) => ({
      id,
      name: p.name ?? id,
      models: Object.entries(p.models ?? {}).map(([modelId, m]) => {
        const rawInputModalities = m.modalities?.input;
        const inputModalities = (
          Array.isArray(rawInputModalities)
            ? rawInputModalities
            : rawInputModalities
              ? [rawInputModalities]
              : []
        ).map((modality) => modality.toLowerCase());
        const contextWindow = parseContextWindow(m.limit?.context);
        return {
          id: modelId,
          name: m.name ?? modelId,
          reasoning: Boolean(m.reasoning),
          tools: Boolean(m.tool_call),
          vision: inputModalities.some(
            (modality) => modality === "image" || modality.startsWith("image/"),
          ),
          audio: inputModalities.some(
            (modality) => modality === "audio" || modality.startsWith("audio/"),
          ),
          contextWindow: Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : 0,
          cost: m.cost
            ? {
                input: typeof m.cost.input === "number" ? m.cost.input : undefined,
                output: typeof m.cost.output === "number" ? m.cost.output : undefined,
                cacheRead: typeof m.cost.cache_read === "number" ? m.cost.cache_read : undefined,
                cacheWrite: typeof m.cost.cache_write === "number" ? m.cost.cache_write : undefined,
              }
            : undefined,
        };
      }),
    }));
    catalogCache = providers;
    catalogFetchedAt = Date.now();
    return providers;
  })().catch((error: unknown) => {
    catalogPromise = null; // 失败不缓存,允许下次重试
    throw error;
  });
  return catalogPromise;
}

export function useModelCatalog(): CatalogProvider[] {
  const [catalog, setCatalog] = React.useState<CatalogProvider[]>([]);
  React.useEffect(() => {
    let active = true;
    loadModelCatalog()
      .then((data) => {
        if (active) setCatalog(data);
      })
      .catch(() => {
        if (active) setCatalog([]);
      });
    return () => {
      active = false;
    };
  }, []);
  return catalog;
}

/**
 * 结合 models.dev catalog 目录与 tokenlens 计算 Token 对应 USD 成本。
 */
export function calculateCostUSD(
  modelId: string,
  inputTokens: number,
  outputTokens: number,
  catalog?: CatalogProvider[],
): number | null {
  if (!modelId || (inputTokens === 0 && outputTokens === 0)) return null;
  const cleanId = modelId.trim();
  const normId = cleanId.toLowerCase();

  // 1. 优先匹配 models.dev 目录价格 (最权威最新，单位: USD / 1M tokens)
  if (catalog && catalog.length > 0) {
    const strippedId = normId.replace(/[^a-z0-9]/g, "");
    for (const provider of catalog) {
      const match = provider.models.find((m) => {
        const mNorm = m.id.toLowerCase();
        const mStripped = mNorm.replace(/[^a-z0-9]/g, "");
        return (
          mNorm === normId ||
          normId.endsWith(`/${mNorm}`) ||
          mNorm.endsWith(normId) ||
          m.name.toLowerCase() === normId ||
          (strippedId.length >= 4 &&
            (mStripped.includes(strippedId) || strippedId.includes(mStripped)))
        );
      });
      if (
        match?.cost &&
        typeof match.cost.input === "number" &&
        typeof match.cost.output === "number"
      ) {
        const costUSD =
          (inputTokens * match.cost.input + outputTokens * match.cost.output) / 1_000_000;
        return costUSD;
      }
    }
  }

  // 2. 尝试 tokenlens (精确匹配)
  try {
    const lensResult = getUsage({
      modelId: cleanId,
      usage: { input: inputTokens, output: outputTokens },
    });
    if (lensResult.costUSD?.totalUSD !== undefined && !Number.isNaN(lensResult.costUSD.totalUSD)) {
      return lensResult.costUSD.totalUSD;
    }
  } catch {}

  // 3. 尝试 tokenlens (模糊匹配已知模型家族与变体)
  try {
    const clean = normId.replace(/^[^:]+:/, "").replace(/^[^/]+\//, "");
    const stripped = clean.replace(/[^a-z0-9]/g, "");
    const modelKeys = Object.keys(tokenlensModels ?? {});

    // 3.1 词干全等
    for (const key of modelKeys) {
      const keyModel = key.split(":")[1] || key;
      const keyStripped = keyModel.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (keyStripped === stripped) {
        const res = getUsage({
          modelId: key,
          usage: { input: inputTokens, output: outputTokens },
        });
        if (res.costUSD?.totalUSD !== undefined && !Number.isNaN(res.costUSD.totalUSD)) {
          return res.costUSD.totalUSD;
        }
      }
    }

    // 3.2 关键词命中度匹配
    let bestKey: string | null = null;
    let bestScore = 0;
    const tokens = clean.split(/[-_./]/).filter((t) => t.length >= 2);
    if (tokens.length > 0) {
      for (const key of modelKeys) {
        const keyModel = (key.split(":")[1] || key).toLowerCase();
        const matchedCount = tokens.filter((t) => keyModel.includes(t)).length;
        const score = matchedCount / tokens.length;
        if (score > bestScore && score >= 0.5) {
          bestScore = score;
          bestKey = key;
        }
      }
      if (bestKey) {
        const res = getUsage({
          modelId: bestKey,
          usage: { input: inputTokens, output: outputTokens },
        });
        if (res.costUSD?.totalUSD !== undefined && !Number.isNaN(res.costUSD.totalUSD)) {
          return res.costUSD.totalUSD;
        }
      }
    }
  } catch {}

  return null;
}

/**
 * 格式化输出成本金额。
 */
export function formatCostUSD(cost: number | null): string {
  if (cost === null || cost === undefined || Number.isNaN(cost)) {
    return "未定价";
  }
  if (cost === 0) return "$0.00";
  if (cost < 0.0001) return `< $0.0001`;
  if (cost < 0.01) {
    return `$${cost.toFixed(4)}`;
  }
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(cost);
}

// ---------------------------------------------------------------------------
// 供应商模型列表(内置供应商来自 registry;自定义网关走服务端代理)
// 会话内存缓存:同一会话内重复打开选模型弹窗不重复打网关;重启后重拉,
// 天然拿到网关最新列表。
// ---------------------------------------------------------------------------

const providerModelsCache = new Map<string, EnabledModel[]>();

export async function fetchProviderModels(
  provider: ProviderConfig,
  registry: RegistryProvider[],
): Promise<EnabledModel[]> {
  let models: EnabledModel[];
  if (provider.registryId) {
    // 内置供应商:模型清单直接来自 provider-registry(无需网络请求)
    const registryProvider = registry.find((p) => p.id === provider.registryId);
    if (!registryProvider) {
      throw new Error(`未找到内置供应商 ${provider.registryId}`);
    }
    models = registryProvider.models.map((id) => ({ id, name: id }));
  } else {
    // 自定义网关:服务端代理拉取 /models
    const response = await apiFetch(`${MASTRA_SERVER_URL}/work/providers/models`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        protocol: provider.protocol ?? "openai",
        url: provider.baseUrl,
        apiKey: provider.apiKey,
      }),
    });
    if (!response.ok) {
      throw new Error((await readErrorPayload(response, "拉取模型列表失败")).error);
    }
    ({ models } = (await response.json()) as { models: EnabledModel[] });
  }
  models = models.map((model) => ({
    ...model,
    name: getModelDisplayName(model),
  }));
  providerModelsCache.set(provider.id, models);
  return models;
}

export function getCachedProviderModels(providerId: string): EnabledModel[] | null {
  return providerModelsCache.get(providerId) ?? null;
}

/** 失效某供应商的模型列表缓存:编辑(baseUrl/apiKey/协议变了)或删除供应商时调用 */
export function invalidateProviderModelsCache(providerId: string): void {
  providerModelsCache.delete(providerId);
}

// ---------------------------------------------------------------------------
// 能力徽章
// ---------------------------------------------------------------------------

function findCatalogModelsById(catalog: CatalogProvider[], modelId: string): CatalogModel[] {
  const normalizedModelId = modelId.trim();
  if (!normalizedModelId || /^(?:https?|wss?):\/\//i.test(normalizedModelId)) {
    return [];
  }
  const exactModels = catalog
    .flatMap((provider) => provider.models)
    .filter((model) => model.id === normalizedModelId);
  if (exactModels.length > 0) {
    return exactModels;
  }

  // 只接受完整模型 ID。不能按 URL、路径最后一段或模糊名称回退,
  // 否则自定义网关的同名模型会被错误映射到别的供应商。
  return [];
}

/**
 * 优先按 provider 的 registry id 在 models.dev 目录中查模型能力;
 * 自定义网关再按全目录的模型 ID 精确匹配,无法确认时不展示徽章。
 */
export function getModelCapabilities(
  provider: ProviderConfig,
  modelId: string,
  catalog: CatalogProvider[],
): ModelCapabilities {
  const normalizedModelId = modelId.trim();
  if (!normalizedModelId || /^(?:https?|wss?):\/\//i.test(normalizedModelId)) {
    return { reasoning: false, vision: false, audio: false, tools: false };
  }
  const providerModel = provider.registryId
    ? catalog
        .find((p) => p.id === provider.registryId)
        ?.models.find((m) => m.id === normalizedModelId)
    : undefined;
  // 自定义网关没有 registryId,但其模型 ID 仍可能来自 models.dev,只按完整 ID 匹配。
  const models = providerModel
    ? [providerModel]
    : findCatalogModelsById(catalog, normalizedModelId);
  return {
    reasoning: models.some((model) => model.reasoning),
    vision: models.some((model) => model.vision),
    audio: models.some((model) => model.audio),
    tools: models.some((model) => model.tools),
  };
}

/** 模型上下文窗口大小(models.dev limit.context);目录没有匹配项时返回 undefined。 */
export function getModelContextWindow(
  provider: ProviderConfig,
  modelId: string,
  catalog: CatalogProvider[],
): number | undefined {
  const normalizedModelId = modelId.trim();
  if (!normalizedModelId || /^(?:https?|wss?):\/\//i.test(normalizedModelId)) return undefined;
  const providerModel = provider.registryId
    ? catalog
        .find((p) => p.id === provider.registryId)
        ?.models.find((m) => m.id === normalizedModelId)
    : undefined;
  if (providerModel?.contextWindow) {
    return providerModel.contextWindow;
  }

  const matchingModels = findCatalogModelsById(catalog, normalizedModelId);
  const contextWindows = matchingModels
    .map((model) => model.contextWindow)
    .filter((contextWindow) => contextWindow > 0);
  if (contextWindows.length === 0) {
    return undefined;
  }

  // 同一模型 ID 可能有多个供应商记录,取出现次数最多的窗口作为模型级映射。
  const counts = new Map<number, number>();
  let selectedWindow: number | undefined;
  let selectedCount = 0;
  for (const contextWindow of contextWindows) {
    const count = (counts.get(contextWindow) ?? 0) + 1;
    counts.set(contextWindow, count);
    if (count > selectedCount) {
      selectedWindow = contextWindow;
      selectedCount = count;
    }
  }
  return selectedWindow;
}

/** 将 models.dev 的 token 数量格式化为模型列表可读的 K/M/B 标签。 */
export function formatModelContextWindow(contextWindow: number): string {
  if (contextWindow >= 1_000_000_000) {
    return `${formatContextUnit(contextWindow / 1_000_000_000)}B`;
  }
  if (contextWindow >= 1_000_000) {
    return `${formatContextUnit(contextWindow / 1_000_000)}M`;
  }
  if (contextWindow >= 1_000) {
    return `${formatContextUnit(contextWindow / 1_000)}K`;
  }
  return contextWindow.toLocaleString("en-US");
}

function formatContextUnit(value: number): string {
  return value.toLocaleString("en-US", { maximumFractionDigits: value < 10 ? 1 : 0 });
}

/** models.dev 通常返回数字,但网关/缓存中也可能保留 "128K"、"1M" 形式。 */
function parseContextWindow(value: unknown): number {
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  }
  if (typeof value !== "string") return 0;
  const match = /^([0-9]+(?:\.[0-9]+)?)\s*([kmb])?$/i.exec(value.trim());
  if (!match) return 0;
  const amount = Number(match[1]);
  const multiplier =
    match[2]?.toLowerCase() === "b"
      ? 1_000_000_000
      : match[2]?.toLowerCase() === "m"
        ? 1_000_000
        : match[2]?.toLowerCase() === "k"
          ? 1_000
          : 1;
  const parsed = amount * multiplier;
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

// ---------------------------------------------------------------------------
// 连接测试:调用独立的 provider test 路由,只执行一次 generateText。
// 不创建线程、不写入 Memory、不进入 WorkSession,所以测试请求不会出现在会话列表。
// ---------------------------------------------------------------------------

export async function testProviderModel(
  provider: ProviderConfig,
  modelId: string,
): Promise<{ ok: boolean; reply?: string; error?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    const response = await apiFetch(`${MASTRA_SERVER_URL}/work/providers/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        providerId: provider.id,
        modelId,
      }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      return {
        ok: false,
        error: `HTTP ${response.status} ${detail.slice(0, 200)}`,
      };
    }
    const result = (await response.json()) as { ok?: boolean; reply?: string; error?: string };
    return {
      ok: result.ok === true,
      ...(result.reply ? { reply: result.reply } : {}),
      ...(result.error ? { error: result.error } : {}),
    };
  } catch (error) {
    const message =
      error instanceof Error && error.name === "AbortError"
        ? "请求超时(60s)"
        : (error as Error).message;
    return { ok: false, error: message };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// BYOK → 后端请求模型对象
// 参考 docs/en/models/index.mdx:内置 provider 用 "provider/model" + apiKey;
// 自定义网关带 url + protocol + useResponses,由后端(src/mastra/models/gateways.ts)用官方
// provider 包解析为真实端点:anthropic → Messages API,gemini → 原生 API,
// openai → Responses(useResponses)或 Chat Completions
// ---------------------------------------------------------------------------

export function buildRequestModel(provider: ProviderConfig, modelId: string): RequestModelPayload {
  // 内置供应商:registry id 即 model router 的 provider 前缀
  if (provider.registryId) {
    return {
      id: `${provider.registryId}/${modelId}`,
      apiKey: provider.apiKey,
    };
  }
  // 自定义网关:必须带 baseUrl(base URL,非具体 chat 端点)
  return {
    id: `${provider.id}/${modelId}`,
    url: provider.baseUrl,
    apiKey: provider.apiKey,
    ...(provider.protocol ? { protocol: provider.protocol } : {}),
    ...(provider.protocol === "openai" && provider.useResponses ? { useResponses: true } : {}),
  };
}
