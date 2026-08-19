import { registerApiRoute } from "@mastra/core/server";

/**
 * 模型供应商路由(BYOK)。
 * - /work/providers/registry:供应商注册表,实时来源 models.dev/api.json
 *   (docs/en/models/index.mdx:Mastra 每小时自动刷新同一数据源,
 *   @mastra/core 的 provider-registry.json 即其构建期快照)
 * - /work/providers/catalog:models.dev 能力目录服务端代理(渲染进程 CSP 禁止直连外网)
 * - /work/providers/models:自定义网关模型列表拉取(参考 docs/en/models/gateways/custom-gateways.mdx)
 */

// ---------------------------------------------------------------------------
// 内置供应商注册表(实时来自 models.dev)
// ---------------------------------------------------------------------------

export interface RegistryProvider {
  id: string;
  name: string;
  models: string[];
  embeddingModels: string[];
  apiKeyEnvVar: string;
  docUrl: string;
}

/** 从 models.dev api.json 原始数据构建注册表(provider.env 即 API Key 环境变量) */
function fromCatalog(raw: Record<string, unknown>): RegistryProvider[] {
  return Object.entries(raw).map(([id, p]) => {
    const provider = p as {
      name?: string;
      env?: string | string[];
      doc?: string;
      models?: Record<string, Record<string, unknown>>;
    };
    return {
      id,
      name: provider.name ?? id,
      models: Object.keys(provider.models ?? {}),
      embeddingModels: Object.entries(provider.models ?? {})
        .filter(([modelId, model]) => {
          const modalities = model.modalities as { output?: unknown } | undefined;
          const output = Array.isArray(modalities?.output)
            ? modalities.output.map(String)
            : typeof modalities?.output === "string"
              ? [modalities.output]
              : [];
          return (
            model.embedding === true ||
            model.type === "embedding" ||
            output.some((item) => item.toLowerCase().includes("embedding")) ||
            /embed/i.test(modelId)
          );
        })
        .map(([modelId]) => modelId),
      apiKeyEnvVar: Array.isArray(provider.env) ? provider.env.join(" / ") : (provider.env ?? ""),
      docUrl: provider.doc ?? "",
    };
  });
}

// GET /work/providers/registry — 内置供应商列表(按名称排序)
export const providerRegistryRoute = registerApiRoute("/work/providers/registry", {
  method: "GET",
  handler: async (c) => {
    try {
      const providers = fromCatalog(await fetchModelsDevCatalog()).sort((a, b) =>
        a.name.localeCompare(b.name),
      );
      return c.json({ providers });
    } catch (error) {
      return c.json({ error: `models.dev 不可达: ${(error as Error).message}` }, 502);
    }
  },
});

// GET /work/providers/registry/:id — 单个内置供应商(含模型清单)
export const providerRegistryItemRoute = registerApiRoute("/work/providers/registry/:id", {
  method: "GET",
  handler: async (c) => {
    const id = c.req.param("id");
    const provider = fromCatalog(await fetchModelsDevCatalog()).find((p) => p.id === id);
    if (!provider) {
      return c.json({ error: "Provider not found" }, 404);
    }
    return c.json({ provider });
  },
});

// ---------------------------------------------------------------------------
// models.dev 能力目录代理(内存缓存 1 小时,对齐 docs/en/models/index.mdx
// 的每小时自动刷新策略)
// ---------------------------------------------------------------------------

const MODELS_DEV_API = "https://models.dev/api.json";
let catalogCache: { fetchedAt: number; body: unknown } | null = null;
const CATALOG_TTL_MS = 60 * 60 * 1000;

async function fetchModelsDevCatalog(): Promise<Record<string, unknown>> {
  if (catalogCache && Date.now() - catalogCache.fetchedAt < CATALOG_TTL_MS) {
    return catalogCache.body as Record<string, unknown>;
  }
  const response = await fetch(MODELS_DEV_API);
  if (!response.ok) {
    throw new Error(`Upstream ${response.status}`);
  }
  const body = (await response.json()) as Record<string, unknown>;
  catalogCache = { fetchedAt: Date.now(), body };
  return body;
}

export const modelsCatalogRoute = registerApiRoute("/work/providers/catalog", {
  method: "GET",
  handler: async (c) => {
    try {
      return c.json(await fetchModelsDevCatalog());
    } catch (error) {
      return c.json({ error: (error as Error).message }, 502);
    }
  },
});

// ---------------------------------------------------------------------------
// 自定义网关模型列表拉取(规避渲染进程 CORS/外网限制)
// body: { protocol: 'openai' | 'anthropic' | 'gemini', url, apiKey, useResponses? }
// ---------------------------------------------------------------------------

export const listProviderModelsRoute = registerApiRoute("/work/providers/models", {
  method: "POST",
  handler: async (c) => {
    const { protocol, url, apiKey } = (await c.req.json()) as {
      protocol: string;
      url: string;
      apiKey: string;
    };
    try {
      // 与前端 normalizeGatewayUrl 同款的服务端兜底:openai/anthropic 的模型
      // 列表端点在版本段之下(…/v1/models)。裸域名不补 /v1 会打到网关的
      // 网页(返回 HTML),JSON 解析报错完全对不上号;已带路径的端点不动。
      let base = url.trim().replace(/\/+$/, "");
      if (!base) return c.json({ error: "Base URL 不能为空" }, 400);
      if (!/^https?:\/\//i.test(base)) base = `https://${base}`;
      base = base.replace(/\/(v\d+)(?:\/\1)+/gi, "/$1");
      if (protocol === "openai" || protocol === "anthropic") {
        try {
          const parsed = new URL(base);
          if (parsed.pathname === "/" || parsed.pathname === "") {
            base = `${parsed.origin}/v1`;
          }
        } catch {
          return c.json({ error: `Base URL 不是合法地址：${url}` }, 400);
        }
      }
      let endpoint = `${base}/models`;
      const headers: Record<string, string> = {};
      if (protocol === "anthropic") {
        headers["x-api-key"] = apiKey;
        headers["anthropic-version"] = "2023-06-01";
      } else if (protocol === "gemini") {
        endpoint = `${base}/models?key=${encodeURIComponent(apiKey)}`;
      } else {
        headers.Authorization = `Bearer ${apiKey}`;
      }
      const response = await fetch(endpoint, {
        headers,
        // 上游不可达时快速失败,别让设置面板干等
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        return c.json({ error: `Upstream ${response.status}` }, 502);
      }
      // 打到网关网页/代理错误页时 content-type 不是 JSON,提前给出可行动的报错,
      // 而不是在 json() 里抛 "Unexpected token '<'"
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.includes("json")) {
        return c.json(
          {
            error: `上游返回了 ${contentType || "非 JSON"} 内容，通常是 Base URL 指向了网页或缺少版本段（OpenAI 兼容网关一般需要 …/v1）`,
          },
          502,
        );
      }
      const data = (await response.json()) as {
        data?: { id: string; display_name?: string }[];
        models?: { name: string; displayName?: string; supportedGenerationMethods?: string[] }[];
      };
      // OpenAI 兼容 / Anthropic: { data: [{ id }] }; Gemini: { models: [{ name: "models/xxx" }] }
      const models = data.data
        ? data.data.map((m) => ({ id: m.id, name: m.display_name ?? m.id }))
        : (data.models ?? []).map((m) => ({
            id: m.name.replace(/^models\//, ""),
            name: m.displayName ?? m.name.replace(/^models\//, ""),
          }));
      return c.json({
        models: models.map((model) => ({
          ...model,
          ...(/embed/i.test(model.id) ? { embedding: true } : {}),
        })),
      });
    } catch (error) {
      return c.json({ error: (error as Error).message }, 500);
    }
  },
});

// ---------------------------------------------------------------------------
// 供应商配置(app_config 表 key = "providers")
//
// 配置必须在服务端:Studio 的模型选择器与 Agent 的默认模型都要读到它,
// 而 Studio 跑在 Mastra 进程里,读不到渲染进程的 localStorage。
// Key 由 WorkbenchGateway.resolveAuth 直接取用(见 src/mastra/agents/llm.ts),
// 不注入 process.env、也不再随请求体下发。
// ---------------------------------------------------------------------------

// GET /work/providers/config — 读取供应商与当前选定模型
export const providersConfigRoute = registerApiRoute("/work/providers/config", {
  method: "GET",
  handler: async (c) => {
    const { getProvidersConfig } = await import("../../agents/llm");
    return c.json(await getProvidersConfig());
  },
});

// POST /work/providers/config — 写入供应商与/或当前选定模型(按字段合并,见 llm/saveProvidersConfig)
export const saveProvidersConfigRoute = registerApiRoute("/work/providers/config", {
  method: "POST",
  handler: async (c) => {
    const { saveProvidersConfig } = await import("../../agents/llm");
    const config = (await c.req.json()) as Parameters<typeof saveProvidersConfig>[0];
    await saveProvidersConfig(config);
    return c.json({ ok: true });
  },
});
