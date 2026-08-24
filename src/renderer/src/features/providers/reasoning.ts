import type { ProviderConfig, ReasoningEffort } from "./types";

export const REASONING_EFFORT_LABELS: Record<ReasoningEffort, string> = {
  "provider-default": "自动",
  none: "关闭",
  minimal: "极简",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "超高",
  max: "最大",
};

export function getReasoningEfforts(provider: ProviderConfig): ReasoningEffort[] {
  const family = provider.registryId ?? provider.protocol;
  if (family === "anthropic") {
    return ["provider-default", "low", "medium", "high", "xhigh", "max"];
  }
  if (family === "google" || family === "gemini") {
    return ["provider-default", "minimal", "low", "medium", "high"];
  }
  if (family === "openai") {
    return ["provider-default", "none", "minimal", "low", "medium", "high", "xhigh", "max"];
  }
  return ["provider-default", "none", "minimal", "low", "medium", "high", "xhigh"];
}

function supportsMaxEffort(family: string | undefined): boolean {
  return family === "anthropic" || family === "openai";
}

export function buildReasoningRequest(
  provider: ProviderConfig,
  effort: ReasoningEffort,
): Record<string, unknown> {
  const family = provider.registryId ?? provider.protocol;
  if (effort === "max") {
    if (!supportsMaxEffort(family)) return { modelSettings: { reasoning: "xhigh" } };
    return family === "anthropic"
      ? { providerOptions: { anthropic: { effort: "max" } } }
      : { providerOptions: { openai: { reasoningEffort: "max" } } };
  }
  return { modelSettings: { reasoning: effort } };
}
