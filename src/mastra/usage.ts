import { nanoid } from "nanoid";
import { WORKBENCH_GATEWAY_ID } from "./models/create-model";
import { getLibsqlClient } from "./storage";

export interface UsageEventInput {
  resourceId: string;
  threadId?: string;
  model?: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  status?: number;
}

export interface UsageSummary {
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
    source: "chat";
  }>;
}

let schemaReady: Promise<void> | undefined;

function ensureUsageSchema(): Promise<void> {
  schemaReady ??= getLibsqlClient().then(async (client) => {
    await client.execute(`
      CREATE TABLE IF NOT EXISTS usage_events (
        id TEXT PRIMARY KEY,
        resource_id TEXT NOT NULL,
        thread_id TEXT,
        created_at INTEGER NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        total_tokens INTEGER NOT NULL,
        latency_ms INTEGER NOT NULL,
        status INTEGER NOT NULL
      )
    `);
    await client.execute(
      "CREATE INDEX IF NOT EXISTS usage_events_resource_date ON usage_events(resource_id, created_at)",
    );
  });
  return schemaReady;
}

function modelParts(value: string | undefined): { provider: string; model: string } {
  const raw = value?.trim() || "unknown";
  const normalized = raw.startsWith(`${WORKBENCH_GATEWAY_ID}/`)
    ? raw.slice(WORKBENCH_GATEWAY_ID.length + 1)
    : raw;
  const separator = normalized.indexOf("/");
  return separator > 0
    ? { provider: normalized.slice(0, separator), model: normalized.slice(separator + 1) }
    : { provider: normalized, model: normalized };
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

export async function recordUsageEvent(input: UsageEventInput): Promise<void> {
  await ensureUsageSchema();
  const { provider, model } = modelParts(input.model);
  const inputTokens = number(input.inputTokens);
  const outputTokens = number(input.outputTokens);
  await (await getLibsqlClient()).execute({
    sql: `INSERT INTO usage_events
      (id, resource_id, thread_id, created_at, provider, model, input_tokens, output_tokens, total_tokens, latency_ms, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      nanoid(),
      input.resourceId,
      input.threadId ?? null,
      Date.now(),
      provider,
      model,
      inputTokens,
      outputTokens,
      inputTokens + outputTokens,
      number(input.latencyMs),
      input.status ?? 200,
    ],
  });
}

function rowsToNumbers<T extends Record<string, unknown>>(rows: T[]): T[] {
  return rows.map(
    (row) =>
      Object.fromEntries(
        Object.entries(row).map(([key, value]) => [
          key,
          typeof value === "bigint" ? Number(value) : value,
        ]),
      ) as T,
  );
}

export async function getUsageSummary(
  resourceId: string,
  from: number,
  to: number,
): Promise<UsageSummary> {
  await ensureUsageSchema();
  const client = await getLibsqlClient();
  const args = [resourceId, from, to];
  const [totalsResult, activityResult, trendResult, providerResult, modelResult, requestResult] =
    await Promise.all([
      client.execute({
        sql: `SELECT COUNT(*) requests, COALESCE(SUM(input_tokens), 0) inputTokens,
          COALESCE(SUM(output_tokens), 0) outputTokens, COALESCE(SUM(total_tokens), 0) totalTokens,
          COALESCE(SUM(latency_ms), 0) totalLatencyMs, COALESCE(MAX(latency_ms), 0) longestChatMs
          FROM usage_events WHERE resource_id = ? AND created_at >= ? AND created_at < ?`,
        args,
      }),
      client.execute({
        sql: `SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch', 'localtime') date,
          COUNT(*) count, COALESCE(SUM(total_tokens), 0) tokens
          FROM usage_events WHERE resource_id = ? AND created_at >= ? AND created_at < ?
          GROUP BY date ORDER BY date`,
        args,
      }),
      client.execute({
        sql: `SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch', 'localtime') date,
          COUNT(*) requests, COALESCE(SUM(input_tokens), 0) inputTokens,
          COALESCE(SUM(output_tokens), 0) outputTokens, COALESCE(SUM(total_tokens), 0) totalTokens
          FROM usage_events WHERE resource_id = ? AND created_at >= ? AND created_at < ?
          GROUP BY date ORDER BY date`,
        args,
      }),
      client.execute({
        sql: `SELECT provider, COUNT(*) requests, COALESCE(SUM(total_tokens), 0) tokens
          FROM usage_events WHERE resource_id = ? AND created_at >= ? AND created_at < ?
          GROUP BY provider ORDER BY tokens DESC`,
        args,
      }),
      client.execute({
        sql: `SELECT model, provider, COUNT(*) requests, COALESCE(SUM(total_tokens), 0) tokens
          FROM usage_events WHERE resource_id = ? AND created_at >= ? AND created_at < ?
          GROUP BY provider, model ORDER BY tokens DESC`,
        args,
      }),
      client.execute({
        sql: `SELECT id, created_at createdAt, provider, model, input_tokens inputTokens,
          output_tokens outputTokens, total_tokens totalTokens, latency_ms latencyMs, status
          FROM usage_events WHERE resource_id = ? AND created_at >= ? AND created_at < ?
          ORDER BY created_at DESC LIMIT 100`,
        args,
      }),
    ]);

  const totals = rowsToNumbers(totalsResult.rows as Record<string, unknown>[])[0] ?? {};
  return {
    totals: {
      requests: number(totals.requests),
      inputTokens: number(totals.inputTokens),
      outputTokens: number(totals.outputTokens),
      totalTokens: number(totals.totalTokens),
      totalLatencyMs: number(totals.totalLatencyMs),
      longestChatMs: number(totals.longestChatMs),
    },
    activity: rowsToNumbers(activityResult.rows as Record<string, unknown>[]).map((row) => ({
      date: String(row.date),
      count: number(row.count),
      tokens: number(row.tokens),
    })),
    trend: rowsToNumbers(trendResult.rows as Record<string, unknown>[]).map((row) => ({
      date: String(row.date),
      requests: number(row.requests),
      inputTokens: number(row.inputTokens),
      outputTokens: number(row.outputTokens),
      totalTokens: number(row.totalTokens),
    })),
    providers: rowsToNumbers(providerResult.rows as Record<string, unknown>[]).map((row) => ({
      provider: String(row.provider),
      requests: number(row.requests),
      tokens: number(row.tokens),
      cost: null,
    })),
    models: rowsToNumbers(modelResult.rows as Record<string, unknown>[]).map((row) => ({
      model: String(row.model),
      provider: String(row.provider),
      requests: number(row.requests),
      tokens: number(row.tokens),
      cost: null,
      averageCost: null,
    })),
    requests: rowsToNumbers(requestResult.rows as Record<string, unknown>[]).map((row) => ({
      id: String(row.id),
      createdAt: new Date(number(row.createdAt)).toISOString(),
      provider: String(row.provider),
      model: String(row.model),
      inputTokens: number(row.inputTokens),
      outputTokens: number(row.outputTokens),
      totalTokens: number(row.totalTokens),
      latencyMs: number(row.latencyMs),
      status: number(row.status),
      source: "chat",
    })),
  };
}
