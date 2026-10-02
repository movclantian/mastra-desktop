/**
 * 配置边界归一化共享底座:stringRecord / clampNumber / clampInt / cleanStrings,
 * 以及供新写配置 schema 直接组合的 clampNumberSchema / clampIntSchema。
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
