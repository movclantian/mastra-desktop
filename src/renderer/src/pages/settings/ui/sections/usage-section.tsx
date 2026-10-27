import { useNavigate } from "@tanstack/react-router";
import { addDays, format, startOfDay, subDays } from "date-fns";
import { CalendarIcon, ExternalLinkIcon, PencilIcon, RefreshCwIcon } from "lucide-react";
import * as React from "react";
import { type Activity, ActivityCalendar } from "react-activity-calendar";
import type { DateRange } from "react-day-picker";
import { Area, AreaChart, CartesianGrid, Line, XAxis } from "recharts";
import { toast } from "sonner";
import { useAuth } from "@/features/auth";
import { requestJson } from "@/shared/api";
import { i18n, useTranslation } from "@/shared/i18n";
import { cn } from "@/shared/lib";
import { useTheme } from "@/shared/theme";
import { confirmAction } from "@/shared/ui/alert-dialog";
import { AnimatedTabs, AnimatedTabsPanel } from "@/shared/ui/animated-tabs";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { Calendar } from "@/shared/ui/calendar";
import { Card, CardContent, CardHeader, CardTitle } from "@/shared/ui/card";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/shared/ui/chart";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { NumberTicker } from "@/shared/ui/number-ticker";
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/shared/ui/pagination";
import { Popover, PopoverContent, PopoverTrigger } from "@/shared/ui/popover";
import { ScrollArea, ScrollBar } from "@/shared/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/shared/ui/select";
import { SlidingNumber } from "@/shared/ui/sliding-number";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/shared/ui/table";
import { Textarea } from "@/shared/ui/textarea";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/shared/ui/tooltip";
import type { MemoryProfile } from "../../../../../../shared/agent-contract";
import { fetchMemoryProfile, fetchUsage } from "../../api/settings-api";

type UsageDetailTab = "requests" | "providers" | "models";

interface UsageSummary {
  totals: {
    requests: number;
    inputTokens: number | null;
    outputTokens: number | null;
    totalTokens: number | null;
    totalLatencyMs: number;
    longestChatMs: number;
    totalCost: number | null;
    costUnit: string | null;
    unpricedRequests: number;
  };
  activity: Array<{ date: string; count: number; tokens: number | null }>;
  trend: Array<{
    date: string;
    requests: number;
    inputTokens: number | null;
    outputTokens: number | null;
    totalTokens: number | null;
  }>;
  providers: Array<{
    provider: string;
    requests: number;
    inputTokens: number | null;
    outputTokens: number | null;
    tokens: number | null;
    cost: number | null;
    costUnit: string | null;
    costSource?: string;
  }>;
  models: Array<{
    model: string;
    provider: string;
    requests: number;
    inputTokens: number | null;
    outputTokens: number | null;
    tokens: number | null;
    cost: number | null;
    costUnit: string | null;
    averageCost: number | null;
  }>;
  requests: Array<{
    id: string;
    createdAt: string;
    provider: string;
    model: string;
    inputTokens: number | null;
    outputTokens: number | null;
    totalTokens: number | null;
    latencyMs: number;
    status: "ok" | "error" | null;
    source: string;
    cost: number | null;
    costUnit: string | null;
    costSource?: string;
  }>;
}

const chartConfig = {
  get inputTokens() {
    return { label: i18n.t("settings:usage.table.input"), color: "#f97316" };
  },
  get outputTokens() {
    return { label: i18n.t("settings:usage.table.output"), color: "#22c55e" };
  },
  get totalTokens() {
    return { label: i18n.t("settings:usage.table.totalTokens"), color: "#a855f7" };
  },
  get requests() {
    return { label: i18n.t("settings:usage.table.requestsCount"), color: "#3b82f6" };
  },
} satisfies ChartConfig;

function formatNumber(value: number | null): string {
  return value === null ? "—" : new Intl.NumberFormat().format(value);
}

function formatCost(value: number | null, unit: string | null): string {
  return value === null || !unit
    ? i18n.t("settings:usage.unpriced")
    : `${new Intl.NumberFormat(undefined, { maximumSignificantDigits: 6 }).format(value)} ${unit}`;
}

function formatProfileValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

function PreferenceValue({
  value,
  depth = 0,
}: {
  value: unknown;
  depth?: number;
}): React.JSX.Element {
  if (value === null || value === undefined)
    return <span className="text-xs text-muted-foreground">—</span>;
  if (typeof value === "string")
    return (
      <p className="min-w-0 whitespace-pre-wrap break-words text-xs leading-relaxed text-foreground/90 [overflow-wrap:anywhere]">
        {value}
      </p>
    );
  if (typeof value === "number" || typeof value === "boolean")
    return <span className="break-words text-xs tabular-nums">{String(value)}</span>;
  if (depth >= 2)
    return (
      <p className="min-w-0 whitespace-pre-wrap break-words font-mono text-[11px] text-muted-foreground [overflow-wrap:anywhere]">
        {formatProfileValue(value)}
      </p>
    );
  if (Array.isArray(value))
    return value.length ? (
      <ul className="flex min-w-0 flex-wrap gap-1.5">
        {value.map((item, index) => (
          <li key={index} className="min-w-0 max-w-full">
            {item === null || ["string", "number", "boolean"].includes(typeof item) ? (
              <Badge
                variant="secondary"
                className="max-w-full whitespace-normal break-words font-normal"
              >
                {item === null ? "—" : String(item)}
              </Badge>
            ) : (
              <PreferenceValue value={item} depth={depth + 1} />
            )}
          </li>
        ))}
      </ul>
    ) : (
      <span className="text-xs text-muted-foreground">—</span>
    );
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    return entries.length ? (
      <dl className="grid min-w-0 grid-cols-[minmax(4rem,auto)_minmax(0,1fr)] items-start gap-x-2 gap-y-1.5">
        {entries.map(([key, item]) => (
          <React.Fragment key={key}>
            <dt className="min-w-0">
              <Badge
                variant="outline"
                className="max-w-full whitespace-normal break-words font-normal"
              >
                {key}
              </Badge>
            </dt>
            <dd className="min-w-0">
              <PreferenceValue value={item} depth={depth + 1} />
            </dd>
          </React.Fragment>
        ))}
      </dl>
    ) : (
      <span className="text-xs text-muted-foreground">—</span>
    );
  }
  return <span className="break-words text-xs">{String(value)}</span>;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  return minutes
    ? `${minutes} ${i18n.t("common:minutesUnit")} ${seconds} ${i18n.t("common:secondsUnit")}`
    : `${seconds} ${i18n.t("common:secondsUnit")}`;
}

/**
 * 时长指标:数值部分走 NumberTicker 弹簧滚动,单位跟着量级切换 ——
 * 直接把 formatDuration 的成品字符串塞进数字组件会丢掉「分/秒/毫秒」的单位。
 */
function DurationTicker({ ms }: { ms: number }) {
  const { t } = useTranslation();
  if (ms < 1000) {
    return (
      <span className="inline-flex items-baseline gap-0.5">
        <NumberTicker className="text-foreground" value={ms} />
        <span className="text-xs font-normal text-muted-foreground">
          {t("common:millisecondsUnit")}
        </span>
      </span>
    );
  }
  const minutes = Math.floor(ms / 60_000);
  if (minutes > 0) {
    return (
      <span className="inline-flex items-baseline gap-0.5">
        <NumberTicker className="text-foreground" value={minutes} />
        <span className="text-xs font-normal text-muted-foreground">{t("common:minutesUnit")}</span>
        <NumberTicker className="text-foreground" value={Math.floor((ms % 60_000) / 1000)} />
        <span className="text-xs font-normal text-muted-foreground">{t("common:secondsUnit")}</span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-baseline gap-0.5">
      <NumberTicker className="text-foreground" decimalPlaces={1} value={ms / 1000} />
      <span className="text-xs font-normal text-muted-foreground">{t("common:secondsUnit")}</span>
    </span>
  );
}

function activityForRange(
  range: DateRange | undefined,
  entries: UsageSummary["activity"],
): Array<Activity & { tokens?: number | null }> {
  const from = startOfDay(range?.from ?? subDays(new Date(), 30));
  const to = startOfDay(range?.to ?? new Date());
  const byDate = new Map(entries.map((entry) => [entry.date, entry]));
  const result: Array<Activity & { tokens?: number | null }> = [];
  for (let date = from; date <= to; date = addDays(date, 1)) {
    const key = format(date, "yyyy-MM-dd");
    const item = byDate.get(key);
    const count = item?.count ?? 0;
    const tokens = item ? item.tokens : 0;
    result.push({
      date: key,
      count,
      tokens,
      level: count === 0 ? 0 : Math.min(4, Math.ceil(Math.log10(count + 1))),
    });
  }
  return result;
}

const PAGE_SIZE = 10;

export function UsageSection() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { isDark } = useTheme();
  const [range, setRange] = React.useState<DateRange>({
    from: subDays(new Date(), 30),
    to: new Date(),
  });
  const [summary, setSummary] = React.useState<UsageSummary | null>(null);
  const [profile, setProfile] = React.useState<MemoryProfile | null>(null);
  const [memoryThreadId, setMemoryThreadId] = React.useState("");
  const [profileFailed, setProfileFailed] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const [detailTab, setDetailTab] = React.useState<UsageDetailTab>("requests");
  const [requestsPage, setRequestsPage] = React.useState(1);
  const [providersPage, setProvidersPage] = React.useState(1);
  const [modelsPage, setModelsPage] = React.useState(1);

  const query = React.useMemo(() => {
    const params = new URLSearchParams();
    if (range.from) params.set("from", format(startOfDay(range.from), "yyyy-MM-dd"));
    if (range.to) params.set("to", format(addDays(startOfDay(range.to), 1), "yyyy-MM-dd"));
    return `?${params}`;
  }, [range.from, range.to]);

  React.useEffect(() => {
    setRequestsPage(1);
    setProvidersPage(1);
    setModelsPage(1);
  }, [query]);

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const [usage, memoryProfile] = await Promise.allSettled([
        fetchUsage<UsageSummary>(query),
        fetchMemoryProfile<MemoryProfile>(memoryThreadId || undefined),
      ]);
      setSummary(usage.status === "fulfilled" ? usage.value : null);
      setProfile(memoryProfile.status === "fulfilled" ? memoryProfile.value : null);
      setProfileFailed(memoryProfile.status === "rejected");
    } catch {
      setSummary(null);
      setProfile(null);
    } finally {
      setLoading(false);
    }
  }, [query, memoryThreadId]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const totals = summary?.totals ?? {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    totalLatencyMs: 0,
    longestChatMs: 0,
    totalCost: null,
    costUnit: null,
    unpricedRequests: 0,
  };
  const activity = activityForRange(range, summary?.activity ?? []);
  const trend = summary?.trend ?? [];
  const hasTokenTrend = trend.some(
    (point) => point.totalTokens != null || point.inputTokens != null || point.outputTokens != null,
  );
  const averageLatencyMs = totals.requests
    ? Math.round(totals.totalLatencyMs / totals.requests)
    : 0;
  const activeDays = summary?.activity.filter((entry) => entry.count > 0).length ?? 0;
  const requestsList = summary?.requests ?? [];
  const requestsTotalPages = Math.ceil(requestsList.length / PAGE_SIZE) || 1;
  const safeRequestsPage = Math.min(Math.max(1, requestsPage), requestsTotalPages);
  const paginatedRequests = React.useMemo(() => {
    const start = (safeRequestsPage - 1) * PAGE_SIZE;
    return requestsList.slice(start, start + PAGE_SIZE);
  }, [requestsList, safeRequestsPage]);

  /**
   * 数值型指标走动态数字:Token 总量用 SlidingNumber(里程表逐位翻页,
   * 与聊天页上下文用量同一种视觉语言),计数型用 NumberTicker 弹簧滚动。
   * 费用直接显示观测记录的币种;缺失或不完整的费用显示为未知。
   */
  const stats: Array<{ label: string; value: React.ReactNode }> = [
    {
      label: t("settings:usage.stats.totalTokens"),
      value:
        totals.totalTokens === null ? (
          "—"
        ) : (
          <SlidingNumber className="tabular-nums" number={totals.totalTokens} />
        ),
    },
    {
      label: t("settings:usage.stats.requests"),
      value: <NumberTicker className="text-foreground" value={totals.requests} />,
    },
    {
      label: t("settings:usage.stats.totalCost"),
      value: formatCost(totals.totalCost, totals.costUnit),
    },
    {
      label: t("settings:usage.stats.avgLatency"),
      value: <DurationTicker ms={averageLatencyMs} />,
    },
    {
      label: t("settings:usage.stats.maxChatDuration"),
      value: <DurationTicker ms={totals.longestChatMs} />,
    },
    {
      label: t("settings:usage.stats.activeDays"),
      value: <NumberTicker className="text-foreground" value={activeDays} />,
    },
  ];

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <p className="text-xs text-muted-foreground">
        {t("settings:usage.pricingHint", { count: totals.unpricedRequests })}
      </p>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold">{t("settings:usage.title")}</h2>
          <p className="text-xs text-muted-foreground">{t("settings:usage.desc")}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Popover>
            <PopoverTrigger
              render={
                <Button
                  variant="outline"
                  size="sm"
                  className="max-w-full min-w-0 justify-start font-normal"
                >
                  <CalendarIcon className="shrink-0" />
                  <span className="min-w-0 truncate">
                    {range.from
                      ? `${format(range.from, "yyyy-MM-dd")} - ${format(range.to ?? range.from, "yyyy-MM-dd")}`
                      : t("settings:usage.selectDate")}
                  </span>
                </Button>
              }
            />
            <PopoverContent className="w-auto p-0" align="end">
              <Calendar
                mode="range"
                selected={range}
                onSelect={(next) => next && setRange(next)}
                numberOfMonths={2}
              />
            </PopoverContent>
          </Popover>
          <Button
            size="icon-sm"
            variant="ghost"
            title={t("settings:usage.refresh")}
            aria-label={t("settings:usage.refresh")}
            onClick={() => void load()}
          >
            <RefreshCwIcon className={cn(loading && "animate-spin")} />
          </Button>
        </div>
      </div>

      <Card>
        <CardContent className="grid min-w-0 gap-4 p-4 xl:grid-cols-[minmax(16rem,0.8fr)_minmax(0,1.2fr)]">
          <div className="min-w-0 space-y-2">
            <p className="text-sm font-semibold">{t("settings:usage.accountInfo")}</p>
            <div className="space-y-1 text-xs">
              <p className="truncate" title={user?.name ?? user?.email}>
                <span className="text-muted-foreground">{t("settings:usage.name")}</span>
                {user?.name || t("settings:usage.notSet")}
              </p>
              <p className="truncate" title={user?.email}>
                <span className="text-muted-foreground">{t("settings:usage.email")}</span>
                {user?.email || t("settings:usage.notSet")}
              </p>
              <p className="text-muted-foreground">
                {t("settings:usage.threadCount", {
                  count: formatNumber(profile?.threadCount ?? 0),
                })}
              </p>
            </div>
            {profileFailed ? (
              <p role="alert" className="text-xs text-destructive">
                {t("memoryReview:loadFailed")}
              </p>
            ) : null}
            {profile ? (
              <WorkingMemoryReview
                key={[profile.scope, profile.source?.threadId ?? "none"].join(":")}
                profile={profile}
                onSaved={load}
              />
            ) : null}
          </div>
          <div className="min-w-0 space-y-2">
            <Select
              value={memoryThreadId || "recent"}
              disabled={loading}
              onValueChange={(value) => {
                if (value) setMemoryThreadId(value === "recent" ? "" : value);
              }}
            >
              <SelectTrigger aria-label={t("memoryReview:selectThread")} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="recent">{t("memoryReview:recent")}</SelectItem>
                {profile?.threads.map((thread) => (
                  <SelectItem key={thread.id} value={thread.id}>
                    {thread.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{t("memoryReview:extractionHint")}</p>
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-semibold">{t("settings:usage.userPreferences")}</p>
              <span className="shrink-0 text-xs text-muted-foreground">
                {t("settings:usage.itemCount", {
                  count: formatNumber(profile?.extractors.length ?? 0),
                })}
              </span>
            </div>
            {profile?.extractors.length ? (
              <ScrollArea className="max-h-44">
                <div className="space-y-2 pr-2">
                  {profile.extractors.map((item) => (
                    <div
                      key={`${item.threadId}:${item.slug}`}
                      className="min-w-0 space-y-2 rounded-md border border-border/60 bg-muted/10 p-3"
                    >
                      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                        <Badge
                          variant="outline"
                          className="max-w-full whitespace-normal break-words font-medium"
                        >
                          {item.name}
                        </Badge>
                        <span className="shrink-0 text-[10px] text-muted-foreground">
                          {new Date(item.updatedAt).toLocaleDateString(
                            i18n.resolvedLanguage ?? i18n.language,
                          )}
                        </span>
                      </div>
                      <div className="min-w-0 rounded-sm bg-background/60 p-2.5">
                        <PreferenceValue value={item.value} />
                      </div>
                      <p
                        className="min-w-0 break-words text-[10px] text-muted-foreground/70 [overflow-wrap:anywhere]"
                        title={item.threadTitle}
                      >
                        {t("settings:usage.source")}
                        {item.threadTitle}
                      </p>
                      <Button
                        size="xs"
                        variant="link"
                        className="h-auto max-w-full whitespace-normal break-words"
                        onClick={() =>
                          void navigate({ to: "/chat", search: { thread: item.threadId } })
                        }
                      >
                        <ExternalLinkIcon />
                        {t("memoryReview:source")}
                      </Button>
                    </div>
                  ))}
                </div>
              </ScrollArea>
            ) : (
              <p className="text-xs text-muted-foreground">{t("settings:usage.noExtractors")}</p>
            )}
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
        {stats.map((stat) => (
          <Card key={stat.label} className="min-w-0">
            <CardContent className="flex min-w-0 flex-col gap-1 p-3">
              <span className="flex min-w-0 break-words text-lg font-semibold tabular-nums">
                {stat.value}
              </span>
              <span className="truncate text-xs text-muted-foreground">{stat.label}</span>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">{t("settings:usage.activityTitle")}</CardTitle>
        </CardHeader>
        <CardContent className="min-w-0 pb-4">
          <ScrollArea orientation="horizontal" className="w-full min-w-0">
            <div className="min-w-max px-1">
              <TooltipProvider>
                <ActivityCalendar
                  data={activity}
                  colorScheme={isDark ? "dark" : "light"}
                  theme={{ light: ["var(--muted)", "#60a5fa"], dark: ["#2a2a2a", "#60a5fa"] }}
                  labels={{
                    totalCount: t("settings:usage.requestCount", {
                      count: "{{count}}",
                    }),
                  }}
                  blockSize={12}
                  blockMargin={3}
                  blockRadius={3}
                  showWeekdayLabels
                  showTotalCount
                  renderBlock={(block, item) => {
                    const activityItem = item as Activity & { tokens?: number | null };
                    return (
                      <Tooltip key={item.date}>
                        <TooltipTrigger render={block} />
                        <TooltipContent className="text-xs">
                          <div className="flex flex-col gap-0.5">
                            <span className="font-semibold">{item.date}</span>
                            <span>
                              {t("settings:usage.table.requestsCount")}：{formatNumber(item.count)}
                            </span>
                            {activityItem.tokens !== undefined ? (
                              <span>Token：{formatNumber(activityItem.tokens)}</span>
                            ) : null}
                          </div>
                        </TooltipContent>
                      </Tooltip>
                    );
                  }}
                />
              </TooltipProvider>
            </div>
            <ScrollBar orientation="horizontal" />
          </ScrollArea>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex min-w-0 flex-wrap items-center justify-between gap-2 pb-2">
          <CardTitle className="min-w-0 break-words text-sm">
            {t("settings:usage.trendTitle")}
          </CardTitle>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Badge variant="outline" className="shrink-0 text-[10px] font-normal">
              {hasTokenTrend ? t("settings:usage.chartTokens") : t("settings:usage.chartRequests")}
            </Badge>
            <span className="shrink-0 text-xs text-muted-foreground">
              {t("settings:usage.byDay")}
            </span>
          </div>
        </CardHeader>
        <CardContent className="min-w-0 overflow-hidden">
          {trend.length ? (
            <ChartContainer config={chartConfig} className="h-56 min-h-0 w-full min-w-0 md:h-60">
              <AreaChart accessibilityLayer data={trend} margin={{ left: 4, right: 8, top: 8 }}>
                <CartesianGrid vertical={false} />
                <XAxis
                  dataKey="date"
                  tickFormatter={(value) => String(value).slice(5)}
                  tickLine={false}
                  axisLine={false}
                  tickMargin={8}
                  minTickGap={24}
                />
                <ChartTooltip content={<ChartTooltipContent />} />
                {hasTokenTrend ? (
                  <>
                    <Area
                      dataKey="totalTokens"
                      type="monotone"
                      fill="var(--color-totalTokens)"
                      fillOpacity={0.18}
                      stroke="var(--color-totalTokens)"
                      strokeWidth={2}
                    />
                    <Line
                      dataKey="inputTokens"
                      type="monotone"
                      stroke="var(--color-inputTokens)"
                      strokeWidth={2}
                      dot={false}
                    />
                    <Line
                      dataKey="outputTokens"
                      type="monotone"
                      stroke="var(--color-outputTokens)"
                      strokeWidth={2}
                      dot={false}
                    />
                  </>
                ) : (
                  <Line
                    dataKey="requests"
                    type="monotone"
                    stroke="var(--color-requests)"
                    strokeWidth={2}
                    dot={false}
                  />
                )}
              </AreaChart>
            </ChartContainer>
          ) : (
            <div
              role="status"
              className="flex h-56 min-w-0 items-center justify-center rounded-md border border-dashed px-4 text-center text-sm text-muted-foreground md:h-60"
            >
              {loading ? t("common:loading") : t("settings:usage.trendNoData")}
            </div>
          )}
        </CardContent>
      </Card>

      <div className="flex min-w-0 flex-col gap-3">
        <AnimatedTabs
          activeTab={detailTab}
          onChange={(value) => setDetailTab(value as UsageDetailTab)}
          layoutId="usage-detail"
          aria-label={t("settings:usage.tabs.ariaLabel")}
          className="w-full max-w-full overflow-x-auto"
          tabs={[
            { id: "requests", label: t("settings:usage.tabs.requests") },
            { id: "providers", label: t("settings:usage.tabs.providers") },
            { id: "models", label: t("settings:usage.tabs.models") },
          ]}
        />
        <AnimatedTabsPanel activeTab={detailTab} value="requests" layoutId="usage-detail">
          <Card>
            <CardContent className="p-0">
              <ScrollArea className="max-h-[360px] w-full">
                <Table>
                  <TableCaption className="sr-only">
                    {t("settings:usage.tableCaption")}
                  </TableCaption>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("settings:usage.table.time")}</TableHead>
                      <TableHead>{t("settings:usage.table.provider")}</TableHead>
                      <TableHead>{t("settings:usage.table.model")}</TableHead>
                      <TableHead className="text-right">
                        {t("settings:usage.table.input")}
                      </TableHead>
                      <TableHead className="text-right">
                        {t("settings:usage.table.output")}
                      </TableHead>
                      <TableHead className="text-right">
                        {t("settings:usage.table.totalTokens")}
                      </TableHead>
                      <TableHead className="text-right">{t("settings:usage.table.cost")}</TableHead>
                      <TableHead className="text-right">
                        {t("settings:usage.table.duration")}
                      </TableHead>
                      <TableHead className="text-right">
                        {t("settings:usage.table.status")}
                      </TableHead>
                      <TableHead>{t("settings:usage.table.source")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {!requestsList.length ? (
                      <TableRow>
                        <TableCell
                          colSpan={10}
                          className="h-28 text-center text-xs text-muted-foreground"
                        >
                          {t("settings:usage.table.noRequests")}
                        </TableCell>
                      </TableRow>
                    ) : (
                      paginatedRequests.map((request) => {
                        const requestCost = request.cost;
                        return (
                          <TableRow key={request.id}>
                            <TableCell>
                              {new Date(request.createdAt).toLocaleString("zh-CN", {
                                month: "2-digit",
                                day: "2-digit",
                                hour: "2-digit",
                                minute: "2-digit",
                              })}
                            </TableCell>
                            <TableCell>{request.provider}</TableCell>
                            <TableCell className="max-w-56 truncate font-mono text-xs">
                              {request.model}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {formatNumber(request.inputTokens)}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {formatNumber(request.outputTokens)}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {formatNumber(request.totalTokens)}
                            </TableCell>
                            <TableCell
                              className="text-right tabular-nums font-mono text-xs"
                              title={request.costSource}
                            >
                              {request.costSource ? "~ " : ""}
                              {formatCost(requestCost, request.costUnit)}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {formatDuration(request.latencyMs)}
                            </TableCell>
                            <TableCell
                              className={cn(
                                "text-right",
                                request.status === "ok"
                                  ? "text-emerald-500"
                                  : request.status === "error"
                                    ? "text-destructive"
                                    : "text-muted-foreground",
                              )}
                            >
                              {request.status === "ok"
                                ? t("common:success")
                                : request.status === "error"
                                  ? t("common:error")
                                  : t("common:unknown")}
                            </TableCell>
                            <TableCell className="text-muted-foreground">
                              {request.source}
                            </TableCell>
                          </TableRow>
                        );
                      })
                    )}
                  </TableBody>
                </Table>
              </ScrollArea>
              <TablePagination
                currentPage={safeRequestsPage}
                totalPages={requestsTotalPages}
                totalItems={requestsList.length}
                onPageChange={setRequestsPage}
              />
            </CardContent>
          </Card>
        </AnimatedTabsPanel>
        <AnimatedTabsPanel activeTab={detailTab} value="providers" layoutId="usage-detail">
          <StatsTable
            caption={t("settings:usage.tabs.providers")}
            headers={[
              t("settings:usage.table.provider"),
              t("settings:usage.table.requestsCount"),
              t("settings:usage.table.tokens"),
              t("settings:usage.table.cost"),
            ]}
            rows={(summary?.providers ?? []).map((row) => {
              return [
                row.provider,
                formatNumber(row.requests),
                formatNumber(row.tokens),
                formatCost(row.cost, row.costUnit),
              ];
            })}
            page={providersPage}
            onPageChange={setProvidersPage}
            pageSize={PAGE_SIZE}
          />
        </AnimatedTabsPanel>
        <AnimatedTabsPanel activeTab={detailTab} value="models" layoutId="usage-detail">
          <StatsTable
            caption={t("settings:usage.tabs.models")}
            headers={[
              t("settings:usage.table.model"),
              t("settings:usage.table.provider"),
              t("settings:usage.table.requestsCount"),
              t("settings:usage.table.tokens"),
              t("settings:usage.table.totalCost"),
              t("settings:usage.table.avgCost"),
            ]}
            rows={(summary?.models ?? []).map((row) => {
              return [
                row.model,
                row.provider,
                formatNumber(row.requests),
                formatNumber(row.tokens),
                formatCost(row.cost, row.costUnit),
                formatCost(row.averageCost, row.costUnit),
              ];
            })}
            page={modelsPage}
            onPageChange={setModelsPage}
            pageSize={PAGE_SIZE}
          />
        </AnimatedTabsPanel>
      </div>
    </div>
  );
}

function getPageNumbers(currentPage: number, totalPages: number): (number | "ellipsis")[] {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, i) => i + 1);
  }
  if (currentPage <= 4) {
    return [1, 2, 3, 4, 5, "ellipsis", totalPages];
  }
  if (currentPage >= totalPages - 3) {
    return [
      1,
      "ellipsis",
      totalPages - 4,
      totalPages - 3,
      totalPages - 2,
      totalPages - 1,
      totalPages,
    ];
  }
  return [1, "ellipsis", currentPage - 1, currentPage, currentPage + 1, "ellipsis", totalPages];
}

function TablePagination({
  currentPage,
  totalPages,
  totalItems,
  onPageChange,
}: {
  currentPage: number;
  totalPages: number;
  totalItems: number;
  onPageChange: (page: number) => void;
}) {
  const { t } = useTranslation();
  if (totalItems === 0) return null;

  return (
    <div className="flex items-center justify-between border-t border-border px-4 py-2 bg-background/50">
      <span className="text-xs text-muted-foreground">
        {totalPages > 1
          ? t("settings:usage.pagination", {
              page: currentPage,
              total: totalPages,
              count: totalItems,
            })
          : t("settings:usage.paginationSingle", {
              count: totalItems,
            })}
      </span>
      {totalPages > 1 ? (
        <Pagination className="mx-0 w-auto">
          <PaginationContent>
            <PaginationItem>
              <PaginationPrevious
                text={t("settings:usage.prevPage")}
                className={cn(
                  "h-7 cursor-pointer text-xs",
                  currentPage <= 1 && "pointer-events-none opacity-40",
                )}
                onClick={(e) => {
                  e.preventDefault();
                  if (currentPage > 1) onPageChange(currentPage - 1);
                }}
              />
            </PaginationItem>
            {getPageNumbers(currentPage, totalPages).map((item, idx) =>
              item === "ellipsis" ? (
                <PaginationItem key={`ellipsis-${idx}`}>
                  <PaginationEllipsis className="size-7" />
                </PaginationItem>
              ) : (
                <PaginationItem key={item}>
                  <PaginationLink
                    isActive={currentPage === item}
                    className="size-7 cursor-pointer text-xs"
                    onClick={(e) => {
                      e.preventDefault();
                      onPageChange(item);
                    }}
                  >
                    {item}
                  </PaginationLink>
                </PaginationItem>
              ),
            )}
            <PaginationItem>
              <PaginationNext
                text={t("settings:usage.nextPage")}
                className={cn(
                  "h-7 cursor-pointer text-xs",
                  currentPage >= totalPages && "pointer-events-none opacity-40",
                )}
                onClick={(e) => {
                  e.preventDefault();
                  if (currentPage < totalPages) onPageChange(currentPage + 1);
                }}
              />
            </PaginationItem>
          </PaginationContent>
        </Pagination>
      ) : null}
    </div>
  );
}

function StatsTable({
  caption,
  headers,
  rows,
  page = 1,
  onPageChange,
  pageSize = PAGE_SIZE,
}: {
  caption?: string;
  headers: string[];
  rows: string[][];
  page?: number;
  onPageChange?: (page: number) => void;
  pageSize?: number;
}) {
  const { t } = useTranslation();
  const totalPages = Math.ceil(rows.length / pageSize) || 1;
  const safePage = Math.min(Math.max(1, page), totalPages);
  const paginatedRows = rows.slice((safePage - 1) * pageSize, safePage * pageSize);

  return (
    <Card>
      <CardContent className="p-0">
        <ScrollArea className="max-h-[360px] w-full">
          <Table>
            {caption ? <TableCaption className="sr-only">{caption}</TableCaption> : null}
            <TableHeader>
              <TableRow>
                {headers.map((header) => (
                  <TableHead key={header}>{header}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={headers.length}
                    className="h-24 text-center text-xs text-muted-foreground"
                  >
                    {t("settings:usage.table.noStats")}
                  </TableCell>
                </TableRow>
              ) : (
                paginatedRows.map((row) => (
                  <TableRow key={row.join(":")}>
                    {row.map((cell, cellIndex) => (
                      <TableCell
                        key={`${headers[cellIndex] ?? cellIndex}:${cell}`}
                        className={cellIndex > 1 ? "tabular-nums" : "font-mono text-xs"}
                      >
                        {cell}
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </ScrollArea>
        {onPageChange ? (
          <TablePagination
            currentPage={safePage}
            totalPages={totalPages}
            totalItems={rows.length}
            onPageChange={onPageChange}
          />
        ) : null}
      </CardContent>
    </Card>
  );
}

/** Human edits target only native working memory, never rewrite the observation log. */
function WorkingMemoryReview({
  profile,
  onSaved,
}: {
  profile: MemoryProfile;
  onSaved: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [open, setOpen] = React.useState(false);
  const [draft, setDraft] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const busy = React.useRef(false);
  const snapshot = React.useRef(profile);
  const close = async (next: boolean) => {
    if (busy.current) return;
    if (
      !next &&
      draft !== (snapshot.current.workingMemory ?? "") &&
      !(await confirmAction(t("memoryReview:discard")))
    )
      return;
    setOpen(next);
  };
  const save = async (clear: boolean) => {
    const original = snapshot.current;
    if (busy.current || !original.source) return;
    if (clear && !(await confirmAction(t("memoryReview:clearWarning")))) return;
    if (!clear && !draft.trim()) {
      toast.error(t("memoryReview:empty"));
      return;
    }
    busy.current = true;
    setSaving(true);
    try {
      await requestJson(
        "/work/memory/profile/working",
        {
          method: "POST",
          body: {
            threadId: original.source.threadId,
            scope: original.scope,
            snapshot: original.snapshot,
            workingMemory: clear ? "" : draft,
            confirmed: true,
            clear,
          },
        },
        t("memoryReview:saveFailed"),
      );
      setOpen(false);
      toast.success(t("memoryReview:saved"));
      await onSaved();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("memoryReview:saveFailed"));
    } finally {
      busy.current = false;
      setSaving(false);
    }
  };
  return (
    <div className="min-w-0 space-y-2 border-t pt-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-medium">{t("settings:usage.workingMemory")}</p>
        <Badge variant="outline">
          {t(profile.scope === "resource" ? "memoryReview:resource" : "memoryReview:thread")}
        </Badge>
      </div>
      <p className="text-xs text-muted-foreground">{t("memoryReview:hint")}</p>
      <ScrollArea className="max-h-32 rounded border p-2">
        <pre className="whitespace-pre-wrap break-words text-[11px] text-muted-foreground">
          {profile.workingMemory || t("memoryReview:none")}
        </pre>
      </ScrollArea>
      <div className="flex flex-wrap gap-2">
        <Button
          size="xs"
          variant="outline"
          disabled={!profile.enabled || profile.readOnly || !profile.source}
          onClick={() => {
            snapshot.current = profile;
            setDraft(profile.workingMemory ?? "");
            setOpen(true);
          }}
        >
          <PencilIcon />
          {t("memoryReview:edit")}
        </Button>
        {profile.source ? (
          <Button
            size="xs"
            variant="link"
            className="h-auto max-w-full whitespace-normal break-words"
            onClick={() =>
              void navigate({ to: "/chat", search: { thread: profile.source?.threadId } })
            }
          >
            <ExternalLinkIcon />
            {profile.source.threadTitle}
          </Button>
        ) : null}
      </div>
      {profile.readOnly || !profile.enabled ? (
        <p className="text-xs text-muted-foreground">{t("memoryReview:disabled")}</p>
      ) : null}
      <Dialog open={open} onOpenChange={(next) => void close(next)}>
        <DialogContent className="flex max-h-[85vh] min-h-0 min-w-0 flex-col sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t("memoryReview:edit")}</DialogTitle>
            <DialogDescription>{t("memoryReview:warning")}</DialogDescription>
          </DialogHeader>
          <ScrollArea className="min-h-0 flex-1">
            <Textarea
              className="min-h-64 resize-y font-mono text-xs"
              aria-label={t("settings:usage.workingMemory")}
              maxLength={100000}
              value={draft}
              disabled={saving}
              onChange={(event) => setDraft(event.target.value)}
            />
          </ScrollArea>
          <p className="text-xs text-muted-foreground">
            {t(
              snapshot.current.format === "schema" ? "memoryReview:json" : "memoryReview:markdown",
            )}
          </p>
          <div className="flex flex-wrap justify-between gap-2">
            <Button variant="destructive" disabled={saving} onClick={() => void save(true)}>
              {t("memoryReview:clear")}
            </Button>
            <div className="flex gap-2">
              <Button variant="outline" disabled={saving} onClick={() => void close(false)}>
                {t("common:cancel")}
              </Button>
              <Button disabled={saving || !draft.trim()} onClick={() => void save(false)}>
                {t("memoryReview:save")}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
