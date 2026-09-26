/**
 * 模型构建共享模块: 网关 id、协议类型与 LanguageModel 工厂。
 * 打破 gateways.ts -> providers.ts -> gateways.ts 的循环依赖:
 * providers.ts 与 gateways.ts 都从这里取 createGatewayModel /
 * WORKBENCH_GATEWAY_ID / GatewayProtocol, 本模块不依赖二者。
 *
 * 用官方 provider 包构造真实端点的 LanguageModel 实例,协议真实生效:
 * anthropic 走 Messages API、gemini 走原生 generateContent、
 * openai 按 useResponses 走 Responses 或 Chat Completions。
 *
 * OpenAI-compatible 网关直接复用 createOpenAI 的官方 compatibility: "compatible"
 * 模式(AI SDK 内置的兼容端点处理),原生支持 reasoning_content / reasoning、
 * tool call 与标准 v4 stream,无需另起 createOpenAICompatible 实例。
 *
 * 内置 registry provider(只存 registryId、没有自定义端点)不再自己拼端点,
 * 交给 Mastra 官方 models.dev 网关(docs/en/models/overview.mdx):端点来自 provider
 * registry,并按 provider 选用官方实现(deepseek 的 reasoning_content、openai 的
 * Responses 等);registry 里没有端点时它自己报错,不会回退到 SDK 默认端点。
 */
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { Agent } from "@mastra/core/agent";
import {
  defaultGateways,
  type GatewayLanguageModel,
  getProviderConfig,
  modelSupportsStructuredOutput,
} from "@mastra/core/llm";
import { defaultSettingsMiddleware, wrapLanguageModel } from "ai";

export type { GatewayLanguageModel };

/** Mastra 官方 provider registry 网关(静态 registry,无需联网即可解析端点)。 */
const REGISTRY_GATEWAY = defaultGateways.find((gateway) => gateway.id === "models.dev");

export type GatewayProtocol = "openai" | "anthropic" | "gemini";

export const WORKBENCH_GATEWAY_ID = "mastra-work";

/**
 * Mastra's MessageList downloads URL file parts before processLLMRequest runs
 * unless the model advertises that the URL is provider-supported. Library
 * asset URLs are protected by the desktop request context, so that automatic
 * downloader cannot authenticate and turns an otherwise valid attachment into
 * a 401 stream failure. Keep the URL in the prompt until our processor expands
 * it with the authenticated asset store.
 */
const LOCAL_LIBRARY_ASSET_URL =
  /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?\/work\/library\/assets\/[^/]+\/content(?:\?.*)?$/i;

function withLocalLibraryAssetUrls<T extends GatewayLanguageModel>(model: T): T {
  const current = model.supportedUrls;
  const merge = (supported: Record<string, RegExp[]>): Record<string, RegExp[]> => ({
    ...supported,
    "*/*": [...(supported["*/*"] ?? []), LOCAL_LIBRARY_ASSET_URL],
  });
  const value =
    current && typeof (current as PromiseLike<Record<string, RegExp[]>>).then === "function"
      ? Promise.resolve(current).then(merge)
      : merge((current as Record<string, RegExp[]> | undefined) ?? {});
  Object.defineProperty(model, "supportedUrls", {
    configurable: true,
    enumerable: true,
    value,
  });
  return model;
}

/** One-shot Mastra Agent for isolated route work: no registry, memory, or tools. */
export function createEphemeralAgent(
  model: GatewayLanguageModel,
  options: { id: string; name: string; instructions: string },
): Agent {
  return new Agent({ ...options, model });
}

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

/**
 * Resolve the endpoint shipped in Mastra's provider registry.
 *
 * Only gateway metadata needs this: `WorkbenchGateway.fetchProviders/buildUrl`
 * must report an endpoint for providers that persist just a registry id. Model
 * construction goes through the official registry gateway instead.
 */
export function getRegistryProviderBaseUrl(registryId: string): string | undefined {
  const provider = getProviderConfig(registryId.trim());
  const url = typeof provider?.url === "string" ? provider.url.trim() : "";
  if (!url) return undefined;
  return url;
}

/**
 * DeepSeek thinking requests must replay reasoning_content on every assistant
 * message that precedes a tool call. Keep this transform pure so the provider
 * boundary can be regression-tested without making a network request.
 *
 * ponytail: only custom DeepSeek endpoints reach this. Registry DeepSeek goes
 * through Mastra's registry gateway, which uses the official provider and fills
 * reasoning_content itself, scoped to the models that require it. A custom
 * baseUrl forces the generic OpenAI-compatible shape, where that conversion is
 * unreachable without depending on @ai-sdk/deepseek directly; drop this once
 * Mastra resolves provider implementations for user-supplied endpoints too.
 */
export function transformDeepSeekRequestBody(
  body: Record<string, unknown>,
): Record<string, unknown> {
  if (!Array.isArray(body.messages)) return body;
  return {
    ...body,
    messages: body.messages.map((message) => {
      if (
        typeof message !== "object" ||
        message === null ||
        (message as { role?: unknown }).role !== "assistant"
      ) {
        return message;
      }
      const assistant = message as Record<string, unknown>;
      return {
        ...assistant,
        reasoning_content:
          typeof assistant.reasoning_content === "string" ? assistant.reasoning_content : "",
      };
    }),
  };
}

export function normalizeGatewayBaseUrl(
  baseUrl: string | undefined,
  protocol: GatewayProtocol | undefined,
): string | undefined {
  if (!baseUrl) return undefined;
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (!trimmed) return undefined;
  // openai / anthropic 的 SDK 把 baseURL 当作已含版本段的根(默认 …/v1),
  // 只追加端点路径(/chat/completions、/messages),不会自行补 /v1。
  // 故裸域名/裸 IP 时补 /v1;已带路径的端点(如 /api/paas/v4)原样保留,
  // 与前端 normalizeGatewayUrl 行为一致。gemini 由 SDK 默认 baseURL 处理。
  if (protocol === "openai" || protocol === "anthropic") {
    if (trimmed.endsWith("/v1")) return trimmed;
    try {
      const parsed = new URL(trimmed);
      if (parsed.pathname === "" || parsed.pathname === "/") {
        return `${trimmed}/v1`;
      }
    } catch {}
    return trimmed;
  }
  return trimmed;
}

export async function createGatewayModel(options: {
  modelId: string;
  modelRouterId?: string;
  registryId?: string;
  apiKey: string;
  baseUrl?: string;
  protocol: GatewayProtocol | undefined;
  useResponses?: boolean;
  /** Display name used by AI SDK observability for custom gateways. */
  providerName?: string;
}): Promise<GatewayLanguageModel> {
  const { modelId, apiKey, protocol, useResponses, providerName } = options;
  // Anthropic/Gemini-compatible registry providers are intentionally built
  // with their native SDKs below, so they must inherit the endpoint shipped
  // in Mastra's registry when the user has not supplied an override. Keep
  // OpenAI/DeepSeek registry providers on models.dev: that gateway selects
  // provider-specific implementations such as Responses and reasoning fields.
  const nativeRegistryBaseUrl =
    !options.baseUrl && (protocol === "anthropic" || protocol === "gemini") && options.registryId
      ? getRegistryProviderBaseUrl(options.registryId)
      : undefined;
  const normalizedBaseUrl = normalizeGatewayBaseUrl(
    options.baseUrl ?? nativeRegistryBaseUrl,
    protocol,
  );
  // anthropic / gemini 官方 SDK 自带正确默认端点,继续直接构造(anthropic 还要保留
  // cacheControl 中间件);其余已在 registry 中的 provider 没有自定义端点时交给
  // 官方网关,由它提供端点与 provider 专用实现(openai 固定走 responses(),
  // useResponses 只对自定义网关生效);registry 认不出的 provider 落到下方报错。
  if (
    REGISTRY_GATEWAY &&
    !normalizedBaseUrl &&
    options.registryId &&
    getRegistryProviderBaseUrl(options.registryId) &&
    protocol !== "anthropic" &&
    protocol !== "gemini"
  ) {
    return withLocalLibraryAssetUrls(
      await REGISTRY_GATEWAY.resolveLanguageModel({
        modelId,
        providerId: options.registryId,
        apiKey,
      }),
    );
  }
  const common = {
    apiKey,
    ...(providerName?.trim() ? { name: providerName.trim() } : {}),
  };
  const supportsStructuredOutputs = options.modelRouterId
    ? modelSupportsStructuredOutput(options.modelRouterId)
    : undefined;
  let model: GatewayLanguageModel;
  switch (protocol) {
    case "anthropic":
      model = wrapLanguageModel({
        model: createAnthropic({
          ...(normalizedBaseUrl ? { baseURL: normalizedBaseUrl } : {}),
          ...common,
        })(modelId),
        middleware: defaultSettingsMiddleware({
          settings: { providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } } },
        }),
      });
      break;
    case "gemini":
      model = createGoogleGenerativeAI({
        ...(normalizedBaseUrl ? { baseURL: normalizedBaseUrl } : {}),
        ...common,
      })(modelId);
      break;
    default: {
      if (useResponses) {
        const openai = createOpenAI({
          ...(normalizedBaseUrl ? { baseURL: normalizedBaseUrl } : {}),
          ...common,
        });
        model = openai.responses(modelId);
        break;
      }
      if (normalizedBaseUrl) {
        const transformRequestBody =
          options.registryId === "deepseek" ? transformDeepSeekRequestBody : undefined;
        model = createOpenAICompatible({
          baseURL: normalizedBaseUrl,
          name: providerName?.trim() || "openai-compatible",
          apiKey,
          ...(supportsStructuredOutputs !== undefined ? { supportsStructuredOutputs } : {}),
          ...(transformRequestBody ? { transformRequestBody } : {}),
        }).chatModel(modelId);
        break;
      }
      // registry provider 已在上面交给官方 router;走到这里说明既没有 registry
      // 端点也没有自定义端点,fail-closed,不把用户的 Key 发往 SDK 默认端点。
      throw new Error(`供应商 ${providerName || modelId} 缺少 API 端点,请在设置中填写 Base URL`);
    }
  }

  if (supportsStructuredOutputs !== undefined) {
    Object.assign(model, { supportsStructuredOutputs });
  }
  return withLocalLibraryAssetUrls(model);
}
