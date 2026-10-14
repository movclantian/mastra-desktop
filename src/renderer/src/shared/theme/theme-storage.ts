import { THEME_PRESETS } from "./presets";
import type { ThemeCustomization, ThemeMode } from "./types";

export const STORAGE_MODE_KEY = "mastra-work:theme-mode";
export const STORAGE_PRESET_KEY = "mastra-work:theme-preset";
export const STORAGE_CUSTOMIZATIONS_KEY = "mastra-work:theme-customizations";
/** 启动引导脚本(boot-theme.js)消费的最终 CSS 变量快照,消除首帧闪烁 */
export const STORAGE_BOOT_KEY = "mastra-work:theme-boot";

export function userThemeStorageKey(key: string, userId: string): string {
  return `${key}:${encodeURIComponent(userId)}`;
}

export function getInitialMode(defaultTheme: ThemeMode, storageKey: string): ThemeMode {
  try {
    const saved = localStorage.getItem(storageKey) as ThemeMode;
    if (saved === "light" || saved === "dark" || saved === "system") return saved;
  } catch {
    // Ignore localStorage errors and use the configured default.
  }
  return defaultTheme;
}

export function getInitialPreset(defaultPreset: string, storageKey: string): string {
  try {
    const saved = localStorage.getItem(storageKey);
    if (saved && THEME_PRESETS.some((preset) => preset.id === saved)) return saved;
  } catch {
    // Ignore localStorage errors and use the configured default.
  }
  return defaultPreset;
}

export function getInitialCustomizations(storageKey: string): Record<string, ThemeCustomization> {
  try {
    const saved = localStorage.getItem(storageKey);
    if (!saved) return {};
    return sanitizeCustomizations(JSON.parse(saved));
  } catch {
    // Ignore malformed or unavailable local storage.
    return {};
  }
}

const COLOR_KEYS = new Set([
  "background",
  "foreground",
  "card",
  "cardForeground",
  "popover",
  "popoverForeground",
  "primary",
  "primaryForeground",
  "secondary",
  "secondaryForeground",
  "muted",
  "mutedForeground",
  "accent",
  "accentForeground",
  "destructive",
  "destructiveForeground",
  "border",
  "input",
  "ring",
  "sidebar",
  "sidebarForeground",
  "sidebarPrimary",
  "sidebarPrimaryForeground",
  "sidebarAccent",
  "sidebarAccentForeground",
  "sidebarBorder",
] as const satisfies ReadonlyArray<keyof import("./types").ThemeColorTokens>);

const GEOMETRY_KEYS = new Set(["radius", "borderWidth", "shadowDepth"]);
const TYPO_KEYS = new Set([
  "fontSans",
  "fontMono",
  "headingWeight",
  "letterSpacing",
  "textTransform",
]);
const CSS_VALUE_RE = /^[#a-zA-Z0-9,\s.%'"()\-_/]+$/;

function pickStrings(input: unknown, allowed: Set<string>): Record<string, string> | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (allowed.has(k) && typeof v === "string" && v.length <= 300 && CSS_VALUE_RE.test(v)) {
      out[k] = v;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function pickNumbers(input: unknown, allowed: Set<string>, lo: number, hi: number) {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (allowed.has(k) && typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi) {
      out[k] = v;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** 逐字段白名单校验自定义数据,结构损坏或超界字段直接丢弃 */
function sanitizeCustomizations(input: unknown): Record<string, ThemeCustomization> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return {};
  const out: Record<string, ThemeCustomization> = {};
  for (const [presetId, value] of Object.entries(input as Record<string, unknown>)) {
    if (typeof presetId !== "string" || presetId.length > 80) continue;
    if (typeof value !== "object" || value === null) continue;
    const v = value as Record<string, unknown>;
    const cleaned: ThemeCustomization = {};
    const lc = pickStrings(v.lightColors, COLOR_KEYS);
    if (lc) cleaned.lightColors = lc;
    const dc = pickStrings(v.darkColors, COLOR_KEYS);
    if (dc) cleaned.darkColors = dc;
    const geo = pickNumbers(v.geometry, GEOMETRY_KEYS, 0, 40);
    if (geo) cleaned.geometry = geo;
    const typo = pickStrings(v.typography, TYPO_KEYS);
    if (typo) cleaned.typography = typo;
    if (Object.keys(cleaned).length > 0) out[presetId] = cleaned;
  }
  return out;
}
