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
  for (const [name, value] of Object.entries(colorTokens))
    root.style.setProperty(`--${name}`, value);

  root.style.setProperty("--radius", `${geometry.radius / 16}rem`);
  root.style.setProperty("--theme-border-width", `${geometry.borderWidth}px`);
  root.style.setProperty(
    "--theme-shadow-hard",
    geometry.shadowDepth > 0
      ? `${geometry.shadowDepth}px ${geometry.shadowDepth}px 0px var(--border)`
      : "0 1px 2px 0 rgb(0 0 0 / 0.05)",
  );
  root.style.setProperty("--theme-font-sans", typography.fontSans);
  root.style.setProperty("--theme-font-mono", typography.fontMono);
  root.style.setProperty("--theme-heading-weight", typography.headingWeight);
  root.style.setProperty("--theme-letter-spacing", typography.letterSpacing);
  root.style.setProperty("--theme-text-transform", typography.textTransform || "none");
  root.style.fontFamily = typography.fontSans;
  root.style.letterSpacing = typography.letterSpacing;
}
