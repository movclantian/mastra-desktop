/**
 * 自定义模型网关(docs/en/models/gateways/custom-gateways.mdx):
 * WorkbenchGateway 让 Studio 与 model router 直接使用存在数据库里的
 * 供应商与 Key —— fetchProviders 决定模型选择器内容,resolveAuth 在
 * getApiKey / env 回退之前被调用,凭据由网关自己从数据库取。
 */
import {
  type GatewayAuthRequest,
  type GatewayAuthResult,
  type GatewayLanguageModel,
  type ProviderConfig as GatewayProviderConfig,
  MastraModelGateway,
} from "@mastra/core/llm";
import { createGatewayModel, inferGatewayProtocol, WORKBENCH_GATEWAY_ID } from "./create-model";
import {
  getProvidersConfig,
  routerPrefix,
  splitRouterId,
  type UserProviderConfig,
  usableProviders,
} from "./providers";

export type { GatewayLanguageModel };

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
      // 未知 registry 的宿主回退仍按 OpenAI 处理;具体映射集中在 create-model.ts。
      const protocol = inferGatewayProtocol(args.providerId) ?? "openai";
      return createGatewayModel({
        modelId: args.modelId,
        apiKey: args.apiKey,
        protocol,
        useResponses: provider?.useResponses,
      });
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
