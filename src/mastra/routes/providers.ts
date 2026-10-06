/**
 * 模型供应商路由(BYOK)。
 * - /work/providers/registry:Mastra 随包携带的官方供应商注册表,不出网
 * - /work/providers/catalog:models.dev 能力目录服务端代理,用于可选的能力徽章
 * - /work/providers/models:自定义网关模型列表拉取(参考 docs/en/models/gateways/custom-gateways.mdx)
 */
import { Agent } from "@mastra/core/agent";
import { PROVIDER_REGISTRY } from "@mastra/core/llm";
import { MASTRA_RESOURCE_ID_KEY } from "@mastra/core/request-context";
import { createRoute } from "@mastra/server/server-adapter";
import { z } from "zod";
import { providerCredentialPurpose, SecretRefSchema } from "../../shared/credential-contract";
import { resolveCredential } from "../credential-broker";
import { errorText, workError, workValidationError } from "../errors";
import {
  createProviderModel,
  fetchModelsDevCatalog,
  getProvidersConfig,
  providersPatchSchema,
  saveProvidersConfig,
} from "../models/providers";

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
export const providerRegistryRoute = createRoute({
  queryParamSchema: z.object({}).strict(),
  path: "/work/providers/registry",
  responseType: "json",
  onValidationError: workValidationError,
  method: "GET",
  handler: async () => ({ providers: builtinProviderRegistry }),
});

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

export const modelsCatalogRoute = createRoute({
  queryParamSchema: z.object({}).strict(),
  path: "/work/providers/catalog",
  responseType: "json",
  onValidationError: workValidationError,
  method: "GET",
  handler: async () => {
    try {
      return await fetchModelsDevCatalog();
    } catch (error) {
      throw workError("PROVIDER_CATALOG_UNAVAILABLE", {
        text: `模型能力目录不可用：${describeFetchError(error)}`,
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

const providerModelsRequestSchema = z
  .object({
    providerId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
    protocol: z.enum(["openai", "anthropic", "gemini"]),
    url: z.url({ protocol: /^https?$/ }).max(2_048),
    credentialRef: SecretRefSchema,
  })
  .strict();

export const listProviderModelsRoute = createRoute({
  queryParamSchema: z.object({}).strict(),
  path: "/work/providers/models",
  responseType: "json",
  onValidationError: workValidationError,
  method: "POST",
  bodySchema: providerModelsRequestSchema.transform((payload) => ({ payload })),
  handler: async (params) => {
    const payload = params.payload;
    const { protocol } = payload;
    const apiKey = await resolveCredential(
      payload.credentialRef,
      providerCredentialPurpose(payload.providerId),
    );

    // Use the configured API root exactly; the provider owns its version/path convention.
    const base = payload.url.replace(/\/+$/, "");

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
        text: `解析 ${base}/models 的响应失败：${describeFetchError(error)}`,
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
    return {
      models,
    };
  },
});

function providerErrorStatus(error: unknown): number | undefined {
  const values: unknown[] = [error];
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    values.push(record.cause, record.response);
  }
  for (const value of values) {
    if (!value || typeof value !== "object") continue;
    const record = value as Record<string, unknown>;
    for (const key of ["statusCode", "responseStatusCode", "status"]) {
      const status = record[key];
      if (
        typeof status === "number" &&
        Number.isInteger(status) &&
        status >= 400 &&
        status <= 599
      ) {
        return status;
      }
    }
  }
  return undefined;
}

// POST /work/providers/test — 用一次性 Mastra Agent 测试纯文本连通性,
// 不创建线程或写入 Memory。
export const testProviderModelRoute = createRoute({
  queryParamSchema: z.object({}).strict(),
  path: "/work/providers/test",
  responseType: "json",
  onValidationError: workValidationError,
  method: "POST",
  bodySchema: z
    .object({ providerId: z.string().trim().min(1), modelId: z.string().trim().min(1) })
    .strict(),
  handler: async (params) => {
    const resourceId = params.requestContext.get(MASTRA_RESOURCE_ID_KEY) as string;
    const config = await getProvidersConfig(resourceId);
    const provider = config.providers.find((candidate) => candidate.id === params.providerId);
    if (!provider) throw workError("MODEL_NOT_CONFIGURED");
    // Testing checks the saved connection before a model is enabled for conversations.
    const model = await createProviderModel(provider, params.modelId, resourceId);
    if (!model) throw workError("MODEL_NOT_CONFIGURED");
    const testAgent = new Agent({
      model,
      id: "mastra-work-model-test",
      name: "MastraWork Model Test",
      instructions: "只返回简短的纯文本问候语。",
    });
    try {
      const result = await testAgent.generate("请只回复一个简短的 hi。", {
        abortSignal: params.abortSignal,
      });
      const reply = result.text.trim().slice(0, 120);
      if (!reply) throw new Error("模型返回了空响应");
      return { ok: true, reply };
    } catch (error) {
      const upstreamStatus = providerErrorStatus(error);
      throw workError("MODEL_GENERATION_FAILED", {
        text: errorText(error, "模型连接测试失败"),
        cause: error,
        ...(upstreamStatus ? { details: { upstreamStatus } } : {}),
      });
    }
  },
});

// ---------------------------------------------------------------------------
// 供应商配置(app_config 表 key = "providers")
//
// 工作台、Agent 与连接测试统一按认证资源读取服务端配置。
// Key 不注入 process.env、也不随请求体下发。
// ---------------------------------------------------------------------------

// GET /work/providers/config — 读取供应商与当前选定模型
export const providersConfigRoute = createRoute({
  queryParamSchema: z.object({}).strict(),
  path: "/work/providers/config",
  responseType: "json",
  onValidationError: workValidationError,
  method: "GET",
  handler: async (params) => {
    return await getProvidersConfig(params.requestContext.get(MASTRA_RESOURCE_ID_KEY) as string);
  },
});

// POST /work/providers/config — 写入供应商与/或当前选定模型
export const saveProvidersConfigRoute = createRoute({
  queryParamSchema: z.object({}).strict(),
  path: "/work/providers/config",
  responseType: "json",
  onValidationError: workValidationError,
  method: "POST",
  bodySchema: providersPatchSchema.transform((config) => ({ config })),
  handler: async (params) => {
    await saveProvidersConfig(
      params.config,
      params.requestContext.get(MASTRA_RESOURCE_ID_KEY) as string,
    );
    return { ok: true };
  },
});
