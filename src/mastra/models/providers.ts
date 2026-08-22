/**
 * 模型供应商配置与 BYOK 解析。
 * 官方文档:docs/en/models/index.mdx(model router 的 provider/model 路由格式)、
 * docs/en/models/environment-variables.mdx。
 * 配置读写走 app_config 表(key = "providers"),设置面板「模型供应商」写入;
 * resolveRequestModel 供 chat / session 路由按请求覆盖模型 —— 路由 id 只携带
 * provider/model,URL 与 API Key 始终在服务端解析,不经请求体下发。
 */
import { type GatewayLanguageModel, ModelRouterEmbeddingModel } from "@mastra/core/llm";
import { getAppConfig, setAppConfig } from "../storage";
import { createGatewayModel, type GatewayProtocol, WORKBENCH_GATEWAY_ID } from "./create-model";

/** 请求级模型覆盖:chat 路由写入,Agent / 子 Agent 的 model 回调读取 */
export const REQUEST_MODEL_CONTEXT_KEY = "mastra-work:request-model";

export interface EnabledModel {
  id: string;
  name: string;
  /** true only when the provider advertises an embedding endpoint for this model */
  embedding?: boolean;
}

export interface UserProviderConfig {
  id: string;
  name: string;
  /** 内置供应商 id (Mastra registry); 为空 = 自定义网关 */
  registryId?: string;
  /** 自定义网关: 协议与 Base URL */
  protocol?: GatewayProtocol;
  baseUrl?: string;
  /** OpenAI 协议专用: 是否使用 Responses 端点 */
  useResponses?: boolean;
  apiKey: string;
  /** 禁用后不再出现在模型选择器中 (已启用的模型保留配置) */
  disabled?: boolean;
  enabledModels: EnabledModel[];
}

/** 当前选定模型: 驱动输入框, 也作为 Agent 的默认模型 */
interface UserModelSelection {
  providerId: string;
  modelId: string;
  modelName: string;
  reasoningEffort: string;
}

interface ProvidersUserConfig {
  providers: UserProviderConfig[];
  modelSelection: UserModelSelection | null;
}

const PROVIDERS_CONFIG_KEY = "providers";

const DEFAULT_PROVIDERS_CONFIG: ProvidersUserConfig = { providers: [], modelSelection: null };
let providersConfigCache: ProvidersUserConfig | null = null;

export async function getProvidersConfig(): Promise<ProvidersUserConfig> {
  if (providersConfigCache) return providersConfigCache;
  const raw = await getAppConfig(PROVIDERS_CONFIG_KEY);
  if (!raw) {
    providersConfigCache = DEFAULT_PROVIDERS_CONFIG;
    return providersConfigCache;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ProvidersUserConfig>;
    providersConfigCache = {
      providers: Array.isArray(parsed.providers) ? parsed.providers : [],
      modelSelection: parsed.modelSelection ?? null,
    };
    return providersConfigCache;
  } catch {
    providersConfigCache = DEFAULT_PROVIDERS_CONFIG;
    return providersConfigCache;
  }
}

/**
 * 写入供应商配置。按字段合并:
 * 只传 providers 只覆盖供应商清单, 只传 modelSelection 只覆盖默认选定模型。
 */
export async function saveProvidersConfig(config: Partial<ProvidersUserConfig>): Promise<void> {
  const current = await getProvidersConfig();
  const next: ProvidersUserConfig = {
    providers: config.providers ?? current.providers,
    modelSelection:
      config.modelSelection !== undefined ? config.modelSelection : current.modelSelection,
  };
  await setAppConfig(PROVIDERS_CONFIG_KEY, JSON.stringify(next, null, 2));
  providersConfigCache = next;
}

/**
 * Build a provider-backed embedding model from the same BYOK registry used by
 * chat. Synchronous after provider config cache is populated.
 */
function getConfiguredEmbeddingModel(reference: string): ModelRouterEmbeddingModel | undefined {
  const separator = reference.indexOf("/");
  if (separator <= 0 || !providersConfigCache) return undefined;
  const providerId = reference.slice(0, separator);
  const modelId = reference.slice(separator + 1);
  const provider = providersConfigCache.providers.find(
    (candidate) => candidate.id === providerId || routerPrefix(candidate) === providerId,
  );
  if (!provider || provider.disabled || !provider.apiKey || !modelId) return undefined;
  const enabledModel = provider.enabledModels.find((model) => model.id === modelId);
  if (!enabledModel?.embedding) return undefined;
  const routedProviderId = routerPrefix(provider);
  if (provider.baseUrl) {
    if (provider.protocol && provider.protocol !== "openai") return undefined;
    return new ModelRouterEmbeddingModel({
      providerId: routedProviderId,
      modelId,
      url: provider.baseUrl,
      apiKey: provider.apiKey,
    });
  }
  if (routedProviderId !== "openai" && routedProviderId !== "google") return undefined;
  return new ModelRouterEmbeddingModel({
    providerId: routedProviderId,
    modelId,
    apiKey: provider.apiKey,
  });
}

export async function resolveConfiguredEmbeddingModelForUse(
  reference: string,
): Promise<ModelRouterEmbeddingModel | undefined> {
  await getProvidersConfig();
  return getConfiguredEmbeddingModel(reference);
}

/** 可用供应商 = 未禁用、有 Key、且至少启用了一个模型 */
export function usableProviders(config: ProvidersUserConfig): UserProviderConfig[] {
  return config.providers.filter(
    (provider) => !provider.disabled && provider.apiKey && provider.enabledModels.length > 0,
  );
}

/** 模型路由前缀: 内置供应商用 registryId, 自定义网关用自身 id */
export function routerPrefix(provider: UserProviderConfig): string {
  return provider.registryId ?? provider.id;
}

/** 从 `[gateway/]provider/model` 形态的路由 id 中取出 providerId 与 modelId */
export function splitRouterId(routerId: string): { providerId: string; modelId: string } {
  const withoutGateway = routerId.startsWith(`${WORKBENCH_GATEWAY_ID}/`)
    ? routerId.slice(WORKBENCH_GATEWAY_ID.length + 1)
    : routerId;
  const separator = withoutGateway.indexOf("/");
  if (separator === -1) return { providerId: withoutGateway, modelId: "" };
  return {
    providerId: withoutGateway.slice(0, separator),
    modelId: withoutGateway.slice(separator + 1),
  };
}

interface RequestModel {
  id: string;
  apiKey: string;
  url?: string;
  protocol?: GatewayProtocol;
  useResponses?: boolean;
}

function isRequestModel(value: unknown): value is RequestModel {
  if (typeof value !== "object" || value === null) return false;
  const model = value as Record<string, unknown>;
  return typeof model.id === "string" && typeof model.apiKey === "string";
}

/** 前端 body.model 携带模型路由 id; 真正的 URL、协议和 Key 始终从服务端读取 */
export async function resolveRequestModel(
  value: unknown,
): Promise<GatewayLanguageModel | { id: `${string}/${string}`; apiKey: string } | undefined> {
  if (!isRequestModel(value)) return undefined;
  const { providerId, modelId } = splitRouterId(value.id);
  return resolveConfiguredModel(providerId, modelId);
}

/** Resolve a persisted thread model selection without reconstructing a client request payload */
export async function resolveConfiguredModel(
  providerId: string,
  modelId: string,
): Promise<GatewayLanguageModel | { id: `${string}/${string}`; apiKey: string } | undefined> {
  if (!providerId.trim() || !modelId.trim()) return undefined;
  const config = await getProvidersConfig();
  const provider =
    config.providers.find((candidate) => routerPrefix(candidate) === providerId) ??
    config.providers.find((candidate) => candidate.id === providerId);

  if (!provider || provider.disabled || !provider.apiKey || !modelId) return undefined;
  if (!provider.registryId && !provider.baseUrl) return undefined;

  if (provider.baseUrl) {
    return createGatewayModel({
      modelId,
      apiKey: provider.apiKey,
      baseUrl: provider.baseUrl,
      protocol: provider.protocol,
      useResponses: provider.useResponses,
    });
  }

  const routedId = `${WORKBENCH_GATEWAY_ID}/${routerPrefix(provider)}/${modelId}`;
  return { id: routedId as `${string}/${string}`, apiKey: provider.apiKey };
}

/** 当前请求模型的家族名 (Mastra registry id) */
export function requestModelFamily(value: unknown): string | undefined {
  if (!isRequestModel(value) || value.url) return undefined;
  return splitRouterId(value.id).providerId || undefined;
}

/** 当前生效模型是否为「OpenAI 协议 + Responses 端点」的自定义网关 */
export async function usesOpenAIResponses(rawModel: unknown): Promise<boolean> {
  if (isRequestModel(rawModel)) {
    const config = await getProvidersConfig();
    const { providerId } = splitRouterId(rawModel.id);
    const provider =
      config.providers.find((candidate) => routerPrefix(candidate) === providerId) ??
      config.providers.find((candidate) => candidate.id === providerId);
    return Boolean(
      provider?.baseUrl && provider.protocol === "openai" && provider.useResponses === true,
    );
  }
  const config = await getProvidersConfig();
  const selection = config.modelSelection;
  if (!selection) return false;
  const provider = config.providers.find((candidate) => candidate.id === selection.providerId);
  return Boolean(
    provider &&
      !provider.disabled &&
      provider.apiKey &&
      !provider.registryId &&
      provider.baseUrl &&
      provider.protocol === "openai" &&
      provider.useResponses === true,
  );
}

/** 未显式指定模型时的家族名 (取自存储的默认选定模型) */
export async function defaultModelFamily(): Promise<string | undefined> {
  const config = await getProvidersConfig();
  const selection = config.modelSelection;
  if (!selection) return undefined;
  const provider = config.providers.find((candidate) => candidate.id === selection.providerId);
  if (!provider || provider.baseUrl) return undefined;
  return provider.registryId;
}

/** Agent 的默认模型 (Studio 直接聊天、以及记忆里「跟随当前模型」的场景) */
export async function resolveDefaultModelId(): Promise<`${string}/${string}` | undefined> {
  const config = await getProvidersConfig();
  const selection = config.modelSelection;
  const provider = selection
    ? config.providers.find((candidate) => candidate.id === selection.providerId)
    : undefined;
  if (selection) {
    if (!provider || provider.disabled || !provider.apiKey) return undefined;
    return `${WORKBENCH_GATEWAY_ID}/${routerPrefix(provider)}/${selection.modelId}`;
  }
  const fallback = usableProviders(config).find((candidate) => candidate.enabledModels.length > 0);
  const fallbackModel = fallback?.enabledModels[0];
  if (!fallback || !fallbackModel) return undefined;
  return `${WORKBENCH_GATEWAY_ID}/${routerPrefix(fallback)}/${fallbackModel.id}`;
}

export async function resolveDefaultLanguageModel(): Promise<GatewayLanguageModel | undefined> {
  const config = await getProvidersConfig();
  const selection = config.modelSelection;
  const provider = selection
    ? config.providers.find((candidate) => candidate.id === selection.providerId)
    : usableProviders(config).find((candidate) => candidate.enabledModels.length > 0);
  if (!provider || provider.disabled || !provider.apiKey) return undefined;
  const modelId = selection ? selection.modelId : provider.enabledModels[0]?.id;
  if (!modelId) return undefined;
  const protocol =
    provider.protocol ??
    (provider.registryId === "anthropic"
      ? "anthropic"
      : provider.registryId === "google" || provider.registryId === "gemini"
        ? "gemini"
        : provider.registryId === "openai"
          ? "openai"
          : undefined);
  if (!protocol) return undefined;
  return createGatewayModel({
    modelId,
    apiKey: provider.apiKey,
    baseUrl: provider.baseUrl,
    protocol,
    useResponses: provider.useResponses,
  });
}
