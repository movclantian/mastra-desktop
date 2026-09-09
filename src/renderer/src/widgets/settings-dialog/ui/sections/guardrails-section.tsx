import * as React from "react";
import { toast } from "sonner";
import { Badge } from "@/shared/ui/badge";
import {
  fetchGuardrailsConfig,
  fetchGuardrailsStatus,
  saveGuardrailsConfig,
} from "../../api/settings-api";
import {
  NumberRow,
  SelectRow,
  SettingCard,
  SettingRow,
  SliderRow,
  SwitchRow,
  TagMultiSelect,
  TextAreaRow,
} from "../controls";

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

/** 与服务端 DEFAULT_CONFIG 保持一致;检测模型自动跟随当前请求模型。 */
export const DEFAULT_GUARDRAILS_DRAFT: GuardrailsDraft = {
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
        <SettingRow
          description="注入、语言、审核、PII 与清洗检测器自动使用当前 promptInput 选择或请求的模型"
          title="护栏检测模型"
        >
          <span className="shrink-0 text-sm font-medium text-muted-foreground">跟随当前模型</span>
        </SettingRow>
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
        <p className="px-1 pb-2 text-xs text-muted-foreground">
          控制字符清理、表情保留和首尾空白处理由系统安全基线管理。
        </p>
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
            ) : null}
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
            ) : null}
            <TextAreaRow
              description="一行一条正则字符串,补充库内置的识别模式"
              onChange={(text) => patchList("scrubberCustomPatterns", text)}
              placeholder={"You are MastraWork[\\s\\S]{0,80}"}
              rows={3}
              title="自定义识别模式(customPatterns)"
              value={listText.scrubberCustomPatterns}
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
          </>
        ) : null}
      </SettingCard>

      <SettingCard
        description="在切换模型或供应商时整理历史消息中的私有字段,保证上下文仍能被当前供应商接受。默认开启,必要时可关闭。"
        title="供应商历史兼容"
      >
        <SwitchRow
          checked={draft.providerCompat}
          description="仅影响跨供应商发送历史消息时的兼容处理"
          onChange={(v) => patch({ providerCompat: v })}
          title="启用历史兼容"
        />
      </SettingCard>

      <SettingCard
        description="供应商 API 报错时自动修正预填充请求,并对限流和瞬时网络错误进行恢复。默认开启,必要时可关闭。"
        title="错误恢复"
      >
        <SwitchRow
          checked={draft.prefillErrorHandler}
          description="修正部分供应商拒绝以助手消息结尾的请求"
          onChange={(v) => patch({ prefillErrorHandler: v })}
          title="预填充错误修正"
        />
        <SwitchRow
          checked={draft.streamErrorRetry}
          description="对限流与瞬时网络错误自动重试并遵守 Retry-After"
          onChange={(v) => patch({ streamErrorRetry: v })}
          title="流式错误重试"
        />
        <p className="px-1 pb-2 text-xs text-muted-foreground">
          重试次数、退避间隔和未知错误判定由系统稳定性基线管理。
        </p>
      </SettingCard>
    </>
  );
}
