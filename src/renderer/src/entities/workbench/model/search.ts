import type { ProviderConfig } from "./providers";
import {
  SEARCH_DEPTHS,
  SEARCH_ENGINES,
  type SearchDepth,
  type SearchEngine,
  type ToolsConfig,
} from "./types";

export { SEARCH_DEPTHS, SEARCH_ENGINES };

export const SEARCH_ENGINE_META: Record<
  SearchEngine,
  { label: string; description: string; requiresKey: boolean }
> = {
  provider: {
    label: "模型原生检索",
    description: "用模型自带的检索能力,零配置;仅 OpenAI / Anthropic / Google / xAI 模型可用",
    requiresKey: false,
  },
  tavily: {
    label: "Tavily",
    description: "为 LLM 优化的检索 API,答案摘要与引用质量最稳",
    requiresKey: true,
  },
  firecrawl: {
    label: "Firecrawl",
    description: "检索 + 整页抓取,适合需要读全文的场景",
    requiresKey: true,
  },
  anysearch: {
    label: "AnySearch",
    description: "未填 Key 时按匿名额度调用",
    requiresKey: false,
  },
};

export const SEARCH_DEPTH_META: Record<SearchDepth, { label: string; description: string }> = {
  fast: { label: "快速", description: "3 条结果,仅读摘要" },
  balanced: { label: "均衡", description: "6 条结果,标准检索深度" },
  deep: { label: "深度", description: "10 条结果,并抓取重点页面全文" },
};

const PROVIDER_SEARCH_FAMILIES = ["openai", "anthropic", "google", "gemini", "xai"];

function isProviderSearchSupported(provider: ProviderConfig | undefined): boolean {
  if (!provider || provider.baseUrl || !provider.registryId) return false;
  return PROVIDER_SEARCH_FAMILIES.includes(provider.registryId);
}

export function isSearchEngineReady(
  engine: SearchEngine,
  config: ToolsConfig | null,
  activeProvider?: ProviderConfig,
): boolean {
  if (engine === "provider") return isProviderSearchSupported(activeProvider);
  if (!SEARCH_ENGINE_META[engine].requiresKey) return true;
  if (!config) return false;
  return Boolean(engine === "tavily" ? config.tavily.apiKey : config.firecrawl.apiKey);
}
