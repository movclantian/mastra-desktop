import { getUsage } from "tokenlens";
import { getProvidersConfig, routerPrefix, type UserProviderConfig } from "./models/providers";
import { appStorage } from "./storage";

const INPUT_TOKENS_METRIC = "mastra_model_total_input_tokens";
const OUTPUT_TOKENS_METRIC = "mastra_model_total_output_tokens";
const DURATION_METRIC = "mastra_model_duration_ms";

export interface UsageSummary {
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
    source: "observability";
    cost: number | null;
  }>;
}

type MetricRecord = {
  metricId?: string | null;
  timestamp: Date;
  value: number;
  spanId?: string | null;
  requestId?: string | null;
  provider?: string | null;
  model?: string | null;
  estimatedCost?: number | null;
  labels?: Record<string, string>;
};

type MetricFilters = {
  resourceId: string;
  timestamp: { start: Date; end: Date; endExclusive: true };
};

type MetricSeries = {
  points: Array<{ timestamp: Date; value: number }>;
};

function metricStore() {
  return appStorage.getStore("observability").then((store) => {
    if (!store) throw new Error("Mastra observability storage is unavailable");
    return store;
  });
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function metricKey(metric: MetricRecord): string {
  return metric.requestId || metric.spanId || metric.metricId || metric.timestamp.toISOString();
}

function dateKey(value: Date): string {
  const date = new Date(value);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

const PROVIDER_KIND_SUFFIX =
  /\.(?:chat|responses|messages|generateContent|completion|embedding|textEmbedding|image|audio)$/i;

/** Convert an AI SDK provider namespace into the name configured by the user. */
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
  if (configured) return configured.name;

  // Older custom gateway metrics used this fixed namespace. It is only
  // unambiguous when the resource has one custom gateway configured.
  if (namespace === "mastra-work-openai-compatible") {
    const customProviders = configuredProviders.filter((provider) => provider.baseUrl);
    if (customProviders.length === 1) return customProviders[0].name;
  }
  return namespace;
}

function buildFilters(resourceId: string, from: number, to: number): MetricFilters {
  return {
    resourceId,
    timestamp: { start: new Date(from), end: new Date(to), endExclusive: true },
  };
}

async function aggregate(
  name: string | string[],
  aggregation: "sum" | "count" | "max",
  filters: MetricFilters,
) {
  const store = await metricStore();
  return store.getMetricAggregate({
    name: Array.isArray(name) ? name : [name],
    aggregation,
    filters,
  });
}

async function breakdown(
  name: string | string[],
  groupBy: string[],
  filters: MetricFilters,
  aggregation: "sum" | "count" = "sum",
) {
  const store = await metricStore();
  return store.getMetricBreakdown({
    name: Array.isArray(name) ? name : [name],
    groupBy,
    aggregation,
    filters,
  });
}

async function timeSeries(
  name: string | string[],
  aggregation: "sum" | "count",
  filters: MetricFilters,
): Promise<MetricSeries[]> {
  const store = await metricStore();
  const result = await store.getMetricTimeSeries({
    name: Array.isArray(name) ? name : [name],
    interval: "1d",
    aggregation,
    filters,
  });
  return result.series as MetricSeries[];
}

async function listModelMetrics(name: string, filters: MetricFilters): Promise<MetricRecord[]> {
  const store = await metricStore();
  const result = await store.listMetrics({
    filters: { ...filters, name: [name] },
    pagination: { page: 0, perPage: 100 },
    orderBy: { field: "timestamp", direction: "DESC" },
  });
  return result.metrics as MetricRecord[];
}

function seriesMap(series: MetricSeries[] | undefined): Map<string, number> {
  return new Map(
    (series?.[0]?.points ?? []).map((point) => [dateKey(point.timestamp), asNumber(point.value)]),
  );
}

export async function getUsageSummary(
  resourceId: string,
  from: number,
  to: number,
): Promise<UsageSummary> {
  const filters = buildFilters(resourceId, from, to);
  const [
    requests,
    inputTokens,
    outputTokens,
    latency,
    longest,
    inputSeries,
    outputSeries,
    requestSeries,
    providerTokens,
    modelTokens,
    providerInput,
    providerOutput,
    modelInput,
    modelOutput,
    providerRequests,
    modelRequests,
    durations,
    inputs,
    outputs,
  ] = await Promise.all([
    aggregate(DURATION_METRIC, "count", filters),
    aggregate(INPUT_TOKENS_METRIC, "sum", filters),
    aggregate(OUTPUT_TOKENS_METRIC, "sum", filters),
    aggregate(DURATION_METRIC, "sum", filters),
    aggregate(DURATION_METRIC, "max", filters),
    timeSeries(INPUT_TOKENS_METRIC, "sum", filters),
    timeSeries(OUTPUT_TOKENS_METRIC, "sum", filters),
    timeSeries(DURATION_METRIC, "count", filters),
    breakdown([INPUT_TOKENS_METRIC, OUTPUT_TOKENS_METRIC], ["provider"], filters),
    breakdown([INPUT_TOKENS_METRIC, OUTPUT_TOKENS_METRIC], ["provider", "model"], filters),
    breakdown(INPUT_TOKENS_METRIC, ["provider"], filters),
    breakdown(OUTPUT_TOKENS_METRIC, ["provider"], filters),
    breakdown(INPUT_TOKENS_METRIC, ["provider", "model"], filters),
    breakdown(OUTPUT_TOKENS_METRIC, ["provider", "model"], filters),
    breakdown(INPUT_TOKENS_METRIC, ["provider"], filters, "count"),
    breakdown(INPUT_TOKENS_METRIC, ["provider", "model"], filters, "count"),
    listModelMetrics(DURATION_METRIC, filters),
    listModelMetrics(INPUT_TOKENS_METRIC, filters),
    listModelMetrics(OUTPUT_TOKENS_METRIC, filters),
  ]);
  const configuredProviders = (await getProvidersConfig(resourceId)).providers;

  function estimateFallbackCost(
    modelId: string | null | undefined,
    inputTokens: number,
    outputTokens: number,
  ): number | null {
    if (!modelId) return null;
    const cleanId = modelId.trim();
    if (!cleanId) return null;
    try {
      const res = getUsage({
        modelId: cleanId,
        usage: { input: inputTokens, output: outputTokens },
      });
      if (res.costUSD?.totalUSD !== undefined && !Number.isNaN(res.costUSD.totalUSD)) {
        return res.costUSD.totalUSD;
      }
    } catch {}
    return null;
  }

  const outputByRequest = new Map(outputs.map((metric) => [metricKey(metric), metric]));
  const durationByRequest = new Map(durations.map((metric) => [metricKey(metric), metric]));
  const requestRows = inputs.map((input) => {
    const key = metricKey(input);
    const output = outputByRequest.get(key);
    const duration = durationByRequest.get(key);
    const inputValue = asNumber(input?.value);
    const outputValue = asNumber(output?.value);
    const costs = [input?.estimatedCost, output?.estimatedCost].filter(
      (value): value is number => typeof value === "number" && Number.isFinite(value),
    );
    const model = input.model || output?.model || duration?.model || "unknown";
    const telemetryCost = costs.length ? costs.reduce((sum, value) => sum + value, 0) : null;
    const fallbackCost =
      telemetryCost == null ? estimateFallbackCost(model, inputValue, outputValue) : null;
    return {
      id: key,
      createdAt: new Date(input.timestamp).toISOString(),
      provider: providerLabel(
        input.provider || output?.provider || duration?.provider,
        configuredProviders,
      ),
      model,
      inputTokens: inputValue,
      outputTokens: outputValue,
      totalTokens: inputValue + outputValue,
      latencyMs: asNumber(duration?.value),
      status: duration?.labels?.status === "error" ? 500 : 200,
      source: "observability" as const,
      cost: telemetryCost ?? fallbackCost,
    };
  });

  const inputByDate = seriesMap(inputSeries);
  const outputByDate = seriesMap(outputSeries);
  const requestByDate = seriesMap(requestSeries);
  const dates = new Set([...inputByDate.keys(), ...outputByDate.keys(), ...requestByDate.keys()]);
  const trend = [...dates].sort().map((date) => {
    const input = inputByDate.get(date) ?? 0;
    const output = outputByDate.get(date) ?? 0;
    return {
      date,
      requests: requestByDate.get(date) ?? 0,
      inputTokens: input,
      outputTokens: output,
      totalTokens: input + output,
    };
  });

  const activity = trend.map((row) => ({
    date: row.date,
    count: row.requests,
    tokens: row.totalTokens,
  }));
  const groupValue = (
    groups: Array<{ dimensions: Record<string, unknown>; value: number }>,
    dimensions: Record<string, string>,
  ) =>
    asNumber(
      groups.find((group) =>
        Object.entries(dimensions).every(
          ([key, value]) => String(group.dimensions[key] ?? "unknown") === value,
        ),
      )?.value,
    );

  const models = modelTokens.groups.map((group) => {
    const rawProvider = String(group.dimensions.provider ?? "unknown");
    const provider = providerLabel(rawProvider, configuredProviders);
    const model = String(group.dimensions.model ?? "unknown");
    const requestGroup = modelRequests.groups.find(
      (item) =>
        String(item.dimensions.provider ?? "unknown") === rawProvider &&
        String(item.dimensions.model ?? "unknown") === model,
    );
    const inTokens = groupValue(modelInput.groups, { provider: rawProvider, model });
    const outTokens = groupValue(modelOutput.groups, { provider: rawProvider, model });
    const fallbackCost =
      group.estimatedCost == null ? estimateFallbackCost(model, inTokens, outTokens) : null;
    const cost = group.estimatedCost ?? fallbackCost;
    const requestCount = asNumber(requestGroup?.value);
    return {
      model,
      provider,
      requests: requestCount,
      inputTokens: inTokens,
      outputTokens: outTokens,
      tokens: asNumber(group.value),
      cost,
      averageCost: cost !== null && requestCount > 0 ? cost / requestCount : null,
    };
  });

  const providers = providerTokens.groups.map((group) => {
    const rawProvider = String(group.dimensions.provider ?? "unknown");
    const provider = providerLabel(rawProvider, configuredProviders);
    const requestGroup = providerRequests.groups.find(
      (item) => String(item.dimensions.provider ?? "unknown") === rawProvider,
    );
    const matchingModels = models.filter((m) => m.provider === provider);
    const modelsCost = matchingModels.some((m) => m.cost !== null)
      ? matchingModels.reduce((sum, m) => sum + (m.cost ?? 0), 0)
      : null;
    return {
      provider,
      requests: asNumber(requestGroup?.value),
      inputTokens: groupValue(providerInput.groups, { provider: rawProvider }),
      outputTokens: groupValue(providerOutput.groups, { provider: rawProvider }),
      tokens: asNumber(group.value),
      cost: group.estimatedCost ?? modelsCost,
    };
  });

  const totalCost = models.reduce((sum, m) => (m.cost == null ? sum : sum + m.cost), 0);
  const hasCost = models.some((m) => typeof m.cost === "number" && Number.isFinite(m.cost));

  return {
    totals: {
      requests: asNumber(requests.value),
      inputTokens: asNumber(inputTokens.value),
      outputTokens: asNumber(outputTokens.value),
      totalTokens: asNumber(inputTokens.value) + asNumber(outputTokens.value),
      totalLatencyMs: asNumber(latency.value),
      longestChatMs: asNumber(longest.value),
      totalCost: hasCost ? totalCost : null,
    },
    activity,
    trend,
    providers,
    models,
    requests: requestRows,
  };
}
