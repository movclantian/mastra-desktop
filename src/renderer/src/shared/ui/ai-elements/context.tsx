"use client";

import type { LanguageModelUsage } from "ai";
import type { ComponentProps } from "react";
import { createContext, useContext, useMemo } from "react";
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

type ContextUsageColor = "teal" | "amber" | "violet" | "sky" | "rose";

type ContextUsageMetricId =
  | "system-prompt"
  | "tools-and-subagents"
  | "conversation"
  | "mcp"
  | "skills";

interface ContextUsageMetric {
  id: ContextUsageMetricId;
  label: string;
  tokens: number;
  color: ContextUsageColor;
}

const CONTEXT_USAGE_COLOR_CLASSES: Record<ContextUsageColor, string> = {
  amber: "bg-amber-400",
  rose: "bg-rose-400",
  sky: "bg-sky-500",
  teal: "bg-teal-500",
  violet: "bg-violet-500",
};

export type ContextUsageBreakdown = Partial<Record<ContextUsageMetricId, number>>;

type ModelId = string;

interface ContextSchema {
  usedTokens: number;
  maxTokens: number;
  usage?: LanguageModelUsage;
  modelId?: ModelId;
  breakdown?: ContextUsageBreakdown;
  catalog?: CatalogProvider[];
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

/**
 * AI SDK v7 的 usage.inputTokens 是「含缓存」的总量,inputTokenDetails 才是分项
 * (noCache / cacheRead / cacheWrite)。展示与计费都必须拆开:缓存命中约 0.1x 输入价,
 * 缓存写入约 1.25x —— 混在一起既看不出命中率,也会把账算错。
 */
const splitInputTokens = (usage?: LanguageModelUsage) => {
  const total = Math.max(0, usage?.inputTokens ?? 0);
  const cacheRead = Math.max(0, Math.min(total, usage?.inputTokenDetails?.cacheReadTokens ?? 0));
  const cacheWrite = Math.max(
    0,
    Math.min(total - cacheRead, usage?.inputTokenDetails?.cacheWriteTokens ?? 0),
  );
  const noCache = Math.max(
    0,
    usage?.inputTokenDetails?.noCacheTokens ?? total - cacheRead - cacheWrite,
  );
  return { cacheRead, cacheWrite, noCache, total };
};

const getContextUsageMetrics = (
  usedTokens: number,
  breakdown?: ContextUsageBreakdown,
): ContextUsageMetric[] => {
  const total = Number.isFinite(usedTokens) ? Math.max(0, usedTokens) : 0;
  const raw = {
    systemPrompt: Math.max(0, breakdown?.["system-prompt"] ?? 0),
    toolsAndSubagents: Math.max(0, breakdown?.["tools-and-subagents"] ?? 0),
    conversation: Math.max(0, breakdown?.conversation ?? 0),
    mcp: Math.max(0, breakdown?.mcp ?? 0),
    skills: Math.max(0, breakdown?.skills ?? 0),
  };
  const specified = Object.values(raw).reduce((sum, tokens) => sum + tokens, 0);
  // Aggregate provider usage can leave a remainder; keep it visible in the
  // conversation segment so the colored bar always represents the total.
  raw.conversation += Math.max(0, total - specified);

  return [
    { color: "teal", id: "system-prompt", label: "系统提示词", tokens: raw.systemPrompt },
    {
      color: "amber",
      id: "tools-and-subagents",
      label: "工具及子智能体",
      tokens: raw.toolsAndSubagents,
    },
    { color: "violet", id: "conversation", label: "对话消息", tokens: raw.conversation },
    { color: "sky", id: "mcp", label: "MCP", tokens: raw.mcp },
    { color: "rose", id: "skills", label: "技能", tokens: raw.skills },
  ];
};

export type ContextProps = ComponentProps<typeof HoverCard> & ContextSchema;

export const Context = ({
  usedTokens,
  maxTokens,
  usage,
  modelId,
  breakdown,
  catalog,
  ...props
}: ContextProps) => {
  const contextValue = useMemo(
    () => ({ breakdown, catalog, maxTokens, modelId, usage, usedTokens }),
    [breakdown, catalog, maxTokens, modelId, usage, usedTokens],
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
  const { usedTokens, maxTokens } = useContextValue();
  const percentNumber = getUsagePercent(usedTokens, maxTokens);

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
  const { usage, usedTokens, maxTokens, breakdown } = useContextValue();
  const metrics = getContextUsageMetrics(usedTokens, breakdown);
  const percentNumber = getUsagePercent(usedTokens, maxTokens);
  const input = splitInputTokens(usage);
  const cachePercent = formatUsagePercent(getUsagePercent(input.cacheRead, input.total));

  return (
    <div className={cn("w-full space-y-2 p-3", className)} {...props}>
      {children ?? (
        <>
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">上下文用量</span>
          </div>
          <div className="flex items-baseline justify-between gap-3">
            <p className="flex items-baseline gap-0.5 text-lg font-bold tabular-nums text-foreground">
              <SlidingNumber number={percentNumber} decimalPlaces={1} />
              <span className="text-xs font-semibold">%</span>
            </p>
            <p className="flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground tabular-nums">
              <span>已使用</span>
              <span>{formatCompactTokens(usedTokens)}</span>
              <span>/</span>
              <span>{formatCompactTokens(maxTokens)}</span>
              <span aria-hidden="true">·</span>
              <span>缓存比 {cachePercent}</span>
            </p>
          </div>
          <div
            aria-label="上下文分类用量"
            aria-valuemax={PERCENT_MAX}
            aria-valuemin={0}
            aria-valuenow={percentNumber}
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
  const { usedTokens, maxTokens, breakdown } = useContextValue();
  const metrics = getContextUsageMetrics(usedTokens, breakdown);

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
  const { modelId, usage, usedTokens, catalog } = useContextValue();
  const input = splitInputTokens(usage);
  const inputTokens = input.total > 0 ? input.total : Math.max(0, usedTokens);
  const outputTokens = usage?.outputTokens ?? 0;

  const cost = modelId ? calculateCostUSD(modelId, inputTokens, outputTokens, catalog) : null;
  const formattedCost = formatCostUSD(cost);

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
          <span className="text-muted-foreground">总费用</span>
          <span className="font-medium tabular-nums text-foreground">{formattedCost}</span>
        </>
      )}
    </div>
  );
};
