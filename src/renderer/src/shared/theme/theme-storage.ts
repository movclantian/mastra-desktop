import { THEME_PRESETS } from "./presets";
import type { ThemeCustomization, ThemeMode } from "./types";

export const STORAGE_MODE_KEY = "mastra-work:theme-mode";
export const STORAGE_PRESET_KEY = "mastra-work:theme-preset";
export const STORAGE_CUSTOMIZATIONS_KEY = "mastra-work:theme-customizations";

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
    if (saved) return JSON.parse(saved) as Record<string, ThemeCustomization>;
  } catch {
    // Ignore malformed or unavailable local storage.
  }
  return {};
}
