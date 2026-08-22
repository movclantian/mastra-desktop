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
