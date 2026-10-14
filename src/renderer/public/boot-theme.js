/**
 * boot-theme.js — 首帧主题引导(在 React 挂载前同步执行)。
 *
 * 读取 apply-theme.ts 落盘的 CSS 变量快照(mastra-work:theme-boot),
 * 直接把 .dark/.light class、data-theme-* 属性与全部变量写到 <html>,
 * 彻底消除深色用户启动时的白闪(FOUC)。文件经 public/ 以 'self' 引入,
 * 满足生产 CSP(script-src 无 unsafe-inline)。
 */
(() => {
  try {
    const raw = localStorage.getItem("mastra-work:theme-boot");
    if (!raw) return;
    const snap = JSON.parse(raw);
    if (!snap || typeof snap !== "object") return;
    const root = document.documentElement;
    root.classList.remove("light", "dark");
    root.classList.add(snap.dark ? "dark" : "light");
    if (snap.preset) root.setAttribute("data-theme-preset", String(snap.preset));
    if (snap.style) root.setAttribute("data-theme-style", String(snap.style));
    if (snap.generated) root.setAttribute("data-theme-generated", "true");
    for (const group of [snap.colors, snap.geometry, snap.typography]) {
      if (!group || typeof group !== "object") continue;
      for (const [name, value] of Object.entries(group)) {
        if (typeof value === "string" && value.length <= 300) {
          root.style.setProperty(name.startsWith("-") ? name : `--${name}`, value);
        }
      }
    }
  } catch {
    /* 快照损坏时静默回退到 :root 默认浅色 */
  }
})();
