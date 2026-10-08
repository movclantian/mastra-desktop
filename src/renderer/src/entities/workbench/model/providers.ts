// BYOK & Provider Catalog Domain Model
import * as React from "react";
import { toast } from "sonner";
import { apiFetch, MASTRA_SERVER_URL } from "@/shared/api";
import { i18n } from "@/shared/i18n";
import { readErrorPayload } from "@/shared/lib";
import { inferModelKind, type ModelKind } from "../../../../../shared/agent-contract";

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
  readonly kind?: ModelKind;
}

export interface ProviderConfig {
  id: string;
  name: string;
  registryId?: string;
  protocol?: GatewayProtocol;
  baseUrl?: string;
  useResponses?: boolean;
  credentialRef: string;
  credentialHint: string;
  hasCredential: true;
  disabled?: boolean;
  enabledModels: EnabledModel[];
}

interface CatalogModel {
  id: string;
  name: string;
  kind?: ModelKind;
  reasoning: boolean;
  tools: boolean;
  structuredOutput: boolean;
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
  structuredOutput: boolean;
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
}

export const REASONING_EFFORT_LABELS: Record<ReasoningEffort, string> = {
  get "provider-default"() {
    return i18n.t("chat:models.efforts.provider-default");
  },
  get none() {
    return i18n.t("chat:models.efforts.none");
  },
  get minimal() {
    return i18n.t("chat:models.efforts.minimal");
  },
  get low() {
    return i18n.t("chat:models.efforts.low");
  },
  get medium() {
    return i18n.t("chat:models.efforts.medium");
  },
  get high() {
    return i18n.t("chat:models.efforts.high");
  },
  get xhigh() {
    return i18n.t("chat:models.efforts.xhigh");
  },
  get max() {
    return i18n.t("chat:models.efforts.max");
  },
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

function loadRegistry(): Promise<RegistryProvider[]> {
  registryPromise ??= apiFetch(`${MASTRA_SERVER_URL}/work/providers/registry`)
    .then(async (response) => {
      if (!response.ok) {
        throw new Error(
          (await readErrorPayload(response, i18n.t("settings:providers.fetchBuiltinListFailed")))
            .error,
        );
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
        toast.error(
          i18n.t("settings:providers.fetchBuiltinListFailedWithDetail", {
            error: (error as Error).message,
          }),
        );
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
      throw new Error(
        (await readErrorPayload(response, i18n.t("settings:providers.fetchCatalogFailed"))).error,
      );
    }
    // models.dev api.json 模型字段:reasoning / tool_call / structured_output /
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
            structured_output?: boolean;
            modalities?: { input?: string[] | string; output?: string[] };
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
          kind: m.modalities?.output?.length
            ? inferModelKind(modelId, { outputModalities: m.modalities.output })
            : undefined,
          reasoning: Boolean(m.reasoning),
          tools: Boolean(m.tool_call),
          structuredOutput: Boolean(m.structured_output),
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
  })().finally(() => {
    catalogPromise = null; // 只复用进行中的请求，成功后仍由目录 TTL 决定是否刷新。
  });
  return catalogPromise;
}

/**
 * 结合 models.dev catalog 目录与 tokenlens 计算 Token 对应 USD 成本。
 */

/**
 * 格式化输出成本金额。
 */

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
  if (provider.registryId && provider.registryId !== "vercel") {
    // 内置供应商:模型清单直接来自 provider-registry(无需网络请求)
    const registryProvider = registry.find((p) => p.id === provider.registryId);
    if (!registryProvider) {
      throw new Error(i18n.t("settings:providers.builtinNotFound", { id: provider.registryId }));
    }
    models = registryProvider.models.map((id) => ({ id, name: id }));
  } else {
    // 自定义网关:服务端代理拉取 /models
    const response = await apiFetch(`${MASTRA_SERVER_URL}/work/providers/models`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providerId: provider.id,
        protocol: provider.protocol ?? "openai",
        url: provider.baseUrl,
        credentialRef: provider.credentialRef,
      }),
    });
    if (!response.ok) {
      throw new Error(
        (await readErrorPayload(response, i18n.t("settings:providers.fetchModelListFailed"))).error,
      );
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

/** 失效某供应商的模型列表缓存:编辑(baseUrl/凭据/协议变了)或删除供应商时调用 */
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

export function getModelKind(
  provider: ProviderConfig,
  modelId: string,
  catalog: CatalogProvider[],
  discoveredKind?: ModelKind,
): ModelKind {
  const exact = catalog
    .find((item) => item.id === provider.registryId)
    ?.models.find((model) => model.id === modelId);
  const matches = new Set(
    findCatalogModelsById(catalog, modelId).flatMap((model) => (model.kind ? [model.kind] : [])),
  );
  return (
    exact?.kind ??
    (matches.size === 1 ? [...matches][0] : undefined) ??
    discoveredKind ??
    provider.enabledModels.find((model) => model.id === modelId)?.kind ??
    inferModelKind(modelId)
  );
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
    return {
      reasoning: false,
      vision: false,
      audio: false,
      tools: false,
      structuredOutput: false,
    };
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
  const language = getModelKind(provider, modelId, catalog) === "language";
  return {
    reasoning: language && models.some((model) => model.reasoning),
    vision: models.some((model) => model.vision),
    audio: models.some((model) => model.audio),
    tools: language && models.some((model) => model.tools),
    structuredOutput: language && models.some((model) => model.structuredOutput),
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
  // Match the server budget: ambiguous gateway IDs must not overstate capacity.
  return contextWindows.length ? Math.min(...contextWindows) : undefined;
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
        ? i18n.t("settings:providers.requestTimeout")
        : (error as Error).message;
    return { ok: false, error: message };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// BYOK → 后端请求模型引用。URL、协议与凭据只在服务端按 provider id 解析。
// ---------------------------------------------------------------------------

export function buildRequestModel(provider: ProviderConfig, modelId: string): RequestModelPayload {
  return { id: `${provider.id}/${modelId}` };
}
