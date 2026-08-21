import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  type GatewayAuthRequest,
  type GatewayAuthResult,
  type GatewayLanguageModel,
  type ProviderConfig as GatewayProviderConfig,
  MastraModelGateway,
  ModelRouterEmbeddingModel,
} from "@mastra/core/llm";
import { getAppConfig, setAppConfig } from "../storage";

export type { GatewayLanguageModel };

/** RequestContext key used by the shared work Agent and delegated Agents. */
export const REQUEST_MODEL_CONTEXT_KEY = "mastra-work:request-model";

/**
 * 模型供应商配置 + BYOK 请求模型解析 + 自定义模型网关。
 *
 * 三者本是同一个关注点(「用户配了哪些供应商 / 拿什么 Key / 怎么构造模型实例」),
 * 因此合在一个模块:
 * - 配置读写:app_config 表 key = "providers",设置面板「模型供应商」写入
 * - resolveRequestModel:我们自己的 chat 路由按请求覆盖模型
 * - WorkbenchGateway:注册给 Mastra 的 gateways,让 Studio 的模型选择器直接
 *   看到并使用这些配置(见 docs/en/models/gateways/custom-gateways.mdx)
 */

// ---------------------------------------------------------------------------
// 配置(与前端 src/renderer/src/lib/providers.ts 的类型一一对应)
// ---------------------------------------------------------------------------

export type GatewayProtocol = "openai" | "anthropic" | "gemini";

export interface EnabledModel {
  id: string;
  name: string;
  /** true only when the provider advertises an embedding endpoint for this model */
  embedding?: boolean;
}

export interface UserProviderConfig {
  id: string;
  name: string;
  /** 内置供应商 id(models.dev registry);为空 = 自定义网关 */
  registryId?: string;
  /** 自定义网关:协议与 Base URL */
  protocol?: GatewayProtocol;
  baseUrl?: string;
  /** OpenAI 协议专用:是否使用 Responses 端点 */
  useResponses?: boolean;
  apiKey: string;
  /** 禁用后不再出现在模型选择器中(已启用的模型保留配置) */
  disabled?: boolean;
  enabledModels: EnabledModel[];
}

/** 当前选定模型:既驱动我们的输入框,也作为 Agent 的默认模型(Studio 直接聊天时) */
export interface UserModelSelection {
  providerId: string;
  modelId: string;
  modelName: string;
  reasoningEffort: string;
}

export interface ProvidersUserConfig {
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
 * 写入供应商配置。**按字段合并**:只传 `providers` 只覆盖供应商清单,
 * 只传 `modelSelection` 只覆盖默认选定模型。
 *
 * 必须可分开写:前端的 `modelSelection` 状态在切换线程时会被线程自己的模型快照
 * 覆盖(thread.metadata.modelSelection),而那只是「本线程用哪个模型」,
 * 不应该顺带改掉「新线程与 Studio 的默认模型」。分字段写入让两者各有一份真相。
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
 * chat. This is synchronous after the provider config has been loaded once by
 * the service, which keeps Memory construction compatible with Agent's sync
 * dynamic provider callback.
 */
export function getConfiguredEmbeddingModel(
  reference: string,
): ModelRouterEmbeddingModel | undefined {
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
function usableProviders(config: ProvidersUserConfig): UserProviderConfig[] {
  return config.providers.filter(
    (provider) => !provider.disabled && provider.apiKey && provider.enabledModels.length > 0,
  );
}

/** 模型路由前缀:内置供应商用 registryId,自定义网关用自身 id */
function routerPrefix(provider: UserProviderConfig): string {
  return provider.registryId ?? provider.id;
}

// ---------------------------------------------------------------------------
// 模型实例构造(按协议走真实端点)
// ---------------------------------------------------------------------------

/**
 * 用官方 provider 包构造真实端点的 LanguageModel 实例,协议真实生效:
 * anthropic 走 Messages API、gemini 走原生 generateContent、
 * openai 按 useResponses 走 Responses 或 Chat Completions。
 *
 * OpenAI-compatible 网关必须使用 AI SDK 官方的 openai-compatible provider，
 * 因为它原生支持 reasoning_content / reasoning、tool call 和标准 v4 stream。
 */
function createGatewayModel(options: {
  modelId: string;
  apiKey: string;
  baseUrl?: string;
  protocol: GatewayProtocol | undefined;
  useResponses?: boolean;
}): GatewayLanguageModel {
  const { modelId, apiKey, baseUrl, protocol, useResponses } = options;
  switch (protocol) {
    case "anthropic":
      return createAnthropic({ ...(baseUrl ? { baseURL: baseUrl } : {}), apiKey })(modelId);
    case "gemini":
      return createGoogleGenerativeAI({ ...(baseUrl ? { baseURL: baseUrl } : {}), apiKey })(
        modelId,
      );
    default: {
      const openai = createOpenAI({ ...(baseUrl ? { baseURL: baseUrl } : {}), apiKey });
      if (useResponses) return openai.responses(modelId);
      if (baseUrl) {
        return createOpenAICompatible({
          name: "mastra-work-openai-compatible",
          baseURL: baseUrl,
          apiKey,
        }).chatModel(modelId);
      }
      return openai.chat(modelId);
    }
  }
}

// ---------------------------------------------------------------------------
// BYOK 请求模型解析(我们自己的 chat 路由)
// ---------------------------------------------------------------------------

export interface RequestModel {
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

/**
 * 前端 body.model 携带模型路由 id;真正的 URL、协议和 Key 始终从服务端
 * app_config 读取。这样旧请求里的 url 或 Key 缺失/过期时不会把模型静默交给
 * models.dev 的环境变量路由,也不会错误地回退到 Google 等默认 provider。
 */
export async function resolveRequestModel(
  value: unknown,
): Promise<GatewayLanguageModel | { id: `${string}/${string}`; apiKey: string } | undefined> {
  if (!isRequestModel(value)) return undefined;
  const { providerId, modelId } = splitRouterId(value.id);
  return resolveConfiguredModel(providerId, modelId);
}

/** Resolve a persisted thread model selection without reconstructing a client request payload. */
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

/**
 * 当前请求模型的家族名(models.dev registry id)。
 * 仅内置供应商返回;自定义网关返回 undefined —— 它虽然用官方 provider 包构造
 * (provider id 仍是 openai/anthropic/google),但对端未必支持 provider 原生检索,
 * 贸然注入 webSearchTool 会让上游报错,故一律视为不支持。
 */
export function requestModelFamily(value: unknown): string | undefined {
  if (!isRequestModel(value) || value.url) return undefined;
  return splitRouterId(value.id).providerId || undefined;
}

/**
 * 当前生效模型是否为「OpenAI 协议 + Responses 端点」的自定义网关。
 * Responses 端点的推理只回加密块(providerMetadata.openai.reasoningEncryptedContent),
 * 不带明文 —— 不请求 reasoningSummary 时,推理文本前端展示不出来、Memory 落库
 * 也是空串。内置供应商走 model router,不在此列。
 */
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

/** 未显式指定模型时的家族名(取自存储的默认选定模型) */
export async function defaultModelFamily(): Promise<string | undefined> {
  const config = await getProvidersConfig();
  const selection = config.modelSelection;
  if (!selection) return undefined;
  const provider = config.providers.find((candidate) => candidate.id === selection.providerId);
  if (!provider || provider.baseUrl) return undefined;
  return provider.registryId;
}

/**
 * Agent 的默认模型(Studio 直接聊天、以及记忆里「跟随当前模型」的场景)。
 *
 * 返回**带网关前缀**的路由 id,于是解析确定地落到 WorkbenchGateway:
 * Key 由 resolveAuth 从数据库取,既不注入 process.env 也不落进请求体。
 * 未配置时返回 undefined,调用方据此给出「请先配置供应商」而不是报缺 env。
 */
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
  // 未显式选定模型:回退第一个可用供应商的第一个启用模型 ——
  // 「添加供应商并启用模型」即可用,不强制先手动选定默认模型
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
    : // 与 resolveDefaultModelId 同款回退:未显式选定用第一个可用供应商
      usableProviders(config).find((candidate) => candidate.enabledModels.length > 0);
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

// ---------------------------------------------------------------------------
// 自定义模型网关:让 Studio 直接使用我们存在数据库里的供应商与 Key
//
// 机制(base.d.ts 的 MastraModelGatewayInterface):
// - fetchProviders 决定 Studio 模型选择器里出现哪些供应商与模型
// - resolveAuth 在 getApiKey / env 回退之前被调用,凭据由网关自己从数据库取,
//   因此全程无需把密钥注入 process.env
//
// 刻意**不实现** handlesModel:它会让本网关认领未加前缀的裸 id(如 openai/gpt-5)。
// 而 resolveModelAuth 只接收单个 gateway —— 认领即同时接管「解析」与「凭据」,
// 于是会绕过 models.dev 注册表的 per-model 覆盖(ProviderConfig.modelOverrides
// 的 shape: responses | completions 等)。代价大于收益,所以只在本网关前缀下
// (mastra-work/<provider>/<model>)提供模型,裸 id 仍归 models.dev 解析。
// ---------------------------------------------------------------------------

/** 从 `[gateway/]provider/model` 形态的路由 id 中取出 providerId 与 modelId */
function splitRouterId(routerId: string): { providerId: string; modelId: string } {
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

export const WORKBENCH_GATEWAY_ID = "mastra-work";

export class WorkbenchGateway extends MastraModelGateway {
  readonly id = WORKBENCH_GATEWAY_ID;
  readonly name = "MastraWork 供应商";

  /** 按 providerId 定位配置:先按注册表前缀匹配,再按供应商自身 id */
  private async findProvider(providerId: string): Promise<UserProviderConfig | undefined> {
    const providers = usableProviders(await getProvidersConfig());
    return (
      providers.find((provider) => routerPrefix(provider) === providerId) ??
      providers.find((provider) => provider.id === providerId)
    );
  }

  /** Studio 模型选择器的数据源 */
  async fetchProviders(): Promise<Record<string, GatewayProviderConfig>> {
    const providers = usableProviders(await getProvidersConfig());
    return Object.fromEntries(
      providers.map((provider) => [
        routerPrefix(provider),
        {
          name: provider.name,
          models: provider.enabledModels.map((model) => model.id),
          // 空数组表示该供应商不依赖进程环境变量;凭据由 resolveAuth 从 app_config
          // 提供,Studio 因此不会再显示「Set to use this provider」。
          apiKeyEnvVar: [],
          gateway: this.id,
          ...(provider.baseUrl ? { url: provider.baseUrl } : {}),
        } satisfies GatewayProviderConfig,
      ]),
    );
  }

  async resolveAuth(request: GatewayAuthRequest): Promise<GatewayAuthResult | undefined> {
    const provider = await this.findProvider(request.providerId);
    if (!provider) return undefined;
    return { apiKey: provider.apiKey, source: "gateway" };
  }

  async getApiKey(modelId: string): Promise<string> {
    const { providerId } = splitRouterId(modelId);
    const provider = await this.findProvider(providerId);
    if (!provider) {
      throw new Error(`未在设置中找到供应商 ${providerId} 的 API Key,请先在「模型供应商」配置`);
    }
    return provider.apiKey;
  }

  /** 自定义网关返回其 Base URL;内置供应商返回 undefined 以走官方端点 */
  async buildUrl(modelId: string): Promise<string | undefined> {
    const { providerId } = splitRouterId(modelId);
    const provider = await this.findProvider(providerId);
    return provider?.baseUrl || undefined;
  }

  async resolveLanguageModel(args: {
    modelId: string;
    providerId: string;
    apiKey: string;
  }): Promise<GatewayLanguageModel> {
    const provider = await this.findProvider(args.providerId);
    const baseUrl = provider?.baseUrl;
    if (!baseUrl) {
      // 内置供应商无自定义端点:用官方包的默认 baseURL(不传 baseURL 即官方端点)
      const protocol = inferProtocol(args.providerId);
      if (protocol === "anthropic") return createAnthropic({ apiKey: args.apiKey })(args.modelId);
      if (protocol === "gemini") {
        return createGoogleGenerativeAI({ apiKey: args.apiKey })(args.modelId);
      }
      return createOpenAI({ apiKey: args.apiKey }).responses(args.modelId);
    }
    return createGatewayModel({
      modelId: args.modelId,
      apiKey: args.apiKey,
      baseUrl,
      protocol: provider?.protocol,
      useResponses: provider?.useResponses,
    });
  }
}

/** 内置供应商按 registryId 推断协议家族(models.dev 的 id 即家族名) */
function inferProtocol(providerId: string): GatewayProtocol {
  if (providerId === "anthropic") return "anthropic";
  if (providerId === "google" || providerId === "gemini") return "gemini";
  return "openai";
}
