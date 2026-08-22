import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { THEME_PRESETS } from "@/lib/theme/presets";
import type {
  ThemeColorTokens,
  ThemeContextValue,
  ThemeCustomization,
  ThemeGeometryTokens,
  ThemeMode,
  ThemePreset,
} from "@/lib/theme/types";

interface ThemeProviderProps {
  children: React.ReactNode;
  defaultTheme?: ThemeMode;
  defaultPreset?: string;
  storageKey?: string;
}

const STORAGE_MODE_KEY = "vite-ui-theme-mode";
const STORAGE_PRESET_KEY = "vite-ui-theme-preset";
const STORAGE_CUSTOMIZATIONS_KEY = "vite-ui-theme-customizations";

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

function getInitialMode(defaultTheme: ThemeMode, storageKey?: string): ThemeMode {
  try {
    const saved =
      (localStorage.getItem(STORAGE_MODE_KEY) as ThemeMode) ||
      (storageKey ? (localStorage.getItem(storageKey) as ThemeMode) : null);
    if (saved === "light" || saved === "dark" || saved === "system") {
      return saved;
    }
  } catch {
    // ignore localStorage errors
  }
  return defaultTheme;
}

function getInitialPreset(defaultPreset: string): string {
  try {
    const saved = localStorage.getItem(STORAGE_PRESET_KEY);
    if (saved && THEME_PRESETS.some((p) => p.id === saved)) {
      return saved;
    }
  } catch {
    // ignore
  }
  return defaultPreset;
}

function getInitialCustomizations(): Record<string, ThemeCustomization> {
  try {
    const saved = localStorage.getItem(STORAGE_CUSTOMIZATIONS_KEY);
    if (saved) {
      return JSON.parse(saved) as Record<string, ThemeCustomization>;
    }
  } catch {
    // ignore
  }
  return {};
}

export function ThemeProvider({
  children,
  defaultTheme = "light",
  defaultPreset = "default",
  storageKey,
}: ThemeProviderProps) {
  const [mode, setModeState] = useState<ThemeMode>(() =>
    getInitialMode(defaultTheme, storageKey),
  );
  const [activePresetId, setActivePresetIdState] = useState<string>(() =>
    getInitialPreset(defaultPreset),
  );
  const [customizations, setCustomizations] = useState<Record<string, ThemeCustomization>>(() =>
    getInitialCustomizations(),
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
    const customColors = isDark
      ? activeCustomization.darkColors
      : activeCustomization.lightColors;
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

  // 实时将主题样式变量与属性注入 document.documentElement
  useEffect(() => {
    if (typeof window === "undefined") return;
    const root = window.document.documentElement;

    // 1. 设置暗色模式 class
    root.classList.remove("light", "dark");
    root.classList.add(isDark ? "dark" : "light");

    // 2. 设置主题专属 data 属性
    root.setAttribute("data-theme-preset", activePreset.id);
    root.setAttribute("data-theme-style", activePreset.styleKey);

    // 3. 实时写入核心 CSS 自定义属性
    root.style.setProperty("--background", resolvedColors.background);
    root.style.setProperty("--foreground", resolvedColors.foreground);
    root.style.setProperty("--card", resolvedColors.card);
    root.style.setProperty("--card-foreground", resolvedColors.cardForeground);
    root.style.setProperty("--popover", resolvedColors.popover);
    root.style.setProperty("--popover-foreground", resolvedColors.popoverForeground);
    root.style.setProperty("--primary", resolvedColors.primary);
    root.style.setProperty("--primary-foreground", resolvedColors.primaryForeground);
    root.style.setProperty("--secondary", resolvedColors.secondary);
    root.style.setProperty("--secondary-foreground", resolvedColors.secondaryForeground);
    root.style.setProperty("--muted", resolvedColors.muted);
    root.style.setProperty("--muted-foreground", resolvedColors.mutedForeground);
    root.style.setProperty("--accent", resolvedColors.accent);
    root.style.setProperty("--accent-foreground", resolvedColors.accentForeground);
    root.style.setProperty("--destructive", resolvedColors.destructive);
    root.style.setProperty("--destructive-foreground", resolvedColors.destructiveForeground);
    root.style.setProperty("--border", resolvedColors.border);
    root.style.setProperty("--input", resolvedColors.input);
    root.style.setProperty("--ring", resolvedColors.ring);

    // 侧边栏专属变量
    root.style.setProperty("--sidebar", resolvedColors.sidebar);
    root.style.setProperty("--sidebar-foreground", resolvedColors.sidebarForeground);
    root.style.setProperty("--sidebar-primary", resolvedColors.sidebarPrimary);
    root.style.setProperty("--sidebar-primary-foreground", resolvedColors.sidebarPrimaryForeground);
    root.style.setProperty("--sidebar-accent", resolvedColors.sidebarAccent);
    root.style.setProperty("--sidebar-accent-foreground", resolvedColors.sidebarAccentForeground);
    root.style.setProperty("--sidebar-border", resolvedColors.sidebarBorder);
    root.style.setProperty("--sidebar-ring", resolvedColors.ring);

    // 几何变量: 圆角按 rem 标准换算(基准 1rem = 16px)
    root.style.setProperty("--radius", `${resolvedGeometry.radius / 16}rem`);
    root.style.setProperty("--theme-border-width", `${resolvedGeometry.borderWidth}px`);
    root.style.setProperty(
      "--theme-shadow-hard",
      resolvedGeometry.shadowDepth > 0
        ? `${resolvedGeometry.shadowDepth}px ${resolvedGeometry.shadowDepth}px 0px var(--border)`
        : "0 1px 2px 0 rgb(0 0 0 / 0.05)",
    );

    // 4. 排版与字体变量
    root.style.setProperty("--theme-font-sans", resolvedTypography.fontSans);
    root.style.setProperty("--theme-font-mono", resolvedTypography.fontMono);
    root.style.setProperty("--theme-heading-weight", resolvedTypography.headingWeight);
    root.style.setProperty("--theme-letter-spacing", resolvedTypography.letterSpacing);
    root.style.setProperty("--theme-text-transform", resolvedTypography.textTransform || "none");
    root.style.fontFamily = resolvedTypography.fontSans;
    root.style.letterSpacing = resolvedTypography.letterSpacing;
  }, [isDark, activePreset, resolvedColors, resolvedGeometry, resolvedTypography]);

  const setMode = (newMode: ThemeMode) => {
    try {
      localStorage.setItem(STORAGE_MODE_KEY, newMode);
      if (storageKey) localStorage.setItem(storageKey, newMode);
    } catch {
      // ignore
    }
    setModeState(newMode);
  };

  const setPreset = (presetId: string) => {
    try {
      localStorage.setItem(STORAGE_PRESET_KEY, presetId);
    } catch {
      // ignore
    }
    setActivePresetIdState(presetId);
  };

  const updateActiveCustomization = (partial: Partial<ThemeCustomization>) => {
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
        localStorage.setItem(STORAGE_CUSTOMIZATIONS_KEY, JSON.stringify(next));
      } catch {
        // ignore
      }
      return next;
    });
  };

  const resetActiveCustomization = () => {
    setCustomizations((prev) => {
      const next = { ...prev };
      delete next[activePresetId];
      try {
        localStorage.setItem(STORAGE_CUSTOMIZATIONS_KEY, JSON.stringify(next));
      } catch {
        // ignore
      }
      return next;
    });
  };

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
