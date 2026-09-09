export type ThemeMode = "light" | "dark" | "system";

export type ThemeCategory =
  | "brutalism"
  | "soft_brutalism"
  | "clay_glass"
  | "skeuomorphism"
  | "scifi_dark"
  | "pixel_retro"
  | "oriental_desktop"
  | "modern";

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
  styleKey:
    | "default"
    | "boldkit"
    | "neobrutalism"
    | "retroui"
    | "saaskit"
    | "pouf"
    | "glasscn"
    | "einui"
    | "sabraman"
    | "thegridcn"
    | "gymnopedies"
    | "atroui"
    | "usva"
    | "8bitcn"
    | "pixelact"
    | "washiveil"
    | "whiskeyjack"
    | string;
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
  resolvedTypography: ThemeTypographyTokens;
  isDark: boolean;
}
