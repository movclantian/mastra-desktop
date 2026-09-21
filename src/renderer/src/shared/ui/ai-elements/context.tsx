"use client";

import type { LanguageModelUsage } from "ai";
import type { ComponentProps } from "react";
import { createContext, useContext, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { breakdownTokens } from "tokenlens";
import {
  type CatalogProviderCostLike as CatalogProvider,
  calculateCostUSD,
  cn,
  formatCostUSD,
} from "@/shared/lib";
import { Button } from "@/shared/ui/button";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/shared/ui/hover-card";
import { ScrollArea } from "@/shared/ui/scroll-area";
import { SlidingNumber } from "@/shared/ui/sliding-number";

const PERCENT_MAX = 100;
const ICON_RADIUS = 10;
const ICON_VIEWBOX = 24;
const ICON_CENTER = 12;
const ICON_STROKE_WIDTH = 2;

const PERCENT_FORMATTER = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 1,
  style: "percent",
});
const COMPACT_NUMBER_FORMATTER = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 1,
  notation: "compact",
  maximumFractionDigits: 1,
});

type ContextUsageColor = "teal" | "amber" | "violet" | "sky";

type ContextUsageMetricId =
  | "non-cached-input"
  | "cache-read"
  | "cache-write"
  | "unclassified-input";

interface ContextUsageMetric {
  id: ContextUsageMetricId;
  label: string;
  tokens: number;
  color: ContextUsageColor;
}

const CONTEXT_USAGE_COLOR_CLASSES: Record<ContextUsageColor, string> = {
  amber: "bg-amber-400",
  sky: "bg-sky-500",
  teal: "bg-teal-500",
  violet: "bg-violet-500",
};

type ModelId = string;

interface ContextSchema {
  maxTokens: number;
  usage?: LanguageModelUsage;
  billingUsage?: LanguageModelUsage;
  modelId?: ModelId;
  catalog?: CatalogProvider[];
}

interface InputTokenBreakdown {
  cacheRead: number;
  cacheWrite: number;
  hasCacheDetails: boolean;
  noCache: number;
  total: number;
  unclassified: number;
}

type ContextValue = ContextSchema & { input: InputTokenBreakdown };

const ContextContext = createContext<ContextValue | null>(null);

const useContextValue = () => {
  const context = useContext(ContextContext);

  if (!context) {
    throw new Error("Context components must be used within Context");
  }

  return context;
};

const getUsagePercent = (tokens: number, maxTokens: number) => {
  if (!Number.isFinite(tokens) || !Number.isFinite(maxTokens) || maxTokens <= 0) return 0;
  return Math.min(PERCENT_MAX, Math.max(0, (tokens / maxTokens) * PERCENT_MAX));
};

const formatUsagePercent = (percent: number) => PERCENT_FORMATTER.format(percent / PERCENT_MAX);

const formatCompactTokens = (tokens: number) => COMPACT_NUMBER_FORMATTER.format(tokens);

/**
 * TokenLens 只归一化供应商真实返回的 token usage,不负责对任意 prompt 文本做
 * tokenizer 估算。AI SDK v7 的 inputTokenDetails 提供缓存分项;供应商未上报的
 * 差额明确保留为 unclassified,不能猜成系统提示词、工具或对话消息。
 */
const splitInputTokens = (usage?: LanguageModelUsage) => {
  const cacheReadTokens = usage?.inputTokenDetails?.cacheReadTokens;
  const cacheWriteTokens = usage?.inputTokenDetails?.cacheWriteTokens;
  const noCacheTokens = usage?.inputTokenDetails?.noCacheTokens;
  const normalized = breakdownTokens({
    input: Math.max(0, usage?.inputTokens ?? 0),
    output: Math.max(0, usage?.outputTokens ?? 0),
    total: Math.max(0, usage?.totalTokens ?? 0),
    ...(cacheReadTokens === undefined ? {} : { cacheReads: Math.max(0, cacheReadTokens) }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWrites: Math.max(0, cacheWriteTokens) }),
    ...(usage?.outputTokenDetails?.reasoningTokens === undefined
      ? {}
      : { reasoningTokens: Math.max(0, usage.outputTokenDetails.reasoningTokens) }),
  });
  const total = Math.max(0, normalized.input);
  const cacheRead = Math.min(total, Math.max(0, normalized.cacheReads ?? 0));
  const cacheWrite = Math.max(0, Math.min(total - cacheRead, normalized.cacheWrites ?? 0));
  const remaining = Math.max(0, total - cacheRead - cacheWrite);
  const noCache = Math.min(remaining, Math.max(0, noCacheTokens ?? 0));
  return {
    cacheRead,
    cacheWrite,
    hasCacheDetails:
      cacheReadTokens !== undefined ||
      cacheWriteTokens !== undefined ||
      noCacheTokens !== undefined,
    noCache,
    total,
    unclassified: Math.max(0, remaining - noCache),
  };
};

const getContextUsageMetrics = (
  input: InputTokenBreakdown,
  t: (key: string) => string,
): ContextUsageMetric[] => {
  return [
    {
      color: "teal",
      id: "non-cached-input",
      label: t("chat:context.metrics.nonCachedInput"),
      tokens: input.noCache,
    },
    {
      color: "violet",
      id: "cache-read",
      label: t("chat:context.metrics.cacheRead"),
      tokens: input.cacheRead,
    },
    {
      color: "amber",
      id: "cache-write",
      label: t("chat:context.metrics.cacheWrite"),
      tokens: input.cacheWrite,
    },
    {
      color: "sky",
      id: "unclassified-input",
      label: t("chat:context.metrics.unclassifiedInput"),
      tokens: input.unclassified,
    },
  ];
};

export type ContextProps = ComponentProps<typeof HoverCard> & ContextSchema;

export const Context = ({
  maxTokens,
  usage,
  billingUsage,
  modelId,
  catalog,
  ...props
}: ContextProps) => {
  const contextValue = useMemo(
    () => ({ catalog, input: splitInputTokens(usage), maxTokens, modelId, usage, billingUsage }),
    [catalog, maxTokens, modelId, usage, billingUsage],
  );

  return (
    <ContextContext.Provider value={contextValue}>
      <HoverCard {...props} />
    </ContextContext.Provider>
  );
};

const ContextIcon = () => {
  const { input, maxTokens } = useContextValue();
  const circumference = 2 * Math.PI * ICON_RADIUS;
  const usedPercent = getUsagePercent(input.total, maxTokens) / PERCENT_MAX;
  const dashOffset = circumference * (1 - usedPercent);

  return (
    <svg
      aria-label="Model context usage"
      className="size-3.5 shrink-0"
      height="16"
      role="img"
      style={{ color: "currentcolor" }}
      viewBox={`0 0 ${ICON_VIEWBOX} ${ICON_VIEWBOX}`}
      width="16"
    >
      <circle
        cx={ICON_CENTER}
        cy={ICON_CENTER}
        fill="none"
        opacity="0.25"
        r={ICON_RADIUS}
        stroke="currentColor"
        strokeWidth={ICON_STROKE_WIDTH}
      />
      <circle
        cx={ICON_CENTER}
        cy={ICON_CENTER}
        fill="none"
        opacity="0.7"
        r={ICON_RADIUS}
        stroke="currentColor"
        strokeDasharray={`${circumference} ${circumference}`}
        strokeDashoffset={dashOffset}
        strokeLinecap="round"
        strokeWidth={ICON_STROKE_WIDTH}
        style={{ transform: "rotate(-90deg)", transformOrigin: "center" }}
      />
    </svg>
  );
};

export type ContextTriggerProps = ComponentProps<typeof Button>;

export const ContextTrigger = ({ children, className, ...props }: ContextTriggerProps) => {
  const { input, maxTokens, usage } = useContextValue();
  const percentNumber = getUsagePercent(input.total, maxTokens);

  return (
    <HoverCardTrigger closeDelay={0} delay={0}>
      {children ?? (
        <Button
          className={cn(
            "h-7 gap-1 px-2 text-xs font-normal text-muted-foreground hover:text-foreground",
            className,
          )}
          size="sm"
          type="button"
          variant="ghost"
          {...props}
        >
          <span className="flex items-center gap-0.5 font-medium tabular-nums">
            {usage?.inputTokens === undefined ? (
              "—"
            ) : (
              <>
                <SlidingNumber number={percentNumber} decimalPlaces={1} />%
              </>
            )}
          </span>
          <ContextIcon />
        </Button>
      )}
    </HoverCardTrigger>
  );
};

export type ContextContentProps = ComponentProps<typeof HoverCardContent>;

export const ContextContent = ({ className, ...props }: ContextContentProps) => (
  <HoverCardContent
    className={cn(
      "w-64 min-w-56 max-w-[calc(100vw-2rem)] divide-y divide-border/60 overflow-hidden p-0 text-xs shadow-lg",
      className,
    )}
    {...props}
  />
);

export type ContextContentHeaderProps = ComponentProps<"div">;

export const ContextContentHeader = ({
  children,
  className,
  ...props
}: ContextContentHeaderProps) => {
  const { t } = useTranslation();
  const { input, maxTokens, usage } = useContextValue();
  const metrics = getContextUsageMetrics(input, t);
  const percentNumber = getUsagePercent(input.total, maxTokens);
  const cachePercent = input.hasCacheDetails
    ? formatUsagePercent(getUsagePercent(input.cacheRead, input.total))
    : "—";

  return (
    <div className={cn("w-full space-y-2 p-3", className)} {...props}>
      {children ?? (
        <>
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">
              {t("chat:context.usageTitle")}
            </span>
          </div>
          <div className="flex items-baseline justify-between gap-3">
            <p className="flex items-baseline gap-0.5 text-lg font-bold tabular-nums text-foreground">
              {usage?.inputTokens === undefined ? (
                "—"
              ) : (
                <>
                  <SlidingNumber number={percentNumber} decimalPlaces={1} />
                  <span className="text-xs font-semibold">%</span>
                </>
              )}
            </p>
            <p className="flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground tabular-nums">
              <span>{t("chat:context.used")}</span>
              <span>
                {usage?.inputTokens === undefined ? "—" : formatCompactTokens(input.total)}
              </span>
              <span>/</span>
              <span>{formatCompactTokens(maxTokens)}</span>
              <span aria-hidden="true">·</span>
              <span>{t("chat:context.cacheRatio", { ratio: cachePercent })}</span>
            </p>
          </div>
          <div
            aria-label={t("chat:context.categoryUsage")}
            aria-valuemax={PERCENT_MAX}
            aria-valuemin={0}
            aria-valuenow={usage?.inputTokens === undefined ? undefined : percentNumber}
            className="flex h-1.5 w-full gap-px overflow-hidden rounded-full bg-muted"
            role="progressbar"
          >
            {metrics.map((metric) => {
              const percent = getUsagePercent(metric.tokens, maxTokens);
              if (percent <= 0) return null;
              return (
                <span
                  aria-label={`${metric.label} ${formatUsagePercent(percent)}`}
                  className={cn("h-full shrink-0", CONTEXT_USAGE_COLOR_CLASSES[metric.color])}
                  key={metric.id}
                  style={{ width: `${percent}%` }}
                />
              );
            })}
          </div>
        </>
      )}
    </div>
  );
};

export type ContextContentBodyProps = ComponentProps<"div">;

export const ContextContentBody = ({ children, className, ...props }: ContextContentBodyProps) => (
  <div className={cn("w-full", className)} {...props}>
    <ScrollArea className="max-h-[min(24rem,calc(100svh-12rem))]">
      <div className="w-full space-y-2 p-3">{children}</div>
    </ScrollArea>
  </div>
);

export type ContextContentBreakdownProps = ComponentProps<"div">;

export const ContextContentBreakdown = ({ className, ...props }: ContextContentBreakdownProps) => {
  const { t } = useTranslation();
  const { input, maxTokens, usage } = useContextValue();
  const metrics = getContextUsageMetrics(input, t);

  if (usage?.inputTokens === undefined)
    return <p className="p-3 text-muted-foreground">{t("chat:context.unknownUsage")}</p>;

  return (
    <div className={cn("w-full space-y-1.5", className)} role="list" {...props}>
      {metrics.map((metric) => {
        const percent = getUsagePercent(metric.tokens, maxTokens);
        return (
          <div
            className="flex min-w-0 items-center justify-between gap-3 text-xs"
            key={metric.id}
            role="listitem"
          >
            <span className="flex min-w-0 items-center gap-2">
              <span
                aria-hidden="true"
                className={cn(
                  "size-2 shrink-0 rounded-full",
                  CONTEXT_USAGE_COLOR_CLASSES[metric.color],
                )}
              />
              <span className="truncate text-foreground/90">{metric.label}</span>
            </span>
            <span className="flex shrink-0 items-baseline gap-2 font-mono text-[11px] tabular-nums">
              <span className="text-muted-foreground">{formatCompactTokens(metric.tokens)}</span>
              <span className="font-medium text-foreground">{formatUsagePercent(percent)}</span>
            </span>
          </div>
        );
      })}
    </div>
  );
};

export type ContextContentFooterProps = ComponentProps<"div">;

export const ContextContentFooter = ({
  children,
  className,
  ...props
}: ContextContentFooterProps) => {
  const { t } = useTranslation();
  const { modelId, billingUsage, catalog } = useContextValue();
  const inputTokens = billingUsage?.inputTokens;
  const outputTokens = billingUsage?.outputTokens;
  const hasBillingUsage =
    inputTokens !== undefined &&
    Number.isFinite(inputTokens) &&
    inputTokens >= 0 &&
    outputTokens !== undefined &&
    Number.isFinite(outputTokens) &&
    outputTokens >= 0;
  const cost =
    modelId && hasBillingUsage
      ? calculateCostUSD(modelId, inputTokens, outputTokens, catalog)
      : null;
  const formattedCost = hasBillingUsage ? formatCostUSD(cost) : "—";

  return (
    <div
      className={cn(
        "flex w-full items-center justify-between gap-3 bg-muted/40 px-3 py-2 text-xs",
        className,
      )}
      {...props}
    >
      {children ?? (
        <>
          <span className="text-muted-foreground">{t("chat:context.totalCost")}</span>
          <span className="font-medium tabular-nums text-foreground">{formattedCost}</span>
        </>
      )}
    </div>
  );
};
