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
import {
  createGatewayModel,
  getRegistryProviderBaseUrl,
  inferGatewayProtocol,
  WORKBENCH_GATEWAY_ID,
} from "./create-model";
import {
  getProvidersConfig,
  resolveProviderCredential,
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

  private async findProviderForModel(modelId: string): Promise<UserProviderConfig | undefined> {
    return this.findProvider(splitRouterId(modelId).providerId);
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
          ...(() => {
            const url =
              provider.baseUrl ??
              (provider.registryId ? getRegistryProviderBaseUrl(provider.registryId) : undefined);
            return url ? { url } : {};
          })(),
        } satisfies GatewayProviderConfig,
      ]),
    );
  }

  async resolveAuth(request: GatewayAuthRequest): Promise<GatewayAuthResult | undefined> {
    const provider = await this.findProvider(request.providerId);
    if (!provider) return undefined;
    return { apiKey: await resolveProviderCredential(provider), source: "gateway" };
  }

  async getApiKey(modelId: string): Promise<string> {
    const provider = await this.findProviderForModel(modelId);
    if (!provider) {
      throw new Error(
        `未在设置中找到供应商 ${splitRouterId(modelId).providerId} 的 API Key,请先在「模型供应商」配置`,
      );
    }
    return resolveProviderCredential(provider);
  }

  async buildUrl(modelId: string): Promise<string | undefined> {
    const provider = await this.findProviderForModel(modelId);
    return (
      provider?.baseUrl ??
      (provider?.registryId ? getRegistryProviderBaseUrl(provider.registryId) : undefined)
    );
  }

  async resolveLanguageModel(args: {
    modelId: string;
    providerId: string;
    apiKey: string;
  }): Promise<GatewayLanguageModel> {
    const provider = await this.findProvider(args.providerId);
    const baseUrl =
      provider?.baseUrl ??
      (provider?.registryId ? getRegistryProviderBaseUrl(provider.registryId) : undefined);
    const protocol =
      provider?.protocol ?? inferGatewayProtocol(provider?.registryId ?? args.providerId);
    if (!baseUrl) {
      // 未知 registry 的宿主回退仍按 OpenAI 处理;具体映射集中在 create-model.ts。
      return createGatewayModel({
        modelId: args.modelId,
        modelRouterId: `${args.providerId}/${args.modelId}`,
        registryId: provider?.registryId,
        apiKey: args.apiKey,
        protocol: protocol ?? "openai",
        useResponses: provider?.useResponses,
        providerName: provider?.name,
      });
    }
    return createGatewayModel({
      modelId: args.modelId,
      modelRouterId: `${args.providerId}/${args.modelId}`,
      registryId: provider?.registryId,
      apiKey: args.apiKey,
      baseUrl,
      protocol,
      useResponses: provider?.useResponses,
      providerName: provider?.name,
    });
  }
}
