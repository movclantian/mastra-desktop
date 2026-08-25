/**
 * Models 模块入口 (docs/en/models/):
 * - gateways: 自定义网关 WorkbenchGateway (docs/en/models/gateways/custom-gateways.mdx)
 * - providers: 供应商配置与 BYOK 模型解析 (docs/en/models/providers/)
 * - create-model: 共享的模型构建工厂与网关常量 (无内部依赖, 打破 gateway/providers 循环)
 */

export {
  type GatewayProtocol,
  normalizeGatewayBaseUrl,
  WORKBENCH_GATEWAY_ID,
} from "./create-model";
export { type GatewayLanguageModel, WorkbenchGateway } from "./gateways";
export {
  defaultModelFamily,
  getProvidersConfig,
  parseModelSelection,
  REQUEST_MODEL_CONTEXT_KEY,
  requestModelFamily,
  resolveConfiguredModel,
  resolveDefaultLanguageModel,
  resolveDefaultModelId,
  resolveRequestModel,
  saveProvidersConfig,
  splitRouterId,
  usesOpenAIResponses,
} from "./providers";
