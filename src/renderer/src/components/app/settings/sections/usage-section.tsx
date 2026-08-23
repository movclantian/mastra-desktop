import { addDays, format, startOfDay, subDays } from "date-fns";
import { CalendarIcon, RefreshCwIcon } from "lucide-react";
import * as React from "react";
import { type Activity, ActivityCalendar } from "react-activity-calendar";
import type { DateRange } from "react-day-picker";
import { Area, AreaChart, CartesianGrid, Line, XAxis } from "recharts";
import { useTheme } from "@/components/theme-provider";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { MASTRA_SERVER_URL } from "@/lib/providers";
import { cn } from "@/lib/utils";

interface UsageSummary {
  totals: {
    requests: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    totalLatencyMs: number;
    longestChatMs: number;
  };
  activity: Array<{ date: string; count: number; tokens: number }>;
  trend: Array<{
    date: string;
    requests: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  }>;
  providers: Array<{ provider: string; requests: number; tokens: number; cost: null }>;
  models: Array<{
    model: string;
    provider: string;
    requests: number;
    tokens: number;
    cost: null;
    averageCost: null;
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
  }>;
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

function activityForRange(
  range: DateRange | undefined,
  entries: UsageSummary["activity"],
): Activity[] {
  const from = startOfDay(range?.from ?? subDays(new Date(), 30));
  const to = startOfDay(range?.to ?? new Date());
  const byDate = new Map(entries.map((entry) => [entry.date, entry]));
  const result: Activity[] = [];
  for (let date = from; date <= to; date = addDays(date, 1)) {
    const key = format(date, "yyyy-MM-dd");
    const count = byDate.get(key)?.count ?? 0;
    result.push({
      date: key,
      count,
      level: count === 0 ? 0 : Math.min(4, Math.ceil(Math.log10(count + 1))),
    });
  }
  return result;
}

export function UsageSection() {
  const { isDark } = useTheme();
  const [range, setRange] = React.useState<DateRange>({
    from: subDays(new Date(), 30),
    to: new Date(),
  });
  const [summary, setSummary] = React.useState<UsageSummary | null>(null);
  const [loading, setLoading] = React.useState(true);

  const query = React.useMemo(() => {
    const from = range.from ? format(startOfDay(range.from), "yyyy-MM-dd") : "";
    const to = range.to ? format(addDays(startOfDay(range.to), 1), "yyyy-MM-dd") : "";
    return `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  }, [range.from, range.to]);

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(`${MASTRA_SERVER_URL}/work/usage${query}`);
      if (!response.ok) throw new Error("用量统计加载失败");
      setSummary((await response.json()) as UsageSummary);
    } catch {
      setSummary(null);
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
  };
  const activity = activityForRange(range, summary?.activity ?? []);

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold">用量统计</h2>
          <p className="text-xs text-muted-foreground">仅显示当前登录用户的数据。</p>
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

      <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
        {[
          ["累计 Token 数", formatNumber(totals.totalTokens)],
          ["模型请求数", formatNumber(totals.requests)],
          [
            "平均响应时长",
            formatDuration(
              totals.requests ? Math.round(totals.totalLatencyMs / totals.requests) : 0,
            ),
          ],
          ["最长聊天时长", formatDuration(totals.longestChatMs)],
          [
            "活跃天数",
            formatNumber(summary?.activity.filter((entry) => entry.count > 0).length ?? 0),
          ],
        ].map(([label, value]) => (
          <Card key={label} className="min-w-0">
            <CardContent className="flex min-w-0 flex-col gap-1 p-3">
              <span className="truncate text-lg font-semibold tabular-nums">{value}</span>
              <span className="truncate text-xs text-muted-foreground">{label}</span>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Token 活动</CardTitle>
        </CardHeader>
        <CardContent className="min-w-0 overflow-x-auto pb-4">
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
          />
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

      <Tabs defaultValue="requests" className="min-w-0">
        <TabsList>
          <TabsTrigger value="requests">请求日志</TabsTrigger>
          <TabsTrigger value="providers">Provider 统计</TabsTrigger>
          <TabsTrigger value="models">模型统计</TabsTrigger>
        </TabsList>
        <TabsContent value="requests" className="min-w-0">
          <Card>
            <CardContent className="p-0">
              <ScrollArea className="max-h-[360px] w-full">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>时间</TableHead>
                      <TableHead>供应商</TableHead>
                      <TableHead>计费模型</TableHead>
                      <TableHead className="text-right">输入</TableHead>
                      <TableHead className="text-right">输出</TableHead>
                      <TableHead className="text-right">总 Token</TableHead>
                      <TableHead className="text-right">用时</TableHead>
                      <TableHead className="text-right">状态</TableHead>
                      <TableHead>来源</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {summary?.requests.map((request) => (
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
                        <TableCell className="text-right tabular-nums">
                          {formatDuration(request.latencyMs)}
                        </TableCell>
                        <TableCell className="text-right text-emerald-500">
                          {request.status}
                        </TableCell>
                        <TableCell className="text-muted-foreground">{request.source}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </ScrollArea>
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="providers" className="min-w-0">
          <StatsTable
            headers={["供应商", "请求数", "Tokens", "成本"]}
            rows={(summary?.providers ?? []).map((row) => [
              row.provider,
              formatNumber(row.requests),
              formatNumber(row.tokens),
              "未定价",
            ])}
          />
        </TabsContent>
        <TabsContent value="models" className="min-w-0">
          <StatsTable
            headers={["模型", "请求数", "Tokens", "总成本", "平均成本"]}
            rows={(summary?.models ?? []).map((row) => [
              row.model,
              formatNumber(row.requests),
              formatNumber(row.tokens),
              "未定价",
              "未定价",
            ])}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function StatsTable({ headers, rows }: { headers: string[]; rows: string[][] }) {
  return (
    <Card>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              {headers.map((header) => (
                <TableHead key={header}>{header}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.join(":")}>
                {row.map((cell, cellIndex) => (
                  <TableCell
                    key={`${headers[cellIndex] ?? cellIndex}:${cell}`}
                    className={cellIndex > 0 ? "tabular-nums" : "font-mono text-xs"}
                  >
                    {cell}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
