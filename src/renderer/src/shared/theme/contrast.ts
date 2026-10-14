/**
 * 运行时色彩对比度工具 — 供灵感色板应用等场景自动派生可读前景色。
 * 与内置主题预设的 WCAG 校准规则保持一致。
 */

function hexToRgb(hex: string): [number, number, number] {
  let h = hex.replace("#", "").trim();
  if (h.length === 3) h = [...h].map((c) => c + c).join("");
  const n = Number.parseInt(h.slice(0, 6), 16);
  return Number.isNaN(n) ? [0, 0, 0] : [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function wcagLum(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const la = wcagLum(a);
  const lb = wcagLum(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** 返回与底色对比度更高的黑白之一 */
function readableOn(bg: string): string {
  return contrast("#ffffff", bg) >= contrast("#000000", bg) ? "#ffffff" : "#000000";
}

/**
 * 校验一组用户注入的颜色:为每个底色角色自动派生缺失/低对比的 on-* 前景。
 * 返回一个新对象(含原值 + 派生前景),不修改入参。
 */
export function withDerivedForegrounds(colors: Record<string, string>): Record<string, string> {
  const out = { ...colors };
  const pairs: Array<[string, string]> = [
    ["primary", "primaryForeground"],
    ["secondary", "secondaryForeground"],
    ["accent", "accentForeground"],
    ["destructive", "destructiveForeground"],
  ];
  for (const [bgKey, fgKey] of pairs) {
    const bg = out[bgKey];
    if (typeof bg !== "string" || !bg.startsWith("#")) continue;
    const fg = out[fgKey];
    // 前景缺失,或与底色对比不足 3:1(按钮文字等 UI 需求)时自动派生
    if (typeof fg !== "string" || !fg.startsWith("#") || contrast(fg, bg) < 3) {
      out[fgKey] = readableOn(bg);
    }
  }
  return out;
}
