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
 * OpenAI-compatible 网关使用 AI SDK 官方的 openai-compatible provider，
 * 原生支持 reasoning_content / reasoning、tool call 和标准 v4 stream。
 */
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { GatewayLanguageModel } from "@mastra/core/llm";

export type { GatewayLanguageModel };

export type GatewayProtocol = "openai" | "anthropic" | "gemini";

export const WORKBENCH_GATEWAY_ID = "mastra-work";

/** Mastra registry provider id 到实际 API 协议的唯一映射。 */
export function inferGatewayProtocol(registryId: string): GatewayProtocol | undefined {
  switch (registryId) {
    case "anthropic":
      return "anthropic";
    case "google":
    case "gemini":
      return "gemini";
    case "openai":
      return "openai";
    default:
      return undefined;
  }
}

export function normalizeGatewayBaseUrl(
  baseUrl: string | undefined,
  protocol: GatewayProtocol | undefined,
): string | undefined {
  if (!baseUrl) return undefined;
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (!trimmed) return undefined;
  if (protocol === "anthropic") {
    if (trimmed.endsWith("/v1")) return trimmed;
    return `${trimmed}/v1`;
  }
  if (protocol === "openai") {
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
  apiKey: string;
  baseUrl?: string;
  protocol: GatewayProtocol | undefined;
  useResponses?: boolean;
}): GatewayLanguageModel {
  const { modelId, apiKey, protocol, useResponses } = options;
  const normalizedBaseUrl = normalizeGatewayBaseUrl(options.baseUrl, protocol);
  switch (protocol) {
    case "anthropic":
      return createAnthropic({
        ...(normalizedBaseUrl ? { baseURL: normalizedBaseUrl } : {}),
        apiKey,
      })(modelId);
    case "gemini":
      return createGoogleGenerativeAI({
        ...(normalizedBaseUrl ? { baseURL: normalizedBaseUrl } : {}),
        apiKey,
      })(modelId);
    default: {
      const openai = createOpenAI({
        ...(normalizedBaseUrl ? { baseURL: normalizedBaseUrl } : {}),
        apiKey,
      });
      if (useResponses) return openai.responses(modelId);
      if (normalizedBaseUrl) {
        return createOpenAICompatible({
          name: "mastra-work-openai-compatible",
          baseURL: normalizedBaseUrl,
          apiKey,
        }).chatModel(modelId);
      }
      return openai.chat(modelId);
    }
  }
}
