/**
 * 主题专属字体离线自托管加载 (Fontsource)
 *
 * 设计原则:
 * 1. Electron 桌面应用离线优先 —— 全部字体通过 @fontsource 本地打包,不依赖 Google Fonts CDN;
 * 2. 字体族名与 presets.ts 完全对齐 —— 静态包暴露标准 family 名(如 "JetBrains Mono"),
 *    仅 Bricolage Grotesque / Noto Serif SC 使用变量包(family 名带 Variable 后缀,
 *    presets.ts 已同步更新),兼顾 CJK 字体体积与全字重覆盖;
 * 3. 静默降级 —— 若某字体包未来被下架,import 失败不影响主题切换(颜色/几何不受影响)。
 *
 * 字体与主题对照(来源 presets.ts -> typography):
 *   default/whiskeyjack   : system-ui (无需加载)
 *   boldkit/neobrutalism  : Space Grotesk + Space Mono
 *   retroui               : Bricolage Grotesque (Variable) + Space Mono
 *   saaskit/einui         : Plus Jakarta Sans + (Space Mono / JetBrains Mono / Fira Code)
 *   pouf                  : Nunito + JetBrains Mono
 *   glasscn               : SF Pro / Plus Jakarta Sans (Plus Jakarta 自托管)
 *   sabraman              : Helvetica Neue / Lucida Grande (系统字体,无需加载)
 *   thegridcn             : Orbitron + Rajdhani + Space Mono
 *   gymnopedies           : Cormorant Garamond + Cinzel + JetBrains Mono
 *   atroui                : Plus Jakarta Sans + JetBrains Mono
 *   usva                  : Inter + Geist + Geist Mono
 *   8bitcn                : Press Start 2P + Silkscreen + Space Mono
 *   pixelact              : VT323 + Silkscreen + Space Mono
 *   washiveil             : Noto Serif SC (Variable) + Shippori Mincho + Cormorant Garamond
 */

// ============================================================================
// 粗野主义 (Brutalism): boldkit / neobrutalism / retroui / saaskit
// ============================================================================
import "@fontsource/space-grotesk/300.css";
import "@fontsource/space-grotesk/400.css";
import "@fontsource/space-grotesk/500.css";
import "@fontsource/space-grotesk/600.css";
import "@fontsource/space-grotesk/700.css";

import "@fontsource/space-mono/400.css";
import "@fontsource/space-mono/700.css";
import "@fontsource/space-mono/400-italic.css";
import "@fontsource/space-mono/700-italic.css";

// Bricolage Grotesque 仅有变量包,family 名为 "Bricolage Grotesque Variable"
// (presets.ts retroui.fontSans 已同步使用该名)
import "@fontsource-variable/bricolage-grotesque";

import "@fontsource/public-sans/400.css";
import "@fontsource/public-sans/500.css";
import "@fontsource/public-sans/600.css";
import "@fontsource/public-sans/700.css";

// ============================================================================
// 拟物 / 玻璃 (Clay / Glass): pouf / glasscn / einui / sabraman
// ============================================================================
import "@fontsource/plus-jakarta-sans/200.css";
import "@fontsource/plus-jakarta-sans/300.css";
import "@fontsource/plus-jakarta-sans/400.css";
import "@fontsource/plus-jakarta-sans/500.css";
import "@fontsource/plus-jakarta-sans/600.css";
import "@fontsource/plus-jakarta-sans/700.css";
import "@fontsource/plus-jakarta-sans/800.css";

import "@fontsource/nunito/400.css";
import "@fontsource/nunito/600.css";
import "@fontsource/nunito/700.css";
import "@fontsource/nunito/800.css";

import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/600.css";
import "@fontsource/jetbrains-mono/700.css";
import "@fontsource/jetbrains-mono/800.css";

import "@fontsource/fira-code/400.css";
import "@fontsource/fira-code/500.css";

// ============================================================================
// 科幻 / 赛博 (Sci-Fi / Cyberpunk): thegridcn / gymnopedies / atroui / usva
// ============================================================================
import "@fontsource/orbitron/400.css";
import "@fontsource/orbitron/500.css";
import "@fontsource/orbitron/600.css";
import "@fontsource/orbitron/700.css";
import "@fontsource/orbitron/800.css";
import "@fontsource/orbitron/900.css";

import "@fontsource/rajdhani/300.css";
import "@fontsource/rajdhani/400.css";
import "@fontsource/rajdhani/500.css";
import "@fontsource/rajdhani/600.css";
import "@fontsource/rajdhani/700.css";

import "@fontsource/cormorant-garamond/300.css";
import "@fontsource/cormorant-garamond/400.css";
import "@fontsource/cormorant-garamond/500.css";
import "@fontsource/cormorant-garamond/600.css";
import "@fontsource/cormorant-garamond/700.css";
import "@fontsource/cormorant-garamond/300-italic.css";
import "@fontsource/cormorant-garamond/400-italic.css";
import "@fontsource/cormorant-garamond/500-italic.css";
import "@fontsource/cormorant-garamond/600-italic.css";
import "@fontsource/cormorant-garamond/700-italic.css";

import "@fontsource/cinzel/400.css";
import "@fontsource/cinzel/500.css";
import "@fontsource/cinzel/600.css";
import "@fontsource/cinzel/700.css";
import "@fontsource/cinzel/800.css";
import "@fontsource/cinzel/900.css";

import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";

import "@fontsource/geist/400.css";
import "@fontsource/geist/500.css";
import "@fontsource/geist/600.css";
import "@fontsource/geist/700.css";

import "@fontsource/geist-mono/400.css";
import "@fontsource/geist-mono/500.css";
import "@fontsource/geist-mono/600.css";

// ============================================================================
// 像素 / 游戏 (Pixel / Retro Gaming): 8bitcn / pixelact
// ============================================================================
import "@fontsource/press-start-2p"; // 仅 400 字重
import "@fontsource/vt323"; // 仅 400 字重
import "@fontsource/silkscreen/400.css";
import "@fontsource/silkscreen/700.css";

// ============================================================================
// 东方 / 桌面 (Oriental / Desktop): washiveil / whiskeyjack
// ============================================================================
// Noto Serif SC 为 CJK 字体,变量包单文件覆盖全字重,体积远优于多静态字重
// (presets.ts washiveil.fontSans 已同步使用 "Noto Serif SC Variable")
import "@fontsource-variable/noto-serif-sc";

import "@fontsource/shippori-mincho/400.css";
import "@fontsource/shippori-mincho/500.css";
import "@fontsource/shippori-mincho/600.css";
import "@fontsource/shippori-mincho/700.css";
import "@fontsource/shippori-mincho/800.css";

/**
 * 主题字体加载完成标记。
 * 供 ThemeProvider 在切换主题时用于诊断(可选)。
 */
export const THEME_FONTS_LOADED = true;

/**
 * 字体包与主题的映射关系,供调试或按需懒加载扩展使用。
 */
export const THEME_FONT_MAP: Record<string, string[]> = {
  default: ["system-ui"],
  boldkit: ["Space Grotesk", "Public Sans", "Space Mono"],
  neobrutalism: ["Space Grotesk", "Public Sans", "Space Mono"],
  retroui: ["Bricolage Grotesque Variable", "Plus Jakarta Sans", "Space Mono"],
  saaskit: ["Plus Jakarta Sans", "Inter", "Space Mono"],
  pouf: ["Nunito", "Plus Jakarta Sans", "JetBrains Mono"],
  glasscn: ["Plus Jakarta Sans", "Inter"],
  einui: ["Plus Jakarta Sans", "Inter", "JetBrains Mono", "Fira Code"],
  sabraman: ["Helvetica Neue", "Lucida Grande"],
  thegridcn: ["Orbitron", "Rajdhani", "Space Grotesk", "Space Mono"],
  gymnopedies: ["Cormorant Garamond", "Cinzel", "JetBrains Mono"],
  atroui: ["Plus Jakarta Sans", "Inter", "JetBrains Mono"],
  usva: ["Inter", "Geist", "Plus Jakarta Sans", "Geist Mono"],
  "8bitcn": ["Press Start 2P", "Silkscreen", "Space Mono"],
  pixelact: ["VT323", "Silkscreen", "Space Mono"],
  washiveil: ["Noto Serif SC Variable", "Shippori Mincho", "Cormorant Garamond"],
  whiskeyjack: ["system-ui", "Inter", "JetBrains Mono"],
};
