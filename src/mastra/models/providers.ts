/**
 * 模型供应商配置与 BYOK 解析。
 * 官方文档:docs/en/models/index.mdx(model router 的 provider/model 路由格式)、
 * docs/en/models/environment-variables.mdx。
 * 配置读写走 app_config 表(key = "providers"),设置面板「模型供应商」写入;
 * resolveRequestModel 供 chat / session 路由按请求覆盖模型 —— 路由 id 只携带
 * provider/model,URL 与 API Key 始终在服务端解析,不经请求体下发。
 */
import type { GatewayLanguageModel } from "@mastra/core/llm";
import { z } from "zod";
import {
  CredentialHintSchema,
  providerCredentialPurpose,
  SecretRefSchema,
} from "../../shared/credential-contract";
import { deleteCredential, resolveCredential } from "../credential-broker";
import { getAppConfig, setAppConfig } from "../storage";
import {
  createGatewayModel,
  type GatewayProtocol,
  inferGatewayProtocol,
  WORKBENCH_GATEWAY_ID,
} from "./create-model";

/** 请求级模型覆盖:chat 路由写入,Agent / 子 Agent 的 model 回调读取 */
export const REQUEST_MODEL_CONTEXT_KEY = "mastra-work:request-model";

export interface EnabledModel {
  id: string;
  name: string;
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
  credentialRef: string;
  credentialHint: string;
  hasCredential: true;
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
const providersPatchSchema = z
  .object({
    providers: z.array(providerSchema).optional(),
    modelSelection: modelSelectionSchema.nullable().optional(),
  })
  .strict();

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
export function usableProviders(config: ProvidersUserConfig): UserProviderConfig[] {
  return config.providers.filter(
    (provider) => !provider.disabled && provider.hasCredential && provider.enabledModels.length > 0,
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
}

function isRequestModel(value: unknown): value is RequestModel {
  if (typeof value !== "object" || value === null) return false;
  const model = value as Record<string, unknown>;
  return typeof model.id === "string" && Object.keys(model).every((key) => key === "id");
}

export async function resolveProviderCredential(provider: UserProviderConfig): Promise<string> {
  return resolveCredential(provider.credentialRef, providerCredentialPurpose(provider.id));
}

export interface ModelSelectionInput {
  providerId: string;
  modelId: string;
}

/** Parse an untrusted route payload into the provider/model pair used by the resolver. */
export function parseModelSelection(value: unknown): ModelSelectionInput | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const selection = value as Record<string, unknown>;
  const providerId = typeof selection.providerId === "string" ? selection.providerId.trim() : "";
  const modelId = typeof selection.modelId === "string" ? selection.modelId.trim() : "";
  return providerId && modelId ? { providerId, modelId } : undefined;
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
  const provider =
    config.providers.find((candidate) => routerPrefix(candidate) === providerId) ??
    config.providers.find((candidate) => candidate.id === providerId);

  if (!provider || provider.disabled || !provider.hasCredential || !modelId) return undefined;
  // A route is valid only when the model is explicitly enabled for this
  // provider. This keeps persisted subagent selections and request overrides
  // aligned with the same catalog used by the model picker.
  if (!provider.enabledModels.some((model) => model.id === modelId)) return undefined;
  if (!provider.registryId && !provider.baseUrl) return undefined;
  const apiKey = await resolveProviderCredential(provider);

  // The registered Mastra gateway is also used by Studio's global model router,
  // but that router has no resourceId argument. BYOK settings are tenant-scoped,
  // so request-context routes must resolve the provider here before constructing
  // the SDK model. The construction itself stays in the shared factory below.
  if (provider.baseUrl) {
    return createGatewayModel({
      modelId,
      modelRouterId: `${routerPrefix(provider)}/${modelId}`,
      apiKey,
      baseUrl: provider.baseUrl,
      protocol: provider.protocol,
      useResponses: provider.useResponses,
      providerName: provider.name,
    });
  }

  const protocol = provider.protocol ?? inferGatewayProtocol(provider.registryId ?? "");
  if (!protocol) return undefined;
  return createGatewayModel({
    modelId,
    modelRouterId: `${routerPrefix(provider)}/${modelId}`,
    apiKey,
    protocol,
    useResponses: provider.useResponses,
    providerName: provider.name,
  });
}

/** 当前请求模型的家族名 (Mastra registry id) */
export function requestModelFamily(value: unknown): string | undefined {
  if (!isRequestModel(value)) return undefined;
  return splitRouterId(value.id).providerId || undefined;
}

/** 当前生效模型是否为「OpenAI 协议 + Responses 端点」的自定义网关 */
export async function usesOpenAIResponses(
  rawModel: unknown,
  resourceId?: string,
): Promise<boolean> {
  if (isRequestModel(rawModel)) {
    const config = await getProvidersConfig(resourceId);
    const { providerId } = splitRouterId(rawModel.id);
    const provider =
      config.providers.find((candidate) => routerPrefix(candidate) === providerId) ??
      config.providers.find((candidate) => candidate.id === providerId);
    return Boolean(
      provider?.baseUrl && provider.protocol === "openai" && provider.useResponses === true,
    );
  }
  const config = await getProvidersConfig(resourceId);
  const selection = config.modelSelection;
  if (!selection) return false;
  const provider = config.providers.find((candidate) => candidate.id === selection.providerId);
  return Boolean(
    provider &&
      !provider.disabled &&
      provider.hasCredential &&
      !provider.registryId &&
      provider.baseUrl &&
      provider.protocol === "openai" &&
      provider.useResponses === true,
  );
}

/** 未显式指定模型时的家族名 (取自存储的默认选定模型) */
export async function defaultModelFamily(resourceId?: string): Promise<string | undefined> {
  const config = await getProvidersConfig(resourceId);
  const selection = config.modelSelection;
  if (!selection) return undefined;
  const provider = config.providers.find((candidate) => candidate.id === selection.providerId);
  if (!provider || provider.baseUrl) return undefined;
  return provider.registryId;
}

/** Agent 的默认模型 (Studio 直接聊天、以及记忆里「跟随当前模型」的场景) */
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
    return `${WORKBENCH_GATEWAY_ID}/${routerPrefix(provider)}/${selection.modelId}`;
  }
  const fallback = usableProviders(config).find((candidate) => candidate.enabledModels.length > 0);
  const fallbackModel = fallback?.enabledModels[0];
  if (!fallback || !fallbackModel) return undefined;
  return `${WORKBENCH_GATEWAY_ID}/${routerPrefix(fallback)}/${fallbackModel.id}`;
}

export async function resolveDefaultLanguageModel(
  resourceId?: string,
): Promise<GatewayLanguageModel | undefined> {
  const config = await getProvidersConfig(resourceId);
  const selection = config.modelSelection;
  const provider = selection
    ? config.providers.find((candidate) => candidate.id === selection.providerId)
    : usableProviders(config).find((candidate) => candidate.enabledModels.length > 0);
  if (
    !provider ||
    provider.disabled ||
    !provider.hasCredential ||
    !provider.enabledModels.some(
      (model) => model.id === (selection?.modelId ?? provider.enabledModels[0]?.id),
    )
  )
    return undefined;
  const modelId = selection ? selection.modelId : provider.enabledModels[0]?.id;
  if (!modelId) return undefined;
  return resolveConfiguredModel(routerPrefix(provider), modelId, resourceId);
}
