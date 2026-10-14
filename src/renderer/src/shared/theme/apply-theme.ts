import { STORAGE_BOOT_KEY } from "./theme-storage";
import type {
  ThemeColorTokens,
  ThemeGeometryTokens,
  ThemePreset,
  ThemeTypographyTokens,
} from "./types";

export function applyThemeToDocument(
  isDark: boolean,
  preset: ThemePreset,
  colors: ThemeColorTokens,
  geometry: ThemeGeometryTokens,
  typography: ThemeTypographyTokens,
): void {
  if (typeof window === "undefined") return;
  const root = window.document.documentElement;
  root.classList.remove("light", "dark");
  root.classList.add(isDark ? "dark" : "light");
  root.setAttribute("data-theme-preset", preset.id);
  root.setAttribute("data-theme-style", preset.styleKey);
  if (preset.family) root.setAttribute("data-theme-family", preset.family);
  if (preset.generated) root.setAttribute("data-theme-generated", "true");

  const colorTokens: Record<string, string> = {
    background: colors.background,
    foreground: colors.foreground,
    card: colors.card,
    "card-foreground": colors.cardForeground,
    popover: colors.popover,
    "popover-foreground": colors.popoverForeground,
    primary: colors.primary,
    "primary-foreground": colors.primaryForeground,
    secondary: colors.secondary,
    "secondary-foreground": colors.secondaryForeground,
    muted: colors.muted,
    "muted-foreground": colors.mutedForeground,
    accent: colors.accent,
    "accent-foreground": colors.accentForeground,
    destructive: colors.destructive,
    "destructive-foreground": colors.destructiveForeground,
    border: colors.border,
    input: colors.input,
    ring: colors.ring,
    sidebar: colors.sidebar,
    "sidebar-foreground": colors.sidebarForeground,
    "sidebar-primary": colors.sidebarPrimary,
    "sidebar-primary-foreground": colors.sidebarPrimaryForeground,
    "sidebar-accent": colors.sidebarAccent,
    "sidebar-accent-foreground": colors.sidebarAccentForeground,
    "sidebar-border": colors.sidebarBorder,
    "sidebar-ring": colors.ring,
  };

  const geometryTokens: Record<string, string> = {
    "--radius": `${geometry.radius / 16}rem`,
    "--theme-border-width": `${geometry.borderWidth}px`,
    "--theme-shadow-hard":
      geometry.shadowDepth > 0
        ? `${geometry.shadowDepth}px ${geometry.shadowDepth}px 0px var(--border)`
        : "0 1px 2px 0 rgb(0 0 0 / 0.05)",
  };

  const typographyTokens: Record<string, string> = {
    "--theme-font-sans": typography.fontSans,
    "--theme-font-mono": typography.fontMono,
    "--theme-heading-weight": typography.headingWeight,
    "--theme-letter-spacing": typography.letterSpacing,
    "--theme-text-transform": typography.textTransform || "none",
  };

  for (const [name, value] of Object.entries(colorTokens))
    root.style.setProperty(`--${name}`, value);
  for (const [name, value] of Object.entries(geometryTokens)) root.style.setProperty(name, value);
  for (const [name, value] of Object.entries(typographyTokens)) root.style.setProperty(name, value);
  root.style.fontFamily = typography.fontSans;
  root.style.letterSpacing = typography.letterSpacing;

  persistBootSnapshot(isDark, preset, colorTokens, geometryTokens, typographyTokens);
}

/**
 * 把当前生效的全部 CSS 变量快照到 localStorage,供 index.html 的
 * boot-theme.js 在 React 挂载前同步应用,彻底消除深色用户的首帧白闪。
 */
function persistBootSnapshot(
  isDark: boolean,
  preset: ThemePreset,
  colorTokens: Record<string, string>,
  geometryTokens: Record<string, string>,
  typographyTokens: Record<string, string>,
): void {
  try {
    localStorage.setItem(
      STORAGE_BOOT_KEY,
      JSON.stringify({
        dark: isDark,
        preset: preset.id,
        style: preset.styleKey,
        family: preset.family ?? "",
        generated: preset.generated === true,
        colors: colorTokens,
        geometry: geometryTokens,
        typography: typographyTokens,
      }),
    );
  } catch {
    // 忽略持久化失败(隐私模式/配额),启动脚本会回退到默认浅色。
  }
}
