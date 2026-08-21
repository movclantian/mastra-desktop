import * as React from "react";
import { toast } from "sonner";

/**
 * BYOK 模型供应商管理。
 * - 内置供应商列表来自 Mastra 随包携带的官方 registry,不依赖外网
 * - 模型能力目录来自 models.dev,仅用于推理/视觉/上下文窗口等可选展示
 * - 自定义网关参考 docs/en/models/gateways/custom-gateways.mdx
 *   (OpenAI Compatible / Anthropic / Gemini 三种协议)
 */

export const MASTRA_SERVER_URL = import.meta.env.VITE_MASTRA_SERVER_URL ?? "http://localhost:4111";

// ---------------------------------------------------------------------------
// Mastra 内置供应商注册表(服务端 /work/providers/registry)。服务端直接读取
// @mastra/core 内置快照,这里仅做会话内 promise memo 去重。
// ---------------------------------------------------------------------------

export interface RegistryProvider {
  id: string;
  name: string;
  models: string[];
  embeddingModels: string[];
  apiKeyEnvVar: string;
  docUrl: string;
}

/**
 * 服务端的错误响应统一带 { error },里面是可行动的原因(代理没生效、DNS 被污染、
 * Key 无效…)。只显示 HTTP 状态码等于把这些信息全丢掉,所以统一从响应体里取。
 */
async function readErrorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string };
    if (body.error) return body.error;
  } catch {
    // 非 JSON 响应(代理错误页等),退回状态码
  }
  return `${fallback}（HTTP ${response.status}）`;
}

let registryPromise: Promise<RegistryProvider[]> | null = null;

export function loadRegistry(): Promise<RegistryProvider[]> {
  registryPromise ??= fetch(`${MASTRA_SERVER_URL}/work/providers/registry`)
    .then(async (response) => {
      if (!response.ok) {
        throw new Error(await readErrorMessage(response, "拉取内置供应商列表失败"));
      }
      const { providers } = (await response.json()) as { providers: RegistryProvider[] };
      return providers;
    })
    .catch((error: unknown) => {
      registryPromise = null; // 失败不缓存,允许下次重试
      throw error;
    });
  return registryPromise;
}

/**
 * 内置供应商下拉的 UI 状态。放在非组件模块可保持 providers-section.tsx 的 Fast
 * Refresh 边界只导出组件,避免 Vite 将 hook 与组件混合导出判定为不兼容。
 */
export function useRegistry(): RegistryProvider[] {
  const [registry, setRegistry] = React.useState<RegistryProvider[]>([]);
  React.useEffect(() => {
    let active = true;
    loadRegistry()
      .then((nextRegistry) => {
        if (active) setRegistry(nextRegistry);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setRegistry([]);
        toast.error(`内置供应商列表加载失败：${(error as Error).message}`);
      });
    return () => {
      active = false;
    };
  }, []);
  return registry;
}

// ---------------------------------------------------------------------------
// 自定义网关协议(docs/en/models/gateways/custom-gateways.mdx)
// ---------------------------------------------------------------------------

export type GatewayProtocol = "openai" | "anthropic" | "gemini";

export const GATEWAY_PROTOCOLS: { value: GatewayProtocol; label: string }[] = [
  { value: "openai", label: "OpenAI Compatible" },
  { value: "anthropic", label: "Anthropic" },
  { value: "gemini", label: "Google Gemini" },
];

/**
 * 网关 Base URL 归一化(防护性处理 + 协议感知补 /v1):
 * - 去首尾空白与尾部斜杠
 * - 无协议时补 https://
 * - 重复的版本段折叠(/v1/v1 → /v1)
 * - openai 协议且路径为空(裸域名/裸 IP)时补 /v1:服务端 createOpenAI 的
 *   baseURL 需含版本段(官方默认 https://api.openai.com/v1,SDK 只追加
 *   /chat/completions),业界客户端同样默认裸域名 → /v1
 * 已带路径的端点(如 /api/paas/v4、/api/coding/v3)原样保留;
 * anthropic/gemini 协议不补(其 SDK 自行追加 /v1/messages、/models/…)。
 */
export function normalizeGatewayUrl(input: string, protocol?: GatewayProtocol): string {
  let url = input.trim().replace(/[\\/]+$/, "");
  if (!url) return url;
  if (!/^https?:\/\//i.test(url)) {
    url = `https://${url}`;
  }
  // 折叠相邻重复的版本段(/v1/v1 → /v1;版本号不同则不动,如 /v1beta 不受影响)
  url = url.replace(/\/(v\d+)(?:\/\1)+/gi, "/$1");
  if (protocol === "openai") {
    try {
      const parsed = new URL(url);
      if (parsed.pathname === "/" || parsed.pathname === "") {
        url = `${parsed.origin}/v1`;
      }
    } catch {
      // 非法 URL 交由保存前的表单校验兜底,归一化不强行处理
    }
  }
  return url;
}

// ---------------------------------------------------------------------------
// 用户供应商配置(由 Workbench 同步到服务端 app_config,按用户隔离)
// ---------------------------------------------------------------------------

export interface EnabledModel {
  id: string;
  name: string;
  embedding?: boolean;
}

/**
 * 模型名称只用于界面展示;当网关把完整路由(provider/model)重复放进 name 时,
 * 退回真实模型 ID,避免把内部路由或 URL 暴露给用户。
 */
export function getModelDisplayName(model: Pick<EnabledModel, "id" | "name">): string {
  const id = model.id.trim();
  const name = model.name?.trim() ?? "";
  if (!name) return id;

  const nameLeaf = name.slice(name.lastIndexOf("/") + 1);
  const idLeaf = id.slice(id.lastIndexOf("/") + 1);
  return name.includes("/") && nameLeaf === idLeaf ? id : name;
}

export interface ProviderConfig {
  id: string;
  /** 显示名 */
  name: string;
  /** 内置供应商 id(registry);为空 = 自定义网关 */
  registryId?: string;
  /** 自定义网关:协议与 Base URL */
  protocol?: GatewayProtocol;
  baseUrl?: string;
  /** OpenAI 协议专用:是否使用 Responses 端点 */
  useResponses?: boolean;
  apiKey: string;
  /** 禁用后,该供应商的模型不再出现在模型选择器中(已启用的模型保留配置) */
  disabled?: boolean;
  /** 用户启用的模型列表 */
  enabledModels: EnabledModel[];
}

// ---------------------------------------------------------------------------
// models.dev 模型能力目录(可选元数据)
// 跨会话由服务端代理缓存 1 小时;会话内再缓存解析结果,避免重复解析大 JSON。
// 目录不可用时只是不显示能力徽章,不影响供应商和模型本身的使用。
// ---------------------------------------------------------------------------

export interface CatalogModel {
  id: string;
  name: string;
  reasoning: boolean;
  tools: boolean;
  vision: boolean;
  audio: boolean;
  contextWindow: number;
}

export interface CatalogProvider {
  id: string;
  name: string;
  models: CatalogModel[];
}

const CATALOG_TTL_MS = 60 * 60 * 1000;

let catalogCache: CatalogProvider[] | null = null;
let catalogFetchedAt = 0;
let catalogPromise: Promise<CatalogProvider[]> | null = null;

export function loadModelCatalog(): Promise<CatalogProvider[]> {
  if (catalogCache && Date.now() - catalogFetchedAt < CATALOG_TTL_MS) {
    return Promise.resolve(catalogCache);
  }
  catalogPromise ??= (async () => {
    // 通过 Mastra 服务端代理拉取(渲染进程 CSP 禁止直连外网,且服务端已缓存 1 小时)
    const response = await fetch(`${MASTRA_SERVER_URL}/work/providers/catalog`);
    if (!response.ok) {
      throw new Error(await readErrorMessage(response, "拉取模型目录失败"));
    }
    // models.dev api.json 模型字段:reasoning / tool_call /
    // modalities.input 含 image|audio / limit.context
    const raw = (await response.json()) as Record<
      string,
      {
        name: string;
        models: Record<
          string,
          {
            name?: string;
            reasoning?: boolean;
            tool_call?: boolean;
            modalities?: { input?: string[] | string };
            limit?: { context?: number | string };
          }
        >;
      }
    >;
    const providers: CatalogProvider[] = Object.entries(raw).map(([id, p]) => ({
      id,
      name: p.name ?? id,
      models: Object.entries(p.models ?? {}).map(([modelId, m]) => {
        const rawInputModalities = m.modalities?.input;
        const inputModalities = (
          Array.isArray(rawInputModalities)
            ? rawInputModalities
            : rawInputModalities
              ? [rawInputModalities]
              : []
        ).map((modality) => modality.toLowerCase());
        const contextWindow = parseContextWindow(m.limit?.context);
        return {
          id: modelId,
          name: m.name ?? modelId,
          reasoning: Boolean(m.reasoning),
          tools: Boolean(m.tool_call),
          vision: inputModalities.some(
            (modality) => modality === "image" || modality.startsWith("image/"),
          ),
          audio: inputModalities.some(
            (modality) => modality === "audio" || modality.startsWith("audio/"),
          ),
          contextWindow: Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : 0,
        };
      }),
    }));
    catalogCache = providers;
    catalogFetchedAt = Date.now();
    return providers;
  })().catch((error: unknown) => {
    catalogPromise = null; // 失败不缓存,允许下次重试
    throw error;
  });
  return catalogPromise;
}

// ---------------------------------------------------------------------------
// 供应商模型列表(内置供应商来自 registry;自定义网关走服务端代理)
// 会话内存缓存:同一会话内重复打开选模型弹窗不重复打网关;重启后重拉,
// 天然拿到网关最新列表(原先 localStorage 无 TTL,不手动失效就永远旧列表)。
// ---------------------------------------------------------------------------

const providerModelsCache = new Map<string, EnabledModel[]>();

export async function fetchProviderModels(
  provider: ProviderConfig,
  registry: RegistryProvider[],
): Promise<EnabledModel[]> {
  let models: EnabledModel[];
  if (provider.registryId) {
    // 内置供应商:模型清单直接来自 provider-registry(无需网络请求)
    const registryProvider = registry.find((p) => p.id === provider.registryId);
    if (!registryProvider) {
      throw new Error(`未找到内置供应商 ${provider.registryId}`);
    }
    models = registryProvider.models.map((id) => ({
      id,
      name: id,
      ...(registryProvider.embeddingModels?.includes(id) ? { embedding: true } : {}),
    }));
  } else {
    // 自定义网关:服务端代理拉取 /models
    const response = await fetch(`${MASTRA_SERVER_URL}/work/providers/models`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        protocol: provider.protocol ?? "openai",
        url: provider.baseUrl,
        apiKey: provider.apiKey,
      }),
    });
    if (!response.ok) {
      throw new Error(await readErrorMessage(response, "拉取模型列表失败"));
    }
    ({ models } = (await response.json()) as { models: EnabledModel[] });
  }
  models = models.map((model) => ({
    ...model,
    name: getModelDisplayName(model),
  }));
  providerModelsCache.set(provider.id, models);
  return models;
}

export function getCachedProviderModels(providerId: string): EnabledModel[] | null {
  return providerModelsCache.get(providerId) ?? null;
}

/** 失效某供应商的模型列表缓存:编辑(baseUrl/apiKey/协议变了)或删除供应商时调用 */
export function invalidateProviderModelsCache(providerId: string): void {
  providerModelsCache.delete(providerId);
}

// ---------------------------------------------------------------------------
// 能力徽章
// ---------------------------------------------------------------------------

export interface ModelCapabilities {
  reasoning: boolean;
  vision: boolean;
  audio: boolean;
  tools: boolean;
}

function findCatalogModelsById(catalog: CatalogProvider[], modelId: string): CatalogModel[] {
  const normalizedModelId = modelId.trim();
  if (!normalizedModelId || /^(?:https?|wss?):\/\//i.test(normalizedModelId)) {
    return [];
  }
  const exactModels = catalog
    .flatMap((provider) => provider.models)
    .filter((model) => model.id === normalizedModelId);
  if (exactModels.length > 0) {
    return exactModels;
  }

  // 只接受完整模型 ID。不能按 URL、路径最后一段或模糊名称回退,
  // 否则自定义网关的同名模型会被错误映射到别的供应商。
  return [];
}

/**
 * 优先按 provider 的 registry id 在 models.dev 目录中查模型能力;
 * 自定义网关再按全目录的模型 ID 精确匹配,无法确认时不展示徽章。
 */
export function getModelCapabilities(
  provider: ProviderConfig,
  modelId: string,
  catalog: CatalogProvider[],
): ModelCapabilities {
  const normalizedModelId = modelId.trim();
  if (!normalizedModelId || /^(?:https?|wss?):\/\//i.test(normalizedModelId)) {
    return { reasoning: false, vision: false, audio: false, tools: false };
  }
  const providerModel = provider.registryId
    ? catalog
        .find((p) => p.id === provider.registryId)
        ?.models.find((m) => m.id === normalizedModelId)
    : undefined;
  // 自定义网关没有 registryId,但其模型 ID 仍可能来自 models.dev,只按完整 ID 匹配。
  const models = providerModel
    ? [providerModel]
    : findCatalogModelsById(catalog, normalizedModelId);
  return {
    reasoning: models.some((model) => model.reasoning),
    vision: models.some((model) => model.vision),
    audio: models.some((model) => model.audio),
    tools: models.some((model) => model.tools),
  };
}

/** 模型上下文窗口大小(models.dev limit.context);目录没有匹配项时返回 undefined。 */
export function getModelContextWindow(
  provider: ProviderConfig,
  modelId: string,
  catalog: CatalogProvider[],
): number | undefined {
  const normalizedModelId = modelId.trim();
  if (!normalizedModelId || /^(?:https?|wss?):\/\//i.test(normalizedModelId)) return undefined;
  const providerModel = provider.registryId
    ? catalog
        .find((p) => p.id === provider.registryId)
        ?.models.find((m) => m.id === normalizedModelId)
    : undefined;
  if (providerModel?.contextWindow) {
    return providerModel.contextWindow;
  }

  const matchingModels = findCatalogModelsById(catalog, normalizedModelId);
  const contextWindows = matchingModels
    .map((model) => model.contextWindow)
    .filter((contextWindow) => contextWindow > 0);
  if (contextWindows.length === 0) {
    return undefined;
  }

  // 同一模型 ID 可能有多个供应商记录,取出现次数最多的窗口作为模型级映射。
  const counts = new Map<number, number>();
  let selectedWindow: number | undefined;
  let selectedCount = 0;
  for (const contextWindow of contextWindows) {
    const count = (counts.get(contextWindow) ?? 0) + 1;
    counts.set(contextWindow, count);
    if (count > selectedCount) {
      selectedWindow = contextWindow;
      selectedCount = count;
    }
  }
  return selectedWindow;
}

/** 将 models.dev 的 token 数量格式化为模型列表可读的 K/M/B 标签。 */
export function formatModelContextWindow(contextWindow: number): string {
  if (contextWindow >= 1_000_000_000) {
    return `${formatContextUnit(contextWindow / 1_000_000_000)}B`;
  }
  if (contextWindow >= 1_000_000) {
    return `${formatContextUnit(contextWindow / 1_000_000)}M`;
  }
  if (contextWindow >= 1_000) {
    return `${formatContextUnit(contextWindow / 1_000)}K`;
  }
  return contextWindow.toLocaleString("en-US");
}

function formatContextUnit(value: number): string {
  return value.toLocaleString("en-US", { maximumFractionDigits: value < 10 ? 1 : 0 });
}

/** models.dev 通常返回数字,但网关/缓存中也可能保留 "128K"、"1M" 形式。 */
function parseContextWindow(value: unknown): number {
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  }
  if (typeof value !== "string") return 0;
  const match = /^([0-9]+(?:\.[0-9]+)?)\s*([kmb])?$/i.exec(value.trim());
  if (!match) return 0;
  const amount = Number(match[1]);
  const multiplier =
    match[2]?.toLowerCase() === "b"
      ? 1_000_000_000
      : match[2]?.toLowerCase() === "m"
        ? 1_000_000
        : match[2]?.toLowerCase() === "k"
          ? 1_000
          : 1;
  const parsed = amount * multiplier;
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

// ---------------------------------------------------------------------------
// 思考等级(reasoning effort)
//
// 主通道 = AI SDK 标准化字段 modelSettings.reasoning(mastra PR #18500):
//   ReasoningLevel = NonNullable<LanguageModelV4CallOptions['reasoning']>
//                  = 'provider-default' | 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
// model router 原生按 V4 → V3 → V2 分发,该字段对所有 LanguageModelV4 provider
// 一视同仁地转发。我们装的 @ai-sdk/{openai,anthropic,google} 均为 spec v4,
// 因此它是真实生效的,且无需再按供应商家族各自映射 —— 家族映射只覆盖三家,
// 其余(xai / deepseek / groq / mistral…)会拿到读不懂的键从而静默失效。
//
// 例外 = 'max' 档:标准 ReasoningLevel 目前只到 'xhigh',但
//   @ai-sdk/openai 的 reasoningEffort 与 @ai-sdk/anthropic 的 effort 都接受 'max',
// 故仅该档退回 provider 专属的 providerOptions 通道。
//
// 关于「自动」:三家 provider 都没有字面量 auto;标准里的 'provider-default'
// 就是它的语义(AI SDK 注释:Defaults to 'provider-default'),即不指定档位、
// 由供应商自己决定思考量。作为可选档位暴露给用户。
// ---------------------------------------------------------------------------

export type ReasoningEffort =
  | "provider-default"
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

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

/**
 * 各家族可选档位。'provider-default' 走标准字段,对所有 V4 provider 通用,故一律置首。
 * 其余取值以对应 provider 包实际接受的枚举为准:
 * - @ai-sdk/anthropic  effort: low | medium | high | xhigh | max
 * - @ai-sdk/google     thinkingConfig.thinkingLevel: minimal | low | medium | high
 * - @ai-sdk/openai     reasoningEffort: none | minimal | low | medium | high | xhigh | max
 * 其余家族只给标准 ReasoningLevel 覆盖的档位(不含 max)。
 */
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

/** 是否支持 'max'(标准字段表达不了,需 provider 专属选项) */
function supportsMaxEffort(family: string | undefined): boolean {
  return family === "anthropic" || family === "openai";
}

/**
 * 构造思考等级的请求体片段,由 chat 路由原样透传给 AgentExecutionOptions。
 * 返回 `{ modelSettings }` 或 `{ providerOptions }`,调用方直接展开进 body。
 */
export function buildReasoningRequest(
  provider: ProviderConfig,
  effort: ReasoningEffort,
): Record<string, unknown> {
  const family = provider.registryId ?? provider.protocol;
  if (effort === "max") {
    // 标准字段没有 max;openai/anthropic 走各自 provider 选项,其余家族降到 xhigh
    if (!supportsMaxEffort(family)) return { modelSettings: { reasoning: "xhigh" } };
    return family === "anthropic"
      ? { providerOptions: { anthropic: { effort: "max" } } }
      : { providerOptions: { openai: { reasoningEffort: "max" } } };
  }
  return { modelSettings: { reasoning: effort } };
}

// ---------------------------------------------------------------------------
// 连接测试:复用官方 chat 路由(docs/en/reference/ai-sdk/chat-route.mdx)
// 以真实对话链路发送 "hi",解析 data stream,测完删除临时线程。
// 请求显式带 model → 服务端将其存入 REQUEST_MODEL_CONTEXT_KEY,不依赖
// 全局默认选定模型,因此「未启用任何模型」也能准确测出连通性。
// 测试通过 = 该供应商/模型/API Key 可用。
// ---------------------------------------------------------------------------

export async function testProviderModel(
  provider: ProviderConfig,
  modelId: string,
  resourceId: string,
): Promise<{ ok: boolean; reply?: string; error?: string }> {
  const threadId = `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    // memory 必须带:Agent 配置了 memory,不带 threadId 会被 Agent.stream 拒绝
    const response = await fetch(`${MASTRA_SERVER_URL}/chat/mastra-work-agent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        messages: [
          {
            id: `test-msg-${Date.now()}`,
            role: "user",
            parts: [{ type: "text", text: "hi" }],
          },
        ],
        model: buildRequestModel(provider, modelId),
        memory: { resource: resourceId, thread: threadId },
      }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      return { ok: false, error: `HTTP ${response.status} ${detail.slice(0, 200)}` };
    }
    if (!response.body) {
      return { ok: false, error: "响应无内容" };
    }
    // 解析 SSE data stream:收到首个 text-delta 即成功;error 事件即失败
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let reply = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        let chunk: Record<string, unknown>;
        try {
          chunk = JSON.parse(payload) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (chunk.type === "error") {
          return { ok: false, error: String(chunk.errorText ?? chunk.error ?? "流式响应错误") };
        }
        if (chunk.type === "text-delta") {
          reply += String(chunk.delta ?? chunk.text ?? "");
          if (reply.trim()) {
            return { ok: true, reply: reply.trim().slice(0, 120) };
          }
        }
      }
    }
    return reply.trim()
      ? { ok: true, reply: reply.trim().slice(0, 120) }
      : { ok: false, error: "未收到模型回复" };
  } catch (error) {
    const message =
      error instanceof Error && error.name === "AbortError"
        ? "请求超时(60s)"
        : (error as Error).message;
    return { ok: false, error: message };
  } finally {
    clearTimeout(timer);
    // 清理测试线程,避免污染线程列表
    void fetch(
      `${MASTRA_SERVER_URL}/work/threads/${threadId}?resourceId=${encodeURIComponent(resourceId)}`,
      { method: "DELETE" },
    ).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// BYOK → 后端请求模型对象
// 参考 docs/en/models/index.mdx:内置 provider 用 "provider/model" + apiKey;
// 自定义网关带 url + protocol + useResponses,由后端(src/mastra/agents/llm)用官方
// provider 包解析为真实端点:anthropic → Messages API,gemini → 原生 API,
// openai → Responses(useResponses)或 Chat Completions
// ---------------------------------------------------------------------------

export interface RequestModelPayload {
  id: string;
  apiKey: string;
  url?: string;
  protocol?: GatewayProtocol;
  useResponses?: boolean;
}

export function buildRequestModel(provider: ProviderConfig, modelId: string): RequestModelPayload {
  // 内置供应商:registry id 即 model router 的 provider 前缀
  if (provider.registryId) {
    return {
      id: `${provider.registryId}/${modelId}`,
      apiKey: provider.apiKey,
    };
  }
  // 自定义网关:必须带 baseUrl(base URL,非具体 chat 端点)
  return {
    id: `${provider.id}/${modelId}`,
    url: provider.baseUrl,
    apiKey: provider.apiKey,
    ...(provider.protocol ? { protocol: provider.protocol } : {}),
    ...(provider.protocol === "openai" && provider.useResponses ? { useResponses: true } : {}),
  };
}
