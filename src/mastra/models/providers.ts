/**
 * 模型供应商配置与 BYOK 解析。
 * 官方文档:docs/en/models/index.mdx(model router 的 provider/model 路由格式)、
 * docs/en/models/environment-variables.mdx。
 * 配置读写走 app_config 表(key = "providers"),设置面板「模型供应商」写入;
 * resolveRequestModel 供 chat / session 路由按请求覆盖模型 —— 路由 id 只携带
 * provider/model,URL 与 API Key 始终在服务端解析,不经请求体下发。
 */
import { createAnthropic } from "@ai-sdk/anthropic";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  type GatewayLanguageModel,
  getProviderConfig,
  ModelsDevGateway,
  modelSupportsStructuredOutput,
} from "@mastra/core/llm";
import { MASTRA_RESOURCE_ID_KEY } from "@mastra/core/request-context";
import { defaultSettingsMiddleware, type LanguageModelMiddleware, wrapLanguageModel } from "ai";
import { z } from "zod";
import {
  CredentialHintSchema,
  providerCredentialPurpose,
  SecretRefSchema,
} from "../../shared/credential-contract";
import { deleteCredential, resolveCredential } from "../credential-broker";
import { getAppConfig, setAppConfig } from "../storage";

const REGISTRY_GATEWAY = new ModelsDevGateway();
type GatewayProtocol = "openai" | "anthropic" | "gemini";

/** Keep authenticated library URLs intact until the attachment input processor resolves them. */
const libraryAttachmentMiddleware: LanguageModelMiddleware = {
  async overrideSupportedUrls({ model }) {
    const supported = await model.supportedUrls;
    return {
      ...supported,
      "*/*": [
        ...(supported["*/*"] ?? []),
        /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?\/work\/library\/assets\/[^/]+\/content(?:\?.*)?$/i,
      ],
    };
  },
};

/** Resolve the SDK protocol from Mastra's provider registry metadata. */
export function inferGatewayProtocol(registryId: string): GatewayProtocol | undefined {
  const provider = getProviderConfig(registryId.trim());
  if (!provider) return undefined;
  const npm = provider.npm?.toLowerCase() ?? "";
  if (npm.includes("anthropic")) return "anthropic";
  if (npm.includes("google") || npm.includes("gemini")) return "gemini";
  if (provider.url || npm.includes("openai")) return "openai";
  return undefined;
}

/** 无 Controller 的独立操作可指定模型；Session 运行以原生 modelId 为准。 */
export const REQUEST_MODEL_ID_CONTEXT_KEY = "mastra-work:request-model-id";

const PROVIDERS_CONFIG_KEY = "providers";

const enabledModelSchema = z.object({ id: z.string().min(1), name: z.string() }).strict();
const providerSchema = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
    name: z.string().min(1).max(128),
    registryId: z.string().min(1).max(128).optional(),
    protocol: z.enum(["openai", "anthropic", "gemini"]).optional(),
    baseUrl: z.url().optional(),
    useResponses: z.boolean().optional(),
    credentialRef: SecretRefSchema,
    credentialHint: CredentialHintSchema,
    hasCredential: z.literal(true),
    disabled: z.boolean().optional(),
    enabledModels: z.array(enabledModelSchema),
  })
  .strict();
const modelSelectionSchema = z
  .object({
    providerId: z.string().min(1),
    modelId: z.string().min(1),
    modelName: z.string(),
    reasoningEffort: z.string(),
  })
  .strict();
const providersConfigSchema = z
  .object({ providers: z.array(providerSchema), modelSelection: modelSelectionSchema.nullable() })
  .strict();
export const providersPatchSchema = z
  .object({
    providers: z.array(providerSchema).optional(),
    modelSelection: modelSelectionSchema.nullable().optional(),
  })
  .strict();

export type UserProviderConfig = z.infer<typeof providerSchema>;
type ProvidersUserConfig = z.infer<typeof providersConfigSchema>;

const DEFAULT_PROVIDERS_CONFIG: ProvidersUserConfig = { providers: [], modelSelection: null };
const providersConfigCache = new Map<string, ProvidersUserConfig>();

function providerScopeKey(resourceId?: string): string {
  return resourceId?.trim() || "__system__";
}

export async function getProvidersConfig(resourceId?: string): Promise<ProvidersUserConfig> {
  const scope = providerScopeKey(resourceId);
  const cached = providersConfigCache.get(scope);
  if (cached) return cached;
  const raw = await getAppConfig(PROVIDERS_CONFIG_KEY, resourceId);
  if (!raw) {
    providersConfigCache.set(scope, DEFAULT_PROVIDERS_CONFIG);
    return DEFAULT_PROVIDERS_CONFIG;
  }
  try {
    const config = providersConfigSchema.parse(JSON.parse(raw));
    providersConfigCache.set(scope, config);
    return config;
  } catch {
    providersConfigCache.set(scope, DEFAULT_PROVIDERS_CONFIG);
    return DEFAULT_PROVIDERS_CONFIG;
  }
}

/**
 * 写入供应商配置。按字段合并:
 * 只传 providers 只覆盖供应商清单, 只传 modelSelection 只覆盖默认选定模型。
 */
export async function saveProvidersConfig(config: unknown, resourceId?: string): Promise<void> {
  const patch = providersPatchSchema.parse(config);
  const current = await getProvidersConfig(resourceId);
  const next: ProvidersUserConfig = {
    providers: patch.providers ?? current.providers,
    modelSelection:
      patch.modelSelection !== undefined ? patch.modelSelection : current.modelSelection,
  };
  if (patch.providers) {
    await Promise.all(patch.providers.map(resolveProviderCredential));
  }
  await setAppConfig(PROVIDERS_CONFIG_KEY, JSON.stringify(next, null, 2), resourceId);
  providersConfigCache.set(providerScopeKey(resourceId), next);
  if (patch.providers) {
    const nextById = new Map(next.providers.map((provider) => [provider.id, provider]));
    await Promise.all(
      current.providers
        .filter((provider) => nextById.get(provider.id)?.credentialRef !== provider.credentialRef)
        .map((provider) =>
          deleteCredential(provider.credentialRef, providerCredentialPurpose(provider.id)).catch(
            () => undefined,
          ),
        ),
    );
  }
}

/** 可用供应商 = 未禁用、有 Key、且至少启用了一个模型 */
function usableProviders(config: ProvidersUserConfig): UserProviderConfig[] {
  return config.providers.filter(
    (provider) => !provider.disabled && provider.hasCredential && provider.enabledModels.length > 0,
  );
}

/** 模型路由前缀: 内置供应商用 registryId, 自定义网关用自身 id */
export function routerPrefix(provider: UserProviderConfig): string {
  return provider.registryId ?? provider.id;
}

/** Native Session stores the configured provider id followed by the model id. */
export function splitRouterId(routerId: string): { providerId: string; modelId: string } {
  const separator = routerId.indexOf("/");
  if (separator === -1) return { providerId: routerId, modelId: "" };
  return {
    providerId: routerId.slice(0, separator),
    modelId: routerId.slice(separator + 1),
  };
}

interface RequestModel {
  id: string;
}

function isRequestModel(value: unknown): value is RequestModel {
  if (typeof value !== "object" || value === null) return false;
  const model = value as Record<string, unknown>;
  return typeof model.id === "string" && Object.keys(model).every((key) => key === "id");
}

export async function resolveProviderCredential(provider: UserProviderConfig): Promise<string> {
  return resolveCredential(provider.credentialRef, providerCredentialPurpose(provider.id));
}

/** 前端 body.model 携带模型路由 id; 真正的 URL、协议和 Key 始终从服务端读取 */
export async function resolveRequestModel(
  value: unknown,
  resourceId?: string,
): Promise<GatewayLanguageModel | undefined> {
  if (!isRequestModel(value)) return undefined;
  const { providerId, modelId } = splitRouterId(value.id);
  return resolveConfiguredModel(providerId, modelId, resourceId);
}

/** Resolve a persisted thread model selection without reconstructing a client request payload */
export async function resolveConfiguredModel(
  providerId: string,
  modelId: string,
  resourceId?: string,
): Promise<GatewayLanguageModel | undefined> {
  if (!providerId.trim() || !modelId.trim()) return undefined;
  const config = await getProvidersConfig(resourceId);
  const provider = config.providers.find((candidate) => candidate.id === providerId);

  if (!provider || provider.disabled || !provider.hasCredential || !modelId) return undefined;
  // A route is valid only when the model is explicitly enabled for this
  // provider. This keeps persisted subagent selections and request overrides
  // aligned with the same catalog used by the model picker.
  if (!provider.enabledModels.some((model) => model.id === modelId)) return undefined;
  if (!provider.registryId && !provider.baseUrl) return undefined;
  const apiKey = await resolveProviderCredential(provider);

  const protocol = provider.protocol ?? inferGatewayProtocol(provider.registryId ?? "");
  let model: GatewayLanguageModel;
  if (!provider.baseUrl && provider.registryId) {
    // The official registry owns provider SDKs, endpoints and model-specific overrides.
    model = await REGISTRY_GATEWAY.resolveLanguageModel({
      modelId,
      providerId: provider.registryId,
      apiKey,
    });
  } else {
    const baseURL = provider.baseUrl;
    if (!baseURL) return undefined;
    switch (protocol) {
      case "anthropic":
        model = createAnthropic({ apiKey, baseURL })(modelId);
        break;
      case "gemini":
        model = createGoogleGenerativeAI({ apiKey, baseURL })(modelId);
        break;
      default:
        if (provider.useResponses) {
          model = createOpenAI({ apiKey, baseURL }).responses(modelId);
        } else if (provider.registryId === "deepseek") {
          model = createDeepSeek({ apiKey, baseURL })(modelId);
        } else {
          model = createOpenAICompatible({
            apiKey,
            baseURL,
            name: provider.name,
            supportsStructuredOutputs: modelSupportsStructuredOutput(
              `${routerPrefix(provider)}/${modelId}`,
            ),
          }).chatModel(modelId);
        }
    }
  }
  return wrapLanguageModel({
    model,
    middleware: [
      libraryAttachmentMiddleware,
      ...(protocol === "anthropic"
        ? [
            defaultSettingsMiddleware({
              settings: { providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } } },
            }),
          ]
        : []),
    ],
  });
}

/** 当前请求模型的家族名 (Mastra registry id) */
export async function requestModelFamily(
  value: unknown,
  resourceId?: string,
): Promise<string | undefined> {
  if (!isRequestModel(value)) return undefined;
  const { providerId } = splitRouterId(value.id);
  const config = await getProvidersConfig(resourceId);
  const provider = config.providers.find((candidate) => candidate.id === providerId);
  return provider?.baseUrl ? undefined : provider?.registryId;
}

/**
 * 当前生效模型是否请求 OpenAI Responses 端点。
 * 内置 openai provider 由 Mastra 官方 registry 网关构造,它固定用 responses();
 * 自定义网关则看用户勾选的 useResponses。
 */
function providerUsesResponses(provider: UserProviderConfig | undefined): boolean {
  if (!provider) return false;
  if (provider.registryId === "openai" && !provider.baseUrl) return true;
  return Boolean(provider.baseUrl && provider.protocol === "openai" && provider.useResponses);
}

export async function usesOpenAIResponses(
  rawModel: unknown,
  resourceId?: string,
): Promise<boolean> {
  const config = await getProvidersConfig(resourceId);
  if (isRequestModel(rawModel)) {
    const { providerId } = splitRouterId(rawModel.id);
    return providerUsesResponses(config.providers.find((candidate) => candidate.id === providerId));
  }
  const selection = config.modelSelection;
  if (!selection) return false;
  const provider = config.providers.find((candidate) => candidate.id === selection.providerId);
  if (!provider || provider.disabled || !provider.hasCredential) return false;
  return providerUsesResponses(provider);
}

/** Resolve the user's selected model, or the first enabled model for a new configuration. */
export async function resolveDefaultModelId(
  resourceId?: string,
): Promise<`${string}/${string}` | undefined> {
  const config = await getProvidersConfig(resourceId);
  const selection = config.modelSelection;
  const provider = selection
    ? config.providers.find((candidate) => candidate.id === selection.providerId)
    : undefined;
  if (selection) {
    if (
      !provider ||
      provider.disabled ||
      !provider.hasCredential ||
      !provider.enabledModels.some((model) => model.id === selection.modelId)
    )
      return undefined;
    return `${provider.id}/${selection.modelId}`;
  }
  const fallback = usableProviders(config).find((candidate) => candidate.enabledModels.length > 0);
  const fallbackModel = fallback?.enabledModels[0];
  if (!fallback || !fallbackModel) return undefined;
  return `${fallback.id}/${fallbackModel.id}`;
}

export async function resolveDefaultLanguageModel(
  resourceId?: string,
): Promise<GatewayLanguageModel | undefined> {
  const modelId = await resolveDefaultModelId(resourceId);
  return modelId ? resolveRequestModel({ id: modelId }, resourceId) : undefined;
}

/** Agent、子 Agent 与 OM 从同一个原生 Session 模型选择解析租户凭据。 */
export async function resolveContextModel(requestContext?: {
  get(key: string): unknown;
}): Promise<GatewayLanguageModel | undefined> {
  const resourceId = requestContext?.get(MASTRA_RESOURCE_ID_KEY) as string | undefined;
  const controller = requestContext?.get("controller") as
    | { session?: { modelId?: string } }
    | undefined;
  if (controller?.session?.modelId) {
    return resolveRequestModel({ id: controller.session.modelId }, resourceId);
  }
  const modelId = requestContext?.get(REQUEST_MODEL_ID_CONTEXT_KEY);
  return typeof modelId === "string" && modelId
    ? resolveRequestModel({ id: modelId }, resourceId)
    : resolveDefaultLanguageModel(resourceId);
}

/** Native mode transitions can change the provider after the HTTP request was prepared. */
export async function resolveContextModelFamily(requestContext?: {
  get(key: string): unknown;
}): Promise<string | undefined> {
  const resourceId = requestContext?.get(MASTRA_RESOURCE_ID_KEY) as string | undefined;
  const controller = requestContext?.get("controller") as
    | { session?: { modelId?: string } }
    | undefined;
  const modelId = controller?.session?.modelId ?? requestContext?.get(REQUEST_MODEL_ID_CONTEXT_KEY);
  const selected =
    typeof modelId === "string" && modelId ? modelId : await resolveDefaultModelId(resourceId);
  return selected ? requestModelFamily({ id: selected }, resourceId) : undefined;
}
