import { i18n } from "@/shared/i18n";
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
  get provider() {
    return {
      get label() {
        return i18n.t("chat:search.engines.provider.label");
      },
      get description() {
        return i18n.t("chat:search.engines.provider.desc");
      },
      requiresKey: false,
    };
  },
  get tavily() {
    return {
      label: "Tavily",
      get description() {
        return i18n.t("chat:search.engines.tavily.desc");
      },
      requiresKey: true,
    };
  },
  get firecrawl() {
    return {
      label: "Firecrawl",
      get description() {
        return i18n.t("chat:search.engines.firecrawl.desc");
      },
      requiresKey: true,
    };
  },
  get anysearch() {
    return {
      label: "AnySearch",
      get description() {
        return i18n.t("chat:search.engines.anysearch.desc");
      },
      requiresKey: false,
    };
  },
};

export const SEARCH_DEPTH_META: Record<SearchDepth, { label: string; description: string }> = {
  get fast() {
    return {
      get label() {
        return i18n.t("chat:search.depths.fast.label");
      },
      get description() {
        return i18n.t("chat:search.depths.fast.desc");
      },
    };
  },
  get balanced() {
    return {
      get label() {
        return i18n.t("chat:search.depths.balanced.label");
      },
      get description() {
        return i18n.t("chat:search.depths.balanced.desc");
      },
    };
  },
  get deep() {
    return {
      get label() {
        return i18n.t("chat:search.depths.deep.label");
      },
      get description() {
        return i18n.t("chat:search.depths.deep.desc");
      },
    };
  },
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
  return engine === "tavily" ? config.tavily.hasCredential : config.firecrawl.hasCredential;
}
