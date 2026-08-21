/**
 * Models 模块入口 (docs/en/models/):
 * - gateways: 自定义网关 WorkbenchGateway (docs/en/models/gateways/custom-gateways.mdx)
 * - providers: 供应商配置与 BYOK 模型解析 (docs/en/models/providers/)
 */

export {
  createGatewayModel,
  type GatewayLanguageModel,
  inferProtocol,
  WORKBENCH_GATEWAY_ID,
  WorkbenchGateway,
} from "./gateways";
export {
  defaultModelFamily,
  type EnabledModel,
  type GatewayProtocol,
  getConfiguredEmbeddingModel,
  getProvidersConfig,
  isRequestModel,
  type ProvidersUserConfig,
  REQUEST_MODEL_CONTEXT_KEY,
  type RequestModel,
  requestModelFamily,
  resolveConfiguredEmbeddingModelForUse,
  resolveConfiguredModel,
  resolveDefaultLanguageModel,
  resolveDefaultModelId,
  resolveRequestModel,
  routerPrefix,
  saveProvidersConfig,
  splitRouterId,
  type UserModelSelection,
  type UserProviderConfig,
  usableProviders,
  usesOpenAIResponses,
} from "./providers";
