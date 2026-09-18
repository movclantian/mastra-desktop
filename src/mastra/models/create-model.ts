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
 */
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { Agent } from "@mastra/core/agent";
import {
  type GatewayLanguageModel,
  getProviderConfig,
  modelSupportsStructuredOutput,
} from "@mastra/core/llm";
import { defaultSettingsMiddleware, wrapLanguageModel } from "ai";

export type { GatewayLanguageModel };

export type GatewayProtocol = "openai" | "anthropic" | "gemini";

export const WORKBENCH_GATEWAY_ID = "mastra-work";

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

export function createGatewayModel(options: {
  modelId: string;
  modelRouterId?: string;
  apiKey: string;
  baseUrl?: string;
  protocol: GatewayProtocol | undefined;
  useResponses?: boolean;
  /** Display name used by AI SDK observability for custom gateways. */
  providerName?: string;
}): GatewayLanguageModel {
  const { modelId, apiKey, protocol, useResponses, providerName } = options;
  const normalizedBaseUrl = normalizeGatewayBaseUrl(options.baseUrl, protocol);
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
        model = createOpenAICompatible({
          baseURL: normalizedBaseUrl,
          name: providerName?.trim() || "openai-compatible",
          apiKey,
          ...(supportsStructuredOutputs !== undefined ? { supportsStructuredOutputs } : {}),
        }).chatModel(modelId);
        break;
      }
      model = createOpenAI({ ...common }).chat(modelId);
      break;
    }
  }

  if (supportsStructuredOutputs !== undefined) {
    Object.assign(model, { supportsStructuredOutputs });
  }
  return model;
}
