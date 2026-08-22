"use client";

import type { LanguageModelUsage } from "ai";
import type { ComponentProps } from "react";
import { createContext, useContext, useMemo } from "react";
import { getUsage } from "tokenlens";
import { Button } from "@/components/ui/button";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SlidingNumber } from "@/components/ui/sliding-number";
import { cn } from "@/lib/utils";

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

type ContextUsageColor = "teal" | "amber" | "violet";

interface ContextUsageMetric {
  id: "input" | "output" | "reasoning";
  label: string;
  tokens: number;
  color: ContextUsageColor;
}

const CONTEXT_USAGE_COLOR_CLASSES: Record<ContextUsageColor, string> = {
  amber: "bg-amber-400",
  teal: "bg-teal-500",
  violet: "bg-violet-500",
};

type ModelId = string;

interface ContextSchema {
  usedTokens: number;
  maxTokens: number;
  usage?: LanguageModelUsage;
  modelId?: ModelId;
}

const ContextContext = createContext<ContextSchema | null>(null);

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

const getContextUsageMetrics = (usage?: LanguageModelUsage): ContextUsageMetric[] => {
  if (!usage) return [];

  const outputTokens = Math.max(0, usage.outputTokens ?? 0);
  const reasoningTokens = Math.min(outputTokens, usage.outputTokenDetails?.reasoningTokens ?? 0);

  return [
    { color: "teal", id: "input", label: "输入", tokens: usage.inputTokens ?? 0 },
    {
      color: "amber",
      id: "output",
      label: "输出",
      tokens: outputTokens - reasoningTokens,
    },
    { color: "violet", id: "reasoning", label: "思考", tokens: reasoningTokens },
  ];
};

export type ContextProps = ComponentProps<typeof HoverCard> & ContextSchema;

export const Context = ({ usedTokens, maxTokens, usage, modelId, ...props }: ContextProps) => {
  const contextValue = useMemo(
    () => ({ maxTokens, modelId, usage, usedTokens }),
    [maxTokens, modelId, usage, usedTokens],
  );

  return (
    <ContextContext.Provider value={contextValue}>
      <HoverCard {...props} />
    </ContextContext.Provider>
  );
};

const ContextIcon = () => {
  const { usedTokens, maxTokens } = useContextValue();
  const circumference = 2 * Math.PI * ICON_RADIUS;
  const usedPercent = getUsagePercent(usedTokens, maxTokens) / PERCENT_MAX;
  const dashOffset = circumference * (1 - usedPercent);

  return (
    <svg
      aria-label="Model context usage"
      height="20"
      role="img"
      style={{ color: "currentcolor" }}
      viewBox={`0 0 ${ICON_VIEWBOX} ${ICON_VIEWBOX}`}
      width="20"
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

export const ContextTrigger = ({ children, ...props }: ContextTriggerProps) => {
  const { usedTokens, maxTokens } = useContextValue();
  const percentNumber = getUsagePercent(usedTokens, maxTokens);

  return (
    <HoverCardTrigger closeDelay={0} delay={0}>
      {children ?? (
        <Button type="button" variant="ghost" {...props}>
          <span className="flex items-center gap-0.5 font-medium tabular-nums text-muted-foreground">
            <SlidingNumber number={percentNumber} decimalPlaces={1} />%
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
    className={cn("w-72 min-w-60 max-w-[calc(100vw-2rem)] divide-y overflow-hidden p-0", className)}
    {...props}
  />
);

export type ContextContentHeaderProps = ComponentProps<"div">;

export const ContextContentHeader = ({
  children,
  className,
  ...props
}: ContextContentHeaderProps) => {
  const { usage, usedTokens, maxTokens } = useContextValue();
  const metrics = getContextUsageMetrics(usage);
  const percentNumber = getUsagePercent(usedTokens, maxTokens);

  return (
    <div className={cn("w-full space-y-2.5 p-3", className)} {...props}>
      {children ?? (
        <>
          <h3 className="text-base font-semibold">上下文用量</h3>
          <div className="flex items-baseline justify-between gap-3">
            <p className="flex items-baseline gap-0.5 text-xl font-semibold tabular-nums">
              <SlidingNumber number={percentNumber} decimalPlaces={1} />
              <span className="text-sm">%</span>
            </p>
            <p className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground tabular-nums">
              <span>已使用</span>
              <span>{formatCompactTokens(usedTokens)}</span>
              <span>/</span>
              <span>{formatCompactTokens(maxTokens)}</span>
            </p>
          </div>
          <div
            aria-label="上下文分类用量"
            aria-valuemax={PERCENT_MAX}
            aria-valuemin={0}
            aria-valuenow={percentNumber}
            className="flex h-2 w-full gap-px overflow-hidden rounded-sm bg-muted"
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
    <ScrollArea className="max-h-[min(32rem,calc(100svh-12rem))]">
      <div className="w-full space-y-3 p-4">{children}</div>
    </ScrollArea>
  </div>
);

export type ContextContentBreakdownProps = ComponentProps<"div">;

export const ContextContentBreakdown = ({ className, ...props }: ContextContentBreakdownProps) => {
  const { usage, maxTokens } = useContextValue();
  const metrics = getContextUsageMetrics(usage);

  if (metrics.length === 0) return null;

  return (
    <div className={cn("w-full space-y-2.5", className)} role="list" {...props}>
      {metrics.map((metric) => {
        const percent = getUsagePercent(metric.tokens, maxTokens);
        return (
          <div
            className="flex min-w-0 items-center justify-between gap-3"
            key={metric.id}
            role="listitem"
          >
            <span className="flex min-w-0 items-center gap-2 text-sm">
              <span
                aria-hidden="true"
                className={cn(
                  "size-2.5 shrink-0 rounded-full",
                  CONTEXT_USAGE_COLOR_CLASSES[metric.color],
                )}
              />
              <span className="truncate">{metric.label}</span>
            </span>
            <span className="flex shrink-0 items-baseline gap-2 font-mono text-xs tabular-nums">
              <span className="text-muted-foreground">{formatCompactTokens(metric.tokens)}</span>
              <span className="font-semibold text-foreground">{formatUsagePercent(percent)}</span>
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
  const { modelId, usage } = useContextValue();
  const costUSD = modelId
    ? getUsage({
        modelId,
        usage: {
          input: usage?.inputTokens ?? 0,
          output: usage?.outputTokens ?? 0,
        },
      }).costUSD?.totalUSD
    : undefined;
  const totalCost = new Intl.NumberFormat("en-US", {
    currency: "USD",
    style: "currency",
  }).format(costUSD ?? 0);

  return (
    <div
      className={cn(
        "flex w-full items-center justify-between gap-3 bg-secondary p-3 text-xs",
        className,
      )}
      {...props}
    >
      {children ?? (
        <>
          <span className="text-muted-foreground">总费用</span>
          <span>{totalCost}</span>
        </>
      )}
    </div>
  );
};
