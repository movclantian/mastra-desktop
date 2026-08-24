import * as React from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { useWorkbench } from "@/features/workbench";
import { fetchGuardrailsConfig, fetchGuardrailsStatus, saveGuardrailsConfig } from "../api";
import {
  FOLLOW_CURRENT_MODEL,
  ModelSelectDropdown,
  NumberRow,
  SelectRow,
  SettingCard,
  SettingRow,
  SliderRow,
  SwitchRow,
  TagMultiSelect,
  TextAreaRow,
} from "../components/controls";

// ---------------------------------------------------------------------------
// 护栏与处理器(暴露 @mastra/core/processors 全部内置处理器的可配置项,
// 写入数据库 app_config 表 key = "guardrails",保存后实时生效)。
// 字段与 src/mastra/agents/guardrails.ts 的 GuardrailsUserConfig 一一对应;
// 参数语义对照 docs/en/docs/agents/{guardrails,processors}.mdx
// 与 docs/en/reference/processors/*.mdx。
//
// 刻意不含 MessageHistory / SemanticRecall / WorkingMemory 三个处理器 ——
// 它们由 Memory 类自动加入管线,参数在「记忆」页配置。
// ---------------------------------------------------------------------------

/** 纯文本/逐行列表字段:保存时静默,不弹撤回 toast(其余开关/滑块/下拉才弹) */
const GUARDRAILS_TEXT_KEYS = new Set<string>([
  "regexRules",
  "injectionInstructions",
  "languageTargets",
  "languageInstructions",
  "moderationInstructions",
  "piiInstructions",
  "scrubberPlaceholderText",
  "scrubberCustomPatterns",
  "scrubberInstructions",
  "toolCallFilterExclude",
  "responseCacheScopeValue",
]);

export interface GuardrailsDraft {
  model: string;
  jsonPromptInjection: boolean;
  maxProcessorRetries: number;

  unicode: boolean;
  unicodeStripControlChars: boolean;
  unicodePreserveEmojis: boolean;
  unicodeCollapseWhitespace: boolean;
  unicodeTrim: boolean;

  regex: boolean;
  regexPresets: string[];
  regexStrategy: "block" | "redact" | "warn";
  regexPhase: "input" | "output" | "all";
  regexIncludeRedactedValues: boolean;
  regexStreamCarryoverSize: number;
  regexRules: string;

  injection: boolean;
  injectionTypes: string[];
  injectionThreshold: number;
  injectionStrategy: "block" | "warn" | "filter" | "rewrite";
  injectionLastMessageOnly: boolean;
  injectionIncludeScores: boolean;
  injectionInstructions: string;

  language: boolean;
  languageTargets: string[];
  languageThreshold: number;
  languageStrategy: "detect" | "translate" | "block" | "warn";
  languagePreserveOriginal: boolean;
  languageMinTextLength: number;
  languageLastMessageOnly: boolean;
  languageIncludeDetails: boolean;
  languageInstructions: string;

  moderationInput: boolean;
  moderationOutput: boolean;
  moderationCategories: string[];
  moderationThreshold: number;
  moderationStrategy: "block" | "warn" | "filter";
  moderationLastMessageOnly: boolean;
  moderationIncludeScores: boolean;
  moderationChunkWindow: number;
  moderationInstructions: string;

  piiInput: boolean;
  piiOutput: boolean;
  piiTypes: string[];
  piiThreshold: number;
  piiStrategy: "block" | "warn" | "filter" | "redact";
  piiRedactionMethod: "mask" | "hash" | "remove" | "placeholder";
  piiPreserveFormat: boolean;
  piiLastMessageOnly: boolean;
  piiIncludeDetections: boolean;
  piiInstructions: string;

  scrubber: boolean;
  scrubberStrategy: "block" | "warn" | "filter" | "redact";
  scrubberRedactionMethod: "mask" | "placeholder" | "remove";
  scrubberPlaceholderText: string;
  scrubberCustomPatterns: string[];
  scrubberIncludeDetections: boolean;
  scrubberLastMessageOnly: boolean;
  scrubberInstructions: string;

  batchParts: boolean;
  batchPartsSize: number;
  batchPartsMaxWaitTime: number;
  batchPartsEmitOnNonText: boolean;

  tokenLimitInput: boolean;
  tokenLimitInputValue: number;
  tokenLimitTrimMode: "best-fit" | "contiguous";
  tokenLimitOutput: boolean;
  tokenLimitOutputValue: number;
  tokenLimitOutputStrategy: "truncate" | "abort";
  tokenLimitOutputCountMode: "cumulative" | "part";

  tokenCost: boolean;
  tokenCostMax: number;
  tokenCostScope: "run" | "resource" | "thread" | "user" | "organization" | "session";
  tokenCostWindow: "1h" | "6h" | "24h" | "7d" | "30d" | "365d";
  tokenCostStrategy: "block" | "warn";
  tokenCostWarnAtPercent: number;
  tokenCostIncludeBreakdown: boolean;

  toolCallFilter: boolean;
  toolCallFilterExclude: string[];
  toolCallFilterAfterToolSteps: number;
  toolCallFilterPreserveModelOutput: boolean;

  responseCache: boolean;
  responseCacheTtl: number;
  responseCacheScopeMode: "auto" | "none" | "custom";
  responseCacheScopeValue: string;

  providerCompat: boolean;

  toolSearch: boolean;
  toolSearchTopK: number;
  toolSearchMinScore: number;
  toolSearchAutoLoad: boolean;
  toolSearchStorage: "in-memory" | "context";
  toolSearchTtl: number;

  skillSearch: boolean;
  skillSearchTopK: number;
  skillSearchMinScore: number;
  skillSearchTtl: number;

  prefillErrorHandler: boolean;
  streamErrorRetry: boolean;
  streamErrorRetryMax: number;
  streamErrorRetryDelayMs: number;
  streamErrorRetryMaxRetryAfterMs: number;
  streamErrorRetryUnknown: boolean;
}

/** 与服务端 DEFAULT_CONFIG 保持一致(model 用下拉哨兵值表示"跟随") */
export const DEFAULT_GUARDRAILS_DRAFT: GuardrailsDraft = {
  model: FOLLOW_CURRENT_MODEL,
  jsonPromptInjection: true,
  maxProcessorRetries: 0,

  unicode: true,
  unicodeStripControlChars: true,
  unicodePreserveEmojis: true,
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
  injectionTypes: [
    "injection",
    "jailbreak",
    "tool-exfiltration",
    "data-exfiltration",
    "system-override",
    "role-manipulation",
  ],
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
  moderationCategories: [
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
  ],
  moderationThreshold: 0.5,
  moderationStrategy: "block",
  moderationLastMessageOnly: true,
  moderationIncludeScores: false,
  moderationChunkWindow: 0,
  moderationInstructions: "",

  piiInput: false,
  piiOutput: false,
  piiTypes: [
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
  ],
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

// --- 枚举选项(值为库接受的字面量,标签为中文说明) -------------------------

const REGEX_PRESET_OPTIONS = [
  { value: "secrets", label: "secrets(密钥/令牌)" },
  { value: "pii", label: "pii(邮箱/电话/卡号)" },
  { value: "urls", label: "urls(HTTP 链接)" },
];

const INJECTION_TYPE_OPTIONS = [
  { value: "injection", label: "指令注入" },
  { value: "jailbreak", label: "越狱" },
  { value: "tool-exfiltration", label: "工具外泄" },
  { value: "data-exfiltration", label: "数据外泄" },
  { value: "system-override", label: "系统覆写" },
  { value: "role-manipulation", label: "角色操纵" },
];

const MODERATION_CATEGORY_OPTIONS = [
  { value: "hate", label: "仇恨" },
  { value: "hate/threatening", label: "仇恨威胁" },
  { value: "harassment", label: "骚扰" },
  { value: "harassment/threatening", label: "骚扰威胁" },
  { value: "self-harm", label: "自我伤害" },
  { value: "self-harm/intent", label: "自伤意图" },
  { value: "self-harm/instructions", label: "自伤教程" },
  { value: "sexual", label: "色情" },
  { value: "sexual/minors", label: "未成年色情" },
  { value: "violence", label: "暴力" },
  { value: "violence/graphic", label: "血腥暴力" },
];

const PII_TYPE_OPTIONS = [
  { value: "email", label: "邮箱" },
  { value: "phone", label: "电话" },
  { value: "credit-card", label: "银行卡号" },
  { value: "ssn", label: "社保号" },
  { value: "api-key", label: "API 密钥" },
  { value: "ip-address", label: "IP 地址" },
  { value: "name", label: "姓名" },
  { value: "address", label: "地址" },
  { value: "date-of-birth", label: "出生日期" },
  { value: "url", label: "URL" },
  { value: "uuid", label: "UUID" },
  { value: "crypto-wallet", label: "加密钱包" },
  { value: "iban", label: "IBAN" },
];

/** 逐行文本 → 去空白去空行的字符串数组 */
function linesToList(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/** 逐行编辑的三个列表字段:文本形态存本地,数组形态存草稿(边打字边保留空行) */
type ListFieldKey = "languageTargets" | "scrubberCustomPatterns" | "toolCallFilterExclude";

type ListText = Record<ListFieldKey, string>;

function listTextFromDraft(draft: GuardrailsDraft): ListText {
  return {
    languageTargets: draft.languageTargets.join("\n"),
    scrubberCustomPatterns: draft.scrubberCustomPatterns.join("\n"),
    toolCallFilterExclude: draft.toolCallFilterExclude.join("\n"),
  };
}

/** 前置条件状态徽章:说明"这个护栏此刻为什么不会生效" */
function ReadyBadge({
  ready,
  readyText,
  blockedText,
}: {
  ready: boolean;
  readyText: string;
  blockedText: string;
}) {
  return ready ? (
    <Badge className="text-[10px]" variant="secondary">
      {readyText}
    </Badge>
  ) : (
    <Badge className="text-[10px] text-muted-foreground" variant="outline">
      {blockedText}
    </Badge>
  );
}

interface GuardrailsStatus {
  modelReady: boolean;
  costMetricsReady: boolean;
  workspaceReady: boolean;
}

export function GuardrailsSection() {
  const { providers } = useWorkbench();
  const [draft, setDraft] = React.useState<GuardrailsDraft>(DEFAULT_GUARDRAILS_DRAFT);
  const [listText, setListText] = React.useState<ListText>(() =>
    listTextFromDraft(DEFAULT_GUARDRAILS_DRAFT),
  );
  const [loaded, setLoaded] = React.useState(false);
  const [status, setStatus] = React.useState<GuardrailsStatus>({
    modelReady: true,
    costMetricsReady: true,
    workspaceReady: true,
  });

  const refreshStatus = React.useCallback(() => {
    fetchGuardrailsStatus<GuardrailsStatus>()
      .then((next) => setStatus(next))
      .catch(() => undefined);
  }, []);

  React.useEffect(() => {
    if (loaded) return;
    fetchGuardrailsConfig<Partial<GuardrailsDraft>>()
      .then((config) => {
        const merged = { ...DEFAULT_GUARDRAILS_DRAFT, ...config } as GuardrailsDraft;
        // 空模型串(跟随当前模型)映射为下拉的哨兵值
        merged.model = merged.model || FOLLOW_CURRENT_MODEL;
        setDraft(merged);
        setListText(listTextFromDraft(merged));
      })
      .catch(() => undefined)
      .finally(() => setLoaded(true));
    refreshStatus();
  }, [loaded, refreshStatus]);

  // 上次已保存的草稿快照:识别非文本字段变化并供撤回
  const prevSavedRef = React.useRef<GuardrailsDraft | null>(null);

  // 自动保存:800ms 防抖写入;非文本字段变化成功后弹 toast 供撤回,
  // 文本/逐行列表编辑静默。保存后重探前置条件(护栏模型可能刚被改掉)。
  React.useEffect(() => {
    if (!loaded) return;
    const timer = window.setTimeout(() => {
      void saveGuardrailsConfig({
        ...draft,
        model: draft.model === FOLLOW_CURRENT_MODEL ? "" : draft.model,
      })
        .then(() => {
          refreshStatus();
          const before = prevSavedRef.current;
          prevSavedRef.current = draft;
          const changed =
            before !== null &&
            (Object.keys(before) as Array<keyof GuardrailsDraft>).some(
              (key) => !GUARDRAILS_TEXT_KEYS.has(key) && !Object.is(before[key], draft[key]),
            );
          if (before !== null && changed) {
            toast.success("护栏配置已更新", {
              action: {
                label: "撤回",
                onClick: () => {
                  // 预置快照:随后的自动保存视为无变化,不再弹 toast
                  prevSavedRef.current = before;
                  setDraft(before);
                  setListText(listTextFromDraft(before));
                },
              },
            });
          }
        })
        .catch(() => toast.error("护栏配置自动保存失败,请确认 Mastra 服务已启动"));
    }, 800);
    return () => window.clearTimeout(timer);
  }, [draft, loaded, refreshStatus]);

  const patch = (next: Partial<GuardrailsDraft>) => setDraft({ ...draft, ...next });

  /** 逐行列表:文本原样留在输入框,数组同步进草稿 */
  const patchList = (key: ListFieldKey, text: string) => {
    setListText((prev) => ({ ...prev, [key]: text }));
    patch({ [key]: linesToList(text) } as Partial<GuardrailsDraft>);
  };

  // 自定义正则规则实时校验:非 JSON 数组时服务端会整体忽略,这里给即时提示
  const regexRulesValid = React.useMemo(() => {
    const text = draft.regexRules.trim();
    if (!text) return true;
    try {
      return Array.isArray(JSON.parse(text));
    } catch {
      return false;
    }
  }, [draft.regexRules]);

  const llmBadge = (
    <ReadyBadge blockedText="需先选定模型" ready={status.modelReady} readyText="需调用模型" />
  );

  return (
    <>
      <SettingCard
        action={llmBadge}
        description="模型调用前后加一层内置处理器管线:输入侧规范化与检测,输出侧过滤与清洗,报错时恢复(guardrails.mdx / processors.mdx)。历史消息、语义召回、工作记忆三个处理器由记忆模块自动接入,在「记忆」页配置。"
        title="通用"
      >
        <div className="space-y-2 py-2">
          <div className="space-y-1">
            <p className="text-sm leading-none font-medium">护栏检测模型</p>
            <p className="text-xs text-muted-foreground">
              注入/语言/审核/PII/清洗五个检测器共用;每轮都要额外调用,建议单独选一个便宜快速的小模型
            </p>
          </div>
          <ModelSelectDropdown
            allowFollow
            onChange={(model) => patch({ model })}
            providers={providers}
            value={draft.model}
          />
        </div>
        <SwitchRow
          checked={draft.jsonPromptInjection}
          description="检测器用提示词注入 JSON 代替原生 response_format;第三方网关多不支持结构化输出,关闭会导致检测结果解析失败"
          onChange={(v) => patch({ jsonPromptInjection: v })}
          title="兼容模式结构化输出(jsonPromptInjection)"
        />
        <NumberRow
          description="处理器 abort({ retry: true }) 后的最大重试次数;0 = 不显式设置,用库默认"
          max={5}
          onChange={(v) => patch({ maxProcessorRetries: v })}
          suffix="次"
          title="处理器重试上限(maxProcessorRetries)"
          value={draft.maxProcessorRetries}
        />
      </SettingCard>

      <SettingCard
        description="输入侧第一道:统一 Unicode 形态、剔除不可见控制字符,消除同形字与零宽字符绕过后续检测的手法(unicode-normalizer.mdx)。零 LLM 成本。"
        title="文本规范化(UnicodeNormalizer)"
      >
        <SwitchRow
          checked={draft.unicode}
          description="所有输入消息统一 NFC 规范化"
          onChange={(v) => patch({ unicode: v })}
          title="启用文本规范化"
        />
        {draft.unicode ? (
          <>
            <SwitchRow
              checked={draft.unicodeStripControlChars}
              description="剔除零宽字符与不可见控制符(常用于绕过关键词检测)"
              onChange={(v) => patch({ unicodeStripControlChars: v })}
              title="剔除控制字符(stripControlChars)"
            />
            <SwitchRow
              checked={draft.unicodePreserveEmojis}
              description="关闭则连同表情符号一并剔除"
              onChange={(v) => patch({ unicodePreserveEmojis: v })}
              title="保留表情符号(preserveEmojis)"
            />
            <SwitchRow
              checked={draft.unicodeCollapseWhitespace}
              description="库默认开启;此处默认关闭 —— 折叠空白会破坏粘贴进来的代码与 Markdown 缩进"
              onChange={(v) => patch({ unicodeCollapseWhitespace: v })}
              title="折叠连续空白(collapseWhitespace)"
            />
            <SwitchRow
              checked={draft.unicodeTrim}
              description="去掉消息首尾空白"
              onChange={(v) => patch({ unicodeTrim: v })}
              title="首尾去空白(trim)"
            />
          </>
        ) : null}
      </SettingCard>

      <SettingCard
        description="纯正则匹配,不调用模型:内置密钥/PII/URL 预设,可加自定义规则;流式输出按 carryover 窗口保证跨块的匹配被整段处理(regex-filter-processor.mdx)。"
        title="正则过滤(RegexFilterProcessor)"
      >
        <SwitchRow
          checked={draft.regex}
          description="零成本的第一道过滤,推荐常开"
          onChange={(v) => patch({ regex: v })}
          title="启用正则过滤"
        />
        {draft.regex ? (
          <>
            <TagMultiSelect
              description="内置规则集;与下方自定义规则叠加,全部留空则该处理器不加入管线"
              onChange={(regexPresets) => patch({ regexPresets })}
              options={REGEX_PRESET_OPTIONS}
              title="内置预设(presets)"
              value={draft.regexPresets}
            />
            <SelectRow
              description="block 直接中断本轮;redact 替换为占位符;warn 仅记录不改写"
              onChange={(regexStrategy) => patch({ regexStrategy })}
              options={[
                { value: "redact" as const, label: "redact(替换)" },
                { value: "block" as const, label: "block(中断)" },
                { value: "warn" as const, label: "warn(仅告警)" },
              ]}
              title="命中策略(strategy)"
              value={draft.regexStrategy}
            />
            <SelectRow
              description="all 时同一实例同时进入输入与输出两条管线"
              onChange={(regexPhase) => patch({ regexPhase })}
              options={[
                { value: "all" as const, label: "all(输入+输出)" },
                { value: "input" as const, label: "input(仅输入)" },
                { value: "output" as const, label: "output(仅输出)" },
              ]}
              title="作用阶段(phase)"
              value={draft.regexPhase}
            />
            {draft.regexStrategy === "redact" ? (
              <SwitchRow
                checked={draft.regexIncludeRedactedValues}
                description="默认关闭:被替换的正是要清除的数据,记录下来等于留了第二份副本"
                onChange={(v) => patch({ regexIncludeRedactedValues: v })}
                title="审计记录保留原文(includeRedactedValues)"
              />
            ) : null}
            <NumberRow
              description="流式替换时回退保留的字符数,需不小于自定义规则可能匹配到的最长片段"
              max={4096}
              min={16}
              onChange={(v) => patch({ regexStreamCarryoverSize: v })}
              step={16}
              suffix="字符"
              title="流式回退窗口(streamCarryoverSize)"
              value={draft.regexStreamCarryoverSize}
            />
            <TextAreaRow
              description={
                '格式:[{ "name": "internal-id", "pattern": "INTERNAL-\\\\d{6}", "flags": "i", "replacement": "[INTERNAL_ID]" }];缺少 g 标志会自动补上,单条语法非法只跳过该条'
              }
              invalid={!regexRulesValid}
              invalidHint="不是合法的 JSON 数组,服务端将忽略全部自定义规则"
              onChange={(regexRules) => patch({ regexRules })}
              placeholder="[]"
              rows={5}
              title="自定义规则(rules)"
              value={draft.regexRules}
            />
          </>
        ) : null}
      </SettingCard>

      <SettingCard
        action={llmBadge}
        description="用检测模型识别指令注入、越狱与外泄企图,拦在真正的模型调用之前(prompt-injection-detector.mdx)。"
        title="提示词注入检测(PromptInjectionDetector)"
      >
        <SwitchRow
          checked={draft.injection}
          description="每轮额外一次模型调用,按需开启"
          onChange={(v) => patch({ injection: v })}
          title="启用注入检测"
        />
        {draft.injection ? (
          <>
            <TagMultiSelect
              description="要检测的攻击类型"
              onChange={(injectionTypes) => patch({ injectionTypes })}
              options={INJECTION_TYPE_OPTIONS}
              title="检测类型(detectionTypes)"
              value={draft.injectionTypes}
            />
            <SliderRow
              description="置信度阈值,越高越不敏感、误报越少(库默认 0.7)"
              max={1}
              min={0}
              onChange={(v) => patch({ injectionThreshold: Math.round(v * 100) / 100 })}
              step={0.05}
              title="判定阈值(threshold)"
              value={draft.injectionThreshold}
            />
            <SelectRow
              description="block 中断;filter 丢掉命中的消息;rewrite 让模型改写为无害表述;warn 仅记录"
              onChange={(injectionStrategy) => patch({ injectionStrategy })}
              options={[
                { value: "block" as const, label: "block(中断)" },
                { value: "filter" as const, label: "filter(丢弃消息)" },
                { value: "rewrite" as const, label: "rewrite(改写)" },
                { value: "warn" as const, label: "warn(仅告警)" },
              ]}
              title="命中策略(strategy)"
              value={draft.injectionStrategy}
            />
            <SwitchRow
              checked={draft.injectionLastMessageOnly}
              description="只检测本轮新消息,不重复检测已通过的历史(省 token)"
              onChange={(v) => patch({ injectionLastMessageOnly: v })}
              title="仅检测最新消息(lastMessageOnly)"
            />
            <SwitchRow
              checked={draft.injectionIncludeScores}
              description="在告警详情里附上每个类型的置信度"
              onChange={(v) => patch({ injectionIncludeScores: v })}
              title="附带分数(includeScores)"
            />
            <TextAreaRow
              description="追加给检测代理的判定说明,留空使用库内置提示词"
              onChange={(injectionInstructions) => patch({ injectionInstructions })}
              placeholder="例如:本产品允许用户粘贴他人提示词作为素材讨论,不视为注入。"
              rows={3}
              title="附加指令(instructions)"
              value={draft.injectionInstructions}
            />
          </>
        ) : null}
      </SettingCard>

      <SettingCard
        action={llmBadge}
        description="识别输入语言,可仅标记、翻译成目标语言,或直接拦截非目标语言(language-detector.mdx)。"
        title="语言检测(LanguageDetector)"
      >
        <SwitchRow
          checked={draft.language}
          description="每轮额外一次模型调用"
          onChange={(v) => patch({ language: v })}
          title="启用语言检测"
        />
        {draft.language ? (
          <>
            <TextAreaRow
              description="一行一个,可用英文名或 ISO 代码(如 Chinese / zh);留空则该处理器不加入管线"
              onChange={(text) => patchList("languageTargets", text)}
              placeholder={"Chinese\nzh"}
              rows={3}
              title="目标语言(targetLanguages)"
              value={listText.languageTargets}
            />
            <SliderRow
              description="语言判定置信度阈值(库默认 0.7)"
              max={1}
              min={0}
              onChange={(v) => patch({ languageThreshold: Math.round(v * 100) / 100 })}
              step={0.05}
              title="判定阈值(threshold)"
              value={draft.languageThreshold}
            />
            <SelectRow
              description="detect 仅标记;translate 自动译为目标语言;block 拦截;warn 仅记录"
              onChange={(languageStrategy) => patch({ languageStrategy })}
              options={[
                { value: "detect" as const, label: "detect(仅标记)" },
                { value: "translate" as const, label: "translate(翻译)" },
                { value: "block" as const, label: "block(拦截)" },
                { value: "warn" as const, label: "warn(仅告警)" },
              ]}
              title="处理策略(strategy)"
              value={draft.languageStrategy}
            />
            {draft.languageStrategy === "translate" ? (
              <SwitchRow
                checked={draft.languagePreserveOriginal}
                description="翻译后在元数据中保留用户原文"
                onChange={(v) => patch({ languagePreserveOriginal: v })}
                title="保留原文(preserveOriginal)"
              />
            ) : null}
            <NumberRow
              description="短于该长度的文本不做检测(几个字判语言不可靠)"
              max={500}
              onChange={(v) => patch({ languageMinTextLength: v })}
              suffix="字符"
              title="最小检测长度(minTextLength)"
              value={draft.languageMinTextLength}
            />
            <SwitchRow
              checked={draft.languageLastMessageOnly}
              description="只检测本轮新消息"
              onChange={(v) => patch({ languageLastMessageOnly: v })}
              title="仅检测最新消息(lastMessageOnly)"
            />
            <SwitchRow
              checked={draft.languageIncludeDetails}
              description="在结果里附上语言与置信度明细"
              onChange={(v) => patch({ languageIncludeDetails: v })}
              title="附带检测明细(includeDetectionDetails)"
            />
            <TextAreaRow
              description="追加给检测代理的说明,留空使用库内置提示词"
              onChange={(languageInstructions) => patch({ languageInstructions })}
              placeholder="例如:代码块与技术术语不参与语言判定。"
              rows={3}
              title="附加指令(instructions)"
              value={draft.languageInstructions}
            />
          </>
        ) : null}
      </SettingCard>

      <SettingCard
        action={llmBadge}
        description="按类别为内容打分并按策略处置,输入与输出共用同一套参数(moderation-processor.mdx)。"
        title="内容审核(ModerationProcessor)"
      >
        <SwitchRow
          checked={draft.moderationInput}
          description="模型调用前审核用户消息"
          onChange={(v) => patch({ moderationInput: v })}
          title="审核输入"
        />
        <SwitchRow
          checked={draft.moderationOutput}
          description="模型响应后审核助手消息"
          onChange={(v) => patch({ moderationOutput: v })}
          title="审核输出"
        />
        {draft.moderationInput || draft.moderationOutput ? (
          <>
            <TagMultiSelect
              description="与 OpenAI moderation 同名类别"
              onChange={(moderationCategories) => patch({ moderationCategories })}
              options={MODERATION_CATEGORY_OPTIONS}
              title="审核类别(categories)"
              value={draft.moderationCategories}
            />
            <SliderRow
              description="任一类别得分超过该值即判定命中(库默认 0.5)"
              max={1}
              min={0}
              onChange={(v) => patch({ moderationThreshold: Math.round(v * 100) / 100 })}
              step={0.05}
              title="判定阈值(threshold)"
              value={draft.moderationThreshold}
            />
            <SelectRow
              description="block 中断;filter 丢掉命中的消息;warn 仅记录"
              onChange={(moderationStrategy) => patch({ moderationStrategy })}
              options={[
                { value: "block" as const, label: "block(中断)" },
                { value: "filter" as const, label: "filter(丢弃消息)" },
                { value: "warn" as const, label: "warn(仅告警)" },
              ]}
              title="命中策略(strategy)"
              value={draft.moderationStrategy}
            />
            <SwitchRow
              checked={draft.moderationLastMessageOnly}
              description="只审核本轮新消息"
              onChange={(v) => patch({ moderationLastMessageOnly: v })}
              title="仅审核最新消息(lastMessageOnly)"
            />
            <SwitchRow
              checked={draft.moderationIncludeScores}
              description="在告警详情里附上各类别得分"
              onChange={(v) => patch({ moderationIncludeScores: v })}
              title="附带分数(includeScores)"
            />
            <NumberRow
              description="输出流按该字符数分块送审,0 = 不分块(等整段响应结束再审)"
              max={20_000}
              onChange={(v) => patch({ moderationChunkWindow: v })}
              step={100}
              suffix="字符"
              title="流式审核窗口(chunkWindow)"
              value={draft.moderationChunkWindow}
            />
            <TextAreaRow
              description="追加给审核代理的尺度说明,留空使用库内置提示词"
              onChange={(moderationInstructions) => patch({ moderationInstructions })}
              placeholder="例如:安全研究场景下讨论攻击原理不算违规。"
              rows={3}
              title="附加指令(instructions)"
              value={draft.moderationInstructions}
            />
          </>
        ) : null}
      </SettingCard>

      <SettingCard
        action={llmBadge}
        description="识别并按需脱敏个人身份信息,输入与输出共用同一套参数(pii-detector.mdx)。"
        title="PII 检测(PIIDetector)"
      >
        <SwitchRow
          checked={draft.piiInput}
          description="模型调用前处理用户消息中的 PII"
          onChange={(v) => patch({ piiInput: v })}
          title="检测输入"
        />
        <SwitchRow
          checked={draft.piiOutput}
          description="模型响应后处理助手消息中的 PII"
          onChange={(v) => patch({ piiOutput: v })}
          title="检测输出"
        />
        {draft.piiInput || draft.piiOutput ? (
          <>
            <TagMultiSelect
              description="要识别的信息类型"
              onChange={(piiTypes) => patch({ piiTypes })}
              options={PII_TYPE_OPTIONS}
              title="检测类型(detectionTypes)"
              value={draft.piiTypes}
            />
            <SliderRow
              description="置信度阈值(库默认 0.6)"
              max={1}
              min={0}
              onChange={(v) => patch({ piiThreshold: Math.round(v * 100) / 100 })}
              step={0.05}
              title="判定阈值(threshold)"
              value={draft.piiThreshold}
            />
            <SelectRow
              description="redact 就地脱敏后放行,是最常用的一档"
              onChange={(piiStrategy) => patch({ piiStrategy })}
              options={[
                { value: "redact" as const, label: "redact(脱敏)" },
                { value: "block" as const, label: "block(中断)" },
                { value: "filter" as const, label: "filter(丢弃消息)" },
                { value: "warn" as const, label: "warn(仅告警)" },
              ]}
              title="命中策略(strategy)"
              value={draft.piiStrategy}
            />
            {draft.piiStrategy === "redact" ? (
              <>
                <SelectRow
                  description="mask 掩码;hash 哈希;placeholder 占位标签;remove 整段删除"
                  onChange={(piiRedactionMethod) => patch({ piiRedactionMethod })}
                  options={[
                    { value: "mask" as const, label: "mask(掩码)" },
                    { value: "hash" as const, label: "hash(哈希)" },
                    { value: "placeholder" as const, label: "placeholder(占位)" },
                    { value: "remove" as const, label: "remove(删除)" },
                  ]}
                  title="脱敏方式(redactionMethod)"
                  value={draft.piiRedactionMethod}
                />
                <SwitchRow
                  checked={draft.piiPreserveFormat}
                  description="保留原值的格式骨架(如 ***-**-1234),便于模型理解上下文"
                  onChange={(v) => patch({ piiPreserveFormat: v })}
                  title="保留格式(preserveFormat)"
                />
              </>
            ) : null}
            <SwitchRow
              checked={draft.piiLastMessageOnly}
              description="只检测本轮新消息"
              onChange={(v) => patch({ piiLastMessageOnly: v })}
              title="仅检测最新消息(lastMessageOnly)"
            />
            <SwitchRow
              checked={draft.piiIncludeDetections}
              description="默认关闭:明细里含被脱敏的原值,开启前确认日志与原文同级受保护"
              onChange={(v) => patch({ piiIncludeDetections: v })}
              title="附带检测明细(includeDetections)"
            />
            <TextAreaRow
              description="追加给检测代理的说明,留空使用库内置提示词"
              onChange={(piiInstructions) => patch({ piiInstructions })}
              placeholder="例如:公司公开邮箱 support@example.com 不视为个人信息。"
              rows={3}
              title="附加指令(instructions)"
              value={draft.piiInstructions}
            />
          </>
        ) : null}
      </SettingCard>

      <SettingCard
        action={llmBadge}
        description="输出侧:识别助手回复里泄漏的系统提示词片段并按策略处置(system-prompt-scrubber.mdx)。"
        title="系统提示词清洗(SystemPromptScrubber)"
      >
        <SwitchRow
          checked={draft.scrubber}
          description="防止模型把自身指令原样吐给用户"
          onChange={(v) => patch({ scrubber: v })}
          title="启用提示词清洗"
        />
        {draft.scrubber ? (
          <>
            <SelectRow
              description="redact 替换泄漏片段;filter 丢掉整条消息;block 中断;warn 仅记录"
              onChange={(scrubberStrategy) => patch({ scrubberStrategy })}
              options={[
                { value: "redact" as const, label: "redact(替换)" },
                { value: "filter" as const, label: "filter(丢弃消息)" },
                { value: "block" as const, label: "block(中断)" },
                { value: "warn" as const, label: "warn(仅告警)" },
              ]}
              title="命中策略(strategy)"
              value={draft.scrubberStrategy}
            />
            {draft.scrubberStrategy === "redact" ? (
              <>
                <SelectRow
                  description="mask 掩码;placeholder 用下方占位文本替换;remove 整段删除"
                  onChange={(scrubberRedactionMethod) => patch({ scrubberRedactionMethod })}
                  options={[
                    { value: "mask" as const, label: "mask(掩码)" },
                    { value: "placeholder" as const, label: "placeholder(占位)" },
                    { value: "remove" as const, label: "remove(删除)" },
                  ]}
                  title="替换方式(redactionMethod)"
                  value={draft.scrubberRedactionMethod}
                />
                <SettingRow
                  description="placeholder 方式下用于替换的文本"
                  title="占位文本(placeholderText)"
                >
                  <Input
                    className="w-52 font-mono text-xs"
                    onChange={(e) => patch({ scrubberPlaceholderText: e.target.value })}
                    spellCheck={false}
                    value={draft.scrubberPlaceholderText}
                  />
                </SettingRow>
              </>
            ) : null}
            <TextAreaRow
              description="一行一条正则字符串,补充库内置的识别模式"
              onChange={(text) => patchList("scrubberCustomPatterns", text)}
              placeholder={"You are MastraWork[\\s\\S]{0,80}"}
              rows={3}
              title="自定义识别模式(customPatterns)"
              value={listText.scrubberCustomPatterns}
            />
            <SwitchRow
              checked={draft.scrubberIncludeDetections}
              description="默认关闭:明细里含被清洗的提示词原文"
              onChange={(v) => patch({ scrubberIncludeDetections: v })}
              title="附带检测明细(includeDetections)"
            />
            <SwitchRow
              checked={draft.scrubberLastMessageOnly}
              description="只清洗本轮新生成的消息"
              onChange={(v) => patch({ scrubberLastMessageOnly: v })}
              title="仅处理最新消息(lastMessageOnly)"
            />
            <TextAreaRow
              description="追加给检测代理的说明,留空使用库内置提示词"
              onChange={(scrubberInstructions) => patch({ scrubberInstructions })}
              placeholder="例如:用户主动询问工具用法时,复述工具名称不算泄漏。"
              rows={3}
              title="附加指令(instructions)"
              value={draft.scrubberInstructions}
            />
          </>
        ) : null}
      </SettingCard>

      <SettingCard
        description="输出侧:把细碎的流式分片合并后再下发,降低前端渲染频率(batch-parts-processor.mdx)。"
        title="流式批处理(BatchPartsProcessor)"
      >
        <SwitchRow
          checked={draft.batchParts}
          description="默认关闭:合并会让打字机效果变顿挫,弱终端或长响应场景才需要"
          onChange={(v) => patch({ batchParts: v })}
          title="启用流式批处理"
        />
        {draft.batchParts ? (
          <>
            <NumberRow
              description="累计多少个分片后合并下发"
              max={100}
              min={2}
              onChange={(v) => patch({ batchPartsSize: v })}
              suffix="片"
              title="批大小(batchSize)"
              value={draft.batchPartsSize}
            />
            <NumberRow
              description="未攒够批大小时的最长等待;0 = 不设超时,只按批大小触发"
              max={5_000}
              onChange={(v) => patch({ batchPartsMaxWaitTime: v })}
              step={50}
              suffix="毫秒"
              title="最长等待(maxWaitTime)"
              value={draft.batchPartsMaxWaitTime}
            />
            <SwitchRow
              checked={draft.batchPartsEmitOnNonText}
              description="遇到工具调用等非文本分片时立即冲刷缓冲,保证时序正确"
              onChange={(v) => patch({ batchPartsEmitOnNonText: v })}
              title="非文本分片立即下发(emitOnNonText)"
            />
          </>
        ) : null}
      </SettingCard>

      <SettingCard
        description="按 token 数裁剪上下文与响应。输入侧排在管线末尾,前面的处理器增删完消息后再保证上下文装得下(token-limiter-processor.mdx)。"
        title="Token 上限(TokenLimiterProcessor)"
      >
        <SwitchRow
          checked={draft.tokenLimitInput}
          description="超出上限时按裁剪模式丢弃较早的消息"
          onChange={(v) => patch({ tokenLimitInput: v })}
          title="限制输入上下文"
        />
        {draft.tokenLimitInput ? (
          <>
            <NumberRow
              description="送入模型的消息总 token 上限"
              max={2_000_000}
              min={1_000}
              onChange={(v) => patch({ tokenLimitInputValue: v })}
              step={1_000}
              suffix="token"
              title="上下文上限(limit)"
              value={draft.tokenLimitInputValue}
            />
            <SelectRow
              description="contiguous 保留连续的最近消息;best-fit 跨空档挑选以尽量填满预算"
              onChange={(tokenLimitTrimMode) => patch({ tokenLimitTrimMode })}
              options={[
                { value: "contiguous" as const, label: "contiguous(保留连续)" },
                { value: "best-fit" as const, label: "best-fit(尽量填满)" },
              ]}
              title="裁剪模式(trimMode)"
              value={draft.tokenLimitTrimMode}
            />
          </>
        ) : null}
        <SwitchRow
          checked={draft.tokenLimitOutput}
          description="响应超过上限时截断或中断"
          onChange={(v) => patch({ tokenLimitOutput: v })}
          title="限制输出长度"
        />
        {draft.tokenLimitOutput ? (
          <>
            <NumberRow
              description="单次响应允许的 token 数"
              max={200_000}
              min={100}
              onChange={(v) => patch({ tokenLimitOutputValue: v })}
              step={100}
              suffix="token"
              title="输出上限(limit)"
              value={draft.tokenLimitOutputValue}
            />
            <SelectRow
              description="truncate 截断后正常收尾;abort 直接中断本轮"
              onChange={(tokenLimitOutputStrategy) => patch({ tokenLimitOutputStrategy })}
              options={[
                { value: "truncate" as const, label: "truncate(截断)" },
                { value: "abort" as const, label: "abort(中断)" },
              ]}
              title="超限策略(strategy)"
              value={draft.tokenLimitOutputStrategy}
            />
            <SelectRow
              description="cumulative 按整轮累计计数;part 按单个分片计数"
              onChange={(tokenLimitOutputCountMode) => patch({ tokenLimitOutputCountMode })}
              options={[
                { value: "cumulative" as const, label: "cumulative(累计)" },
                { value: "part" as const, label: "part(按分片)" },
              ]}
              title="计数方式(countMode)"
              value={draft.tokenLimitOutputCountMode}
            />
          </>
        ) : null}
      </SettingCard>

      <SettingCard
        action={
          <ReadyBadge
            blockedText="观测存储不支持"
            ready={status.costMetricsReady}
            readyText="可用"
          />
        }
        description="按时间窗统计已花费的模型费用,超出预算时告警或拦截。金额为近似值:观测指标异步落盘,跑得快的一轮可能短暂越界(token-cost-control.mdx)。"
        title="成本上限(TokenCostControl)"
      >
        <SwitchRow
          checked={draft.tokenCost}
          description="依赖观测存储的费用聚合能力"
          disabled={!status.costMetricsReady}
          onChange={(v) => patch({ tokenCost: v })}
          title="启用成本上限"
        />
        {draft.tokenCost ? (
          <>
            <NumberRow
              description="统计窗口内允许的最大花费"
              max={10_000}
              min={0.1}
              onChange={(v) => patch({ tokenCostMax: v })}
              step={0.5}
              suffix="美元"
              title="费用上限(maxCost)"
              value={draft.tokenCostMax}
            />
            <SelectRow
              description="按哪一维聚合费用:resource = 每个用户,thread = 每条会话"
              onChange={(tokenCostScope) => patch({ tokenCostScope })}
              options={[
                { value: "resource" as const, label: "resource(每用户)" },
                { value: "thread" as const, label: "thread(每会话)" },
                { value: "run" as const, label: "run(每轮)" },
                { value: "user" as const, label: "user(登录用户)" },
                { value: "session" as const, label: "session(会话期)" },
                { value: "organization" as const, label: "organization(组织)" },
              ]}
              title="统计维度(scope)"
              value={draft.tokenCostScope}
            />
            <SelectRow
              description="回溯多长时间累计费用"
              onChange={(tokenCostWindow) => patch({ tokenCostWindow })}
              options={[
                { value: "1h" as const, label: "最近 1 小时" },
                { value: "6h" as const, label: "最近 6 小时" },
                { value: "24h" as const, label: "最近 24 小时" },
                { value: "7d" as const, label: "最近 7 天" },
                { value: "30d" as const, label: "最近 30 天" },
                { value: "365d" as const, label: "最近 365 天" },
              ]}
              title="统计窗口(window)"
              value={draft.tokenCostWindow}
            />
            <SelectRow
              description="block 超额直接拒绝新请求;warn 仅提示"
              onChange={(tokenCostStrategy) => patch({ tokenCostStrategy })}
              options={[
                { value: "warn" as const, label: "warn(仅告警)" },
                { value: "block" as const, label: "block(拦截)" },
              ]}
              title="超额策略(strategy)"
              value={draft.tokenCostStrategy}
            />
            <SliderRow
              description="达到上限的该百分比时提前告警;0 = 不启用软阈值"
              max={95}
              min={0}
              onChange={(v) => patch({ tokenCostWarnAtPercent: v })}
              step={5}
              title="软阈值(warnAtPercent %)"
              value={draft.tokenCostWarnAtPercent}
            />
            <SwitchRow
              checked={draft.tokenCostIncludeBreakdown}
              description="告警中附上按模型/维度拆分的花费明细"
              onChange={(v) => patch({ tokenCostIncludeBreakdown: v })}
              title="附带费用明细(includeBreakdown)"
            />
          </>
        ) : null}
      </SettingCard>

      <SettingCard
        description="把历史里的工具调用与结果从送给模型的上下文中摘掉,长任务里能省下大量 token(tool-call-filter.mdx)。"
        title="工具调用裁剪(ToolCallFilter)"
      >
        <SwitchRow
          checked={draft.toolCallFilter}
          description="只影响送进模型的历史,前端展示不受影响"
          onChange={(v) => patch({ toolCallFilter: v })}
          title="启用工具调用裁剪"
        />
        {draft.toolCallFilter ? (
          <>
            <TextAreaRow
              description="一行一个工具名,只裁剪列出的工具;留空 = 裁剪全部工具调用"
              onChange={(text) => patchList("toolCallFilterExclude", text)}
              placeholder={"library_vector_search\nweb_search"}
              rows={3}
              title="仅裁剪这些工具(exclude)"
              value={listText.toolCallFilterExclude}
            />
            <NumberRow
              description="保留最近 N 个产生工具调用的步骤;-1 = 本轮循环内不裁剪,只裁剪更早的历史"
              max={20}
              min={-1}
              onChange={(v) => patch({ toolCallFilterAfterToolSteps: v })}
              suffix="步"
              title="保留最近步骤数(filterAfterToolSteps)"
              value={draft.toolCallFilterAfterToolSteps}
            />
            <SwitchRow
              checked={draft.toolCallFilterPreserveModelOutput}
              description="裁掉工具调用时保留模型当时的文字说明,免得上下文出现断层"
              onChange={(v) => patch({ toolCallFilterPreserveModelOutput: v })}
              title="保留模型文字(preserveModelOutput)"
            />
          </>
        ) : null}
      </SettingCard>

      <SettingCard
        description="相同请求在有效期内直接返回上次结果,不再调用模型(response-cache.mdx)。缓存在内存中,重启即清空。"
        title="响应缓存(ResponseCache)"
      >
        <SwitchRow
          checked={draft.responseCache}
          description="默认关闭:对话类场景重复命中率低,且会掩盖模型的随机性"
          onChange={(v) => patch({ responseCache: v })}
          title="启用响应缓存"
        />
        {draft.responseCache ? (
          <>
            <NumberRow
              description="缓存条目的存活时间"
              max={86_400}
              min={10}
              onChange={(v) => patch({ responseCacheTtl: v })}
              step={10}
              suffix="秒"
              title="有效期(ttl)"
              value={draft.responseCacheTtl}
            />
            <SelectRow
              description="auto 按用户隔离;none 全局共享(注意串用户);custom 使用固定租户键"
              onChange={(responseCacheScopeMode) => patch({ responseCacheScopeMode })}
              options={[
                { value: "auto" as const, label: "auto(按用户隔离)" },
                { value: "none" as const, label: "none(全局共享)" },
                { value: "custom" as const, label: "custom(固定键)" },
              ]}
              title="隔离范围(scope)"
              value={draft.responseCacheScopeMode}
            />
            {draft.responseCacheScopeMode === "custom" ? (
              <SettingRow description="所有请求共用的缓存键前缀" title="自定义范围键">
                <Input
                  className="w-52 font-mono text-xs"
                  onChange={(e) => patch({ responseCacheScopeValue: e.target.value })}
                  placeholder="tenant-a"
                  spellCheck={false}
                  value={draft.responseCacheScopeValue}
                />
              </SettingRow>
            ) : null}
          </>
        ) : null}
      </SettingCard>

      <SettingCard
        description="切换供应商后,把历史里上一家的推理块、工具调用等私有字段整理成新供应商能接受的形态,并在其报错时二次修正(provider-history-compat.mdx)。"
        title="供应商历史兼容(ProviderHistoryCompat)"
      >
        <SwitchRow
          checked={draft.providerCompat}
          description="本产品允许随时换模型换供应商,建议常开"
          onChange={(v) => patch({ providerCompat: v })}
          title="启用历史兼容"
        />
      </SettingCard>

      <SettingCard
        description="工具多到撑爆提示词时,先按语义检索出相关工具再交给模型,其余工具不进提示词(tool-search-processor.mdx)。"
        title="工具检索(ToolSearchProcessor)"
      >
        <SwitchRow
          checked={draft.toolSearch}
          description="本产品当前工具数量有限,默认关闭;接入大量 MCP 工具后再开"
          onChange={(v) => patch({ toolSearch: v })}
          title="启用工具检索"
        />
        {draft.toolSearch ? (
          <>
            <NumberRow
              description="每轮检索出多少个候选工具"
              max={30}
              min={1}
              onChange={(v) => patch({ toolSearchTopK: v })}
              suffix="个"
              title="候选数(topK)"
              value={draft.toolSearchTopK}
            />
            <SliderRow
              description="低于该相关度的工具不返回;0 = 不设下限"
              max={1}
              min={0}
              onChange={(v) => patch({ toolSearchMinScore: Math.round(v * 100) / 100 })}
              step={0.05}
              title="最低相关度(minScore)"
              value={draft.toolSearchMinScore}
            />
            <SwitchRow
              checked={draft.toolSearchAutoLoad}
              description="检索到即直接装载,省一次模型往返;开启时 topK 要压小"
              onChange={(v) => patch({ toolSearchAutoLoad: v })}
              title="自动装载(autoLoad)"
            />
            <SelectRow
              description="context 从会话消息推导已装载工具,重启不丢;in-memory 存进程内存"
              onChange={(toolSearchStorage) => patch({ toolSearchStorage })}
              options={[
                { value: "context" as const, label: "context(随会话)" },
                { value: "in-memory" as const, label: "in-memory(进程内存)" },
              ]}
              title="装载状态存储(storage)"
              value={draft.toolSearchStorage}
            />
            {draft.toolSearchStorage === "in-memory" ? (
              <NumberRow
                description="线程闲置多久后清掉它的已装载工具集合(仅 in-memory 生效)"
                max={1_440}
                min={1}
                onChange={(v) => patch({ toolSearchTtl: v * 60_000 })}
                suffix="分钟"
                title="闲置清理(ttl)"
                value={Math.round(draft.toolSearchTtl / 60_000)}
              />
            ) : null}
          </>
        ) : null}
      </SettingCard>

      <SettingCard
        action={
          <ReadyBadge blockedText="需启用工作区" ready={status.workspaceReady} readyText="可用" />
        }
        description="按语义检索工作区里的 SKILL.md,只把相关技能的指令注入提示词(skill-search-processor.mdx)。需要线程已绑定工作区。"
        title="技能检索(SkillSearchProcessor)"
      >
        <SwitchRow
          checked={draft.skillSearch}
          description="未绑定工作区的线程自动跳过该处理器"
          disabled={!status.workspaceReady}
          onChange={(v) => patch({ skillSearch: v })}
          title="启用技能检索"
        />
        {draft.skillSearch ? (
          <>
            <NumberRow
              description="每轮检索出多少个候选技能"
              max={20}
              min={1}
              onChange={(v) => patch({ skillSearchTopK: v })}
              suffix="个"
              title="候选数(topK)"
              value={draft.skillSearchTopK}
            />
            <SliderRow
              description="低于该相关度的技能不返回;0 = 不设下限"
              max={1}
              min={0}
              onChange={(v) => patch({ skillSearchMinScore: Math.round(v * 100) / 100 })}
              step={0.05}
              title="最低相关度(minScore)"
              value={draft.skillSearchMinScore}
            />
            <NumberRow
              description="线程闲置多久后清掉它的已装载技能集合"
              max={1_440}
              min={1}
              onChange={(v) => patch({ skillSearchTtl: v * 60_000 })}
              suffix="分钟"
              title="闲置清理(ttl)"
              value={Math.round(draft.skillSearchTtl / 60_000)}
            />
          </>
        ) : null}
      </SettingCard>

      <SettingCard
        description="供应商 API 报错时的恢复通路,失败请求不必直接抛给用户(prefill-error-handler.mdx / stream-error-retry-processor.mdx)。"
        title="错误恢复(errorProcessors)"
      >
        <SwitchRow
          checked={draft.prefillErrorHandler}
          description="部分供应商拒绝以助手消息结尾的请求,该处理器识别这类报错并自动修正后重发"
          onChange={(v) => patch({ prefillErrorHandler: v })}
          title="预填充错误修正(PrefillErrorHandler)"
        />
        <SwitchRow
          checked={draft.streamErrorRetry}
          description="限流与瞬时网络错误自动重试,尊重响应里的 Retry-After"
          onChange={(v) => patch({ streamErrorRetry: v })}
          title="流式错误重试(StreamErrorRetryProcessor)"
        />
        {draft.streamErrorRetry ? (
          <>
            <NumberRow
              description="同一轮请求最多重试几次"
              max={5}
              min={1}
              onChange={(v) => patch({ streamErrorRetryMax: v })}
              suffix="次"
              title="重试次数(maxRetries)"
              value={draft.streamErrorRetryMax}
            />
            <NumberRow
              description="首次重试前的等待时间,后续按指数退避"
              max={30_000}
              min={100}
              onChange={(v) => patch({ streamErrorRetryDelayMs: v })}
              step={100}
              suffix="毫秒"
              title="重试间隔(delayMs)"
              value={draft.streamErrorRetryDelayMs}
            />
            <NumberRow
              description="供应商要求的等待时间超过该值就放弃,不让用户干等"
              max={300_000}
              min={1_000}
              onChange={(v) => patch({ streamErrorRetryMaxRetryAfterMs: v })}
              step={1_000}
              suffix="毫秒"
              title="可接受的最长等待(maxRetryAfterMs)"
              value={draft.streamErrorRetryMaxRetryAfterMs}
            />
            <SwitchRow
              checked={draft.streamErrorRetryUnknown}
              description="默认关闭:未知错误多半重试也不会好,反而拖长失败反馈"
              onChange={(v) => patch({ streamErrorRetryUnknown: v })}
              title="重试未知错误(retryUnknownErrors)"
            />
          </>
        ) : null}
      </SettingCard>
    </>
  );
}
