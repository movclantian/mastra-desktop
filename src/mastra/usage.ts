import type { MetricRecord, MetricsFilter, ObservabilityStorage } from "@mastra/core/storage";
import { getProvidersConfig, routerPrefix, type UserProviderConfig } from "./models/providers";
import { appStorage } from "./storage/database";

const INPUT_TOKENS_METRIC = "mastra_model_total_input_tokens";
const OUTPUT_TOKENS_METRIC = "mastra_model_total_output_tokens";
const DURATION_METRIC = "mastra_model_duration_ms";

interface UsageCost {
  cost: number | null;
  costUnit: string | null;
}

interface UsageCounts {
  requests: number;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
}

interface UsageRequest extends UsageCost {
  id: string;
  createdAt: string;
  provider: string;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  latencyMs: number;
  status: "ok" | "error" | null;
  source: "observability";
}

export interface UsageSummary {
  totals: UsageCounts & {
    totalLatencyMs: number;
    longestChatMs: number;
    totalCost: number | null;
    costUnit: string | null;
  };
  activity: Array<{ date: string; count: number; tokens: number | null }>;
  trend: Array<UsageCounts & { date: string }>;
  providers: Array<
    UsageCost & {
      provider: string;
      requests: number;
      inputTokens: number | null;
      outputTokens: number | null;
      tokens: number | null;
    }
  >;
  models: Array<
    UsageCost & {
      model: string;
      provider: string;
      requests: number;
      inputTokens: number | null;
      outputTokens: number | null;
      tokens: number | null;
      averageCost: number | null;
    }
  >;
  requests: UsageRequest[];
}

function spanKey(metric: { traceId?: string | null; spanId?: string | null }): string | null {
  return metric.traceId && metric.spanId ? JSON.stringify([metric.traceId, metric.spanId]) : null;
}

function sumKnown(values: Array<number | null>): number | null {
  return values.some((value) => value === null)
    ? null
    : values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
}

function metricValue(metrics: MetricRecord[], name: string): number | null {
  const matches = metrics.filter((metric) => metric.name === name);
  return matches.length ? matches.reduce((sum, metric) => sum + metric.value, 0) : null;
}

function summarizeCost(costs: UsageCost[]): UsageCost {
  const unit = costs[0]?.costUnit;
  if (!unit || costs.some((item) => item.cost === null || item.costUnit !== unit)) {
    return { cost: null, costUnit: null };
  }
  return { cost: sumKnown(costs.map((item) => item.cost)), costUnit: unit };
}

/** Use only Mastra's directional totals; detail metrics overlap these costs. */
function modelCost(metrics: MetricRecord[]): UsageCost {
  const unavailable = { cost: null, costUnit: null };
  if (!metrics.length || metrics.some((metric) => metric.costMetadata?.error)) return unavailable;
  const costOf = (metric: MetricRecord): UsageCost => ({
    cost:
      typeof metric.estimatedCost === "number" &&
      Number.isFinite(metric.estimatedCost) &&
      metric.estimatedCost >= 0
        ? metric.estimatedCost
        : null,
    costUnit: metric.costUnit || null,
  });
  const queryTotals = metrics.filter(
    (metric) =>
      metric.costMetadata?.allocation === "query_total" ||
      metric.costMetadata?.scope === "query_total",
  );
  if (queryTotals.length) {
    const total = costOf(queryTotals[0]);
    // A provider-reported query total uses one carrier metric. Identical
    // repeated totals are one cost; conflicting totals remain unavailable.
    if (
      queryTotals.some(
        (metric) => metric.estimatedCost !== total.cost || metric.costUnit !== total.costUnit,
      ) ||
      metrics.some((metric) => !queryTotals.includes(metric) && metric.estimatedCost != null)
    )
      return unavailable;
    return summarizeCost([total]);
  }
  if (
    metrics.filter((metric) => metric.name === INPUT_TOKENS_METRIC).length !== 1 ||
    metrics.filter((metric) => metric.name === OUTPUT_TOKENS_METRIC).length !== 1
  )
    return unavailable;
  return summarizeCost(metrics.map(costOf));
}

const PROVIDER_KIND_SUFFIX =
  /\.(?:chat|responses|messages|generateContent|completion|embedding|textEmbedding|image|audio)$/i;

function providerLabel(
  rawValue: string | null | undefined,
  configuredProviders: UserProviderConfig[],
): string {
  const raw = rawValue?.trim() || "unknown";
  const namespace = raw.replace(PROVIDER_KIND_SUFFIX, "");
  const configured = configuredProviders.find(
    (provider) =>
      provider.name.trim() === raw ||
      provider.name.trim() === namespace ||
      provider.id === namespace ||
      provider.registryId === namespace ||
      routerPrefix(provider) === namespace,
  );
  return configured?.name ?? namespace;
}

async function listAllMetrics(
  store: ObservabilityStorage,
  filters: MetricsFilter,
): Promise<MetricRecord[]> {
  const metrics: MetricRecord[] = [];
  const seen = new Set<string>();
  for (let page = 0; ; page++) {
    const result = await store.listMetrics({
      filters,
      pagination: { page, perPage: 100 },
      orderBy: { field: "timestamp", direction: "ASC" },
    });
    for (const metric of result.metrics) {
      if (metric.metricId && seen.has(metric.metricId)) continue;
      if (metric.metricId) seen.add(metric.metricId);
      metrics.push(metric);
    }
    if (!result.pagination?.hasMore) return metrics;
  }
}

function counts(rows: UsageRequest[]): UsageCounts {
  return {
    requests: rows.length,
    inputTokens: sumKnown(rows.map((row) => row.inputTokens)),
    outputTokens: sumKnown(rows.map((row) => row.outputTokens)),
    totalTokens: sumKnown(rows.map((row) => row.totalTokens)),
  };
}

function groupRows(rows: UsageRequest[], keyOf: (row: UsageRequest) => string) {
  const groups = new Map<string, UsageRequest[]>();
  for (const row of rows) {
    const key = keyOf(row);
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  return groups;
}

export async function getUsageSummary(
  resourceId: string,
  from: number,
  to: number,
): Promise<UsageSummary> {
  const store = await appStorage.getStore("observability");
  if (!store) throw new Error("Mastra observability storage is unavailable");
  const [durations, { providers: configuredProviders }] = await Promise.all([
    listAllMetrics(store, {
      resourceId,
      name: [DURATION_METRIC],
      timestamp: {
        start: new Date(from),
        end: new Date(Math.min(to, Date.now())),
        endExclusive: true,
      },
    }),
    getProvidersConfig(resourceId),
  ]);
  const tokensBySpan = new Map<string, MetricRecord[]>();
  for (const duration of durations) {
    const key = spanKey(duration);
    if (key) tokensBySpan.set(key, []);
  }
  const traceIds = [
    ...new Set(durations.flatMap((metric) => (metric.traceId ? [metric.traceId] : []))),
  ];
  for (let offset = 0; offset < traceIds.length; offset += 1000) {
    // Fetch every token page, including metrics just outside a date boundary.
    const tokens = await listAllMetrics(store, {
      resourceId,
      traceIds: traceIds.slice(offset, offset + 1000),
      name: [INPUT_TOKENS_METRIC, OUTPUT_TOKENS_METRIC],
    });
    for (const metric of tokens) {
      const key = spanKey(metric);
      if (key) tokensBySpan.get(key)?.push(metric);
    }
  }

  const rows = durations.map((duration, index): UsageRequest => {
    const key = spanKey(duration);
    const metrics = key ? (tokensBySpan.get(key) ?? []) : [];
    const inputTokens = metricValue(metrics, INPUT_TOKENS_METRIC);
    const outputTokens = metricValue(metrics, OUTPUT_TOKENS_METRIC);
    return {
      id: key ?? duration.metricId ?? `uncorrelated-${index}`,
      createdAt: new Date(duration.timestamp).toISOString(),
      provider:
        metrics.find((metric) => metric.provider)?.provider ?? duration.provider ?? "unknown",
      model: metrics.find((metric) => metric.model)?.model ?? duration.model ?? "unknown",
      inputTokens,
      outputTokens,
      totalTokens: sumKnown([inputTokens, outputTokens]),
      latencyMs: duration.value,
      status:
        duration.labels.status === "ok" || duration.labels.status === "error"
          ? duration.labels.status
          : null,
      source: "observability",
      ...modelCost(metrics),
    };
  });

  // Failed generations may lack token/cost context. Resolve their model from
  // the exact span through the installed official batch API, never requestId.
  const missingModels = new Map<string, Map<string, UsageRequest>>();
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    const duration = durations[index];
    if (
      (row.provider !== "unknown" && row.model !== "unknown") ||
      !duration.traceId ||
      !duration.spanId
    )
      continue;
    const trace = missingModels.get(duration.traceId) ?? new Map<string, UsageRequest>();
    trace.set(duration.spanId, row);
    missingModels.set(duration.traceId, trace);
  }
  const missingTraces = [...missingModels];
  for (let offset = 0; offset < missingTraces.length; offset += 10) {
    await Promise.all(
      missingTraces.slice(offset, offset + 10).map(async ([traceId, traceRows]) => {
        const result = await store.getSpans({ traceId, spanIds: [...traceRows.keys()] });
        for (const span of result.spans) {
          const row = traceRows.get(span.spanId);
          if (!row || span.resourceId !== resourceId) continue;
          if (row.provider === "unknown" && typeof span.attributes?.provider === "string")
            row.provider = span.attributes.provider;
          const model = span.attributes?.responseModel ?? span.attributes?.model;
          if (row.model === "unknown" && typeof model === "string") row.model = model;
        }
      }),
    );
  }
  for (const row of rows) row.provider = providerLabel(row.provider, configuredProviders);
  rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const trend = [
    ...groupRows(rows, (row) => {
      const date = new Date(row.createdAt);
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    }),
  ]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, group]) => ({ date, ...counts(group) }));
  const providers = [...groupRows(rows, (row) => row.provider)].map(([provider, group]) => {
    const { totalTokens: tokens, ...totals } = counts(group);
    return { provider, ...totals, tokens, ...summarizeCost(group) };
  });
  const models = [...groupRows(rows, (row) => JSON.stringify([row.provider, row.model]))].map(
    ([, group]) => {
      const { totalTokens: tokens, ...totals } = counts(group);
      const cost = summarizeCost(group);
      return {
        provider: group[0].provider,
        model: group[0].model,
        ...totals,
        tokens,
        ...cost,
        averageCost: cost.cost === null ? null : cost.cost / group.length,
      };
    },
  );
  const cost = summarizeCost(rows);
  return {
    totals: {
      ...counts(rows),
      totalLatencyMs: rows.reduce((sum, row) => sum + row.latencyMs, 0),
      longestChatMs: rows.reduce((longest, row) => Math.max(longest, row.latencyMs), 0),
      totalCost: cost.cost,
      costUnit: cost.costUnit,
    },
    activity: trend.map((row) => ({
      date: row.date,
      count: row.requests,
      tokens: row.totalTokens,
    })),
    trend,
    providers,
    models,
    requests: rows,
  };
}
