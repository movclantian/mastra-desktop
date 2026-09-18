import * as React from "react";
import { toast } from "sonner";
import { useTranslation } from "@/shared/i18n";
import { Badge } from "@/shared/ui/badge";
import {
  fetchGuardrailsConfig,
  fetchGuardrailsStatus,
  saveGuardrailsConfig,
} from "../../api/settings-api";
import {
  AdvancedSection,
  KeyValueEditor,
  NumberRow,
  SelectRow,
  SettingCard,
  SettingRow,
  SliderRow,
  SwitchRow,
  TagMultiSelect,
  TextAreaRow,
} from "../controls";

/** 纯文本/逐行列表字段:保存时静默,不弹撤回 toast(其余开关/滑块/下拉才弹) */
const GUARDRAILS_TEXT_KEYS = new Set<string>([
  "regexRules",
  "detectorProviderOptions",
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
  detectorProviderOptions: string;
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
  piiBufferSize: number;
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
  skillSearchBlockingRefresh: boolean;

  toolSearch: boolean;
  toolSearchTopK: number;
  toolSearchMinScore: number;
  toolSearchInjectCatalog: boolean;
  toolSearchAutoLoad: boolean;
  toolSearchStorage: "in-memory" | "context";
  toolSearchTtl: number;

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
  detectorProviderOptions: "{}",
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
  streamErrorRetryDelayMs: 3_000,
  streamErrorRetryMaxRetryAfterMs: 30_000,
  streamErrorRetryUnknown: true,
};

// --- 枚举选项(值为库接受的字面量,标签为中文说明) -------------------------

const getRegexPresetOptions = (t: (k: string) => string) => [
  { value: "secrets", label: t("settings:guardrails.options.secrets") },
  { value: "pii", label: t("settings:guardrails.options.pii") },
  { value: "urls", label: t("settings:guardrails.options.urls") },
];

const getInjectionTypeOptions = (t: (k: string) => string) => [
  { value: "injection", label: t("settings:guardrails.options.injection") },
  { value: "jailbreak", label: t("settings:guardrails.options.jailbreak") },
  { value: "tool-exfiltration", label: t("settings:guardrails.options.toolExfiltration") },
  { value: "data-exfiltration", label: t("settings:guardrails.options.dataExfiltration") },
  { value: "system-override", label: t("settings:guardrails.options.systemOverride") },
  { value: "role-manipulation", label: t("settings:guardrails.options.roleManipulation") },
];

const getModerationCategoryOptions = (t: (k: string) => string) => [
  { value: "hate", label: t("settings:guardrails.options.hate") },
  { value: "hate/threatening", label: t("settings:guardrails.options.hateThreatening") },
  { value: "harassment", label: t("settings:guardrails.options.harassment") },
  {
    value: "harassment/threatening",
    label: t("settings:guardrails.options.harassmentThreatening"),
  },
  { value: "self-harm", label: t("settings:guardrails.options.selfHarm") },
  { value: "self-harm/intent", label: t("settings:guardrails.options.selfHarmIntent") },
  { value: "self-harm/instructions", label: t("settings:guardrails.options.selfHarmInstructions") },
  { value: "sexual", label: t("settings:guardrails.options.sexual") },
  { value: "sexual/minors", label: t("settings:guardrails.options.sexualMinors") },
  { value: "violence", label: t("settings:guardrails.options.violence") },
  { value: "violence/graphic", label: t("settings:guardrails.options.violenceGraphic") },
];

const getPiiTypeOptions = (t: (k: string) => string) => [
  { value: "email", label: t("settings:guardrails.options.email") },
  { value: "phone", label: t("settings:guardrails.options.phone") },
  { value: "credit-card", label: t("settings:guardrails.options.creditCard") },
  { value: "ssn", label: t("settings:guardrails.options.ssn") },
  { value: "api-key", label: t("settings:guardrails.options.apiKey") },
  { value: "ip-address", label: t("settings:guardrails.options.ipAddress") },
  { value: "name", label: t("settings:guardrails.options.name") },
  { value: "address", label: t("settings:guardrails.options.address") },
  { value: "date-of-birth", label: t("settings:guardrails.options.dateOfBirth") },
  { value: "url", label: t("settings:guardrails.options.webAddress") },
  { value: "uuid", label: t("settings:guardrails.options.uniqueIdentifier") },
  { value: "crypto-wallet", label: t("settings:guardrails.options.cryptoWallet") },
  { value: "iban", label: t("settings:guardrails.options.bankAccount") },
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

function providerOptionsFromText(text: string): Record<string, string> {
  try {
    const value = JSON.parse(text) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        typeof entry === "string" ? entry : JSON.stringify(entry),
      ]),
    );
  } catch {
    return {};
  }
}

function updateProviderOptions(currentText: string, next: Record<string, string>): string {
  let current: Record<string, unknown> = {};
  try {
    current = JSON.parse(currentText) as Record<string, unknown>;
  } catch {}
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(next).map(([key, value]) => [
        key,
        key in current &&
        (typeof current[key] === "string" ? current[key] : JSON.stringify(current[key])) === value
          ? current[key]
          : value,
      ]),
    ),
  );
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
  const { t } = useTranslation();
  const regexPresetOptions = React.useMemo(() => getRegexPresetOptions(t), [t]);
  const injectionTypeOptions = React.useMemo(() => getInjectionTypeOptions(t), [t]);
  const moderationCategoryOptions = React.useMemo(() => getModerationCategoryOptions(t), [t]);
  const piiTypeOptions = React.useMemo(() => getPiiTypeOptions(t), [t]);
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
            toast.success(t("settings:guardrails.configUpdated"), {
              action: {
                label: t("settings:guardrails.undo"),
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
        .catch(() => toast.error(t("settings:guardrails.autoSaveFailed")));
    }, 800);
    return () => window.clearTimeout(timer);
  }, [draft, loaded, refreshStatus]);

  const patch = (next: Partial<GuardrailsDraft>) => setDraft({ ...draft, ...next });
  const restore = (...keys: Array<keyof GuardrailsDraft>) => {
    const restored = {
      ...draft,
      ...Object.fromEntries(keys.map((key) => [key, DEFAULT_GUARDRAILS_DRAFT[key]])),
    } as GuardrailsDraft;
    setDraft(restored);
    setListText(listTextFromDraft(restored));
  };
  const resetLabel = t("common:restoreDefaults");
  const blockConfirmation = {
    when: (value: string) => value === "block",
    title: t("settings:guardrails.confirmBlockingTitle"),
    description: t("settings:guardrails.confirmBlockingDesc"),
    cancelLabel: t("common:cancel"),
    confirmLabel: t("settings:guardrails.confirmBlockingAction"),
  };

  /** 逐行列表:文本原样留在输入框,数组同步进草稿 */
  const patchList = (key: ListFieldKey, text: string) => {
    setListText((prev) => ({ ...prev, [key]: text }));
    patch({ [key]: linesToList(text) } as Partial<GuardrailsDraft>);
  };

  const llmBadge = (
    <ReadyBadge
      blockedText={t("settings:guardrails.blockedModel")}
      ready={status.modelReady}
      readyText={t("settings:guardrails.readyModel")}
    />
  );

  return (
    <>
      <SettingCard
        action={llmBadge}
        description={t("settings:guardrails.generalDesc")}
        onReset={() =>
          restore("jsonPromptInjection", "detectorProviderOptions", "maxProcessorRetries")
        }
        resetLabel={resetLabel}
        title={t("settings:guardrails.generalTitle")}
      >
        <SwitchRow
          checked={draft.jsonPromptInjection}
          description={t("settings:guardrails.compatJsonDesc")}
          onChange={(v) => patch({ jsonPromptInjection: v })}
          title={t("settings:guardrails.compatJsonTitle")}
        />
        <NumberRow
          description={t("settings:guardrails.maxRetriesDesc")}
          max={50}
          min={0}
          onChange={(v) => patch({ maxProcessorRetries: v })}
          title={t("settings:guardrails.maxRetriesTitle")}
          value={draft.maxProcessorRetries}
        />
        <SettingRow
          description={t("settings:guardrails.detectorModelDesc")}
          title={t("settings:guardrails.detectorModelTitle")}
        >
          <span className="shrink-0 text-sm font-medium text-muted-foreground">
            {t("settings:guardrails.followCurrentModel")}
          </span>
        </SettingRow>
        <AdvancedSection
          title={t("settings:guardrails.advancedTitle")}
          description={t("settings:guardrails.providerOptionsDesc")}
        >
          <KeyValueEditor
            title={t("settings:guardrails.providerOptionsTitle")}
            description={t("settings:guardrails.providerOptionsEditorDesc")}
            value={providerOptionsFromText(draft.detectorProviderOptions)}
            keyLabel={t("settings:guardrails.optionName")}
            valueLabel={t("settings:guardrails.optionValue")}
            addLabel={t("settings:guardrails.addOption")}
            removeLabel={t("settings:guardrails.removeOption")}
            duplicateLabel={t("settings:guardrails.duplicateOption")}
            onChange={(value) =>
              patch({
                detectorProviderOptions: updateProviderOptions(
                  draft.detectorProviderOptions,
                  value,
                ),
              })
            }
          />
        </AdvancedSection>
      </SettingCard>

      <SettingCard
        description={t("settings:guardrails.unicodeDesc")}
        onReset={() =>
          restore(
            "unicode",
            "unicodeStripControlChars",
            "unicodePreserveEmojis",
            "unicodeCollapseWhitespace",
            "unicodeTrim",
          )
        }
        resetLabel={resetLabel}
        title={t("settings:guardrails.unicodeTitle")}
      >
        <SwitchRow
          checked={draft.unicode}
          description={t("settings:guardrails.enableUnicodeDesc")}
          onChange={(v) => patch({ unicode: v })}
          title={t("settings:guardrails.enableUnicodeTitle")}
        />
        <p className="px-1 pb-2 text-xs text-muted-foreground">
          {t("settings:guardrails.unicodeDesc")}
        </p>
        <SwitchRow
          checked={draft.unicodeStripControlChars}
          onChange={(v) => patch({ unicodeStripControlChars: v })}
          title={t("settings:guardrails.stripControlCharsTitle")}
        />
        <SwitchRow
          checked={draft.unicodePreserveEmojis}
          onChange={(v) => patch({ unicodePreserveEmojis: v })}
          title={t("settings:guardrails.preserveEmojisTitle")}
        />
        <SwitchRow
          checked={draft.unicodeCollapseWhitespace}
          onChange={(v) => patch({ unicodeCollapseWhitespace: v })}
          title={t("settings:guardrails.collapseWhitespaceTitle")}
        />
        <SwitchRow
          checked={draft.unicodeTrim}
          onChange={(v) => patch({ unicodeTrim: v })}
          title={t("settings:guardrails.trimTitle")}
        />
      </SettingCard>

      <SettingCard
        description={t("settings:guardrails.regexDesc")}
        onReset={() =>
          restore(
            "regex",
            "regexPresets",
            "regexStrategy",
            "regexPhase",
            "regexIncludeRedactedValues",
            "regexStreamCarryoverSize",
            "regexRules",
          )
        }
        resetLabel={resetLabel}
        title={t("settings:guardrails.regexTitle")}
      >
        <SwitchRow
          checked={draft.regex}
          description={t("settings:guardrails.enableRegexDesc")}
          onChange={(v) => patch({ regex: v })}
          title={t("settings:guardrails.enableRegexTitle")}
        />
        {draft.regex ? (
          <AdvancedSection title={t("settings:guardrails.advancedTitle")}>
            <TagMultiSelect
              description={t("settings:guardrails.regexPresetsDesc")}
              onChange={(regexPresets) => patch({ regexPresets })}
              options={regexPresetOptions}
              title={t("settings:guardrails.regexPresetsTitle")}
              value={draft.regexPresets}
            />
            <SelectRow
              confirm={blockConfirmation}
              description={t("settings:guardrails.regexStrategyDesc")}
              onChange={(regexStrategy) => patch({ regexStrategy })}
              options={[
                { value: "redact" as const, label: t("settings:guardrails.options.redactReplace") },
                { value: "block" as const, label: t("settings:guardrails.options.blockInterrupt") },
                { value: "warn" as const, label: t("settings:guardrails.options.warnOnly") },
              ]}
              title={t("settings:guardrails.injectionStrategyTitle")}
              value={draft.regexStrategy}
            />
            <SelectRow
              description={t("settings:guardrails.regexPhaseDesc")}
              onChange={(regexPhase) => patch({ regexPhase })}
              options={[
                { value: "all" as const, label: t("settings:guardrails.options.allInputOutput") },
                { value: "input" as const, label: t("settings:guardrails.options.inputOnly") },
                { value: "output" as const, label: t("settings:guardrails.options.outputOnly") },
              ]}
              title={t("settings:guardrails.regexPhaseTitle")}
              value={draft.regexPhase}
            />
            <SwitchRow
              checked={draft.regexIncludeRedactedValues}
              onChange={(v) => patch({ regexIncludeRedactedValues: v })}
              title={t("settings:guardrails.includeRedactedTitle")}
            />
            <NumberRow
              description={t("settings:guardrails.streamCarryoverDesc")}
              max={10_000}
              min={0}
              onChange={(v) => patch({ regexStreamCarryoverSize: v })}
              title={t("settings:guardrails.streamCarryoverTitle")}
              value={draft.regexStreamCarryoverSize}
            />
          </AdvancedSection>
        ) : null}
      </SettingCard>

      <SettingCard
        action={llmBadge}
        description={t("settings:guardrails.injectionDesc")}
        onReset={() =>
          restore(
            "injection",
            "injectionTypes",
            "injectionThreshold",
            "injectionStrategy",
            "injectionLastMessageOnly",
            "injectionIncludeScores",
            "injectionInstructions",
          )
        }
        resetLabel={resetLabel}
        title={t("settings:guardrails.injectionTitle")}
      >
        <SwitchRow
          checked={draft.injection}
          description={t("settings:guardrails.enableInjectionDesc")}
          onChange={(v) => patch({ injection: v })}
          title={t("settings:guardrails.enableInjectionTitle")}
        />
        {draft.injection ? (
          <AdvancedSection title={t("settings:guardrails.advancedTitle")}>
            <TagMultiSelect
              description={t("settings:guardrails.detectionTypesDesc")}
              onChange={(injectionTypes) => patch({ injectionTypes })}
              options={injectionTypeOptions}
              title={t("settings:guardrails.piiDetectionTypesTitle")}
              value={draft.injectionTypes}
            />
            <SliderRow
              description={t("settings:guardrails.injectionThresholdDesc")}
              max={1}
              min={0}
              onChange={(v) => patch({ injectionThreshold: Math.round(v * 100) / 100 })}
              step={0.05}
              title={t("settings:guardrails.thresholdTitle")}
              value={draft.injectionThreshold}
            />
            <SelectRow
              confirm={blockConfirmation}
              description={t("settings:guardrails.injectionStrategyDesc")}
              onChange={(injectionStrategy) => patch({ injectionStrategy })}
              options={[
                { value: "block" as const, label: t("settings:guardrails.options.blockInterrupt") },
                { value: "filter" as const, label: t("settings:guardrails.options.filterDrop") },
                { value: "rewrite" as const, label: t("settings:guardrails.options.rewriteHarm") },
                { value: "warn" as const, label: t("settings:guardrails.options.warnOnly") },
              ]}
              title={t("settings:guardrails.injectionStrategyTitle")}
              value={draft.injectionStrategy}
            />
            <SwitchRow
              checked={draft.injectionLastMessageOnly}
              onChange={(v) => patch({ injectionLastMessageOnly: v })}
              title={t("settings:guardrails.lastMessageOnlyTitle")}
            />
            <SwitchRow
              checked={draft.injectionIncludeScores}
              onChange={(v) => patch({ injectionIncludeScores: v })}
              title={t("settings:guardrails.includeScoresTitle")}
            />
            <TextAreaRow
              description={t("settings:guardrails.injectionInstructionsDesc")}
              onChange={(injectionInstructions) => patch({ injectionInstructions })}
              rows={3}
              title={t("settings:guardrails.instructionsTitle")}
              value={draft.injectionInstructions}
            />
          </AdvancedSection>
        ) : null}
      </SettingCard>

      <SettingCard
        action={llmBadge}
        description={t("settings:guardrails.languageDesc")}
        onReset={() =>
          restore(
            "language",
            "languageTargets",
            "languageThreshold",
            "languageStrategy",
            "languagePreserveOriginal",
            "languageMinTextLength",
            "languageLastMessageOnly",
            "languageIncludeDetails",
            "languageInstructions",
          )
        }
        resetLabel={resetLabel}
        title={t("settings:guardrails.languageTitle")}
      >
        <SwitchRow
          checked={draft.language}
          description={t("settings:guardrails.enableLanguageDesc")}
          onChange={(v) => patch({ language: v })}
          title={t("settings:guardrails.enableLanguageTitle")}
        />
        {draft.language ? (
          <AdvancedSection title={t("settings:guardrails.advancedTitle")}>
            <TagMultiSelect
              description={t("settings:guardrails.targetLanguagesDesc")}
              onChange={(languageTargets) => patch({ languageTargets })}
              options={[
                { value: "Chinese", label: t("settings:guardrails.options.chinese") },
                { value: "English", label: t("settings:guardrails.options.english") },
                { value: "Japanese", label: t("settings:guardrails.options.japanese") },
                { value: "Korean", label: t("settings:guardrails.options.korean") },
                { value: "Spanish", label: t("settings:guardrails.options.spanish") },
                { value: "French", label: t("settings:guardrails.options.french") },
              ]}
              title={t("settings:guardrails.targetLanguagesTitle")}
              value={draft.languageTargets}
            />
            <SliderRow
              description={t("settings:guardrails.languageThresholdDesc")}
              max={1}
              min={0}
              onChange={(v) => patch({ languageThreshold: Math.round(v * 100) / 100 })}
              step={0.05}
              title={t("settings:guardrails.thresholdTitle")}
              value={draft.languageThreshold}
            />
            <SelectRow
              confirm={blockConfirmation}
              description={t("settings:guardrails.languageStrategyDesc")}
              onChange={(languageStrategy) => patch({ languageStrategy })}
              options={[
                { value: "detect" as const, label: t("settings:guardrails.options.detectOnly") },
                {
                  value: "translate" as const,
                  label: t("settings:guardrails.options.translateLang"),
                },
                { value: "block" as const, label: t("settings:guardrails.options.blockIntercept") },
                { value: "warn" as const, label: t("settings:guardrails.options.warnOnly") },
              ]}
              title={t("settings:guardrails.languageStrategyTitle")}
              value={draft.languageStrategy}
            />
            {draft.languageStrategy === "translate" ? (
              <SwitchRow
                checked={draft.languagePreserveOriginal}
                description={t("settings:guardrails.preserveOriginalDesc")}
                onChange={(v) => patch({ languagePreserveOriginal: v })}
                title={t("settings:guardrails.preserveOriginalTitle")}
              />
            ) : null}
            <NumberRow
              description={t("settings:guardrails.minTextLengthDesc")}
              max={10_000}
              min={0}
              onChange={(v) => patch({ languageMinTextLength: v })}
              title={t("settings:guardrails.minTextLengthTitle")}
              value={draft.languageMinTextLength}
            />
            <SwitchRow
              checked={draft.languageLastMessageOnly}
              onChange={(v) => patch({ languageLastMessageOnly: v })}
              title={t("settings:guardrails.lastMessageOnlyTitle")}
            />
            <SwitchRow
              checked={draft.languageIncludeDetails}
              onChange={(v) => patch({ languageIncludeDetails: v })}
              title={t("settings:guardrails.includeDetectionDetailsTitle")}
            />
            <TextAreaRow
              description={t("settings:guardrails.languageInstructionsDesc")}
              onChange={(languageInstructions) => patch({ languageInstructions })}
              rows={3}
              title={t("settings:guardrails.instructionsTitle")}
              value={draft.languageInstructions}
            />
          </AdvancedSection>
        ) : null}
      </SettingCard>

      <SettingCard
        action={llmBadge}
        description={t("settings:guardrails.moderationDesc")}
        onReset={() =>
          restore(
            "moderationInput",
            "moderationOutput",
            "moderationCategories",
            "moderationThreshold",
            "moderationStrategy",
            "moderationLastMessageOnly",
            "moderationIncludeScores",
            "moderationChunkWindow",
            "moderationInstructions",
          )
        }
        resetLabel={resetLabel}
        title={t("settings:guardrails.moderationTitle")}
      >
        <SwitchRow
          checked={draft.moderationInput}
          description={t("settings:guardrails.auditInputDesc")}
          onChange={(v) => patch({ moderationInput: v })}
          title={t("settings:guardrails.auditInputTitle")}
        />
        <SwitchRow
          checked={draft.moderationOutput}
          description={t("settings:guardrails.auditOutputDesc")}
          onChange={(v) => patch({ moderationOutput: v })}
          title={t("settings:guardrails.auditOutputTitle")}
        />
        {draft.moderationInput || draft.moderationOutput ? (
          <AdvancedSection title={t("settings:guardrails.advancedTitle")}>
            <TagMultiSelect
              description={t("settings:guardrails.moderationCategoriesDesc")}
              onChange={(moderationCategories) => patch({ moderationCategories })}
              options={moderationCategoryOptions}
              title={t("settings:guardrails.moderationCategoriesTitle")}
              value={draft.moderationCategories}
            />
            <SliderRow
              description={t("settings:guardrails.moderationThresholdDesc")}
              max={1}
              min={0}
              onChange={(v) => patch({ moderationThreshold: Math.round(v * 100) / 100 })}
              step={0.05}
              title={t("settings:guardrails.thresholdTitle")}
              value={draft.moderationThreshold}
            />
            <SelectRow
              confirm={blockConfirmation}
              description={t("settings:guardrails.moderationStrategyDesc")}
              onChange={(moderationStrategy) => patch({ moderationStrategy })}
              options={[
                { value: "block" as const, label: t("settings:guardrails.options.blockInterrupt") },
                { value: "filter" as const, label: t("settings:guardrails.options.filterDrop") },
                { value: "warn" as const, label: t("settings:guardrails.options.warnOnly") },
              ]}
              title={t("settings:guardrails.injectionStrategyTitle")}
              value={draft.moderationStrategy}
            />
            <SwitchRow
              checked={draft.moderationLastMessageOnly}
              onChange={(v) => patch({ moderationLastMessageOnly: v })}
              title={t("settings:guardrails.lastMessageOnlyTitle")}
            />
            <SwitchRow
              checked={draft.moderationIncludeScores}
              onChange={(v) => patch({ moderationIncludeScores: v })}
              title={t("settings:guardrails.includeScoresTitle")}
            />
            <NumberRow
              description={t("settings:guardrails.chunkWindowDesc")}
              max={100}
              min={0}
              onChange={(v) => patch({ moderationChunkWindow: v })}
              title={t("settings:guardrails.chunkWindowTitle")}
              value={draft.moderationChunkWindow}
            />
            <TextAreaRow
              description={t("settings:guardrails.moderationInstructionsDesc")}
              onChange={(moderationInstructions) => patch({ moderationInstructions })}
              rows={3}
              title={t("settings:guardrails.moderationInstructionsTitle")}
              value={draft.moderationInstructions}
            />
          </AdvancedSection>
        ) : null}
      </SettingCard>

      <SettingCard
        action={llmBadge}
        description={t("settings:guardrails.piiDesc")}
        onReset={() =>
          restore(
            "piiInput",
            "piiOutput",
            "piiTypes",
            "piiThreshold",
            "piiStrategy",
            "piiRedactionMethod",
            "piiPreserveFormat",
            "piiLastMessageOnly",
            "piiIncludeDetections",
            "piiBufferSize",
            "piiInstructions",
          )
        }
        resetLabel={resetLabel}
        title={t("settings:guardrails.piiTitle")}
      >
        <SwitchRow
          checked={draft.piiInput}
          description={t("settings:guardrails.detectInputDesc")}
          onChange={(v) => patch({ piiInput: v })}
          title={t("settings:guardrails.detectInputTitle")}
        />
        <SwitchRow
          checked={draft.piiOutput}
          description={t("settings:guardrails.detectOutputDesc")}
          onChange={(v) => patch({ piiOutput: v })}
          title={t("settings:guardrails.detectOutputTitle")}
        />
        {draft.piiInput || draft.piiOutput ? (
          <AdvancedSection title={t("settings:guardrails.advancedTitle")}>
            <TagMultiSelect
              description={t("settings:guardrails.piiDetectionTypesDesc")}
              onChange={(piiTypes) => patch({ piiTypes })}
              options={piiTypeOptions}
              title={t("settings:guardrails.piiDetectionTypesTitle")}
              value={draft.piiTypes}
            />
            <SliderRow
              description={t("settings:guardrails.piiThresholdDesc")}
              max={1}
              min={0}
              onChange={(v) => patch({ piiThreshold: Math.round(v * 100) / 100 })}
              step={0.05}
              title={t("settings:guardrails.thresholdTitle")}
              value={draft.piiThreshold}
            />
            <SelectRow
              confirm={blockConfirmation}
              description={t("settings:guardrails.piiStrategyDesc")}
              onChange={(piiStrategy) => patch({ piiStrategy })}
              options={[
                { value: "redact" as const, label: t("settings:guardrails.options.redactMask") },
                { value: "block" as const, label: t("settings:guardrails.options.blockInterrupt") },
                { value: "filter" as const, label: t("settings:guardrails.options.filterDrop") },
                { value: "warn" as const, label: t("settings:guardrails.options.warnOnly") },
              ]}
              title={t("settings:guardrails.injectionStrategyTitle")}
              value={draft.piiStrategy}
            />
            {draft.piiStrategy === "redact" ? (
              <SelectRow
                description={t("settings:guardrails.redactionMethodDesc")}
                onChange={(piiRedactionMethod) => patch({ piiRedactionMethod })}
                options={[
                  { value: "mask" as const, label: t("settings:guardrails.options.methodMask") },
                  { value: "hash" as const, label: t("settings:guardrails.options.methodHash") },
                  {
                    value: "placeholder" as const,
                    label: t("settings:guardrails.options.methodPlaceholder"),
                  },
                  {
                    value: "remove" as const,
                    label: t("settings:guardrails.options.methodRemove"),
                  },
                ]}
                title={t("settings:guardrails.redactionMethodTitle")}
                value={draft.piiRedactionMethod}
              />
            ) : null}
            <SwitchRow
              checked={draft.piiPreserveFormat}
              onChange={(v) => patch({ piiPreserveFormat: v })}
              title={t("settings:guardrails.preserveFormatTitle")}
            />
            <SwitchRow
              checked={draft.piiLastMessageOnly}
              onChange={(v) => patch({ piiLastMessageOnly: v })}
              title={t("settings:guardrails.lastMessageOnlyTitle")}
            />
            <SwitchRow
              checked={draft.piiIncludeDetections}
              onChange={(v) => patch({ piiIncludeDetections: v })}
              title={t("settings:guardrails.includeDetectionsTitle")}
            />
            <NumberRow
              description={t("settings:guardrails.bufferSizeDesc")}
              max={10_000}
              min={1}
              onChange={(v) => patch({ piiBufferSize: v })}
              title={t("settings:guardrails.bufferSizeTitle")}
              value={draft.piiBufferSize}
            />
            <TextAreaRow
              description={t("settings:guardrails.piiInstructionsDesc")}
              onChange={(piiInstructions) => patch({ piiInstructions })}
              rows={3}
              title={t("settings:guardrails.instructionsTitle")}
              value={draft.piiInstructions}
            />
          </AdvancedSection>
        ) : null}
      </SettingCard>

      <SettingCard
        action={llmBadge}
        description={t("settings:guardrails.scrubberDesc")}
        onReset={() =>
          restore(
            "scrubber",
            "scrubberStrategy",
            "scrubberRedactionMethod",
            "scrubberPlaceholderText",
            "scrubberCustomPatterns",
            "scrubberIncludeDetections",
            "scrubberLastMessageOnly",
            "scrubberInstructions",
          )
        }
        resetLabel={resetLabel}
        title={t("settings:guardrails.scrubberTitle")}
      >
        <SwitchRow
          checked={draft.scrubber}
          description={t("settings:guardrails.enableScrubberDesc")}
          onChange={(v) => patch({ scrubber: v })}
          title={t("settings:guardrails.enableScrubberTitle")}
        />
        {draft.scrubber ? (
          <AdvancedSection title={t("settings:guardrails.advancedTitle")}>
            <SelectRow
              confirm={blockConfirmation}
              description={t("settings:guardrails.scrubberStrategyDesc")}
              onChange={(scrubberStrategy) => patch({ scrubberStrategy })}
              options={[
                { value: "redact" as const, label: t("settings:guardrails.options.redactReplace") },
                { value: "filter" as const, label: t("settings:guardrails.options.filterDrop") },
                { value: "block" as const, label: t("settings:guardrails.options.blockInterrupt") },
                { value: "warn" as const, label: t("settings:guardrails.options.warnOnly") },
              ]}
              title={t("settings:guardrails.injectionStrategyTitle")}
              value={draft.scrubberStrategy}
            />
            {draft.scrubberStrategy === "redact" ? (
              <SelectRow
                description={t("settings:guardrails.scrubberRedactionModeDesc")}
                onChange={(scrubberRedactionMethod) => patch({ scrubberRedactionMethod })}
                options={[
                  { value: "mask" as const, label: t("settings:guardrails.options.methodMask") },
                  {
                    value: "placeholder" as const,
                    label: t("settings:guardrails.options.methodPlaceholder"),
                  },
                  {
                    value: "remove" as const,
                    label: t("settings:guardrails.options.methodRemove"),
                  },
                ]}
                title={t("settings:guardrails.scrubberRedactionModeTitle")}
                value={draft.scrubberRedactionMethod}
              />
            ) : null}
            <TextAreaRow
              description={t("settings:guardrails.placeholderTextDesc")}
              onChange={(scrubberPlaceholderText) => patch({ scrubberPlaceholderText })}
              rows={2}
              title={t("settings:guardrails.placeholderTextTitle")}
              value={draft.scrubberPlaceholderText}
            />
            <SwitchRow
              checked={draft.scrubberIncludeDetections}
              onChange={(v) => patch({ scrubberIncludeDetections: v })}
              title={t("settings:guardrails.includeDetectionsTitle")}
            />
            <SwitchRow
              checked={draft.scrubberLastMessageOnly}
              onChange={(v) => patch({ scrubberLastMessageOnly: v })}
              title={t("settings:guardrails.lastMessageOnlyTitle")}
            />
            <TextAreaRow
              description={t("settings:guardrails.scrubberInstructionsDesc")}
              onChange={(scrubberInstructions) => patch({ scrubberInstructions })}
              rows={3}
              title={t("settings:guardrails.scrubberInstructionsTitle")}
              value={draft.scrubberInstructions}
            />
          </AdvancedSection>
        ) : null}
      </SettingCard>

      <SettingCard
        description={t("settings:guardrails.batchPartsDesc")}
        onReset={() =>
          restore(
            "batchParts",
            "batchPartsSize",
            "batchPartsMaxWaitTime",
            "batchPartsEmitOnNonText",
          )
        }
        resetLabel={resetLabel}
        title={t("settings:guardrails.batchPartsTitle")}
      >
        <SwitchRow
          checked={draft.batchParts}
          onChange={(v) => patch({ batchParts: v })}
          title={t("settings:guardrails.enableBatchPartsTitle")}
        />
        {draft.batchParts ? (
          <AdvancedSection title={t("settings:guardrails.advancedTitle")}>
            <NumberRow
              description={t("settings:guardrails.batchSizeDesc")}
              max={100}
              min={1}
              onChange={(v) => patch({ batchPartsSize: v })}
              title={t("settings:guardrails.batchSizeTitle")}
              value={draft.batchPartsSize}
            />
            <NumberRow
              description={t("settings:guardrails.maxWaitTimeDesc")}
              max={10_000}
              min={0}
              onChange={(v) => patch({ batchPartsMaxWaitTime: v })}
              suffix={t("common:millisecondsUnit")}
              title={t("settings:guardrails.maxWaitTimeTitle")}
              value={draft.batchPartsMaxWaitTime}
            />
            <SwitchRow
              checked={draft.batchPartsEmitOnNonText}
              onChange={(v) => patch({ batchPartsEmitOnNonText: v })}
              title={t("settings:guardrails.emitOnNonTextTitle")}
            />
          </AdvancedSection>
        ) : null}
      </SettingCard>

      <SettingCard
        description={t("settings:guardrails.tokenLimiterDesc")}
        onReset={() =>
          restore(
            "tokenLimitInput",
            "tokenLimitInputValue",
            "tokenLimitTrimMode",
            "tokenLimitOutput",
            "tokenLimitOutputValue",
            "tokenLimitOutputStrategy",
            "tokenLimitOutputCountMode",
          )
        }
        resetLabel={resetLabel}
        title={t("settings:guardrails.tokenLimiterTitle")}
      >
        <SwitchRow
          checked={draft.tokenLimitInput}
          description={t("settings:guardrails.limitInputDesc")}
          onChange={(v) => patch({ tokenLimitInput: v })}
          title={t("settings:guardrails.limitInputTitle")}
        />
        {draft.tokenLimitInput ? (
          <AdvancedSection title={t("settings:guardrails.advancedTitle")}>
            <NumberRow
              description={t("settings:guardrails.contextLimitDesc")}
              max={2_000_000}
              min={1_000}
              onChange={(v) => patch({ tokenLimitInputValue: v })}
              step={1_000}
              suffix={t("settings:guardrails.tokenUnit")}
              title={t("settings:guardrails.contextLimitTitle")}
              value={draft.tokenLimitInputValue}
            />
            <SelectRow
              description={t("settings:guardrails.trimModeDesc")}
              onChange={(tokenLimitTrimMode) => patch({ tokenLimitTrimMode })}
              options={[
                {
                  value: "contiguous" as const,
                  label: t("settings:guardrails.options.trimContiguous"),
                },
                { value: "best-fit" as const, label: t("settings:guardrails.options.trimBestFit") },
              ]}
              title={t("settings:guardrails.trimModeTitle")}
              value={draft.tokenLimitTrimMode}
            />
          </AdvancedSection>
        ) : null}
        <SwitchRow
          checked={draft.tokenLimitOutput}
          description={t("settings:guardrails.limitOutputDesc")}
          onChange={(v) => patch({ tokenLimitOutput: v })}
          title={t("settings:guardrails.limitOutputTitle")}
        />
        {draft.tokenLimitOutput ? (
          <AdvancedSection title={t("settings:guardrails.advancedTitle")}>
            <NumberRow
              description={t("settings:guardrails.outputLimitDesc")}
              max={200_000}
              min={100}
              onChange={(v) => patch({ tokenLimitOutputValue: v })}
              step={100}
              suffix={t("settings:guardrails.tokenUnit")}
              title={t("settings:guardrails.outputLimitTitle")}
              value={draft.tokenLimitOutputValue}
            />
            <SelectRow
              description={t("settings:guardrails.limitStrategyDesc")}
              onChange={(tokenLimitOutputStrategy) => patch({ tokenLimitOutputStrategy })}
              options={[
                {
                  value: "truncate" as const,
                  label: t("settings:guardrails.options.limitTruncate"),
                },
                { value: "abort" as const, label: t("settings:guardrails.options.limitAbort") },
              ]}
              title={t("settings:guardrails.limitStrategyTitle")}
              value={draft.tokenLimitOutputStrategy}
            />
            <SelectRow
              description={t("settings:guardrails.countModeDesc")}
              onChange={(tokenLimitOutputCountMode) => patch({ tokenLimitOutputCountMode })}
              options={[
                {
                  value: "cumulative" as const,
                  label: t("settings:guardrails.options.countCumulative"),
                },
                { value: "part" as const, label: t("settings:guardrails.options.countPart") },
              ]}
              title={t("settings:guardrails.countModeTitle")}
              value={draft.tokenLimitOutputCountMode}
            />
          </AdvancedSection>
        ) : null}
      </SettingCard>

      <SettingCard
        action={
          <ReadyBadge
            blockedText={t("settings:guardrails.blockedCost")}
            ready={status.costMetricsReady}
            readyText={t("settings:guardrails.readyCost")}
          />
        }
        description={t("settings:guardrails.tokenCostDesc")}
        onReset={() =>
          restore(
            "tokenCost",
            "tokenCostMax",
            "tokenCostScope",
            "tokenCostWindow",
            "tokenCostStrategy",
            "tokenCostWarnAtPercent",
            "tokenCostIncludeBreakdown",
          )
        }
        resetLabel={resetLabel}
        title={t("settings:guardrails.tokenCostTitle")}
      >
        <SwitchRow
          checked={draft.tokenCost}
          description={t("settings:guardrails.enableTokenCostDesc")}
          disabled={!status.costMetricsReady}
          onChange={(v) => patch({ tokenCost: v })}
          title={t("settings:guardrails.enableTokenCostTitle")}
        />
        {draft.tokenCost ? (
          <AdvancedSection title={t("settings:guardrails.advancedTitle")}>
            <NumberRow
              description={t("settings:guardrails.maxCostDesc")}
              max={10_000}
              min={0.1}
              onChange={(v) => patch({ tokenCostMax: v })}
              step={0.5}
              suffix={t("settings:guardrails.options.suffixUsd")}
              title={t("settings:guardrails.maxCostTitle")}
              value={draft.tokenCostMax}
            />
            <SelectRow
              description={t("settings:guardrails.scopeDesc")}
              onChange={(tokenCostScope) => patch({ tokenCostScope })}
              options={[
                {
                  value: "resource" as const,
                  label: t("settings:guardrails.options.scopeResource"),
                },
                { value: "thread" as const, label: t("settings:guardrails.options.scopeThread") },
                { value: "run" as const, label: t("settings:guardrails.options.scopeRun") },
                { value: "user" as const, label: t("settings:guardrails.options.scopeUser") },
                { value: "session" as const, label: t("settings:guardrails.options.scopeSession") },
                {
                  value: "organization" as const,
                  label: t("settings:guardrails.options.scopeOrganization"),
                },
              ]}
              title={t("settings:guardrails.scopeTitle")}
              value={draft.tokenCostScope}
            />
            <SelectRow
              description={t("settings:guardrails.windowDesc")}
              onChange={(tokenCostWindow) => patch({ tokenCostWindow })}
              options={[
                { value: "1h" as const, label: t("settings:guardrails.options.window1h") },
                { value: "6h" as const, label: t("settings:guardrails.options.window6h") },
                { value: "24h" as const, label: t("settings:guardrails.options.window24h") },
                { value: "7d" as const, label: t("settings:guardrails.options.window7d") },
                { value: "30d" as const, label: t("settings:guardrails.options.window30d") },
                { value: "365d" as const, label: t("settings:guardrails.options.window365d") },
              ]}
              title={t("settings:guardrails.windowTitle")}
              value={draft.tokenCostWindow}
            />
            <SelectRow
              confirm={blockConfirmation}
              description={t("settings:guardrails.costStrategyDesc")}
              onChange={(tokenCostStrategy) => patch({ tokenCostStrategy })}
              options={[
                { value: "warn" as const, label: t("settings:guardrails.options.warnOnly") },
                { value: "block" as const, label: t("settings:guardrails.options.blockIntercept") },
              ]}
              title={t("settings:guardrails.costStrategyTitle")}
              value={draft.tokenCostStrategy}
            />
            <SliderRow
              description={t("settings:guardrails.warnAtPercentDesc")}
              max={95}
              min={0}
              onChange={(v) => patch({ tokenCostWarnAtPercent: v })}
              step={5}
              title={t("settings:guardrails.warnAtPercentTitle")}
              value={draft.tokenCostWarnAtPercent}
            />
            <SwitchRow
              checked={draft.tokenCostIncludeBreakdown}
              onChange={(v) => patch({ tokenCostIncludeBreakdown: v })}
              title={t("settings:guardrails.includeBreakdownTitle")}
            />
          </AdvancedSection>
        ) : null}
      </SettingCard>

      <SettingCard
        description={t("settings:guardrails.historyCompatDesc")}
        onReset={() => restore("providerCompat")}
        resetLabel={resetLabel}
        title={t("settings:guardrails.historyCompatTitle")}
      >
        <SwitchRow
          checked={draft.providerCompat}
          description={t("settings:guardrails.enableHistoryCompatDesc")}
          onChange={(v) => patch({ providerCompat: v })}
          title={t("settings:guardrails.enableHistoryCompatTitle")}
        />
      </SettingCard>

      <SettingCard
        description={t("settings:guardrails.toolCallFilterDesc")}
        onReset={() =>
          restore(
            "toolCallFilter",
            "toolCallFilterExclude",
            "toolCallFilterAfterToolSteps",
            "toolCallFilterPreserveModelOutput",
          )
        }
        resetLabel={resetLabel}
        title={t("settings:guardrails.toolCallFilterTitle")}
      >
        <SwitchRow
          checked={draft.toolCallFilter}
          onChange={(v) => patch({ toolCallFilter: v })}
          title={t("settings:guardrails.enableToolCallFilterTitle")}
        />
        {draft.toolCallFilter ? (
          <AdvancedSection title={t("settings:guardrails.advancedTitle")}>
            <TextAreaRow
              description={t("settings:guardrails.excludeToolsDesc")}
              onChange={(text) => patchList("toolCallFilterExclude", text)}
              rows={3}
              title={t("settings:guardrails.excludeToolsTitle")}
              value={listText.toolCallFilterExclude}
            />
            <NumberRow
              description={t("settings:guardrails.filterStartDesc")}
              max={100}
              min={-1}
              onChange={(v) => patch({ toolCallFilterAfterToolSteps: v })}
              title={t("settings:guardrails.filterStartTitle")}
              value={draft.toolCallFilterAfterToolSteps}
            />
            <SwitchRow
              checked={draft.toolCallFilterPreserveModelOutput}
              onChange={(v) => patch({ toolCallFilterPreserveModelOutput: v })}
              title={t("settings:guardrails.preserveModelOutputTitle")}
            />
          </AdvancedSection>
        ) : null}
      </SettingCard>

      <SettingCard
        description={t("settings:guardrails.responseCacheDesc")}
        onReset={() =>
          restore(
            "responseCache",
            "responseCacheTtl",
            "responseCacheScopeMode",
            "responseCacheScopeValue",
          )
        }
        resetLabel={resetLabel}
        title={t("settings:guardrails.responseCacheTitle")}
      >
        <SwitchRow
          checked={draft.responseCache}
          onChange={(v) => patch({ responseCache: v })}
          title={t("settings:guardrails.enableResponseCacheTitle")}
        />
        {draft.responseCache ? (
          <AdvancedSection title={t("settings:guardrails.advancedTitle")}>
            <NumberRow
              description={t("settings:guardrails.cacheTtlDesc")}
              max={86_400}
              min={0}
              onChange={(v) => patch({ responseCacheTtl: v })}
              suffix={t("common:secondsUnit")}
              title={t("settings:guardrails.cacheTtlTitle")}
              value={draft.responseCacheTtl}
            />
            <SelectRow
              description={t("settings:guardrails.cacheScopeDesc")}
              onChange={(responseCacheScopeMode) => patch({ responseCacheScopeMode })}
              options={[
                { value: "auto" as const, label: t("settings:guardrails.options.cacheAuto") },
                { value: "none" as const, label: t("settings:guardrails.options.cacheNone") },
              ]}
              title={t("settings:guardrails.cacheScopeTitle")}
              value={
                draft.responseCacheScopeMode === "custom" ? "auto" : draft.responseCacheScopeMode
              }
            />
          </AdvancedSection>
        ) : null}
      </SettingCard>

      <SettingCard
        action={
          <ReadyBadge
            blockedText={t("settings:guardrails.blockedWorkspace")}
            ready={status.workspaceReady}
            readyText={t("settings:guardrails.readyWorkspace")}
          />
        }
        description={t("settings:guardrails.skillSearchDesc")}
        onReset={() =>
          restore(
            "skillSearch",
            "skillSearchTopK",
            "skillSearchMinScore",
            "skillSearchTtl",
            "skillSearchBlockingRefresh",
          )
        }
        resetLabel={resetLabel}
        title={t("settings:guardrails.skillSearchTitle")}
      >
        <SwitchRow
          checked={draft.skillSearch}
          disabled={!status.workspaceReady}
          onChange={(v) => patch({ skillSearch: v })}
          title={t("settings:guardrails.enableSkillSearchTitle")}
        />
        {draft.skillSearch ? (
          <AdvancedSection title={t("settings:guardrails.advancedTitle")}>
            <SliderRow
              description={t("settings:guardrails.topKDesc")}
              max={20}
              min={1}
              onChange={(v) => patch({ skillSearchTopK: v })}
              step={1}
              title={t("settings:guardrails.topKTitle")}
              value={draft.skillSearchTopK}
            />
            <SliderRow
              description={t("settings:guardrails.minScoreDesc")}
              max={1}
              min={0}
              onChange={(v) => patch({ skillSearchMinScore: Math.round(v * 100) / 100 })}
              step={0.05}
              title={t("settings:guardrails.minScoreTitle")}
              value={draft.skillSearchMinScore}
            />
            <NumberRow
              description={t("settings:guardrails.skillCacheTtlDesc")}
              max={86_400_000}
              min={0}
              onChange={(v) => patch({ skillSearchTtl: v })}
              suffix={t("common:millisecondsUnit")}
              title={t("settings:guardrails.cacheTtlTitle")}
              value={draft.skillSearchTtl}
            />
            <SwitchRow
              checked={draft.skillSearchBlockingRefresh}
              description={t("settings:guardrails.blockingRefreshDesc")}
              onChange={(v) => patch({ skillSearchBlockingRefresh: v })}
              title={t("settings:guardrails.blockingRefreshTitle")}
            />
          </AdvancedSection>
        ) : null}
      </SettingCard>

      <SettingCard
        description={t("settings:guardrails.toolSearchDesc")}
        onReset={() =>
          restore(
            "toolSearch",
            "toolSearchTopK",
            "toolSearchMinScore",
            "toolSearchInjectCatalog",
            "toolSearchAutoLoad",
            "toolSearchStorage",
            "toolSearchTtl",
          )
        }
        resetLabel={resetLabel}
        title={t("settings:guardrails.toolSearchTitle")}
      >
        <SwitchRow
          checked={draft.toolSearch}
          description={t("settings:guardrails.enableToolSearchDesc")}
          onChange={(v) => patch({ toolSearch: v })}
          title={t("settings:guardrails.enableToolSearchTitle")}
        />
        {draft.toolSearch ? (
          <AdvancedSection title={t("settings:guardrails.advancedTitle")}>
            <SliderRow
              description={t("settings:guardrails.toolSearchTopKDesc")}
              max={20}
              min={1}
              onChange={(v) => patch({ toolSearchTopK: v })}
              step={1}
              title={t("settings:guardrails.toolSearchTopKTitle")}
              value={draft.toolSearchTopK}
            />
            <SliderRow
              description={t("settings:guardrails.minScoreDesc")}
              max={1}
              min={0}
              onChange={(v) => patch({ toolSearchMinScore: Math.round(v * 100) / 100 })}
              step={0.05}
              title={t("settings:guardrails.minScoreTitle")}
              value={draft.toolSearchMinScore}
            />
            <SwitchRow
              checked={draft.toolSearchAutoLoad}
              description={t("settings:guardrails.autoLoadDesc")}
              onChange={(v) => patch({ toolSearchAutoLoad: v })}
              title={t("settings:guardrails.autoLoadTitle")}
            />
            <SwitchRow
              checked={draft.toolSearchInjectCatalog}
              description={t("settings:guardrails.injectCatalogDesc")}
              onChange={(v) => patch({ toolSearchInjectCatalog: v })}
              title={t("settings:guardrails.injectCatalogTitle")}
            />
            <SelectRow
              description={t("settings:guardrails.storageDesc")}
              onChange={(toolSearchStorage) => patch({ toolSearchStorage })}
              options={[
                {
                  value: "context" as const,
                  label: t("settings:guardrails.options.storageContext"),
                },
                {
                  value: "in-memory" as const,
                  label: t("settings:guardrails.options.storageInMemory"),
                },
              ]}
              title={t("settings:guardrails.storageTitle")}
              value={draft.toolSearchStorage}
            />
            <NumberRow
              description={t("settings:guardrails.stateTtlDesc")}
              max={86_400_000}
              min={0}
              onChange={(v) => patch({ toolSearchTtl: v })}
              suffix={t("common:millisecondsUnit")}
              title={t("settings:guardrails.stateTtlTitle")}
              value={draft.toolSearchTtl}
            />
          </AdvancedSection>
        ) : null}
      </SettingCard>

      <SettingCard
        description={t("settings:guardrails.errorRecoveryDesc")}
        onReset={() =>
          restore(
            "prefillErrorHandler",
            "streamErrorRetry",
            "streamErrorRetryMax",
            "streamErrorRetryDelayMs",
            "streamErrorRetryMaxRetryAfterMs",
            "streamErrorRetryUnknown",
          )
        }
        resetLabel={resetLabel}
        title={t("settings:guardrails.errorRecoveryTitle")}
      >
        <SwitchRow
          checked={draft.prefillErrorHandler}
          description={t("settings:guardrails.prefillFixDesc")}
          onChange={(v) => patch({ prefillErrorHandler: v })}
          title={t("settings:guardrails.prefillFixTitle")}
        />
        <SwitchRow
          checked={draft.streamErrorRetry}
          description={t("settings:guardrails.streamRetryDesc")}
          onChange={(v) => patch({ streamErrorRetry: v })}
          title={t("settings:guardrails.streamRetryTitle")}
        />
        <NumberRow
          description={t("settings:guardrails.maxRetriesCountDesc")}
          max={10}
          min={0}
          onChange={(v) => patch({ streamErrorRetryMax: v })}
          title={t("settings:guardrails.maxRetriesCountTitle")}
          value={draft.streamErrorRetryMax}
        />
        <NumberRow
          description={t("settings:guardrails.initialDelayDesc")}
          max={120_000}
          min={0}
          onChange={(v) => patch({ streamErrorRetryDelayMs: v })}
          suffix={t("common:millisecondsUnit")}
          title={t("settings:guardrails.initialDelayTitle")}
          value={draft.streamErrorRetryDelayMs}
        />
        <NumberRow
          description={t("settings:guardrails.maxRetryAfterDesc")}
          max={600_000}
          min={0}
          onChange={(v) => patch({ streamErrorRetryMaxRetryAfterMs: v })}
          suffix={t("common:millisecondsUnit")}
          title={t("settings:guardrails.maxRetryAfterTitle")}
          value={draft.streamErrorRetryMaxRetryAfterMs}
        />
        <SwitchRow
          checked={draft.streamErrorRetryUnknown}
          description={t("settings:guardrails.retryUnknownErrorsDesc")}
          onChange={(v) => patch({ streamErrorRetryUnknown: v })}
          title={t("settings:guardrails.retryUnknownErrorsTitle")}
        />
      </SettingCard>
    </>
  );
}
