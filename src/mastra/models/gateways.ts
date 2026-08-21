/**
 * 自定义模型网关(docs/en/models/gateways/custom-gateways.mdx):
 * WorkbenchGateway 让 Studio 与 model router 直接使用存在数据库里的
 * 供应商与 Key —— fetchProviders 决定模型选择器内容,resolveAuth 在
 * getApiKey / env 回退之前被调用,凭据由网关自己从数据库取。
 */
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
} from "@mastra/core/llm";
import {
  type GatewayProtocol,
  getProvidersConfig,
  routerPrefix,
  splitRouterId,
  type UserProviderConfig,
  usableProviders,
} from "./providers";

export type { GatewayLanguageModel };

export const WORKBENCH_GATEWAY_ID = "mastra-work";

/**
 * 用官方 provider 包构造真实端点的 LanguageModel 实例,协议真实生效:
 * anthropic 走 Messages API、gemini 走原生 generateContent、
 * openai 按 useResponses 走 Responses 或 Chat Completions。
 *
 * OpenAI-compatible 网关使用 AI SDK 官方的 openai-compatible provider，
 * 原生支持 reasoning_content / reasoning、tool call 和标准 v4 stream。
 */
export function createGatewayModel(options: {
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

export class WorkbenchGateway extends MastraModelGateway {
  readonly id = WORKBENCH_GATEWAY_ID;
  readonly name = "MastraWork 供应商";

  private async findProvider(providerId: string): Promise<UserProviderConfig | undefined> {
    const providers = usableProviders(await getProvidersConfig());
    return (
      providers.find((provider) => routerPrefix(provider) === providerId) ??
      providers.find((provider) => provider.id === providerId)
    );
  }

  async fetchProviders(): Promise<Record<string, GatewayProviderConfig>> {
    const providers = usableProviders(await getProvidersConfig());
    return Object.fromEntries(
      providers.map((provider) => [
        routerPrefix(provider),
        {
          name: provider.name,
          models: provider.enabledModels.map((model) => model.id),
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

/** 内置供应商按 registryId 推断协议家族 */
function inferProtocol(providerId: string): GatewayProtocol {
  if (providerId === "anthropic") return "anthropic";
  if (providerId === "google" || providerId === "gemini") return "gemini";
  return "openai";
}
