import { addDays, format, startOfDay, subDays } from "date-fns";
import { CalendarIcon, RefreshCwIcon } from "lucide-react";
import * as React from "react";
import { type Activity, ActivityCalendar } from "react-activity-calendar";
import type { DateRange } from "react-day-picker";
import { Area, AreaChart, CartesianGrid, Line, XAxis } from "recharts";
import { calculateCostUSD, formatCostUSD, useModelCatalog } from "@/entities/workbench";
import { useAuth } from "@/features/auth";
import { i18n, useTranslation } from "@/shared/i18n";
import { cn } from "@/shared/lib";
import { useTheme } from "@/shared/theme";
import { AnimatedTabs, AnimatedTabsPanel } from "@/shared/ui/animated-tabs";
import { Button } from "@/shared/ui/button";
import { Calendar } from "@/shared/ui/calendar";
import { Card, CardContent, CardHeader, CardTitle } from "@/shared/ui/card";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/shared/ui/chart";
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
import { ScrollArea } from "@/shared/ui/scroll-area";
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
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/shared/ui/tooltip";
import { fetchMemoryProfile, fetchUsage } from "../../api/settings-api";

type UsageDetailTab = "requests" | "providers" | "models";

interface UsageSummary {
  totals: {
    requests: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    totalLatencyMs: number;
    longestChatMs: number;
    totalCost: number | null;
  };
  activity: Array<{ date: string; count: number; tokens: number }>;
  trend: Array<{
    date: string;
    requests: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  }>;
  providers: Array<{
    provider: string;
    requests: number;
    inputTokens: number;
    outputTokens: number;
    tokens: number;
    cost: number | null;
  }>;
  models: Array<{
    model: string;
    provider: string;
    requests: number;
    inputTokens: number;
    outputTokens: number;
    tokens: number;
    cost: number | null;
    averageCost: number | null;
  }>;
  requests: Array<{
    id: string;
    createdAt: string;
    provider: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    latencyMs: number;
    status: number;
    source: string;
    cost: number | null;
  }>;
}

interface MemoryProfile {
  workingMemory: string | null;
  extractors: Array<{
    slug: string;
    name: string;
    value: unknown;
    threadId: string;
    threadTitle: string;
    updatedAt: string;
  }>;
  threadCount: number;
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
} satisfies ChartConfig;

function formatNumber(value: number): string {
  return new Intl.NumberFormat().format(value);
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
): Array<Activity & { tokens?: number }> {
  const from = startOfDay(range?.from ?? subDays(new Date(), 30));
  const to = startOfDay(range?.to ?? new Date());
  const byDate = new Map(entries.map((entry) => [entry.date, entry]));
  const result: Array<Activity & { tokens?: number }> = [];
  for (let date = from; date <= to; date = addDays(date, 1)) {
    const key = format(date, "yyyy-MM-dd");
    const item = byDate.get(key);
    const count = item?.count ?? 0;
    const tokens = item?.tokens ?? 0;
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
  const { user } = useAuth();
  const { isDark } = useTheme();
  const [range, setRange] = React.useState<DateRange>({
    from: subDays(new Date(), 30),
    to: new Date(),
  });
  const [summary, setSummary] = React.useState<UsageSummary | null>(null);
  const [profile, setProfile] = React.useState<MemoryProfile | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [detailTab, setDetailTab] = React.useState<UsageDetailTab>("requests");
  const catalog = useModelCatalog();
  const [requestsPage, setRequestsPage] = React.useState(1);
  const [providersPage, setProvidersPage] = React.useState(1);
  const [modelsPage, setModelsPage] = React.useState(1);

  const query = React.useMemo(() => {
    const from = range.from ? format(startOfDay(range.from), "yyyy-MM-dd") : "";
    const to = range.to ? format(addDays(startOfDay(range.to), 1), "yyyy-MM-dd") : "";
    return `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  }, [range.from, range.to]);

  React.useEffect(() => {
    setRequestsPage(1);
    setProvidersPage(1);
    setModelsPage(1);
  }, [query]);

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const [usage, memoryProfile] = await Promise.all([
        fetchUsage<UsageSummary>(query),
        fetchMemoryProfile<MemoryProfile>(),
      ]);
      setSummary(usage);
      setProfile(memoryProfile);
    } catch {
      setSummary(null);
      setProfile(null);
    } finally {
      setLoading(false);
    }
  }, [query]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const augmentedSummary = React.useMemo<UsageSummary | null>(() => {
    if (!summary) return null;

    const requests = summary.requests.map((req) => {
      const cost =
        req.cost ?? calculateCostUSD(req.model, req.inputTokens, req.outputTokens, catalog);
      return { ...req, cost };
    });

    const models = summary.models.map((m) => {
      const cost = m.cost ?? calculateCostUSD(m.model, m.inputTokens, m.outputTokens, catalog);
      const averageCost = cost !== null && m.requests > 0 ? cost / m.requests : null;
      return { ...m, cost, averageCost };
    });

    const providers = summary.providers.map((p) => {
      const providerModels = models.filter((m) => m.provider === p.provider);
      const hasAnyCost = providerModels.some((m) => m.cost !== null);
      const modelsCost = hasAnyCost
        ? providerModels.reduce((acc, m) => acc + (m.cost ?? 0), 0)
        : null;
      const cost = p.cost ?? modelsCost;
      return { ...p, cost };
    });

    const hasAnyCost = models.some((m) => m.cost !== null);
    const totalCost =
      summary.totals.totalCost ??
      (hasAnyCost ? models.reduce((acc, m) => acc + (m.cost ?? 0), 0) : null);

    return {
      ...summary,
      totals: {
        ...summary.totals,
        totalCost,
      },
      providers,
      models,
      requests,
    };
  }, [summary, catalog]);

  const totals = augmentedSummary?.totals ?? {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    totalLatencyMs: 0,
    longestChatMs: 0,
    totalCost: null,
  };
  const activity = activityForRange(range, augmentedSummary?.activity ?? []);
  const averageLatencyMs = totals.requests
    ? Math.round(totals.totalLatencyMs / totals.requests)
    : 0;
  const activeDays = augmentedSummary?.activity.filter((entry) => entry.count > 0).length ?? 0;
  const requestsList = augmentedSummary?.requests ?? [];
  const requestsTotalPages = Math.ceil(requestsList.length / PAGE_SIZE) || 1;
  const safeRequestsPage = Math.min(Math.max(1, requestsPage), requestsTotalPages);
  const paginatedRequests = React.useMemo(() => {
    const start = (safeRequestsPage - 1) * PAGE_SIZE;
    return requestsList.slice(start, start + PAGE_SIZE);
  }, [requestsList, safeRequestsPage]);
  const formatProfileValue = (value: unknown): string => {
    if (typeof value === "string") return value;
    try {
      return JSON.stringify(value) ?? "";
    } catch {
      return String(value);
    }
  };

  /**
   * 数值型指标走动态数字:Token 总量用 SlidingNumber(里程表逐位翻页,
   * 与聊天页上下文用量同一种视觉语言),计数型用 NumberTicker 弹簧滚动。
   * 费用保留 formatCostUSD —— 它有「未定价」「< $0.0001」等非数值分支,
   * 塞进数字组件会丢掉这些语义。
   */
  const stats: Array<{ label: string; value: React.ReactNode }> = [
    {
      label: t("settings:usage.stats.totalTokens"),
      value: <SlidingNumber className="tabular-nums" number={totals.totalTokens} />,
    },
    {
      label: t("settings:usage.stats.requests"),
      value: <NumberTicker className="text-foreground" value={totals.requests} />,
    },
    {
      label: t("settings:usage.stats.totalCost"),
      value: formatCostUSD(totals.totalCost),
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
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold">{t("settings:usage.title")}</h2>
          <p className="text-xs text-muted-foreground">{t("settings:usage.desc")}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Popover>
            <PopoverTrigger
              render={
                <Button variant="outline" size="sm" className="justify-start font-normal">
                  <CalendarIcon />
                  {range.from
                    ? `${format(range.from, "yyyy-MM-dd")} - ${format(range.to ?? range.from, "yyyy-MM-dd")}`
                    : t("settings:usage.selectDate")}
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
        <CardContent className="grid min-w-0 gap-4 p-4 md:grid-cols-[minmax(180px,0.8fr)_minmax(0,1.2fr)]">
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
            {profile?.workingMemory ? (
              <div className="border-t border-border pt-2">
                <p className="mb-1 text-xs font-medium">{t("settings:usage.workingMemory")}</p>
                <ScrollArea className="max-h-28 rounded border border-border/60 p-2">
                  <pre className="whitespace-pre-wrap break-words text-[11px] text-muted-foreground">
                    {profile.workingMemory}
                  </pre>
                </ScrollArea>
              </div>
            ) : null}
          </div>
          <div className="min-w-0 space-y-2">
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
                      className="min-w-0 border-b border-border/60 pb-2 last:border-0 last:pb-0"
                    >
                      <div className="flex min-w-0 items-baseline justify-between gap-2">
                        <span className="truncate text-xs font-medium" title={item.name}>
                          {item.name}
                        </span>
                        <span className="shrink-0 text-[10px] text-muted-foreground">
                          {new Date(item.updatedAt).toLocaleDateString("zh-CN")}
                        </span>
                      </div>
                      <p className="break-words text-xs text-muted-foreground">
                        {formatProfileValue(item.value)}
                      </p>
                      <p
                        className="truncate text-[10px] text-muted-foreground/70"
                        title={item.threadTitle}
                      >
                        {t("settings:usage.source")}
                        {item.threadTitle}
                      </p>
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

      <div className="grid grid-cols-2 gap-2 md:grid-cols-6">
        {stats.map((stat) => (
          <Card key={stat.label} className="min-w-0">
            <CardContent className="flex min-w-0 flex-col gap-1 p-3">
              <span className="flex min-w-0 truncate text-lg font-semibold tabular-nums">
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
        <CardContent className="min-w-0 overflow-x-auto pb-4">
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
                const activityItem = item as Activity & { tokens?: number };
                return (
                  <Tooltip key={item.date}>
                    <TooltipTrigger render={block} />
                    <TooltipContent className="text-xs">
                      <div className="flex flex-col gap-0.5">
                        <span className="font-semibold">{item.date}</span>
                        <span>
                          {t("settings:usage.table.requestsCount")}：{formatNumber(item.count)}
                        </span>
                        {typeof activityItem.tokens === "number" && activityItem.tokens > 0 ? (
                          <span>Token：{formatNumber(activityItem.tokens)}</span>
                        ) : null}
                      </div>
                    </TooltipContent>
                  </Tooltip>
                );
              }}
            />
          </TooltipProvider>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <CardTitle className="text-sm">{t("settings:usage.trendTitle")}</CardTitle>
          <span className="text-xs text-muted-foreground">{t("settings:usage.byDay")}</span>
        </CardHeader>
        <CardContent className="min-w-0">
          <ChartContainer config={chartConfig} className="h-[240px] w-full">
            <AreaChart
              accessibilityLayer
              data={augmentedSummary?.trend ?? []}
              margin={{ left: 4, right: 8, top: 8 }}
            >
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="date"
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                minTickGap={24}
              />
              <ChartTooltip content={<ChartTooltipContent />} />
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
            </AreaChart>
          </ChartContainer>
        </CardContent>
      </Card>

      <div className="flex min-w-0 flex-col gap-3">
        <AnimatedTabs
          activeTab={detailTab}
          onChange={(value) => setDetailTab(value as UsageDetailTab)}
          layoutId="usage-detail"
          aria-label={t("settings:usage.tabs.ariaLabel")}
          className="w-fit"
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
                            <TableCell className="text-right tabular-nums font-mono text-xs">
                              {formatCostUSD(requestCost)}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {formatDuration(request.latencyMs)}
                            </TableCell>
                            <TableCell className="text-right text-emerald-500">
                              {request.status}
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
            rows={(augmentedSummary?.providers ?? []).map((row) => {
              return [
                row.provider,
                formatNumber(row.requests),
                formatNumber(row.tokens),
                formatCostUSD(row.cost),
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
            rows={(augmentedSummary?.models ?? []).map((row) => {
              return [
                row.model,
                row.provider,
                formatNumber(row.requests),
                formatNumber(row.tokens),
                formatCostUSD(row.cost),
                formatCostUSD(row.averageCost),
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
