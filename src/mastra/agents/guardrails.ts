/**
 * 护栏与处理器管线(docs/en/docs/agents/guardrails.mdx + processors.mdx,
 * 参数详见 docs/en/reference/processors/*.mdx)。
 * 把 @mastra/core/processors 的全部内置处理器暴露成设置面板可配置项,
 * 写入数据库 app_config 表(key = "guardrails"),保存后实时生效
 * (置空实例缓存,下次请求按新配置重建)。
 *
 * 三组管线与 Agent 的三个数组一一对应:
 * - inputProcessors:模型调用之前(规范化 / 注入检测 / 语言 / 审核 / PII /
 *   Token 上限 / 成本上限 / 工具裁剪 / 响应缓存 / 供应商历史兼容)
 * - outputProcessors:模型响应之后(流式批处理 / Token 上限 / PII / 审核 /
 *   系统提示词清洗)
 * - errorProcessors:供应商 API 报错时(prefill 恢复 / 瞬时流错误重试)
 *
 * 刻意**不在**这里接入 MessageHistory / SemanticRecall / WorkingMemory ——
 * 它们由 Memory 类自动加入管线(processors.mdx「With memory enabled」),
 * 再手工添加会造成历史二次注入;其参数在设置面板「记忆」页配置。
 *
 * 顺序原则(guardrails.mdx「Speed up guardrails」):
 * - 输入:零成本处理器在前,LLM 检测器居中,TokenLimiter 收尾保证上下文可容纳,
 *   只作用于 processLLMRequest 的(工具裁剪 / 兼容 / 响应缓存)排在最后
 * - 输出:BatchParts 与 TokenLimiter 先跑,再交给按块调用 LLM 的重处理器
 */
import { InMemoryServerCache } from "@mastra/core/cache";
import type { MastraModelConfig } from "@mastra/core/llm";
import type { Processor } from "@mastra/core/processors";
import {
  BatchPartsProcessor,
  type ErrorProcessorOrWorkflow,
  type InputProcessorOrWorkflow,
  isBadRequestError,
  isProcessorWorkflow,
  LanguageDetector,
  ModerationProcessor,
  type OutputProcessorOrWorkflow,
  PIIDetector,
  PrefillErrorHandler,
  PromptInjectionDetector,
  ProviderHistoryCompat,
  RegexFilterProcessor,
  type RegexPreset,
  type RegexRule,
  ResponseCache,
  SkillSearchProcessor,
  StreamErrorRetryProcessor,
  SystemPromptScrubber,
  TokenCostControl,
  TokenLimiterProcessor,
  ToolCallFilter,
  ToolSearchProcessor,
  UnicodeNormalizer,
} from "@mastra/core/processors";
import type { RequestContext } from "@mastra/core/request-context";
import { clampNumber, cleanStrings } from "../config/normalize";
import { REQUEST_MODEL_CONTEXT_KEY, resolveDefaultLanguageModel } from "../models";
import { getAppConfig, resourceIdFromContext, setAppConfig } from "../storage";
import { getThreadWorkspace, WORKSPACE_PATH_CONTEXT_KEY } from "../workspace";
import { SESSION_TOOL_POLICY_CONTEXT_KEY } from "./permissions";

const GUARDRAILS_CONFIG_KEY = "guardrails";

type RegexStrategy = "block" | "redact" | "warn";
type RegexPhase = "input" | "output" | "all";
type InjectionStrategy = "block" | "warn" | "filter" | "rewrite";
type ModerationStrategy = "block" | "warn" | "filter";
type PIIStrategy = "block" | "warn" | "filter" | "redact";
type PIIRedaction = "mask" | "hash" | "remove" | "placeholder";
type LanguageStrategy = "detect" | "translate" | "block" | "warn";
type ScrubberStrategy = "block" | "warn" | "filter" | "redact";
type ScrubberRedaction = "mask" | "placeholder" | "remove";
type TokenLimitTrimMode = "best-fit" | "contiguous";
type TokenLimitOutputStrategy = "truncate" | "abort";
type TokenLimitCountMode = "cumulative" | "part";
type CostScope = "run" | "resource" | "thread" | "user" | "organization" | "session";
type CostWindow = "1h" | "6h" | "24h" | "7d" | "30d" | "365d";
type CostStrategy = "block" | "warn";
type CacheScopeMode = "auto" | "none" | "custom";
type ToolSearchStorage = "in-memory" | "context";
export interface GuardrailsUserConfig {
  // --- 通用 ---------------------------------------------------------------
  /**
   * 内部检测 agent 用「提示词注入 JSON」代替原生 structured output。
   * 第三方网关/兼容端点常不支持 response_format,关闭会让检测结果解析失败。
   */
  jsonPromptInjection: boolean;
  /** JSON provider options shared by the internal detector agents. */
  detectorProviderOptions: string;
  /** 处理器重试上限(abort({retry:true}) 生效前提);0 = 不显式设置 */
  maxProcessorRetries: number;

  // --- UnicodeNormalizer(输入) --------------------------------------------
  unicode: boolean;
  unicodeStripControlChars: boolean;
  unicodePreserveEmojis: boolean;
  unicodeCollapseWhitespace: boolean;
  unicodeTrim: boolean;

  // --- RegexFilterProcessor(零 LLM 成本,输入/输出) ------------------------
  regex: boolean;
  regexPresets: RegexPreset[];
  regexStrategy: RegexStrategy;
  regexPhase: RegexPhase;
  regexIncludeRedactedValues: boolean;
  regexStreamCarryoverSize: number;
  /** 自定义规则 JSON 文本:[{ name, pattern, flags?, replacement? }] */
  regexRules: string;

  // --- PromptInjectionDetector(输入) --------------------------------------
  injection: boolean;
  injectionTypes: string[];
  injectionThreshold: number;
  injectionStrategy: InjectionStrategy;
  injectionLastMessageOnly: boolean;
  injectionIncludeScores: boolean;
  injectionInstructions: string;

  // --- LanguageDetector(输入) ---------------------------------------------
  language: boolean;
  languageTargets: string[];
  languageThreshold: number;
  languageStrategy: LanguageStrategy;
  languagePreserveOriginal: boolean;
  languageMinTextLength: number;
  languageLastMessageOnly: boolean;
  languageIncludeDetails: boolean;
  languageInstructions: string;

  // --- ModerationProcessor(输入/输出共用一份参数) --------------------------
  moderationInput: boolean;
  moderationOutput: boolean;
  moderationCategories: string[];
  moderationThreshold: number;
  moderationStrategy: ModerationStrategy;
  moderationLastMessageOnly: boolean;
  moderationIncludeScores: boolean;
  moderationChunkWindow: number;
  moderationInstructions: string;

  // --- PIIDetector(输入/输出共用一份参数) ---------------------------------
  piiInput: boolean;
  piiOutput: boolean;
  piiTypes: string[];
  piiThreshold: number;
  piiStrategy: PIIStrategy;
  piiRedactionMethod: PIIRedaction;
  piiPreserveFormat: boolean;
  piiLastMessageOnly: boolean;
  piiIncludeDetections: boolean;
  piiBufferSize: number;
  piiInstructions: string;

  // --- SystemPromptScrubber(输出) -----------------------------------------
  scrubber: boolean;
  scrubberStrategy: ScrubberStrategy;
  scrubberRedactionMethod: ScrubberRedaction;
  scrubberPlaceholderText: string;
  scrubberCustomPatterns: string[];
  scrubberIncludeDetections: boolean;
  scrubberLastMessageOnly: boolean;
  scrubberInstructions: string;

  // --- BatchPartsProcessor(输出) ------------------------------------------
  batchParts: boolean;
  batchPartsSize: number;
  /** 0 = 不设超时(仅按 batchSize 触发) */
  batchPartsMaxWaitTime: number;
  batchPartsEmitOnNonText: boolean;

  // --- TokenLimiterProcessor(输入 / 输出各一份) ---------------------------
  tokenLimitInput: boolean;
  tokenLimitInputValue: number;
  tokenLimitTrimMode: TokenLimitTrimMode;
  tokenLimitOutput: boolean;
  tokenLimitOutputValue: number;
  tokenLimitOutputStrategy: TokenLimitOutputStrategy;
  tokenLimitOutputCountMode: TokenLimitCountMode;

  // --- TokenCostControl(输入) ---------------------------------------------
  tokenCost: boolean;
  /** 美元上限(近似值:观测指标异步落盘,快跑的 run 可能短暂越界) */
  tokenCostMax: number;
  tokenCostScope: CostScope;
  tokenCostWindow: CostWindow;
  tokenCostStrategy: CostStrategy;
  /** 软阈值百分比(0 = 不启用软告警) */
  tokenCostWarnAtPercent: number;
  tokenCostIncludeBreakdown: boolean;

  // --- ToolCallFilter(输入,processLLMRequest) -----------------------------
  toolCallFilter: boolean;
  /** 仅裁剪这些工具;留空 = 裁剪全部工具调用 */
  toolCallFilterExclude: string[];
  /** 保留最近 N 个产生工具调用的步骤;-1 = 不在本轮循环内裁剪 */
  toolCallFilterAfterToolSteps: number;
  toolCallFilterPreserveModelOutput: boolean;

  // --- ResponseCache(输入,processLLMRequest/Response) ---------------------
  responseCache: boolean;
  responseCacheTtl: number;
  /** auto = 按 resourceId 隔离;none = 全局共享;custom = 固定租户键 */
  responseCacheScopeMode: CacheScopeMode;
  responseCacheScopeValue: string;

  // --- ProviderHistoryCompat(输入,processLLMRequest + processAPIError) ----
  providerCompat: boolean;

  // --- SkillSearchProcessor(输入,需工作区) --------------------------------
  skillSearch: boolean;
  skillSearchTopK: number;
  skillSearchMinScore: number;
  skillSearchTtl: number;
  skillSearchBlockingRefresh: boolean;

  // --- ToolSearchProcessor(输入,动态工具发现) -------------------------------
  toolSearch: boolean;
  toolSearchTopK: number;
  toolSearchMinScore: number;
  toolSearchInjectCatalog: boolean;
  toolSearchAutoLoad: boolean;
  toolSearchStorage: ToolSearchStorage;
  toolSearchTtl: number;

  // --- errorProcessors ----------------------------------------------------
  prefillErrorHandler: boolean;
  streamErrorRetry: boolean;
  streamErrorRetryMax: number;
  streamErrorRetryDelayMs: number;
  streamErrorRetryMaxRetryAfterMs: number;
  streamErrorRetryUnknown: boolean;
}

/** ModerationProcessor 默认类别(与 OpenAI moderation 一致) */
const MODERATION_CATEGORIES = [
  "hate",
  "hate/threatening",
  "harassment",
  "harassment/threatening",
  "self-harm",
  "self-harm/intent",
  "self-harm/instructions",
  "sexual",
  "sexual/minors",
  "violence",
  "violence/graphic",
];

/**
 * PIIDetector 默认检测类型。官方默认集未导出;url 与 uuid 是工作台额外覆盖的
 * 两类敏感标识,因此这里不是对官方私有常量的无意漂移。
 */
const PII_TYPES = [
  "email",
  "phone",
  "credit-card",
  "ssn",
  "api-key",
  "ip-address",
  "name",
  "address",
  "date-of-birth",
  "url",
  "uuid",
  "crypto-wallet",
  "iban",
];

/** PromptInjectionDetector 默认检测类型 */
const INJECTION_TYPES = [
  "injection",
  "jailbreak",
  "tool-exfiltration",
  "data-exfiltration",
  "system-override",
  "role-manipulation",
];

/**
 * 默认值取向:零 LLM 成本、且不会改写正文的处理器默认开启;
 * 每轮都要额外调用模型的检测器(注入 / 审核 / PII / 语言)默认关闭,
 * 由用户按需开启;启用后自动跟随当前请求模型。
 */
const DEFAULT_CONFIG: GuardrailsUserConfig = {
  jsonPromptInjection: true,
  detectorProviderOptions: "{}",
  maxProcessorRetries: 0,

  unicode: true,
  unicodeStripControlChars: true,
  unicodePreserveEmojis: true,
  // 官方默认 true,这里默认关:折叠连续空白会破坏粘贴进来的代码与 Markdown 缩进
  unicodeCollapseWhitespace: false,
  unicodeTrim: true,

  regex: true,
  regexPresets: ["secrets"],
  regexStrategy: "redact",
  regexPhase: "all",
  regexIncludeRedactedValues: false,
  regexStreamCarryoverSize: 128,
  regexRules: "[]",

  injection: false,
  injectionTypes: [...INJECTION_TYPES],
  injectionThreshold: 0.7,
  injectionStrategy: "block",
  injectionLastMessageOnly: true,
  injectionIncludeScores: false,
  injectionInstructions: "",

  language: false,
  languageTargets: ["Chinese", "zh"],
  languageThreshold: 0.7,
  languageStrategy: "detect",
  languagePreserveOriginal: true,
  languageMinTextLength: 10,
  languageLastMessageOnly: true,
  languageIncludeDetails: false,
  languageInstructions: "",

  moderationInput: false,
  moderationOutput: false,
  moderationCategories: [...MODERATION_CATEGORIES],
  moderationThreshold: 0.5,
  moderationStrategy: "block",
  moderationLastMessageOnly: true,
  moderationIncludeScores: false,
  moderationChunkWindow: 0,
  moderationInstructions: "",

  piiInput: false,
  piiOutput: false,
  piiTypes: [...PII_TYPES],
  piiThreshold: 0.6,
  piiStrategy: "redact",
  piiRedactionMethod: "mask",
  piiPreserveFormat: true,
  piiLastMessageOnly: true,
  piiIncludeDetections: false,
  piiBufferSize: 200,
  piiInstructions: "",

  scrubber: false,
  scrubberStrategy: "redact",
  scrubberRedactionMethod: "mask",
  scrubberPlaceholderText: "[SYSTEM_PROMPT]",
  scrubberCustomPatterns: [],
  scrubberIncludeDetections: false,
  scrubberLastMessageOnly: true,
  scrubberInstructions: "",

  batchParts: false,
  batchPartsSize: 5,
  batchPartsMaxWaitTime: 100,
  batchPartsEmitOnNonText: true,

  tokenLimitInput: false,
  tokenLimitInputValue: 120_000,
  tokenLimitTrimMode: "contiguous",
  tokenLimitOutput: false,
  tokenLimitOutputValue: 4_000,
  tokenLimitOutputStrategy: "truncate",
  tokenLimitOutputCountMode: "cumulative",

  tokenCost: false,
  tokenCostMax: 5,
  tokenCostScope: "resource",
  tokenCostWindow: "7d",
  tokenCostStrategy: "warn",
  tokenCostWarnAtPercent: 80,
  tokenCostIncludeBreakdown: true,

  toolCallFilter: false,
  toolCallFilterExclude: [],
  toolCallFilterAfterToolSteps: -1,
  toolCallFilterPreserveModelOutput: true,

  responseCache: false,
  responseCacheTtl: 300,
  responseCacheScopeMode: "auto",
  responseCacheScopeValue: "",

  providerCompat: true,

  skillSearch: false,
  skillSearchTopK: 5,
  skillSearchMinScore: 0,
  skillSearchTtl: 3_600_000,
  skillSearchBlockingRefresh: false,

  toolSearch: false,
  toolSearchTopK: 5,
  toolSearchMinScore: 0,
  toolSearchInjectCatalog: false,
  toolSearchAutoLoad: false,
  toolSearchStorage: "context",
  toolSearchTtl: 3_600_000,

  prefillErrorHandler: true,
  streamErrorRetry: true,
  streamErrorRetryMax: 2,
  // createCodingAgent() uses 3000ms for unknown errors. Network-reset
  // matchers below keep their documented 1000ms exponential backoff.
  streamErrorRetryDelayMs: 3_000,
  streamErrorRetryMaxRetryAfterMs: 30_000,
  streamErrorRetryUnknown: true,
};

/** 读取护栏配置(app_config 表 key="guardrails";无记录或损坏时回落默认值) */
export async function getGuardrailsConfig(resourceId?: string): Promise<GuardrailsUserConfig> {
  const scope = scopeKey(resourceId);
  const cached = guardrailsConfigByScope.get(scope);
  if (cached) return cached;
  const raw = await getAppConfig(GUARDRAILS_CONFIG_KEY, resourceId);
  if (!raw) {
    guardrailsConfigByScope.set(scope, DEFAULT_CONFIG);
    return DEFAULT_CONFIG;
  }
  try {
    const next = normalizeGuardrailsConfig(JSON.parse(raw) as Partial<GuardrailsUserConfig>);
    guardrailsConfigByScope.set(scope, next);
    return next;
  } catch {
    guardrailsConfigByScope.set(scope, DEFAULT_CONFIG);
    return DEFAULT_CONFIG;
  }
}

/** 写入护栏配置并实时生效:替换运行时配置 + 置空全部处理器缓存 */
export async function saveGuardrailsConfig(
  next: GuardrailsUserConfig,
  resourceId?: string,
): Promise<void> {
  const normalized = normalizeGuardrailsConfig(next);
  await setAppConfig(GUARDRAILS_CONFIG_KEY, JSON.stringify(normalized, null, 2), resourceId);
  guardrailsConfigByScope.set(scopeKey(resourceId), normalized);
  invalidateCache(resourceId);
}

const guardrailsConfigByScope = new Map<string, GuardrailsUserConfig>();

function normalizeGuardrailsConfig(input: Partial<GuardrailsUserConfig>): GuardrailsUserConfig {
  const raw = input as Record<string, unknown>;
  const output = { ...DEFAULT_CONFIG } as Record<string, unknown>;
  const booleans = [
    "jsonPromptInjection",
    "unicode",
    "unicodeStripControlChars",
    "unicodePreserveEmojis",
    "unicodeCollapseWhitespace",
    "unicodeTrim",
    "regex",
    "regexIncludeRedactedValues",
    "injection",
    "injectionLastMessageOnly",
    "injectionIncludeScores",
    "language",
    "languagePreserveOriginal",
    "languageLastMessageOnly",
    "languageIncludeDetails",
    "moderationInput",
    "moderationOutput",
    "moderationLastMessageOnly",
    "moderationIncludeScores",
    "piiInput",
    "piiOutput",
    "piiPreserveFormat",
    "piiLastMessageOnly",
    "piiIncludeDetections",
    "scrubber",
    "scrubberIncludeDetections",
    "scrubberLastMessageOnly",
    "batchParts",
    "batchPartsEmitOnNonText",
    "tokenLimitInput",
    "tokenLimitOutput",
    "tokenCost",
    "tokenCostIncludeBreakdown",
    "toolCallFilter",
    "toolCallFilterPreserveModelOutput",
    "responseCache",
    "providerCompat",
    "skillSearch",
    "skillSearchBlockingRefresh",
    "toolSearch",
    "toolSearchInjectCatalog",
    "toolSearchAutoLoad",
    "prefillErrorHandler",
    "streamErrorRetry",
    "streamErrorRetryUnknown",
  ] as const;
  for (const key of booleans) {
    if (typeof raw[key] === "boolean") output[key] = raw[key];
  }

  const numbers: Record<string, [number, number, number]> = {
    maxProcessorRetries: [0, 0, 50],
    injectionThreshold: [0.7, 0, 1],
    languageThreshold: [0.7, 0, 1],
    languageMinTextLength: [10, 0, 10_000],
    moderationThreshold: [0.5, 0, 1],
    moderationChunkWindow: [0, 0, 50],
    piiThreshold: [0.6, 0, 1],
    piiBufferSize: [200, 1, 10_000],
    regexStreamCarryoverSize: [128, 0, 100_000],
    batchPartsSize: [5, 1, 100],
    batchPartsMaxWaitTime: [100, 0, 120_000],
    tokenLimitInputValue: [120_000, 1, 2_000_000],
    tokenLimitOutputValue: [4_000, 1, 500_000],
    tokenCostMax: [5, 0, 1_000_000],
    tokenCostWarnAtPercent: [80, 0, 100],
    toolCallFilterAfterToolSteps: [-1, -1, 100],
    responseCacheTtl: [300, 0, 86_400],
    skillSearchTopK: [5, 1, 100],
    skillSearchMinScore: [0, 0, 1],
    skillSearchTtl: [3_600_000, 0, 86_400_000],
    toolSearchTopK: [5, 1, 100],
    toolSearchMinScore: [0, 0, 1],
    toolSearchTtl: [3_600_000, 0, 86_400_000],
    streamErrorRetryMax: [2, 0, 10],
    streamErrorRetryDelayMs: [3_000, 0, 120_000],
    streamErrorRetryMaxRetryAfterMs: [30_000, 0, 600_000],
  };
  for (const [key, [fallback, min, max]] of Object.entries(numbers)) {
    output[key] = clampNumber(raw[key], fallback, min, max);
  }

  const integerKeys = new Set([
    "maxProcessorRetries",
    "languageMinTextLength",
    "moderationChunkWindow",
    "piiBufferSize",
    "regexStreamCarryoverSize",
    "batchPartsSize",
    "batchPartsMaxWaitTime",
    "tokenLimitInputValue",
    "tokenLimitOutputValue",
    "toolCallFilterAfterToolSteps",
    "responseCacheTtl",
    "skillSearchTopK",
    "skillSearchTtl",
    "toolSearchTopK",
    "toolSearchTtl",
    "streamErrorRetryMax",
    "streamErrorRetryDelayMs",
    "streamErrorRetryMaxRetryAfterMs",
  ]);
  for (const key of integerKeys) {
    const value = output[key];
    if (typeof value === "number") output[key] = Math.round(value);
  }

  const lists: Record<string, number> = {
    regexPresets: 3,
    injectionTypes: 50,
    languageTargets: 50,
    moderationCategories: 50,
    piiTypes: 50,
    scrubberCustomPatterns: 100,
    toolCallFilterExclude: 100,
  };
  for (const [key, limit] of Object.entries(lists)) {
    if (raw[key] !== undefined) output[key] = cleanStrings(raw[key], limit);
  }
  output.regexPresets = (output.regexPresets as string[]).filter((value): value is RegexPreset =>
    ["pii", "secrets", "urls"].includes(value),
  );

  const textKeys = [
    "detectorProviderOptions",
    "regexRules",
    "injectionInstructions",
    "languageInstructions",
    "moderationInstructions",
    "piiInstructions",
    "scrubberPlaceholderText",
    "scrubberInstructions",
    "responseCacheScopeValue",
  ] as const;
  for (const key of textKeys) {
    if (typeof raw[key] === "string") output[key] = raw[key].slice(0, 100_000);
  }

  const enums: Record<string, readonly string[]> = {
    regexStrategy: ["block", "redact", "warn"],
    regexPhase: ["input", "output", "all"],
    injectionStrategy: ["block", "warn", "filter", "rewrite"],
    languageStrategy: ["detect", "translate", "block", "warn"],
    moderationStrategy: ["block", "warn", "filter"],
    piiStrategy: ["block", "warn", "filter", "redact"],
    piiRedactionMethod: ["mask", "hash", "remove", "placeholder"],
    scrubberStrategy: ["block", "warn", "filter", "redact"],
    scrubberRedactionMethod: ["mask", "placeholder", "remove"],
    tokenLimitTrimMode: ["best-fit", "contiguous"],
    tokenLimitOutputStrategy: ["truncate", "abort"],
    tokenLimitOutputCountMode: ["cumulative", "part"],
    tokenCostScope: ["run", "resource", "thread", "user", "organization", "session"],
    tokenCostWindow: ["1h", "6h", "24h", "7d", "30d", "365d"],
    tokenCostStrategy: ["block", "warn"],
    responseCacheScopeMode: ["auto", "none", "custom"],
    toolSearchStorage: ["in-memory", "context"],
  };
  for (const [key, allowed] of Object.entries(enums)) {
    if (typeof raw[key] === "string" && allowed.includes(raw[key])) output[key] = raw[key];
  }

  return output as unknown as GuardrailsUserConfig;
}

function scopeKey(resourceId?: string): string {
  return resourceId?.trim() || "__system__";
}

function currentConfig(resourceId?: string): GuardrailsUserConfig {
  return guardrailsConfigByScope.get(scopeKey(resourceId)) ?? DEFAULT_CONFIG;
}

/** 当前配置(chat 路由与 Agent 的 defaultOptions 读它决定 maxProcessorRetries) */
export function getGuardrailsRuntimeConfig(resourceId?: string): GuardrailsUserConfig {
  return currentConfig(resourceId);
}

// ---------------------------------------------------------------------------
// 处理器实例缓存
//
// 输入/输出处理器按请求模型即时构建;错误处理器可安全按配置缓存。
// SkillSearch 依赖每线程 Workspace 实例,单独按工作区路径缓存。
// ---------------------------------------------------------------------------

interface GuardrailRuntime {
  cachedError: ErrorProcessorOrWorkflow[] | null;
  skillSearchCache: Map<string, SkillSearchProcessor>;
  responseCacheBackend: InMemoryServerCache | null;
}

const runtimeByScope = new Map<string, GuardrailRuntime>();

function getRuntime(resourceId?: string): GuardrailRuntime {
  const key = scopeKey(resourceId);
  let runtime = runtimeByScope.get(key);
  if (!runtime) {
    runtime = {
      cachedError: null,
      skillSearchCache: new Map(),
      responseCacheBackend: null,
    };
    runtimeByScope.set(key, runtime);
  }
  return runtime;
}

function invalidateCache(resourceId?: string): void {
  const runtime = getRuntime(resourceId);
  runtime.cachedError = null;
  runtime.skillSearchCache.clear();
  runtime.responseCacheBackend = null;
}

/** 护栏检测模型跟随当前请求模型;无请求上下文时使用当前资源默认模型。 */
async function resolveGuardrailModel(
  requestContext?: RequestContext,
  resourceId?: string,
): Promise<MastraModelConfig | undefined> {
  const requestModel = requestContext?.get(REQUEST_MODEL_CONTEXT_KEY);
  if (typeof requestModel === "object" && requestModel !== null) {
    return requestModel as MastraModelConfig;
  }
  return resolveDefaultLanguageModel(resourceId);
}

/** 内部检测 agent 的结构化输出形态(第三方网关不支持 response_format 时必需) */
function structuredOutputOptions(cfg: GuardrailsUserConfig) {
  return cfg.jsonPromptInjection ? { jsonPromptInjection: true } : undefined;
}

type DetectorProviderOptions = NonNullable<
  ConstructorParameters<typeof PromptInjectionDetector>[0]["providerOptions"]
>;

function parseDetectorProviderOptions(text: string): DetectorProviderOptions | undefined {
  try {
    const value = JSON.parse(text) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as DetectorProviderOptions)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 自定义正则规则:面板里是 JSON 文本,这里解析成 RegexRule[]。
 * 强制补 g 标志 —— redact 依赖全局替换,漏了只会改写第一处。
 * 单条规则非法(缺 name/pattern、正则语法错)时跳过该条而不是整体失效。
 */
function parseRegexRules(text: string): RegexRule[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const rules: RegexRule[] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) continue;
    const row = item as {
      name?: unknown;
      pattern?: unknown;
      flags?: unknown;
      replacement?: unknown;
    };
    if (typeof row.name !== "string" || typeof row.pattern !== "string") continue;
    const flags = typeof row.flags === "string" ? row.flags : "";
    try {
      rules.push({
        name: row.name,
        pattern: new RegExp(row.pattern, flags.includes("g") ? flags : `${flags}g`),
        ...(typeof row.replacement === "string" ? { replacement: row.replacement } : {}),
      });
    } catch {
      // 正则语法非法:跳过该条
    }
  }
  return rules;
}

/** 正则过滤器:phase = all 时同一实例进输入与输出两个数组 */
function buildRegexFilter(cfg: GuardrailsUserConfig): RegexFilterProcessor | undefined {
  if (!cfg.regex) return undefined;
  const rules = parseRegexRules(cfg.regexRules);
  if (cfg.regexPresets.length === 0 && rules.length === 0) return undefined;
  return new RegexFilterProcessor({
    ...(cfg.regexPresets.length ? { presets: cfg.regexPresets } : {}),
    ...(rules.length ? { rules } : {}),
    strategy: cfg.regexStrategy,
    phase: cfg.regexPhase,
    includeRedactedValues: cfg.regexIncludeRedactedValues,
    streamCarryoverSize: cfg.regexStreamCarryoverSize,
  });
}

/** 审核器:输入与输出共用一个实例(无跨请求状态,内部 agent 只需建一次) */
function buildModeration(model: MastraModelConfig, cfg: GuardrailsUserConfig): ModerationProcessor {
  const structuredOptions = structuredOutputOptions(cfg);
  const providerOptions = parseDetectorProviderOptions(cfg.detectorProviderOptions);
  return new ModerationProcessor({
    model,
    categories: cfg.moderationCategories,
    threshold: cfg.moderationThreshold,
    strategy: cfg.moderationStrategy,
    lastMessageOnly: cfg.moderationLastMessageOnly,
    includeScores: cfg.moderationIncludeScores,
    ...(cfg.moderationChunkWindow > 0 ? { chunkWindow: cfg.moderationChunkWindow } : {}),
    ...(cfg.moderationInstructions.trim()
      ? { instructions: cfg.moderationInstructions.trim() }
      : {}),
    ...(structuredOptions ? { structuredOutputOptions: structuredOptions } : {}),
    ...(providerOptions ? { providerOptions } : {}),
  });
}

/** PII 检测:输入与输出共用一个实例 */
function buildPII(model: MastraModelConfig, cfg: GuardrailsUserConfig): PIIDetector {
  const structuredOptions = structuredOutputOptions(cfg);
  const providerOptions = parseDetectorProviderOptions(cfg.detectorProviderOptions);
  return new PIIDetector({
    model,
    detectionTypes: cfg.piiTypes,
    threshold: cfg.piiThreshold,
    strategy: cfg.piiStrategy,
    redactionMethod: cfg.piiRedactionMethod,
    preserveFormat: cfg.piiPreserveFormat,
    lastMessageOnly: cfg.piiLastMessageOnly,
    includeDetections: cfg.piiIncludeDetections,
    bufferSize: cfg.piiBufferSize,
    ...(cfg.piiInstructions.trim() ? { instructions: cfg.piiInstructions.trim() } : {}),
    ...(structuredOptions ? { structuredOutputOptions: structuredOptions } : {}),
    ...(providerOptions ? { providerOptions } : {}),
  });
}

/**
 * 输入处理器数组。顺序即执行顺序(processors.mdx「Execution order」):
 * 规范化 → 正则 → 注入检测 → 语言 → 审核 → PII → 成本 → Token 上限 →
 * 运行时搜索 → processLLMRequest 类(工具裁剪 / 供应商兼容 / 响应缓存)。
 */
async function buildInput(
  cfg = currentConfig(),
  resourceId?: string,
  requestContext?: RequestContext,
): Promise<InputProcessorOrWorkflow[]> {
  const processors: InputProcessorOrWorkflow[] = [];
  const model = await resolveGuardrailModel(requestContext, resourceId);
  const structuredOptions = structuredOutputOptions(cfg);
  const providerOptions = parseDetectorProviderOptions(cfg.detectorProviderOptions);

  if (cfg.unicode) {
    processors.push(
      new UnicodeNormalizer({
        stripControlChars: cfg.unicodeStripControlChars,
        preserveEmojis: cfg.unicodePreserveEmojis,
        collapseWhitespace: cfg.unicodeCollapseWhitespace,
        trim: cfg.unicodeTrim,
      }),
    );
  }

  const regex = buildRegexFilter(cfg);
  if (regex && cfg.regexPhase !== "output") processors.push(regex);

  if (model) {
    if (cfg.injection) {
      processors.push(
        new PromptInjectionDetector({
          model,
          detectionTypes: cfg.injectionTypes,
          threshold: cfg.injectionThreshold,
          strategy: cfg.injectionStrategy,
          lastMessageOnly: cfg.injectionLastMessageOnly,
          includeScores: cfg.injectionIncludeScores,
          ...(cfg.injectionInstructions.trim()
            ? { instructions: cfg.injectionInstructions.trim() }
            : {}),
          ...(structuredOptions ? { structuredOutputOptions: structuredOptions } : {}),
          ...(providerOptions ? { providerOptions } : {}),
        }),
      );
    }
    if (cfg.language && cfg.languageTargets.length > 0) {
      processors.push(
        new LanguageDetector({
          model,
          targetLanguages: cfg.languageTargets,
          threshold: cfg.languageThreshold,
          strategy: cfg.languageStrategy,
          preserveOriginal: cfg.languagePreserveOriginal,
          minTextLength: cfg.languageMinTextLength,
          lastMessageOnly: cfg.languageLastMessageOnly,
          includeDetectionDetails: cfg.languageIncludeDetails,
          ...(cfg.languageInstructions.trim()
            ? { instructions: cfg.languageInstructions.trim() }
            : {}),
          ...(providerOptions ? { providerOptions } : {}),
        }),
      );
    }
    if (cfg.moderationInput) processors.push(buildModeration(model, cfg));
    if (cfg.piiInput) processors.push(buildPII(model, cfg));
  }

  if (cfg.tokenCost && cfg.tokenCostMax > 0) {
    // 依赖 observability 存储的 getMetricAggregate;不可用时构造即抛,
    // 捕获后跳过 —— 一个可选护栏不该让整个 Agent 起不来。
    try {
      processors.push(
        new TokenCostControl({
          maxCost: cfg.tokenCostMax,
          scope: cfg.tokenCostScope,
          window: cfg.tokenCostWindow,
          strategy: cfg.tokenCostStrategy,
          includeBreakdown: cfg.tokenCostIncludeBreakdown,
          ...(cfg.tokenCostWarnAtPercent > 0 && cfg.tokenCostWarnAtPercent < 100
            ? { warnAtPercent: cfg.tokenCostWarnAtPercent }
            : {}),
        }),
      );
    } catch {
      // 观测存储不支持成本聚合:静默跳过(设置面板的状态接口会提示不可用)
    }
  }

  // TokenLimiter 收尾:前面的处理器可能增删消息,最后一步才能保证上下文可容纳
  if (cfg.tokenLimitInput && cfg.tokenLimitInputValue > 0) {
    processors.push(
      new TokenLimiterProcessor({
        limit: cfg.tokenLimitInputValue,
        trimMode: cfg.tokenLimitTrimMode,
      }),
    );
  }

  if (cfg.toolCallFilter) {
    processors.push(
      new ToolCallFilter({
        ...(cfg.toolCallFilterExclude.length ? { exclude: cfg.toolCallFilterExclude } : {}),
        ...(cfg.toolCallFilterAfterToolSteps >= 0
          ? { filterAfterToolSteps: cfg.toolCallFilterAfterToolSteps }
          : {}),
        preserveModelOutput: cfg.toolCallFilterPreserveModelOutput,
      }),
    );
  }

  if (cfg.toolSearch) {
    processors.push(
      new ToolSearchProcessor({
        tools: {},
        includeResolvedTools: true,
        injectCatalog: cfg.toolSearchInjectCatalog,
        filter: ({ toolName, requestContext }) => {
          const policy = requestContext?.get(SESSION_TOOL_POLICY_CONTEXT_KEY) as
            | ((toolName: string) => string)
            | undefined;
          if (typeof policy !== "function") return true;
          return policy(toolName) !== "deny";
        },
        search: {
          topK: cfg.toolSearchTopK,
          minScore: cfg.toolSearchMinScore,
          autoLoad: cfg.toolSearchAutoLoad,
        },
        storage: cfg.toolSearchStorage,
        ttl: cfg.toolSearchTtl,
      }),
    );
  }

  if (cfg.providerCompat) processors.push(new ProviderHistoryCompat());

  if (cfg.responseCache) {
    const runtime = getRuntime(resourceId);
    runtime.responseCacheBackend ??= new InMemoryServerCache();
    processors.push(
      new ResponseCache({
        cache: runtime.responseCacheBackend,
        ttl: cfg.responseCacheTtl,
        agentId: "mastra-work-agent",
        ...(cfg.responseCacheScopeMode === "none"
          ? { scope: null }
          : cfg.responseCacheScopeMode === "custom" && cfg.responseCacheScopeValue.trim()
            ? { scope: cfg.responseCacheScopeValue.trim() }
            : {}),
      }),
    );
  }

  return processors;
}

/** 输出处理器数组:先批处理与截断,再交给按块调用 LLM 的重处理器 */
async function buildOutput(
  cfg = currentConfig(),
  resourceId?: string,
  requestContext?: RequestContext,
): Promise<OutputProcessorOrWorkflow[]> {
  const processors: OutputProcessorOrWorkflow[] = [];
  const model = await resolveGuardrailModel(requestContext, resourceId);

  if (cfg.batchParts) {
    processors.push(
      new BatchPartsProcessor({
        batchSize: cfg.batchPartsSize,
        ...(cfg.batchPartsMaxWaitTime > 0 ? { maxWaitTime: cfg.batchPartsMaxWaitTime } : {}),
        emitOnNonText: cfg.batchPartsEmitOnNonText,
      }),
    );
  }

  if (cfg.tokenLimitOutput && cfg.tokenLimitOutputValue > 0) {
    processors.push(
      new TokenLimiterProcessor({
        limit: cfg.tokenLimitOutputValue,
        strategy: cfg.tokenLimitOutputStrategy,
        countMode: cfg.tokenLimitOutputCountMode,
      }),
    );
  }

  const regex = buildRegexFilter(cfg);
  if (regex && cfg.regexPhase !== "input") processors.push(regex);

  if (model) {
    if (cfg.piiOutput) processors.push(buildPII(model, cfg));
    if (cfg.moderationOutput) processors.push(buildModeration(model, cfg));
    if (cfg.scrubber) {
      const structuredOptions = structuredOutputOptions(cfg);
      processors.push(
        new SystemPromptScrubber({
          model,
          strategy: cfg.scrubberStrategy,
          redactionMethod: cfg.scrubberRedactionMethod,
          placeholderText: cfg.scrubberPlaceholderText,
          includeDetections: cfg.scrubberIncludeDetections,
          lastMessageOnly: cfg.scrubberLastMessageOnly,
          ...(cfg.scrubberCustomPatterns.length
            ? { customPatterns: cfg.scrubberCustomPatterns }
            : {}),
          ...(cfg.scrubberInstructions.trim()
            ? { instructions: cfg.scrubberInstructions.trim() }
            : {}),
          ...(structuredOptions ? { structuredOutputOptions: structuredOptions } : {}),
        }),
      );
    }
  }

  return processors;
}

/** 错误处理器数组:供应商 API 拒绝时的恢复通路 */
function buildError(cfg = currentConfig()): ErrorProcessorOrWorkflow[] {
  const processors: ErrorProcessorOrWorkflow[] = [];
  if (cfg.streamErrorRetry) {
    processors.push(
      new StreamErrorRetryProcessor({
        maxRetries: cfg.streamErrorRetryMax,
        delayMs: cfg.streamErrorRetryDelayMs,
        maxRetryAfterMs: cfg.streamErrorRetryMaxRetryAfterMs,
        retryUnknownErrors: cfg.streamErrorRetryUnknown,
        matchers: [
          { match: isBadRequestError, maxRetries: 1, delayMs: 2_000 },
          {
            match: (error) => {
              if (!error) return false;
              const code = typeof error === "object" && "code" in error ? error.code : undefined;
              const message = error instanceof Error ? error.message : "";
              return (
                (typeof code === "string" && code.toUpperCase() === "ECONNRESET") ||
                /econnreset|socket hang up/i.test(message)
              );
            },
            maxRetries: cfg.streamErrorRetryMax,
            delayMs: ({ retryCount }) =>
              Math.min(1_000 * 2 ** retryCount, cfg.streamErrorRetryMaxRetryAfterMs),
          },
        ],
      }),
    );
  }
  if (cfg.prefillErrorHandler) processors.push(new PrefillErrorHandler());
  if (cfg.providerCompat) processors.push(new ProviderHistoryCompat());
  return processors;
}

/**
 * 本请求生效的输入处理器。
 * SkillSearchProcessor 依赖本线程的 Workspace 实例,只能在这里按
 * RequestContext 里的工作区路径追加(其余处理器走配置级缓存)。
 */
export async function buildGuardrailInputProcessors(
  requestContext?: RequestContext,
): Promise<InputProcessorOrWorkflow[]> {
  const resourceId = resourceIdFromContext(requestContext);
  const cfg = currentConfig(resourceId);
  const runtime = getRuntime(resourceId);
  const input = await buildInput(cfg, resourceId, requestContext);
  if (!cfg.skillSearch) return input;
  const contextPath = requestContext?.get(WORKSPACE_PATH_CONTEXT_KEY);
  const workspacePath =
    typeof contextPath === "string" && contextPath.trim() ? contextPath.trim() : process.cwd();
  let skillSearch = runtime.skillSearchCache.get(workspacePath);
  if (!skillSearch) {
    skillSearch = new SkillSearchProcessor({
      workspace: getThreadWorkspace(workspacePath, undefined, resourceId),
      search: { topK: cfg.skillSearchTopK, minScore: cfg.skillSearchMinScore },
      ttl: cfg.skillSearchTtl,
      blockingRefresh: cfg.skillSearchBlockingRefresh,
    });
    runtime.skillSearchCache.set(workspacePath, skillSearch);
  }
  return [...input, skillSearch];
}

export async function buildGuardrailOutputProcessors(
  requestContext?: RequestContext,
): Promise<OutputProcessorOrWorkflow[]> {
  const resourceId = resourceIdFromContext(requestContext);
  return buildOutput(currentConfig(resourceId), resourceId, requestContext);
}

export function buildGuardrailErrorProcessors(resourceId?: string): ErrorProcessorOrWorkflow[] {
  const runtime = getRuntime(resourceId);
  runtime.cachedError ??= buildError(currentConfig(resourceId));
  return runtime.cachedError;
}

/**
 * Resolve the currently configured input/output processors once for Mastra's
 * global registry. Agent execution still uses the original dynamic arrays;
 * this registry only makes the same instances discoverable by Studio's
 * `/processors` endpoint and records their Agent configuration below.
 */
export async function getConfiguredProcessorRegistry(): Promise<{
  processors: Record<string, Processor>;
  input: InputProcessorOrWorkflow[];
  output: OutputProcessorOrWorkflow[];
}> {
  const input = await buildGuardrailInputProcessors();
  const output = await buildGuardrailOutputProcessors();
  const error = buildGuardrailErrorProcessors();
  const processors = new Map<string, Processor>();
  for (const candidate of [...input, ...output, ...error]) {
    if (isProcessorWorkflow(candidate) || typeof candidate.id !== "string") continue;
    processors.set(candidate.id, candidate as Processor);
  }
  return { processors: Object.fromEntries(processors), input, output };
}
