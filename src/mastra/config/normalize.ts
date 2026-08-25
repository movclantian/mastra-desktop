/**
 * 配置边界归一化共享底座。
 *
 * 各 app_config 表的 normalize 入口过去各自手写「字符串 record 清洗 / 数值收敛 /
 * 字符串数组清洗」,逻辑分散且容易漂移。本模块集中提供:
 * - 命令式 helper:stringRecord / clampNumber / clampInt / cleanStrings
 * - 声明式 zod 片段:stringRecordSchema / clampNumberSchema / cleanStringsSchema
 *
 * 命令式版本用于在既有 normalize 函数里逐字段处理(渐进迁移);声明式 zod 片段
 * 供新写或重写的配置 schema 直接组合(zod 已是项目依赖,见 routes/agents.ts、
 * tools/web-search.ts)。两者语义一致,按场景取用。
 */
import { z } from "zod";

/**
 * 把 unknown 收敛成 Record<string,string>:丢弃空键与非字符串值。
 * 用于 headers / env / sandboxEnv / lspBinaryOverrides 等配置边界。
 */
export function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      ([key, item]) => key.trim().length > 0 && typeof item === "string",
    ),
  ) as Record<string, string>;
}

export const stringRecordSchema = z
  .record(z.string(), z.string())
  .catch({})
  .transform((entries) => stringRecord(entries));

/**
 * 数值收敛到 [min, max],非有限值回落 fallback。字符串会先 coerce。
 * 是否取整由调用方决定:整数场景用 clampInt,浮点场景用 clampNumber。
 */
export function clampNumber(
  value: unknown,
  fallback: number,
  min = 0,
  max = Number.POSITIVE_INFINITY,
): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

export function clampInt(
  value: unknown,
  fallback: number,
  min = 0,
  max = Number.POSITIVE_INFINITY,
): number {
  return Math.round(clampNumber(value, fallback, min, max));
}

export function clampNumberSchema(fallback: number, min = 0, max = Number.POSITIVE_INFINITY) {
  return z.coerce
    .number()
    .catch(fallback)
    .transform((n) => (Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback));
}

export function clampIntSchema(fallback: number, min = 0, max = Number.POSITIVE_INFINITY) {
  return clampNumberSchema(fallback, min, max).transform((n) => Math.round(n));
}

/**
 * 字符串数组清洗:仅保留字符串、trim、去空、限量。
 * 用于 allowedPaths / skillsPaths / lspDisableServers / scopes 等。
 */
export function cleanStrings(value: unknown, limit = 100): string[] {
  return Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean)
        .slice(0, limit)
    : [];
}

export function cleanStringsSchema(limit = 100) {
  return z
    .array(z.string())
    .catch([])
    .transform((items) => cleanStrings(items, limit));
}
