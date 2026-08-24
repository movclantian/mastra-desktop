import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/features/auth/auth-provider";
import { THEME_PRESETS } from "@/features/theme/presets";
import type {
  ThemeColorTokens,
  ThemeContextValue,
  ThemeCustomization,
  ThemeGeometryTokens,
  ThemeMode,
  ThemePreset,
} from "@/features/theme/types";
import { applyThemeToDocument } from "./apply-theme";
import {
  getInitialCustomizations,
  getInitialMode,
  getInitialPreset,
  STORAGE_CUSTOMIZATIONS_KEY,
  STORAGE_MODE_KEY,
  STORAGE_PRESET_KEY,
  userThemeStorageKey,
} from "./theme-storage";

interface ThemeProviderProps {
  children: React.ReactNode;
  defaultTheme?: ThemeMode;
  defaultPreset?: string;
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

export function ThemeProvider({
  children,
  defaultTheme = "light",
  defaultPreset = "default",
}: ThemeProviderProps) {
  const { user } = useAuth();
  const modeKey = userThemeStorageKey(STORAGE_MODE_KEY, user?.id ?? "anonymous");
  const presetKey = userThemeStorageKey(STORAGE_PRESET_KEY, user?.id ?? "anonymous");
  const customizationsKey = userThemeStorageKey(
    STORAGE_CUSTOMIZATIONS_KEY,
    user?.id ?? "anonymous",
  );
  const [mode, setModeState] = useState<ThemeMode>(() => getInitialMode(defaultTheme, modeKey));
  const [activePresetId, setActivePresetIdState] = useState<string>(() =>
    getInitialPreset(defaultPreset, presetKey),
  );
  const [customizations, setCustomizations] = useState<Record<string, ThemeCustomization>>(() =>
    getInitialCustomizations(customizationsKey),
  );

  const [systemIsDark, setSystemIsDark] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  });

  // 监听系统深浅色切换
  useEffect(() => {
    if (typeof window === "undefined") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const listener = (e: MediaQueryListEvent) => setSystemIsDark(e.matches);
    media.addEventListener("change", listener);
    return () => media.removeEventListener("change", listener);
  }, []);

  const isDark = mode === "dark" || (mode === "system" && systemIsDark);

  const activePreset: ThemePreset = useMemo(() => {
    return THEME_PRESETS.find((p) => p.id === activePresetId) ?? THEME_PRESETS[0];
  }, [activePresetId]);

  const activeCustomization: ThemeCustomization = useMemo(() => {
    return customizations[activePresetId] || {};
  }, [customizations, activePresetId]);

  // 计算当前最终生效的色彩 Tokens
  const resolvedColors: ThemeColorTokens = useMemo(() => {
    const baseColors = isDark ? activePreset.dark : activePreset.light;
    const customColors = isDark ? activeCustomization.darkColors : activeCustomization.lightColors;
    return {
      ...baseColors,
      ...(customColors || {}),
    };
  }, [activePreset, isDark, activeCustomization]);

  // 计算当前最终生效的几何尺度 Tokens
  const resolvedGeometry: ThemeGeometryTokens = useMemo(() => {
    return {
      ...activePreset.geometry,
      ...(activeCustomization.geometry || {}),
    };
  }, [activePreset, activeCustomization]);

  // 计算当前最终生效的排版与字体 Tokens
  const resolvedTypography = useMemo(() => {
    return {
      ...activePreset.typography,
      ...(activeCustomization.typography || {}),
    };
  }, [activePreset, activeCustomization]);

  useEffect(() => {
    applyThemeToDocument(
      isDark,
      activePreset,
      resolvedColors,
      resolvedGeometry,
      resolvedTypography,
    );
  }, [isDark, activePreset, resolvedColors, resolvedGeometry, resolvedTypography]);

  const setMode = useCallback(
    (newMode: ThemeMode) => {
      try {
        localStorage.setItem(modeKey, newMode);
      } catch {
        // ignore
      }
      setModeState(newMode);
    },
    [modeKey],
  );

  const setPreset = useCallback(
    (presetId: string) => {
      try {
        localStorage.setItem(presetKey, presetId);
      } catch {
        // ignore
      }
      setActivePresetIdState(presetId);
    },
    [presetKey],
  );

  const updateActiveCustomization = useCallback(
    (partial: Partial<ThemeCustomization>) => {
      setCustomizations((prev) => {
        const current = prev[activePresetId] || {};
        const updated: ThemeCustomization = {
          lightColors: {
            ...(current.lightColors || {}),
            ...(partial.lightColors || {}),
          },
          darkColors: {
            ...(current.darkColors || {}),
            ...(partial.darkColors || {}),
          },
          geometry: {
            ...(current.geometry || {}),
            ...(partial.geometry || {}),
          },
          typography: {
            ...(current.typography || {}),
            ...(partial.typography || {}),
          },
        };
        const next = { ...prev, [activePresetId]: updated };
        try {
          localStorage.setItem(customizationsKey, JSON.stringify(next));
        } catch {
          // ignore
        }
        return next;
      });
    },
    [activePresetId, customizationsKey],
  );

  const resetActiveCustomization = useCallback(() => {
    setCustomizations((prev) => {
      const next = { ...prev };
      delete next[activePresetId];
      try {
        localStorage.setItem(customizationsKey, JSON.stringify(next));
      } catch {
        // ignore
      }
      return next;
    });
  }, [activePresetId, customizationsKey]);

  const value: ThemeContextValue = useMemo(
    () => ({
      mode,
      setMode,
      theme: mode,
      setTheme: setMode,
      activePresetId,
      activePreset,
      setPreset,
      presets: THEME_PRESETS,
      customizations,
      activeCustomization,
      updateActiveCustomization,
      resetActiveCustomization,
      resolvedColors,
      resolvedGeometry,
      resolvedTypography,
      isDark,
    }),
    [
      mode,
      activePresetId,
      activePreset,
      customizations,
      activeCustomization,
      resolvedColors,
      resolvedGeometry,
      resolvedTypography,
      isDark,
      setMode,
      setPreset,
      updateActiveCustomization,
      resetActiveCustomization,
    ],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  return context;
}
