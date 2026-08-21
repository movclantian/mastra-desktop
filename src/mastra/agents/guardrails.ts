/**
 * 护栏与处理器管线(docs/en/docs/agents/guardrails.mdx + processors.mdx,
 * 参数详见 docs/en/reference/processors/*.mdx)。
 * 把 @mastra/core/processors 的全部内置处理器暴露成设置面板可配置项,
 * 写入数据库 app_config 表(key = "guardrails"),保存后实时生效
 * (置空实例缓存,下次请求按新配置重建)。
 *
 * 三组管线与 Agent 的三个数组一一对应:
 * - inputProcessors:模型调用之前(规范化 / 注入检测 / 语言 / 审核 / PII /
 *   Token 上限 / 成本上限 / 工具裁剪 / 响应缓存 / 供应商历史兼容 / 运行时搜索)
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
import type { Processor } from "@mastra/core/processors";
import {
  BatchPartsProcessor,
  type ErrorProcessorOrWorkflow,
  type InputProcessorOrWorkflow,
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
import { resolveDefaultModelId, WORKBENCH_GATEWAY_ID } from "../models";
import { getAppConfig, setAppConfig } from "../storage";
import { getThreadWorkspace, isWorkspaceEnabled, WORKSPACE_PATH_CONTEXT_KEY } from "../workspace";

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
  /** 护栏检测用模型(路由字符串,不带网关前缀);空 = 跟随当前默认模型 */
  model: string;
  /**
   * 内部检测 agent 用「提示词注入 JSON」代替原生 structured output。
   * 第三方网关/兼容端点常不支持 response_format,关闭会让检测结果解析失败。
   */
  jsonPromptInjection: boolean;
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

  // --- ToolSearchProcessor(输入) ------------------------------------------
  toolSearch: boolean;
  toolSearchTopK: number;
  toolSearchMinScore: number;
  toolSearchAutoLoad: boolean;
  toolSearchStorage: ToolSearchStorage;
  toolSearchTtl: number;

  // --- SkillSearchProcessor(输入,需工作区) --------------------------------
  skillSearch: boolean;
  skillSearchTopK: number;
  skillSearchMinScore: number;
  skillSearchTtl: number;

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

/** PIIDetector 默认检测类型 */
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
 * 由用户按需开启并挑一个便宜模型 —— 与官方「Choose a fast model」建议一致。
 */
const DEFAULT_CONFIG: GuardrailsUserConfig = {
  model: "",
  jsonPromptInjection: true,
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

  toolSearch: false,
  toolSearchTopK: 5,
  toolSearchMinScore: 0,
  toolSearchAutoLoad: false,
  toolSearchStorage: "context",
  toolSearchTtl: 3_600_000,

  skillSearch: false,
  skillSearchTopK: 5,
  skillSearchMinScore: 0,
  skillSearchTtl: 3_600_000,

  prefillErrorHandler: true,
  streamErrorRetry: true,
  streamErrorRetryMax: 2,
  streamErrorRetryDelayMs: 1_000,
  streamErrorRetryMaxRetryAfterMs: 30_000,
  streamErrorRetryUnknown: false,
};

/** 读取护栏配置(app_config 表 key="guardrails";无记录或损坏时回落默认值) */
export async function getGuardrailsConfig(): Promise<GuardrailsUserConfig> {
  const raw = await getAppConfig(GUARDRAILS_CONFIG_KEY);
  if (!raw) return DEFAULT_CONFIG;
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) } as GuardrailsUserConfig;
  } catch {
    return DEFAULT_CONFIG;
  }
}

/** 写入护栏配置并实时生效:替换运行时配置 + 置空全部处理器缓存 */
export async function saveGuardrailsConfig(next: GuardrailsUserConfig): Promise<void> {
  await setAppConfig(GUARDRAILS_CONFIG_KEY, JSON.stringify(next, null, 2));
  config = { ...DEFAULT_CONFIG, ...next };
  invalidateCache();
}

// 运行时配置为模块级可变状态:顶层 await 在服务启动时读库(同 memory / workspace 模块)
let config = await getGuardrailsConfig();

/** 当前配置(chat 路由与 Agent 的 defaultOptions 读它决定 maxProcessorRetries) */
export function getGuardrailsRuntimeConfig(): GuardrailsUserConfig {
  return config;
}

// ---------------------------------------------------------------------------
// 处理器实例缓存
//
// 检测类处理器在构造函数里就建好了内部 Agent(见 moderation.d.ts 的
// private moderationAgent),ToolSearch 还会建索引 —— 每请求重建会白付初始化
// 成本,因此按配置缓存一份,saveGuardrailsConfig 置空后下次请求重建。
// SkillSearch 依赖每线程 Workspace 实例,单独按工作区路径缓存。
// ---------------------------------------------------------------------------

let cachedInput: InputProcessorOrWorkflow[] | null = null;
let cachedOutput: OutputProcessorOrWorkflow[] | null = null;
let cachedError: ErrorProcessorOrWorkflow[] | null = null;
const skillSearchCache = new Map<string, SkillSearchProcessor>();
/** 响应缓存后端:必须跨请求存活,否则每次都是 miss */
let responseCacheBackend: InMemoryServerCache | null = null;

function invalidateCache(): void {
  cachedInput = null;
  cachedOutput = null;
  cachedError = null;
  skillSearchCache.clear();
  responseCacheBackend = null;
}

/**
 * 护栏模型:统一加上 WorkbenchGateway 前缀,于是 Key 由 resolveAuth 从数据库取
 * (既不注入 process.env,也不落进请求体);未配置供应商时返回 undefined,
 * 需要 LLM 的处理器整体跳过 —— 不能让「没配模型」把整条请求打挂。
 */
async function resolveGuardrailModelId(): Promise<`${string}/${string}` | undefined> {
  const selected = config.model.trim();
  if (!selected) return resolveDefaultModelId();
  return selected.startsWith(`${WORKBENCH_GATEWAY_ID}/`)
    ? (selected as `${string}/${string}`)
    : (`${WORKBENCH_GATEWAY_ID}/${selected}` as `${string}/${string}`);
}

/** 内部检测 agent 的结构化输出形态(第三方网关不支持 response_format 时必需) */
function structuredOutputOptions() {
  return config.jsonPromptInjection ? { jsonPromptInjection: true } : undefined;
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
function buildRegexFilter(): RegexFilterProcessor | undefined {
  if (!config.regex) return undefined;
  const rules = parseRegexRules(config.regexRules);
  if (config.regexPresets.length === 0 && rules.length === 0) return undefined;
  return new RegexFilterProcessor({
    ...(config.regexPresets.length ? { presets: config.regexPresets } : {}),
    ...(rules.length ? { rules } : {}),
    strategy: config.regexStrategy,
    phase: config.regexPhase,
    includeRedactedValues: config.regexIncludeRedactedValues,
    streamCarryoverSize: config.regexStreamCarryoverSize,
  });
}

/** 审核器:输入与输出共用一个实例(无跨请求状态,内部 agent 只需建一次) */
function buildModeration(model: `${string}/${string}`): ModerationProcessor {
  return new ModerationProcessor({
    model,
    categories: config.moderationCategories,
    threshold: config.moderationThreshold,
    strategy: config.moderationStrategy,
    lastMessageOnly: config.moderationLastMessageOnly,
    includeScores: config.moderationIncludeScores,
    ...(config.moderationChunkWindow > 0 ? { chunkWindow: config.moderationChunkWindow } : {}),
    ...(config.moderationInstructions.trim()
      ? { instructions: config.moderationInstructions.trim() }
      : {}),
    ...(structuredOutputOptions() ? { structuredOutputOptions: structuredOutputOptions() } : {}),
  });
}

/** PII 检测:输入与输出共用一个实例 */
function buildPII(model: `${string}/${string}`): PIIDetector {
  return new PIIDetector({
    model,
    detectionTypes: config.piiTypes,
    threshold: config.piiThreshold,
    strategy: config.piiStrategy,
    redactionMethod: config.piiRedactionMethod,
    preserveFormat: config.piiPreserveFormat,
    lastMessageOnly: config.piiLastMessageOnly,
    includeDetections: config.piiIncludeDetections,
    ...(config.piiInstructions.trim() ? { instructions: config.piiInstructions.trim() } : {}),
    ...(structuredOutputOptions() ? { structuredOutputOptions: structuredOutputOptions() } : {}),
  });
}

/**
 * 输入处理器数组。顺序即执行顺序(processors.mdx「Execution order」):
 * 规范化 → 正则 → 注入检测 → 语言 → 审核 → PII → 成本 → Token 上限 →
 * 运行时搜索 → processLLMRequest 类(工具裁剪 / 供应商兼容 / 响应缓存)。
 */
async function buildInput(): Promise<InputProcessorOrWorkflow[]> {
  const processors: InputProcessorOrWorkflow[] = [];
  const model = await resolveGuardrailModelId();

  if (config.unicode) {
    processors.push(
      new UnicodeNormalizer({
        stripControlChars: config.unicodeStripControlChars,
        preserveEmojis: config.unicodePreserveEmojis,
        collapseWhitespace: config.unicodeCollapseWhitespace,
        trim: config.unicodeTrim,
      }),
    );
  }

  const regex = buildRegexFilter();
  if (regex && config.regexPhase !== "output") processors.push(regex);

  if (model) {
    if (config.injection) {
      processors.push(
        new PromptInjectionDetector({
          model,
          detectionTypes: config.injectionTypes,
          threshold: config.injectionThreshold,
          strategy: config.injectionStrategy,
          lastMessageOnly: config.injectionLastMessageOnly,
          includeScores: config.injectionIncludeScores,
          ...(config.injectionInstructions.trim()
            ? { instructions: config.injectionInstructions.trim() }
            : {}),
          ...(structuredOutputOptions()
            ? { structuredOutputOptions: structuredOutputOptions() }
            : {}),
        }),
      );
    }
    if (config.language && config.languageTargets.length > 0) {
      processors.push(
        new LanguageDetector({
          model,
          targetLanguages: config.languageTargets,
          threshold: config.languageThreshold,
          strategy: config.languageStrategy,
          preserveOriginal: config.languagePreserveOriginal,
          minTextLength: config.languageMinTextLength,
          lastMessageOnly: config.languageLastMessageOnly,
          includeDetectionDetails: config.languageIncludeDetails,
          ...(config.languageInstructions.trim()
            ? { instructions: config.languageInstructions.trim() }
            : {}),
        }),
      );
    }
    if (config.moderationInput) processors.push(buildModeration(model));
    if (config.piiInput) processors.push(buildPII(model));
  }

  if (config.tokenCost && config.tokenCostMax > 0) {
    // 依赖 observability 存储的 getMetricAggregate;不可用时构造即抛,
    // 捕获后跳过 —— 一个可选护栏不该让整个 Agent 起不来。
    try {
      processors.push(
        new TokenCostControl({
          maxCost: config.tokenCostMax,
          scope: config.tokenCostScope,
          window: config.tokenCostWindow,
          strategy: config.tokenCostStrategy,
          includeBreakdown: config.tokenCostIncludeBreakdown,
          ...(config.tokenCostWarnAtPercent > 0 && config.tokenCostWarnAtPercent < 100
            ? { warnAtPercent: config.tokenCostWarnAtPercent }
            : {}),
        }),
      );
    } catch {
      // 观测存储不支持成本聚合:静默跳过(设置面板的状态接口会提示不可用)
    }
  }

  // TokenLimiter 收尾:前面的处理器可能增删消息,最后一步才能保证上下文可容纳
  if (config.tokenLimitInput && config.tokenLimitInputValue > 0) {
    processors.push(
      new TokenLimiterProcessor({
        limit: config.tokenLimitInputValue,
        trimMode: config.tokenLimitTrimMode,
      }),
    );
  }

  if (config.toolSearch) {
    processors.push(
      new ToolSearchProcessor({
        // 静态清单为空:本 Agent 的工具全部按请求解析(动态 tools 函数),
        // 由 includeResolvedTools 索引它们并在加载前从提示词里扣掉
        tools: {},
        includeResolvedTools: true,
        search: {
          topK: config.toolSearchTopK,
          minScore: config.toolSearchMinScore,
          autoLoad: config.toolSearchAutoLoad,
        },
        storage: config.toolSearchStorage,
        ttl: config.toolSearchTtl,
      }),
    );
  }

  if (config.toolCallFilter) {
    processors.push(
      new ToolCallFilter({
        ...(config.toolCallFilterExclude.length ? { exclude: config.toolCallFilterExclude } : {}),
        ...(config.toolCallFilterAfterToolSteps >= 0
          ? { filterAfterToolSteps: config.toolCallFilterAfterToolSteps }
          : {}),
        preserveModelOutput: config.toolCallFilterPreserveModelOutput,
      }),
    );
  }

  if (config.providerCompat) processors.push(new ProviderHistoryCompat());

  if (config.responseCache) {
    responseCacheBackend ??= new InMemoryServerCache();
    processors.push(
      new ResponseCache({
        cache: responseCacheBackend,
        ttl: config.responseCacheTtl,
        agentId: "mastra-work-agent",
        ...(config.responseCacheScopeMode === "none"
          ? { scope: null }
          : config.responseCacheScopeMode === "custom" && config.responseCacheScopeValue.trim()
            ? { scope: config.responseCacheScopeValue.trim() }
            : {}),
      }),
    );
  }

  return processors;
}

/** 输出处理器数组:先批处理与截断,再交给按块调用 LLM 的重处理器 */
async function buildOutput(): Promise<OutputProcessorOrWorkflow[]> {
  const processors: OutputProcessorOrWorkflow[] = [];
  const model = await resolveGuardrailModelId();

  if (config.batchParts) {
    processors.push(
      new BatchPartsProcessor({
        batchSize: config.batchPartsSize,
        ...(config.batchPartsMaxWaitTime > 0 ? { maxWaitTime: config.batchPartsMaxWaitTime } : {}),
        emitOnNonText: config.batchPartsEmitOnNonText,
      }),
    );
  }

  if (config.tokenLimitOutput && config.tokenLimitOutputValue > 0) {
    processors.push(
      new TokenLimiterProcessor({
        limit: config.tokenLimitOutputValue,
        strategy: config.tokenLimitOutputStrategy,
        countMode: config.tokenLimitOutputCountMode,
      }),
    );
  }

  const regex = buildRegexFilter();
  if (regex && config.regexPhase !== "input") processors.push(regex);

  if (model) {
    if (config.piiOutput) processors.push(buildPII(model));
    if (config.moderationOutput) processors.push(buildModeration(model));
    if (config.scrubber) {
      processors.push(
        new SystemPromptScrubber({
          model,
          strategy: config.scrubberStrategy,
          redactionMethod: config.scrubberRedactionMethod,
          placeholderText: config.scrubberPlaceholderText,
          includeDetections: config.scrubberIncludeDetections,
          lastMessageOnly: config.scrubberLastMessageOnly,
          ...(config.scrubberCustomPatterns.length
            ? { customPatterns: config.scrubberCustomPatterns }
            : {}),
          ...(config.scrubberInstructions.trim()
            ? { instructions: config.scrubberInstructions.trim() }
            : {}),
          ...(structuredOutputOptions()
            ? { structuredOutputOptions: structuredOutputOptions() }
            : {}),
        }),
      );
    }
  }

  return processors;
}

/** 错误处理器数组:供应商 API 拒绝时的恢复通路 */
function buildError(): ErrorProcessorOrWorkflow[] {
  const processors: ErrorProcessorOrWorkflow[] = [];
  if (config.prefillErrorHandler) processors.push(new PrefillErrorHandler());
  if (config.streamErrorRetry) {
    processors.push(
      new StreamErrorRetryProcessor({
        maxRetries: config.streamErrorRetryMax,
        delayMs: config.streamErrorRetryDelayMs,
        maxRetryAfterMs: config.streamErrorRetryMaxRetryAfterMs,
        retryUnknownErrors: config.streamErrorRetryUnknown,
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
  cachedInput ??= await buildInput();
  if (!config.skillSearch || !isWorkspaceEnabled()) return cachedInput;
  const workspacePath = requestContext?.get(WORKSPACE_PATH_CONTEXT_KEY);
  if (typeof workspacePath !== "string" || !workspacePath) return cachedInput;
  let skillSearch = skillSearchCache.get(workspacePath);
  if (!skillSearch) {
    skillSearch = new SkillSearchProcessor({
      workspace: getThreadWorkspace(workspacePath),
      search: { topK: config.skillSearchTopK, minScore: config.skillSearchMinScore },
      ttl: config.skillSearchTtl,
    });
    skillSearchCache.set(workspacePath, skillSearch);
  }
  return [...cachedInput, skillSearch];
}

export async function buildGuardrailOutputProcessors(): Promise<OutputProcessorOrWorkflow[]> {
  cachedOutput ??= await buildOutput();
  return cachedOutput;
}

export function buildGuardrailErrorProcessors(): ErrorProcessorOrWorkflow[] {
  cachedError ??= buildError();
  return cachedError;
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
  const processors = new Map<string, Processor>();
  for (const candidate of [...input, ...output]) {
    if (isProcessorWorkflow(candidate) || typeof candidate.id !== "string") continue;
    processors.set(candidate.id, candidate as Processor);
  }
  return { processors: Object.fromEntries(processors), input, output };
}
