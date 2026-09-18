import { ChevronDownIcon, CircleHelpIcon, PlusIcon, RotateCcwIcon, XIcon } from "lucide-react";
import { nanoid } from "nanoid";
import * as React from "react";
import type { ProviderConfig } from "@/entities/workbench";
import { cn } from "@/shared/lib";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/shared/ui/alert-dialog";
import { Button } from "@/shared/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/shared/ui/collapsible";
import { Field, FieldContent, FieldDescription, FieldError, FieldTitle } from "@/shared/ui/field";
import { Input } from "@/shared/ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/shared/ui/input-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/shared/ui/select";
import { Slider } from "@/shared/ui/slider";
import { Switch } from "@/shared/ui/switch";
import { Textarea } from "@/shared/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/shared/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/shared/ui/tooltip";

// ---------------------------------------------------------------------------
// 通用设置行:左侧标题+描述,右侧控件(shadcn 设置页典型样式)
// ---------------------------------------------------------------------------

export function SettingRow({
  title,
  description,
  defaultHint,
  help,
  children,
}: {
  title: string;
  description?: string;
  defaultHint?: string;
  help?: string;
  children?: React.ReactNode;
}) {
  return (
    <Field
      orientation="responsive"
      className="min-w-0 justify-between gap-3 py-3 @md/field-group:gap-4"
    >
      <FieldContent className="min-w-0">
        <FieldTitle className="max-w-full text-sm leading-snug font-medium">
          <span className="min-w-0 break-words">{title}</span>
          {help ? <HelpTooltip content={help} label={title} /> : null}
        </FieldTitle>
        {description ? (
          <FieldDescription className="max-w-2xl break-words text-xs text-muted-foreground">
            {description}
          </FieldDescription>
        ) : null}
        {defaultHint ? (
          <span className="text-[11px] text-muted-foreground/80">{defaultHint}</span>
        ) : null}
      </FieldContent>
      {children ? (
        <div className="flex min-w-0 flex-wrap items-center gap-2 @md/field-group:shrink-0">
          {children}
        </div>
      ) : null}
    </Field>
  );
}

export function HelpTooltip({ content, label }: { content: string; label: string }) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger
          aria-label={label}
          render={
            <button
              type="button"
              className="inline-flex size-5 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            />
          }
        >
          <CircleHelpIcon className="size-3.5" />
        </TooltipTrigger>
        <TooltipContent className="max-w-72 whitespace-normal leading-relaxed">
          {content}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export function ConfirmDialog({
  trigger,
  title,
  description,
  cancelLabel,
  confirmLabel,
  onConfirm,
  destructive = false,
}: {
  trigger: React.ReactElement;
  title: string;
  description: string;
  cancelLabel: string;
  confirmLabel: string;
  onConfirm: () => void;
  destructive?: boolean;
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger render={trigger} />
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{cancelLabel}</AlertDialogCancel>
          <AlertDialogAction variant={destructive ? "destructive" : "default"} onClick={onConfirm}>
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** 独立设置卡片:用层级底色和轻微 ring 表达容器,避免页面被细碎边框切成网格。 */
export function SettingCard({
  title,
  description,
  action,
  onReset,
  resetLabel,
  children,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
  onReset?: () => void;
  resetLabel?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="w-full overflow-hidden rounded-xl border border-border bg-card shadow-xs transition-all duration-200 hover:border-border/80">
      <header className="border-b border-border/60 bg-muted/40 px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <p className="min-w-0 text-sm font-medium">{title}</p>
          {action || onReset ? (
            <div className="flex shrink-0 flex-nowrap items-center justify-end gap-1.5">
              {action}
              {onReset ? (
                <Button size="xs" type="button" variant="ghost" onClick={onReset}>
                  <RotateCcwIcon className="size-3.5" />
                  {resetLabel}
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
        {description ? <p className="mt-1 text-xs text-muted-foreground">{description}</p> : null}
      </header>
      <div className="@container/field-group divide-y divide-border/60 px-4">{children}</div>
    </section>
  );
}

export function AdvancedSection({
  title,
  description,
  children,
  defaultOpen = false,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  return (
    <Collapsible defaultOpen={defaultOpen} className="py-1">
      <CollapsibleTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            className="group w-full min-w-0 justify-between whitespace-normal px-1 py-2 text-left"
          />
        }
      >
        <span className="min-w-0">
          <span className="block text-sm font-medium">{title}</span>
          {description ? (
            <span className="mt-0.5 block text-xs font-normal text-muted-foreground">
              {description}
            </span>
          ) : null}
        </span>
        <ChevronDownIcon className="size-4 shrink-0 transition-transform group-aria-expanded:rotate-180" />
      </CollapsibleTrigger>
      <CollapsibleContent className="pl-2">{children}</CollapsibleContent>
    </Collapsible>
  );
}

export function SettingGrid({ children }: { children: React.ReactNode }) {
  return <div className="grid min-w-0 gap-x-5 @md/field-group:grid-cols-2">{children}</div>;
}

export function DependencyGroup({
  enabled,
  children,
  className,
}: {
  enabled: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <fieldset
      disabled={!enabled}
      className={cn(
        "min-w-0 transition-opacity disabled:pointer-events-none disabled:opacity-45",
        className,
      )}
    >
      {children}
    </fieldset>
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
  const items = React.useMemo(
    () => [
      { value: "thread" as const, label: threadLabel },
      { value: "resource" as const, label: resourceLabel },
    ],
    [threadLabel, resourceLabel],
  );

  return (
    <Select
      items={items}
      onValueChange={(v) => v !== null && onChange(v as "thread" | "resource")}
      value={value}
    >
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
  suffix,
  presets,
  onChange,
}: {
  title: string;
  description?: string;
  value: number;
  min: number;
  max: number;
  step: number;
  suffix?: string;
  presets?: Array<{ label: string; value: number }>;
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
        <span className="shrink-0 text-sm font-medium tabular-nums">
          {value}
          {suffix ? ` ${suffix}` : ""}
        </span>
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
      {presets?.length ? (
        <div className="flex flex-wrap justify-between gap-1.5">
          {presets.map((preset) => (
            <Button
              key={preset.label}
              type="button"
              size="xs"
              variant={value === preset.value ? "secondary" : "ghost"}
              onClick={() => onChange(preset.value)}
            >
              {preset.label}
            </Button>
          ))}
        </div>
      ) : null}
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
  confirm,
}: {
  title: string;
  description?: string;
  value: T;
  options: Array<{ value: T; label: string; description?: string }>;
  onChange: (value: T) => void;
  width?: string;
  confirm?: {
    when: (value: T) => boolean;
    title: string;
    description: string;
    cancelLabel: string;
    confirmLabel: string;
  };
}) {
  const [pending, setPending] = React.useState<T | null>(null);
  const select = (next: T) => {
    if (confirm?.when(next)) setPending(next);
    else onChange(next);
  };
  return (
    <SettingRow description={description} title={title}>
      <Select items={options} onValueChange={(v) => v !== null && select(v as T)} value={value}>
        <SelectTrigger className={`${width} shrink-0`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent className="min-w-64">
          {options.map((option) => (
            <SelectItem className="items-start py-2" key={option.value} value={option.value}>
              <span className="min-w-0 whitespace-normal">
                <span className="block font-medium">{option.label}</span>
                {(option.description ?? description) ? (
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    {option.description ?? description}
                  </span>
                ) : null}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {confirm ? (
        <AlertDialog
          open={pending !== null}
          onOpenChange={(open) => {
            if (!open) setPending(null);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{confirm.title}</AlertDialogTitle>
              <AlertDialogDescription>{confirm.description}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{confirm.cancelLabel}</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                onClick={() => {
                  if (pending !== null) onChange(pending);
                  setPending(null);
                }}
              >
                {confirm.confirmLabel}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
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
  placeholder,
  hint,
  emptyValue,
}: {
  title: string;
  description?: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
  placeholder?: string;
  hint?: string;
  emptyValue?: number;
}) {
  const displayValue = emptyValue !== undefined && value === emptyValue ? "" : String(value);
  const handleChange = (raw: string) => {
    if (!raw && emptyValue !== undefined) {
      onChange(emptyValue);
      return;
    }
    const next = Number(raw);
    if (Number.isFinite(next)) onChange(next);
  };

  return (
    <SettingRow defaultHint={hint} description={description} title={title}>
      {suffix ? (
        <InputGroup className="w-full min-w-32 @md/field-group:w-36">
          <InputGroupInput
            className="text-right font-mono text-xs"
            max={max}
            min={min}
            onChange={(e) => handleChange(e.target.value)}
            placeholder={placeholder}
            step={step}
            type="number"
            value={displayValue}
          />
          <InputGroupAddon align="inline-end" className="pr-2 text-xs text-muted-foreground">
            {suffix}
          </InputGroupAddon>
        </InputGroup>
      ) : (
        <Input
          className="w-full min-w-32 text-right font-mono text-xs @md/field-group:w-36"
          max={max}
          min={min}
          onChange={(e) => handleChange(e.target.value)}
          placeholder={placeholder}
          step={step}
          type="number"
          value={displayValue}
        />
      )}
    </SettingRow>
  );
}

interface KeyValueRow {
  id: string;
  key: string;
  value: string;
}

export function KeyValueEditor({
  title,
  description,
  value,
  keyLabel,
  valueLabel,
  addLabel,
  removeLabel,
  duplicateLabel,
  quickEntries = [],
  onChange,
}: {
  title: string;
  description?: string;
  value: Record<string, string>;
  keyLabel: string;
  valueLabel: string;
  addLabel: string;
  removeLabel: string;
  duplicateLabel: string;
  quickEntries?: Array<{ key: string; value: string }>;
  onChange: (value: Record<string, string>) => void;
}) {
  const [rows, setRows] = React.useState<KeyValueRow[]>(() =>
    Object.entries(value).map(([key, entryValue]) => ({ id: nanoid(), key, value: entryValue })),
  );
  React.useEffect(() => {
    const entries = Object.entries(value);
    setRows((current) =>
      current.length === entries.length &&
      current.every(
        (row, index) => row.key === entries[index][0] && row.value === entries[index][1],
      )
        ? current
        : entries.map(([key, entryValue]) => ({ id: nanoid(), key, value: entryValue })),
    );
  }, [value]);

  const commit = (next: KeyValueRow[]) => {
    setRows(next);
    const keys = next.map((row) => row.key.trim()).filter(Boolean);
    if (keys.length !== next.length || new Set(keys).size !== keys.length) return;
    onChange(Object.fromEntries(next.map((row) => [row.key.trim(), row.value])));
  };
  const duplicateKeys = new Set(
    rows
      .map((row) => row.key.trim())
      .filter((key, index, keys) => key && keys.indexOf(key) !== index),
  );

  return (
    <Field className="min-w-0 py-3">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
        <FieldContent className="min-w-0">
          <FieldTitle>{title}</FieldTitle>
          {description ? (
            <FieldDescription className="text-xs">{description}</FieldDescription>
          ) : null}
        </FieldContent>
        <Button
          type="button"
          size="xs"
          variant="outline"
          onClick={() => commit([...rows, { id: nanoid(), key: "", value: "" }])}
        >
          <PlusIcon />
          {addLabel}
        </Button>
      </div>
      {quickEntries.length ? (
        <div className="flex flex-wrap gap-1.5">
          {quickEntries
            .filter((entry) => !rows.some((row) => row.key === entry.key))
            .map((entry) => (
              <Button
                key={entry.key}
                type="button"
                size="xs"
                variant="ghost"
                onClick={() =>
                  commit([...rows, { id: nanoid(), key: entry.key, value: entry.value }])
                }
              >
                <PlusIcon />
                {entry.key}
              </Button>
            ))}
        </div>
      ) : null}
      <div className="space-y-2">
        {rows.map((row, index) => (
          <div
            key={row.id}
            className="grid min-w-0 gap-2 sm:grid-cols-[minmax(8rem,1fr)_minmax(8rem,1fr)_auto]"
          >
            <Input
              aria-invalid={duplicateKeys.has(row.key.trim()) || !row.key.trim()}
              aria-label={keyLabel}
              placeholder={keyLabel}
              value={row.key}
              onChange={(event) =>
                commit(
                  rows.map((item, itemIndex) =>
                    itemIndex === index ? { ...item, key: event.target.value } : item,
                  ),
                )
              }
            />
            <Input
              aria-label={valueLabel}
              placeholder={valueLabel}
              value={row.value}
              onChange={(event) =>
                commit(
                  rows.map((item, itemIndex) =>
                    itemIndex === index ? { ...item, value: event.target.value } : item,
                  ),
                )
              }
            />
            <Button
              type="button"
              size="icon"
              variant="ghost"
              aria-label={removeLabel}
              onClick={() => commit(rows.filter((_, itemIndex) => itemIndex !== index))}
            >
              <XIcon />
            </Button>
          </div>
        ))}
      </div>
      {duplicateKeys.size ? <FieldError>{duplicateLabel}</FieldError> : null}
    </Field>
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

export { CAPABILITY_STYLES, CapabilityBadges } from "@/entities/workbench";
