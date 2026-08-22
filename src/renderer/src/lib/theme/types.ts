export type ThemeMode = "light" | "dark" | "system";

export type ThemeCategory = "brutalism" | "soft_brutalism" | "modern";

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

export interface ThemePreset {
  id: string;
  name: string;
  englishName: string;
  category: ThemeCategory;
  categoryLabel: string;
  description: string;
  registrySource: string;
  styleKey: "default" | "boldkit" | "neobrutalism" | "retroui" | "saaskit" | string;
  light: ThemeColorTokens;
  dark: ThemeColorTokens;
  geometry: ThemeGeometryTokens;
}

export interface ThemeCustomization {
  lightColors?: Partial<ThemeColorTokens>;
  darkColors?: Partial<ThemeColorTokens>;
  geometry?: Partial<ThemeGeometryTokens>;
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
  /** 兼容旧版 theme 字段 */
  theme: ThemeMode;
  /** 兼容旧版 setTheme 签名 */
  setTheme: (theme: ThemeMode) => void;
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
  isDark: boolean;
}
