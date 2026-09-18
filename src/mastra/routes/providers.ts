/**
 * 模型供应商路由(BYOK)。
 * - /work/providers/registry:Mastra 随包携带的官方供应商注册表,不出网
 * - /work/providers/catalog:models.dev 能力目录服务端代理,用于可选的能力徽章
 * - /work/providers/models:自定义网关模型列表拉取(参考 docs/en/models/gateways/custom-gateways.mdx)
 */
import { PROVIDER_REGISTRY } from "@mastra/core/llm";
import { MASTRA_RESOURCE_ID_KEY } from "@mastra/core/request-context";
import { registerApiRoute } from "@mastra/core/server";
import { z } from "zod";
import { providerCredentialPurpose, SecretRefSchema } from "../../shared/credential-contract";
import { resolveCredential } from "../credential-broker";
import { errorText, workError } from "../errors";
import {
  createEphemeralAgent,
  getProvidersConfig,
  parseModelSelection,
  resolveConfiguredModel,
  saveProvidersConfig,
} from "../models";

// ---------------------------------------------------------------------------
// 内置供应商注册表(随 @mastra/core 打包)
// ---------------------------------------------------------------------------

export interface RegistryProvider {
  id: string;
  name: string;
  models: string[];
  apiKeyEnvVar: string;
  docUrl: string;
}

/**
 * 这是 Mastra 发布包携带的 provider/model 快照。设置页直接用它,首次启动和离线状态
 * 都可添加内置供应商；在线 catalog 仅补充能力徽章,不再决定供应商是否可用。
 */
const builtinProviderRegistry: RegistryProvider[] = Object.entries(PROVIDER_REGISTRY)
  .map(([id, provider]) => {
    const models = provider.models ?? [];
    return {
      id,
      name: provider.name,
      models,
      apiKeyEnvVar: Array.isArray(provider.apiKeyEnvVar)
        ? provider.apiKeyEnvVar.join(" / ")
        : provider.apiKeyEnvVar,
      docUrl: provider.docUrl ?? "",
    };
  })
  .sort((a, b) => a.name.localeCompare(b.name));

// GET /work/providers/registry — 内置供应商列表(按名称排序)
export const providerRegistryRoute = registerApiRoute("/work/providers/registry", {
  method: "GET",
  handler: (c) => c.json({ providers: builtinProviderRegistry }),
});

// ---------------------------------------------------------------------------
// models.dev 能力目录代理
//
// 这份目录只服务能力徽章与上下文窗口展示,不决定内置供应商是否可用。
// 服务端做一小时内存缓存并合并并发请求；上游不可用时仅禁用能力徽章。
// ---------------------------------------------------------------------------

const MODELS_DEV_API = "https://models.dev/api.json";
const CATALOG_TTL_MS = 60 * 60 * 1000;
const CATALOG_TIMEOUT_MS = 30_000;

type Catalog = Record<string, unknown>;

let catalogCache: { fetchedAt: number; body: Catalog } | null = null;
let catalogInflight: Promise<Catalog> | null = null;

async function fetchModelsDevCatalog(): Promise<Catalog> {
  if (catalogCache && Date.now() - catalogCache.fetchedAt < CATALOG_TTL_MS) {
    return catalogCache.body;
  }
  catalogInflight ??= refreshModelsDevCatalog().finally(() => {
    catalogInflight = null;
  });
  return catalogInflight;
}

async function refreshModelsDevCatalog(): Promise<Catalog> {
  try {
    const response = await fetch(MODELS_DEV_API, {
      signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`models.dev 返回 HTTP ${response.status}`);
    }
    const body = (await response.json()) as Catalog;
    if (Object.keys(body).length === 0) {
      throw new Error("models.dev 返回了空目录");
    }
    catalogCache = { fetchedAt: Date.now(), body };
    return body;
  } catch (error) {
    throw new Error(describeFetchError(error));
  }
}

/**
 * Node fetch 的网络错误一律只说 "fetch failed",真实原因埋在 error.cause 里:
 * ECONNREFUSED = 代理端口没人监听(代理客户端没开)、ENOTFOUND = DNS 被污染或域名写错、
 * ETIMEDOUT / UND_ERR_CONNECT_TIMEOUT = 被墙或代理没生效。
 * 设置面板必须看到这一层,才能区分"代理问题"和"Base URL 写错了"。
 */
function describeFetchError(error: unknown): string {
  if (!(error instanceof Error)) return errorText(error, "请求失败");
  if (error.name === "TimeoutError" || error.name === "AbortError") {
    return "请求超时（通常是被墙，或代理未生效）";
  }
  const cause = error.cause;
  if (!(cause instanceof Error)) return error.message;
  const code = (cause as Error & { code?: string }).code;
  if (code === "ECONNRESET") {
    return `${error.message}（ECONNRESET: ${cause.message}；若已启用代理，请检查代理客户端和分流规则）`;
  }
  if (code === "UND_ERR_CONNECT_TIMEOUT") {
    return `${error.message}（连接超时：${cause.message}；请检查代理是否已启用，或确认该网关可直连）`;
  }
  return `${error.message}（${code ? `${code}: ` : ""}${cause.message}）`;
}

export const modelsCatalogRoute = registerApiRoute("/work/providers/catalog", {
  method: "GET",
  handler: async (c) => {
    try {
      return c.json(await fetchModelsDevCatalog());
    } catch (error) {
      throw workError("PROVIDER_CATALOG_UNAVAILABLE", {
        text: `模型能力目录不可用：${(error as Error).message}`,
        cause: error,
      });
    }
  },
});

// ---------------------------------------------------------------------------
// 自定义网关模型列表拉取(规避渲染进程 CORS/外网限制)
// body only carries gateway metadata and credentialRef; plaintext is resolved through the broker.
// ---------------------------------------------------------------------------

/** 网关 /models 本身很快,但经代理时握手会慢,给到 30s */
const GATEWAY_TIMEOUT_MS = 30_000;

export const listProviderModelsRoute = registerApiRoute("/work/providers/models", {
  method: "POST",
  handler: async (c) => {
    let payload: z.infer<typeof providerModelsRequestSchema>;
    try {
      payload = providerModelsRequestSchema.parse(await c.req.json());
    } catch {
      throw workError("VALIDATION_INVALID_JSON");
    }
    const { protocol } = payload;
    const apiKey = await resolveCredential(
      payload.credentialRef,
      providerCredentialPurpose(payload.providerId),
    );

    // 与前端 normalizeGatewayUrl 同款的服务端兜底:openai/anthropic 的模型列表端点在
    // 版本段之下(…/v1/models)。裸域名不补 /v1 会打到网关的网页(返回 HTML),JSON
    // 解析报错完全对不上号;已带路径的端点不动。
    let base = (payload.url ?? "").trim().replace(/\/+$/, "");
    if (!base) throw workError("VALIDATION_FAILED", { text: "Base URL 不能为空" });
    if (!/^https?:\/\//i.test(base)) base = `https://${base}`;
    base = base.replace(/\/(v\d+)(?:\/\1)+/gi, "/$1");
    if (protocol === "openai" || protocol === "anthropic") {
      try {
        const parsed = new URL(base);
        if (parsed.pathname === "/" || parsed.pathname === "") {
          base = `${parsed.origin}/v1`;
        }
      } catch {
        throw workError("VALIDATION_FAILED", { text: `Base URL 不是合法地址：${payload.url}` });
      }
    }

    let endpoint = `${base}/models`;
    const headers: Record<string, string> = {};
    if (protocol === "anthropic") {
      headers["x-api-key"] = apiKey;
      headers["anthropic-version"] = "2023-06-01";
    } else if (protocol === "gemini") {
      // Gemini 把 Key 放在 query 上,所以后面所有报错只回显 base,不回显 endpoint
      endpoint = `${base}/models?key=${encodeURIComponent(apiKey)}`;
    } else {
      headers.Authorization = `Bearer ${apiKey}`;
    }

    let response: Response;
    try {
      response = await fetch(endpoint, {
        headers,
        // 上游不可达时快速失败,别让设置面板干等
        signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
      });
    } catch (error) {
      throw workError("PROVIDER_MODELS_FETCH_FAILED", {
        text: `连接 ${base}/models 失败：${describeFetchError(error)}`,
        cause: error,
      });
    }

    if (!response.ok) {
      // 401/404 这类错误的原因全在响应体里(Key 无效、路径不对),必须带回前端
      const detail = (await response.text().catch(() => "")).trim().slice(0, 300);
      throw workError("PROVIDER_MODELS_FETCH_FAILED", {
        text: `${base}/models 返回 HTTP ${response.status}${detail ? `：${detail}` : ""}`,
      });
    }
    // 打到网关网页/代理错误页时 content-type 不是 JSON,提前给出可行动的报错,
    // 而不是在 json() 里抛 "Unexpected token '<'"
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("json")) {
      throw workError("PROVIDER_MODELS_FETCH_FAILED", {
        text: `上游返回了 ${contentType || "非 JSON"} 内容，通常是 Base URL 指向了网页或缺少版本段（OpenAI 兼容网关一般需要 …/v1）`,
      });
    }

    let data: {
      data?: { id: string; display_name?: string }[];
      models?: { name: string; displayName?: string }[];
    };
    try {
      data = (await response.json()) as typeof data;
    } catch (error) {
      throw workError("PROVIDER_MODELS_FETCH_FAILED", {
        text: `解析 ${base}/models 的响应失败：${(error as Error).message}`,
        cause: error,
      });
    }
    // OpenAI 兼容 / Anthropic: { data: [{ id }] };Gemini: { models: [{ name: "models/xxx" }] }
    if (!Array.isArray(data.data) && !Array.isArray(data.models)) {
      throw workError("PROVIDER_MODELS_FETCH_FAILED", {
        text: `${base}/models 的响应里没有模型列表（既无 data[] 也无 models[]），请确认 Base URL 填的是网关根地址而不是具体端点`,
      });
    }
    const models = Array.isArray(data.data)
      ? data.data.map((m) => ({ id: m.id, name: m.display_name ?? m.id }))
      : (data.models ?? []).map((m) => ({
          id: m.name.replace(/^models\//, ""),
          name: m.displayName ?? m.name.replace(/^models\//, ""),
        }));
    return c.json({
      models,
    });
  },
});

const providerModelsRequestSchema = z
  .object({
    providerId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
    protocol: z.enum(["openai", "anthropic", "gemini"]),
    url: z.string().min(1).max(2_048),
    credentialRef: SecretRefSchema,
  })
  .strict();

// POST /work/providers/test — 用一次性 Mastra Agent 测试文本与结构化输出,
// 不创建线程或写入 Memory。
export const testProviderModelRoute = registerApiRoute("/work/providers/test", {
  method: "POST",
  handler: async (c) => {
    try {
      const payload = (await c.req.json()) as { providerId?: unknown; modelId?: unknown };
      const selection = parseModelSelection(payload);
      if (!selection) throw workError("MODEL_SELECTION_REQUIRED");
      const resourceId = c.get("requestContext").get(MASTRA_RESOURCE_ID_KEY) as string;
      const model = await resolveConfiguredModel(
        selection.providerId,
        selection.modelId,
        resourceId,
      );
      if (!model) throw workError("MODEL_NOT_CONFIGURED");
      const testAgent = createEphemeralAgent(model, {
        id: "mastra-work-model-test",
        name: "MastraWork Model Test",
        instructions: "返回一个简短问候语,并严格按结构化字段输出。",
      });
      const result = await testAgent.generate("请回复一个简短的 hi。", {
        structuredOutput: {
          schema: z.object({ reply: z.string().min(1) }),
          jsonPromptInjection: "auto",
        },
        abortSignal: c.req.raw.signal,
      });
      return c.json({ ok: true, reply: result.object.reply.trim().slice(0, 120) });
    } catch (error) {
      return c.json(
        {
          ok: false,
          error: errorText(error, "模型连接测试失败"),
        },
        400,
      );
    }
  },
});

// ---------------------------------------------------------------------------
// 供应商配置(app_config 表 key = "providers")
//
// 配置必须在服务端:Studio 的模型选择器与 Agent 的默认模型都要读到它,
// 而 Studio 跑在 Mastra 进程里,读不到渲染进程的 localStorage。
// 请求内的模型实例由 resolveConfiguredModel 按资源直接构造；WorkbenchGateway
// 仅保留给 Studio/model registry 使用。Key 不注入 process.env、也不随请求体下发。
// ---------------------------------------------------------------------------

// GET /work/providers/config — 读取供应商与当前选定模型
export const providersConfigRoute = registerApiRoute("/work/providers/config", {
  method: "GET",
  handler: async (c) => {
    return c.json(
      await getProvidersConfig(c.get("requestContext").get(MASTRA_RESOURCE_ID_KEY) as string),
    );
  },
});

// POST /work/providers/config — 写入供应商与/或当前选定模型
export const saveProvidersConfigRoute = registerApiRoute("/work/providers/config", {
  method: "POST",
  handler: async (c) => {
    await saveProvidersConfig(
      await c.req.json(),
      c.get("requestContext").get(MASTRA_RESOURCE_ID_KEY) as string,
    );
    return c.json({ ok: true });
  },
});
