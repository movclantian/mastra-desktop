/**
 * 护栏与处理器管线(docs/en/docs/agents/guardrails.mdx + processors.mdx,
 * 参数详见 docs/en/reference/processors/*.mdx)。
 * 将产品支持的 @mastra/core/processors 处理器参数暴露为设置项,
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
import type { Workspace } from "@mastra/core/workspace";
import { z } from "zod";
import { resolveContextModel, resolveDefaultLanguageModel } from "../models/providers";
import { getAppConfig, setAppConfig, userIdFromContext } from "../storage/database";
import {
  getThreadWorkspace,
  invalidateWorkspaceInstances,
  onWorkspaceDestroy,
  WORKSPACE_PATH_CONTEXT_KEY,
  WORKSPACE_THREAD_ID_CONTEXT_KEY,
} from "../workspace/workspace-manager";
import { SESSION_TOOL_POLICY_CONTEXT_KEY } from "./permissions";

const GUARDRAILS_CONFIG_KEY = "guardrails";

export const guardrailsConfigSchema = z
  .object({
    // --- 通用 ---------------------------------------------------------------
    /**
     * 内部检测 agent 用「提示词注入 JSON」代替原生 structured output。
     * 第三方网关/兼容端点常不支持 response_format,关闭会让检测结果解析失败。
     */
    jsonPromptInjection: z.boolean(),
    /** JSON provider options shared by the internal detector agents. */
    detectorProviderOptions: z.string().max(100_000),
    /** 处理器重试上限(abort({retry:true}) 生效前提);0 = 不显式设置 */
    maxProcessorRetries: z.number().int().min(0).max(50),

    // --- UnicodeNormalizer(输入) --------------------------------------------
    unicode: z.boolean(),
    unicodeStripControlChars: z.boolean(),
    unicodePreserveEmojis: z.boolean(),
    unicodeCollapseWhitespace: z.boolean(),
    unicodeTrim: z.boolean(),

    // --- RegexFilterProcessor(零 LLM 成本,输入/输出) ------------------------
    regex: z.boolean(),
    regexPresets: z.array(z.enum(["pii", "secrets", "urls"])).max(3),
    regexStrategy: z.enum(["block", "redact", "warn"]),
    regexPhase: z.enum(["input", "output", "all"]),
    regexIncludeRedactedValues: z.boolean(),
    regexStreamCarryoverSize: z.number().int().min(0).max(100_000),
    /** 自定义规则 JSON 文本:[{ name, pattern, flags?, replacement? }] */
    regexRules: z.string().max(100_000),

    // --- PromptInjectionDetector(输入) --------------------------------------
    injection: z.boolean(),
    injectionTypes: z.array(z.string()).max(50),
    injectionThreshold: z.number().min(0).max(1),
    injectionStrategy: z.enum(["block", "warn", "filter", "rewrite"]),
    injectionLastMessageOnly: z.boolean(),
    injectionIncludeScores: z.boolean(),
    injectionInstructions: z.string().max(100_000),

    // --- LanguageDetector(输入) ---------------------------------------------
    language: z.boolean(),
    languageTargets: z.array(z.string()).max(50),
    languageThreshold: z.number().min(0).max(1),
    languageStrategy: z.enum(["detect", "translate", "block", "warn"]),
    languagePreserveOriginal: z.boolean(),
    languageMinTextLength: z.number().int().min(0).max(10_000),
    languageLastMessageOnly: z.boolean(),
    languageIncludeDetails: z.boolean(),
    languageInstructions: z.string().max(100_000),

    // --- ModerationProcessor(输入/输出共用一份参数) --------------------------
    moderationInput: z.boolean(),
    moderationOutput: z.boolean(),
    moderationCategories: z.array(z.string()).max(50),
    moderationThreshold: z.number().min(0).max(1),
    moderationStrategy: z.enum(["block", "warn", "filter"]),
    moderationLastMessageOnly: z.boolean(),
    moderationIncludeScores: z.boolean(),
    moderationChunkWindow: z.number().int().min(0).max(50),
    moderationInstructions: z.string().max(100_000),

    // --- PIIDetector(输入/输出共用一份参数) ---------------------------------
    piiInput: z.boolean(),
    piiOutput: z.boolean(),
    piiTypes: z.array(z.string()).max(50),
    piiThreshold: z.number().min(0).max(1),
    piiStrategy: z.enum(["block", "warn", "filter", "redact"]),
    piiRedactionMethod: z.enum(["mask", "hash", "remove", "placeholder"]),
    piiPreserveFormat: z.boolean(),
    piiLastMessageOnly: z.boolean(),
    piiIncludeDetections: z.boolean(),
    piiBufferSize: z.number().int().min(1).max(10_000),
    piiInstructions: z.string().max(100_000),

    // --- SystemPromptScrubber(输出) -----------------------------------------
    scrubber: z.boolean(),
    scrubberStrategy: z.enum(["block", "warn", "filter", "redact"]),
    scrubberRedactionMethod: z.enum(["mask", "placeholder", "remove"]),
    scrubberPlaceholderText: z.string().max(100_000),
    scrubberCustomPatterns: z.array(z.string()).max(100),
    scrubberIncludeDetections: z.boolean(),
    scrubberLastMessageOnly: z.boolean(),
    scrubberInstructions: z.string().max(100_000),

    // --- BatchPartsProcessor(输出) ------------------------------------------
    batchParts: z.boolean(),
    batchPartsSize: z.number().int().min(1).max(100),
    /** 0 = 不设超时(仅按 batchSize 触发) */
    batchPartsMaxWaitTime: z.number().int().min(0).max(120_000),
    batchPartsEmitOnNonText: z.boolean(),

    // --- TokenLimiterProcessor(输入 / 输出各一份) ---------------------------
    tokenLimitInput: z.boolean(),
    tokenLimitInputValue: z.number().int().min(1).max(2_000_000),
    tokenLimitTrimMode: z.enum(["best-fit", "contiguous"]),
    tokenLimitOutput: z.boolean(),
    tokenLimitOutputValue: z.number().int().min(1).max(500_000),
    tokenLimitOutputStrategy: z.enum(["truncate", "abort"]),
    tokenLimitOutputCountMode: z.enum(["cumulative", "part"]),

    // --- TokenCostControl(输入) ---------------------------------------------
    tokenCost: z.boolean(),
    /** 美元上限(近似值:观测指标异步落盘,快跑的 run 可能短暂越界) */
    tokenCostMax: z.number().min(0).max(1_000_000),
    tokenCostScope: z.enum(["run", "resource", "thread", "user", "organization", "session"]),
    tokenCostWindow: z.enum(["1h", "6h", "24h", "7d", "30d", "365d"]),
    tokenCostStrategy: z.enum(["block", "warn"]),
    /** 软阈值百分比(0 = 不启用软告警) */
    tokenCostWarnAtPercent: z.number().min(0).max(100),
    tokenCostIncludeBreakdown: z.boolean(),

    // --- ToolCallFilter(输入,processLLMRequest) -----------------------------
    toolCallFilter: z.boolean(),
    /** 仅裁剪这些工具;留空 = 裁剪全部工具调用 */
    toolCallFilterExclude: z.array(z.string()).max(100),
    /** 保留最近 N 个产生工具调用的步骤;-1 = 不在本轮循环内裁剪 */
    toolCallFilterAfterToolSteps: z.number().int(),
    toolCallFilterPreserveModelOutput: z.boolean(),

    // --- ResponseCache(输入,processLLMRequest/Response) ---------------------
    responseCache: z.boolean(),
    responseCacheTtl: z.number().int().min(0).max(86_400),
    /** auto = 按 resourceId 隔离;none = 全局共享;custom = 固定租户键 */
    responseCacheScopeMode: z.enum(["auto", "none", "custom"]),
    responseCacheScopeValue: z.string().max(100_000),

    // --- ProviderHistoryCompat(输入,processLLMRequest + processAPIError) ----
    providerCompat: z.boolean(),

    // --- SkillSearchProcessor(输入,需工作区) --------------------------------
    skillSearch: z.boolean(),
    skillSearchTopK: z.number().int().min(1).max(100),
    skillSearchMinScore: z.number().min(0).max(1),
    skillSearchTtl: z.number().int().min(0).max(86_400_000),
    skillSearchBlockingRefresh: z.boolean(),

    // --- ToolSearchProcessor(输入,动态工具发现) -------------------------------
    toolSearch: z.boolean(),
    toolSearchTopK: z.number().int().min(1).max(100),
    toolSearchMinScore: z.number().min(0).max(1),
    toolSearchInjectCatalog: z.boolean(),
    toolSearchAutoLoad: z.boolean(),
    toolSearchStorage: z.enum(["in-memory", "context"]),
    toolSearchTtl: z.number().int().min(0).max(86_400_000),

    // --- errorProcessors ----------------------------------------------------
    prefillErrorHandler: z.boolean(),
    streamErrorRetry: z.boolean(),
    streamErrorRetryMax: z.number().int().min(0).max(10),
    streamErrorRetryDelayMs: z.number().int().min(0).max(120_000),
    streamErrorRetryMaxRetryAfterMs: z.number().int().min(0).max(600_000),
    streamErrorRetryUnknown: z.boolean(),
  })
  .strict();

export type GuardrailsUserConfig = z.infer<typeof guardrailsConfigSchema>;

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

  regex: false,
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
  const previous = await getGuardrailsConfig(resourceId);
  const normalized = normalizeGuardrailsConfig(next);
  await setAppConfig(GUARDRAILS_CONFIG_KEY, JSON.stringify(normalized, null, 2), resourceId);
  guardrailsConfigByScope.set(scopeKey(resourceId), normalized);
  invalidateCache(resourceId);
  if (
    (
      [
        "skillSearch",
        "skillSearchTopK",
        "skillSearchMinScore",
        "skillSearchTtl",
        "skillSearchBlockingRefresh",
      ] as const
    ).some((key) => previous[key] !== normalized[key])
  ) {
    await invalidateWorkspaceInstances(resourceId);
  }
}

const guardrailsConfigByScope = new Map<string, GuardrailsUserConfig>();

function normalizeGuardrailsConfig(input: Partial<GuardrailsUserConfig>): GuardrailsUserConfig {
  return guardrailsConfigSchema.parse({ ...DEFAULT_CONFIG, ...input });
}

function scopeKey(resourceId?: string): string {
  return resourceId?.trim() || "__system__";
}

// ---------------------------------------------------------------------------
// 处理器实例缓存
//
// 输入/输出处理器按请求模型即时构建;错误处理器可安全按配置缓存。
// SkillSearch 依赖每线程 Workspace 实例,单独按工作区路径缓存。
// ---------------------------------------------------------------------------

interface GuardrailRuntime {
  cachedError: ErrorProcessorOrWorkflow[] | null;
  skillSearchCache: WeakMap<Workspace, SkillSearchProcessor>;
  responseCacheBackend: InMemoryServerCache | null;
}

const runtimeByScope = new Map<string, GuardrailRuntime>();

function getRuntime(resourceId?: string): GuardrailRuntime {
  const key = scopeKey(resourceId);
  let runtime = runtimeByScope.get(key);
  if (!runtime) {
    runtime = {
      cachedError: null,
      skillSearchCache: new WeakMap(),
      responseCacheBackend: null,
    };
    runtimeByScope.set(key, runtime);
  }
  return runtime;
}

function invalidateCache(resourceId?: string): void {
  const runtime = getRuntime(resourceId);
  runtime.cachedError = null;
  runtime.responseCacheBackend = null;
}

/** 护栏检测模型跟随当前请求模型;无请求上下文时使用当前资源默认模型。 */
async function resolveGuardrailModel(
  requestContext?: RequestContext,
  resourceId?: string,
): Promise<MastraModelConfig | undefined> {
  return requestContext
    ? resolveContextModel(requestContext)
    : resolveDefaultLanguageModel(resourceId);
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
  cfg: GuardrailsUserConfig,
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
  cfg: GuardrailsUserConfig,
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

/**
 * Settings own the complete error stack (errorProcessorDefaults: false).
 * Repair the request before a broad retry matcher can resend it unchanged.
 * Both error/output arrays are explicit; CyberRefusalHandler is not enabled.
 */
function buildError(cfg: GuardrailsUserConfig): ErrorProcessorOrWorkflow[] {
  const processors: ErrorProcessorOrWorkflow[] = [];
  if (cfg.providerCompat) processors.push(new ProviderHistoryCompat());
  if (cfg.prefillErrorHandler) processors.push(new PrefillErrorHandler());
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
  const resourceId = userIdFromContext(requestContext);
  const cfg = await getGuardrailsConfig(resourceId);
  const runtime = getRuntime(resourceId);
  const input = await buildInput(cfg, resourceId, requestContext);
  if (!cfg.skillSearch) return input;
  const contextPath = requestContext?.get(WORKSPACE_PATH_CONTEXT_KEY);
  const workspacePath =
    typeof contextPath === "string" && contextPath.trim() ? contextPath.trim() : process.cwd();
  const threadId = requestContext?.get(WORKSPACE_THREAD_ID_CONTEXT_KEY);
  const workspace = await getThreadWorkspace(
    workspacePath,
    typeof threadId === "string" ? threadId : undefined,
    resourceId,
  );
  let skillSearch = runtime.skillSearchCache.get(workspace);
  if (!skillSearch) {
    skillSearch = new SkillSearchProcessor({
      workspace,
      search: { topK: cfg.skillSearchTopK, minScore: cfg.skillSearchMinScore },
      ttl: cfg.skillSearchTtl,
      blockingRefresh: cfg.skillSearchBlockingRefresh,
    });
    runtime.skillSearchCache.set(workspace, skillSearch);
    const processor = skillSearch;
    onWorkspaceDestroy(workspace, () => processor.dispose());
  }
  return [...input, skillSearch];
}

export async function buildGuardrailOutputProcessors(
  requestContext?: RequestContext,
): Promise<OutputProcessorOrWorkflow[]> {
  const resourceId = userIdFromContext(requestContext);
  return buildOutput(await getGuardrailsConfig(resourceId), resourceId, requestContext);
}

export async function buildGuardrailErrorProcessors(
  resourceId?: string,
): Promise<ErrorProcessorOrWorkflow[]> {
  const config = await getGuardrailsConfig(resourceId);
  const runtime = getRuntime(resourceId);
  runtime.cachedError ??= buildError(config);
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
  const error = await buildGuardrailErrorProcessors();
  const processors = new Map<string, Processor>();
  for (const candidate of [...input, ...output, ...error]) {
    if (isProcessorWorkflow(candidate) || typeof candidate.id !== "string") continue;
    processors.set(candidate.id, candidate as Processor);
  }
  return { processors: Object.fromEntries(processors), input, output };
}
