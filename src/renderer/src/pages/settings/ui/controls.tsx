import type * as React from "react";
import type { getModelCapabilities, ProviderConfig } from "@/entities/workbench";
import { Badge } from "@/shared/ui/badge";
import { Field, FieldContent, FieldDescription, FieldError, FieldTitle } from "@/shared/ui/field";
import { Input } from "@/shared/ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/shared/ui/input-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/shared/ui/select";
import { Slider } from "@/shared/ui/slider";
import { Switch } from "@/shared/ui/switch";
import { Textarea } from "@/shared/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/shared/ui/toggle-group";

// ---------------------------------------------------------------------------
// 通用设置行:左侧标题+描述,右侧控件(shadcn 设置页典型样式)
// ---------------------------------------------------------------------------

export function SettingRow({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children?: React.ReactNode;
}) {
  return (
    <Field orientation="horizontal" className="justify-between gap-4 py-2">
      <FieldContent className="min-w-0">
        <FieldTitle className="text-sm leading-none font-medium">{title}</FieldTitle>
        {description ? (
          <FieldDescription className="text-xs text-muted-foreground">
            {description}
          </FieldDescription>
        ) : null}
      </FieldContent>
      {children ? <div className="flex shrink-0 items-center gap-2">{children}</div> : null}
    </Field>
  );
}

/** 独立设置卡片:用层级底色和轻微 ring 表达容器,避免页面被细碎边框切成网格。 */
export function SettingCard({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="w-full overflow-hidden rounded-xl border border-border bg-card shadow-xs transition-all duration-200 hover:border-border/80">
      <header className="border-b border-border/60 bg-muted/40 px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <p className="min-w-0 text-sm font-medium">{title}</p>
          {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
        </div>
        {description ? <p className="mt-1 text-xs text-muted-foreground">{description}</p> : null}
      </header>
      <div className="divide-y divide-border/60 px-4">{children}</div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// 当前对话模型路由辅助:用于显示和计算跟随当前模型的派生配置。
// ---------------------------------------------------------------------------

/** 当前对话所选模型的路由字符串(供"跟随当前模型"派生) */
export function currentModelRouterString(
  providers: ProviderConfig[],
  modelSelection: { providerId: string; modelId: string } | null,
): string {
  if (!modelSelection) return "";
  const provider = providers.find((p) => p.id === modelSelection.providerId);
  if (!provider) return "";
  return provider.registryId
    ? `${provider.registryId}/${modelSelection.modelId}`
    : `${provider.id}/${modelSelection.modelId}`;
}

/** scope 选择下拉(thread/resource) */
export function ScopeSelect({
  value,
  onChange,
  threadLabel,
  resourceLabel,
}: {
  value: "thread" | "resource";
  onChange: (value: "thread" | "resource") => void;
  threadLabel: string;
  resourceLabel: string;
}) {
  return (
    <Select onValueChange={(v) => v !== null && onChange(v as "thread" | "resource")} value={value}>
      <SelectTrigger className="w-52 shrink-0">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="thread">{threadLabel}</SelectItem>
        <SelectItem value="resource">{resourceLabel}</SelectItem>
      </SelectContent>
    </Select>
  );
}

/** 滑块设置行:标题+描述+当前值+Slider(记忆页复用) */
export function SliderRow({
  title,
  description,
  value,
  min,
  max,
  step,
  onChange,
}: {
  title: string;
  description?: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
}) {
  return (
    <Field className="py-4">
      <div className="flex items-center justify-between gap-4">
        <FieldContent className="min-w-0">
          <FieldTitle className="text-sm leading-none font-medium">{title}</FieldTitle>
          {description ? (
            <FieldDescription className="text-xs text-muted-foreground">
              {description}
            </FieldDescription>
          ) : null}
        </FieldContent>
        <span className="shrink-0 text-sm font-medium tabular-nums">{value}</span>
      </div>
      <Slider
        aria-label={title}
        className="mt-4"
        max={max}
        min={min}
        step={step}
        value={[value]}
        onValueChange={(v) => onChange(Array.isArray(v) ? v[0] : v)}
      />
    </Field>
  );
}

// ---------------------------------------------------------------------------
// 护栏页复用的通用控件:开关行 / 下拉行 / 数字行 / 多行文本行 / 多选标签组
// ---------------------------------------------------------------------------

/** 开关设置行:护栏页几十个布尔项都是这一形态 */
export function SwitchRow({
  title,
  description,
  checked,
  onChange,
  disabled,
}: {
  title: string;
  description?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <SettingRow description={description} title={title}>
      <Switch checked={checked} disabled={disabled} onCheckedChange={onChange} />
    </SettingRow>
  );
}

/** 下拉设置行:左侧标题+描述,右侧固定宽度 Select */
export function SelectRow<T extends string>({
  title,
  description,
  value,
  options,
  onChange,
  width = "w-52",
}: {
  title: string;
  description?: string;
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
  width?: string;
}) {
  return (
    <SettingRow description={description} title={title}>
      <Select onValueChange={(v) => v !== null && onChange(v as T)} value={value}>
        <SelectTrigger className={`${width} shrink-0`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </SettingRow>
  );
}

/**
 * 数字设置行:滑块不适用的量(金额、毫秒、Token 上限)用输入框。
 * 空串归零 —— 各处理器把 0 当作「不显式设置/不启用该项」。
 */
export function NumberRow({
  title,
  description,
  value,
  onChange,
  min = 0,
  max,
  step = 1,
  suffix,
}: {
  title: string;
  description?: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
}) {
  return (
    <SettingRow description={description} title={title}>
      {suffix ? (
        <InputGroup className="w-28">
          <InputGroupInput
            className="text-right font-mono text-xs"
            max={max}
            min={min}
            onChange={(e) => {
              const next = Number(e.target.value);
              onChange(Number.isFinite(next) ? next : 0);
            }}
            step={step}
            type="number"
            value={String(value)}
          />
          <InputGroupAddon align="inline-end" className="pr-2 text-xs text-muted-foreground">
            {suffix}
          </InputGroupAddon>
        </InputGroup>
      ) : (
        <Input
          className="w-28 text-right font-mono text-xs"
          max={max}
          min={min}
          onChange={(e) => {
            const next = Number(e.target.value);
            onChange(Number.isFinite(next) ? next : 0);
          }}
          step={step}
          type="number"
          value={String(value)}
        />
      )}
    </SettingRow>
  );
}

/** 多行文本设置行:自定义指令 / 规则 JSON(标题与描述在上,输入框独占整行) */
export function TextAreaRow({
  title,
  description,
  value,
  placeholder,
  rows = 4,
  invalid,
  invalidHint,
  onChange,
}: {
  title: string;
  description?: string;
  value: string;
  placeholder?: string;
  rows?: number;
  invalid?: boolean;
  invalidHint?: string;
  onChange: (value: string) => void;
}) {
  return (
    <Field className="py-3" data-invalid={invalid}>
      <FieldContent>
        <FieldTitle className="text-sm leading-none font-medium">{title}</FieldTitle>
        {description ? (
          <FieldDescription className="text-xs text-muted-foreground">
            {description}
          </FieldDescription>
        ) : null}
      </FieldContent>
      <Textarea
        aria-invalid={invalid}
        className="min-h-20 font-mono text-xs"
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={rows}
        spellCheck={false}
        value={value}
      />
      {invalid && invalidHint ? <FieldError>{invalidHint}</FieldError> : null}
    </Field>
  );
}

/**
 * 多选标签组:检测类别 / PII 类型 / 正则预设这类「多选枚举」。
 * 用官方 ToggleGroup 的 multiple 形态,选中态即 outline → 实心。
 */
export function TagMultiSelect({
  title,
  description,
  value,
  options,
  onChange,
}: {
  title: string;
  description?: string;
  value: string[];
  options: Array<{ value: string; label: string }>;
  onChange: (value: string[]) => void;
}) {
  return (
    <Field className="py-3">
      <div className="flex items-baseline justify-between gap-2">
        <FieldContent className="min-w-0">
          <FieldTitle className="text-sm leading-none font-medium">{title}</FieldTitle>
          {description ? (
            <FieldDescription className="text-xs text-muted-foreground">
              {description}
            </FieldDescription>
          ) : null}
        </FieldContent>
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
          {value.length}/{options.length}
        </span>
      </div>
      <ToggleGroup
        className="flex w-full flex-wrap gap-1.5"
        multiple
        onValueChange={(next) => onChange([...next])}
        value={value}
        variant="outline"
      >
        {options.map((option) => (
          <ToggleGroupItem className="h-7 px-2 text-xs" key={option.value} value={option.value}>
            {option.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </Field>
  );
}

// 能力徽章:不同能力不同颜色(models.dev 目录提供能力数据)
export const CAPABILITY_STYLES = [
  {
    key: "reasoning",
    label: "推理",
    className: "border-violet-500/25 bg-violet-500/10 text-violet-600",
  },
  {
    key: "vision",
    label: "视觉",
    className: "border-blue-500/25 bg-blue-500/10 text-blue-600",
  },
  {
    key: "audio",
    label: "音频",
    className: "border-emerald-500/25 bg-emerald-500/10 text-emerald-600",
  },
  {
    key: "tools",
    label: "工具",
    className: "border-amber-500/25 bg-amber-500/10 text-amber-600",
  },
] as const;

/** 模型能力徽章(四色区分),chat-panel 模型菜单同样复用 */
export function CapabilityBadges({ caps }: { caps: ReturnType<typeof getModelCapabilities> }) {
  return (
    <div className="flex flex-wrap gap-1">
      {CAPABILITY_STYLES.filter((cap) => caps[cap.key]).map((cap) => (
        <Badge key={cap.key} variant="outline" className={`text-[10px] ${cap.className}`}>
          {cap.label}
        </Badge>
      ))}
    </div>
  );
}
