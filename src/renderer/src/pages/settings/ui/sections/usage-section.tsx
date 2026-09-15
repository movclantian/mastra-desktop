import { addDays, format, startOfDay, subDays } from "date-fns";
import { CalendarIcon, RefreshCwIcon } from "lucide-react";
import * as React from "react";
import { type Activity, ActivityCalendar } from "react-activity-calendar";
import type { DateRange } from "react-day-picker";
import { Area, AreaChart, CartesianGrid, Line, XAxis } from "recharts";
import { formatCostUSD } from "@/entities/workbench";
import { useAuth } from "@/features/auth";
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
  inputTokens: { label: "输入", color: "#f97316" },
  outputTokens: { label: "输出", color: "#22c55e" },
  totalTokens: { label: "总 Token", color: "#a855f7" },
} satisfies ChartConfig;

function formatNumber(value: number): string {
  return new Intl.NumberFormat("zh-CN").format(value);
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  return minutes ? `${minutes} 分 ${seconds} 秒` : `${seconds} 秒`;
}

/**
 * 时长指标:数值部分走 NumberTicker 弹簧滚动,单位跟着量级切换 ——
 * 直接把 formatDuration 的成品字符串塞进数字组件会丢掉「分/秒/毫秒」的单位。
 */
function DurationTicker({ ms }: { ms: number }) {
  if (ms < 1000) {
    return (
      <span className="inline-flex items-baseline gap-0.5">
        <NumberTicker className="text-foreground" value={ms} />
        <span className="text-xs font-normal text-muted-foreground">ms</span>
      </span>
    );
  }
  const minutes = Math.floor(ms / 60_000);
  if (minutes > 0) {
    return (
      <span className="inline-flex items-baseline gap-0.5">
        <NumberTicker className="text-foreground" value={minutes} />
        <span className="text-xs font-normal text-muted-foreground">分</span>
        <NumberTicker className="text-foreground" value={Math.floor((ms % 60_000) / 1000)} />
        <span className="text-xs font-normal text-muted-foreground">秒</span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-baseline gap-0.5">
      <NumberTicker className="text-foreground" decimalPlaces={1} value={ms / 1000} />
      <span className="text-xs font-normal text-muted-foreground">秒</span>
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

export function UsageSection() {
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

  const query = React.useMemo(() => {
    const from = range.from ? format(startOfDay(range.from), "yyyy-MM-dd") : "";
    const to = range.to ? format(addDays(startOfDay(range.to), 1), "yyyy-MM-dd") : "";
    return `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  }, [range.from, range.to]);

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

  const totals = summary?.totals ?? {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    totalLatencyMs: 0,
    longestChatMs: 0,
    totalCost: null,
  };
  const activity = activityForRange(range, summary?.activity ?? []);
  const averageLatencyMs = totals.requests
    ? Math.round(totals.totalLatencyMs / totals.requests)
    : 0;
  const activeDays = summary?.activity.filter((entry) => entry.count > 0).length ?? 0;
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
      label: "累计 Token 数",
      value: <SlidingNumber className="tabular-nums" number={totals.totalTokens} />,
    },
    {
      label: "模型请求数",
      value: <NumberTicker className="text-foreground" value={totals.requests} />,
    },
    { label: "预估总费用", value: formatCostUSD(totals.totalCost) },
    { label: "平均响应时长", value: <DurationTicker ms={averageLatencyMs} /> },
    { label: "最长聊天时长", value: <DurationTicker ms={totals.longestChatMs} /> },
    { label: "活跃天数", value: <NumberTicker className="text-foreground" value={activeDays} /> },
  ];

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold">个人与用量</h2>
          <p className="text-xs text-muted-foreground">当前账号、Agent 提取偏好和模型使用情况。</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Popover>
            <PopoverTrigger
              render={
                <Button variant="outline" size="sm" className="justify-start font-normal">
                  <CalendarIcon />
                  {range.from
                    ? `${format(range.from, "yyyy-MM-dd")} - ${format(range.to ?? range.from, "yyyy-MM-dd")}`
                    : "选择日期"}
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
            title="刷新用量统计"
            aria-label="刷新用量统计"
            onClick={() => void load()}
          >
            <RefreshCwIcon className={cn(loading && "animate-spin")} />
          </Button>
        </div>
      </div>

      <Card>
        <CardContent className="grid min-w-0 gap-4 p-4 md:grid-cols-[minmax(180px,0.8fr)_minmax(0,1.2fr)]">
          <div className="min-w-0 space-y-2">
            <p className="text-sm font-semibold">账号信息</p>
            <div className="space-y-1 text-xs">
              <p className="truncate" title={user?.name ?? user?.email}>
                <span className="text-muted-foreground">名称：</span>
                {user?.name || "未设置"}
              </p>
              <p className="truncate" title={user?.email}>
                <span className="text-muted-foreground">邮箱：</span>
                {user?.email || "未设置"}
              </p>
              <p className="text-muted-foreground">
                已建立 {formatNumber(profile?.threadCount ?? 0)} 个会话
              </p>
            </div>
            {profile?.workingMemory ? (
              <div className="border-t border-border pt-2">
                <p className="mb-1 text-xs font-medium">工作记忆</p>
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
              <p className="text-sm font-semibold">Agent 提取的用户偏好</p>
              <span className="shrink-0 text-xs text-muted-foreground">
                {formatNumber(profile?.extractors.length ?? 0)} 项
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
                        来源：{item.threadTitle}
                      </p>
                    </div>
                  ))}
                </div>
              </ScrollArea>
            ) : (
              <p className="text-xs text-muted-foreground">
                暂无提取结果。完成几轮对话并达到 OM 观察阈值后，这里会显示稳定偏好。
              </p>
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
          <CardTitle className="text-sm">Token 活动</CardTitle>
        </CardHeader>
        <CardContent className="min-w-0 overflow-x-auto pb-4">
          <TooltipProvider>
            <ActivityCalendar
              data={activity}
              colorScheme={isDark ? "dark" : "light"}
              theme={{ light: ["var(--muted)", "#60a5fa"], dark: ["#2a2a2a", "#60a5fa"] }}
              labels={{ totalCount: "{{count}} 次请求" }}
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
                        <span>请求：{formatNumber(item.count)} 次</span>
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
          <CardTitle className="text-sm">使用趋势</CardTitle>
          <span className="text-xs text-muted-foreground">按天</span>
        </CardHeader>
        <CardContent className="min-w-0">
          <ChartContainer config={chartConfig} className="h-[240px] w-full">
            <AreaChart
              accessibilityLayer
              data={summary?.trend ?? []}
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
          aria-label="用量明细"
          className="w-fit"
          tabs={[
            { id: "requests", label: "请求日志" },
            { id: "providers", label: "Provider 统计" },
            { id: "models", label: "模型统计" },
          ]}
        />
        <AnimatedTabsPanel activeTab={detailTab} value="requests" layoutId="usage-detail">
          <Card>
            <CardContent className="p-0">
              <ScrollArea className="max-h-[360px] w-full">
                <Table>
                  <TableCaption className="sr-only">模型请求日志与费用明细</TableCaption>
                  <TableHeader>
                    <TableRow>
                      <TableHead>时间</TableHead>
                      <TableHead>供应商</TableHead>
                      <TableHead>计费模型</TableHead>
                      <TableHead className="text-right">输入</TableHead>
                      <TableHead className="text-right">输出</TableHead>
                      <TableHead className="text-right">总 Token</TableHead>
                      <TableHead className="text-right">预估费用</TableHead>
                      <TableHead className="text-right">用时</TableHead>
                      <TableHead className="text-right">状态</TableHead>
                      <TableHead>来源</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {!summary?.requests?.length ? (
                      <TableRow>
                        <TableCell
                          colSpan={10}
                          className="h-28 text-center text-xs text-muted-foreground"
                        >
                          选定时间范围内暂无请求记录
                        </TableCell>
                      </TableRow>
                    ) : (
                      summary.requests.map((request) => {
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
            </CardContent>
          </Card>
        </AnimatedTabsPanel>
        <AnimatedTabsPanel activeTab={detailTab} value="providers" layoutId="usage-detail">
          <StatsTable
            caption="供应商用量统计"
            headers={["供应商", "请求数", "Tokens", "预估成本"]}
            rows={(summary?.providers ?? []).map((row) => {
              return [
                row.provider,
                formatNumber(row.requests),
                formatNumber(row.tokens),
                formatCostUSD(row.cost),
              ];
            })}
          />
        </AnimatedTabsPanel>
        <AnimatedTabsPanel activeTab={detailTab} value="models" layoutId="usage-detail">
          <StatsTable
            caption="模型用量统计"
            headers={["模型", "供应商", "请求数", "Tokens", "总成本", "单次平均成本"]}
            rows={(summary?.models ?? []).map((row) => {
              return [
                row.model,
                row.provider,
                formatNumber(row.requests),
                formatNumber(row.tokens),
                formatCostUSD(row.cost),
                formatCostUSD(row.averageCost),
              ];
            })}
          />
        </AnimatedTabsPanel>
      </div>
    </div>
  );
}

function StatsTable({
  caption,
  headers,
  rows,
}: {
  caption?: string;
  headers: string[];
  rows: string[][];
}) {
  return (
    <Card>
      <CardContent className="p-0">
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
                  暂无统计数据
                </TableCell>
              </TableRow>
            ) : (
              rows.map((row) => (
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
      </CardContent>
    </Card>
  );
}
