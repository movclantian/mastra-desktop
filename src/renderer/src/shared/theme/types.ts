export type ThemeMode = "light" | "dark" | "system";

type ThemeCategory =
  | "brutalism"
  | "soft_brutalism"
  | "clay_glass"
  | "skeuomorphism"
  | "scifi_dark"
  | "pixel_retro"
  | "oriental_desktop"
  | "modern"
  | "retro_wave"
  | "artistic"
  | "professional"
  | "luxury"
  | "nature_warm"
  | "expressive";

/**
 * 质感签名家族:CSS 侧以 [data-theme-family] 选择器按家族应用
 * 阴影/圆角/模糊/辉光/像素化等深度定制,颜色则全部经 token 变量派生。
 */
export type ThemeFamily =
  | "flat"
  | "brutalism"
  | "clay"
  | "glass"
  | "glow"
  | "pixel"
  | "paper"
  | "mono"
  | "aero";

export interface ThemeColorTokens {
  background: string;
  foreground: string;
  card: string;
  cardForeground: string;
  popover: string;
  popoverForeground: string;
  primary: string;
  primaryForeground: string;
  secondary: string;
  secondaryForeground: string;
  muted: string;
  mutedForeground: string;
  accent: string;
  accentForeground: string;
  destructive: string;
  destructiveForeground: string;
  border: string;
  input: string;
  ring: string;
  sidebar: string;
  sidebarForeground: string;
  sidebarPrimary: string;
  sidebarPrimaryForeground: string;
  sidebarAccent: string;
  sidebarAccentForeground: string;
  sidebarBorder: string;
}

export interface ThemeGeometryTokens {
  /** 基础圆角半径(px) */
  radius: number;
  /** 边框粗细(px) */
  borderWidth: number;
  /** 硬阴影偏移深度(px, 0 为无硬阴影) */
  shadowDepth: number;
}

export interface ThemeTypographyTokens {
  /** 核心无衬线字体栈 */
  fontSans: string;
  /** 等宽代码字体栈 */
  fontMono: string;
  /** 标题字重 (例如 "600", "700", "800") */
  headingWeight: string;
  /** 字符间距 (例如 "-0.03em", "0", "0.01em") */
  letterSpacing: string;
  /** 强调文字大小写转换 (none / uppercase) */
  textTransform?: "none" | "uppercase";
}

export interface ThemePreset {
  id: string;
  name: string;
  englishName: string;
  category: ThemeCategory;
  categoryLabel: string;
  description: string;
  registrySource: string;
  /** 经 [data-theme-style] 暴露给 CSS;与 preset id 一致 */
  styleKey: string;
  /** 质感签名家族,经 [data-theme-family] 暴露 */
  family?: ThemeFamily;
  /** 内置主题标记(氛围层等 CSS 仅作用于内置主题) */
  generated?: boolean;
  light: ThemeColorTokens;
  dark: ThemeColorTokens;
  geometry: ThemeGeometryTokens;
  typography: ThemeTypographyTokens;
}

export interface ThemeCustomization {
  lightColors?: Partial<ThemeColorTokens>;
  darkColors?: Partial<ThemeColorTokens>;
  geometry?: Partial<ThemeGeometryTokens>;
  typography?: Partial<ThemeTypographyTokens>;
}

export interface ThemeInspirationPalette {
  id: string;
  name: string;
  description: string;
  primary: string;
  secondary: string;
  accent: string;
  border?: string;
  backgroundLight?: string;
  backgroundDark?: string;
}

export interface ThemeContextValue {
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
  activePresetId: string;
  activePreset: ThemePreset;
  setPreset: (presetId: string) => void;
  presets: ThemePreset[];
  customizations: Record<string, ThemeCustomization>;
  activeCustomization: ThemeCustomization;
  updateActiveCustomization: (partial: Partial<ThemeCustomization>) => void;
  resetActiveCustomization: () => void;
  resolvedColors: ThemeColorTokens;
  resolvedGeometry: ThemeGeometryTokens;
  resolvedTypography: ThemeTypographyTokens;
  isDark: boolean;
}
