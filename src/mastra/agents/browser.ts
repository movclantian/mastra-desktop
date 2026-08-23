/**
 * 浏览器运行时(docs/en/docs/browser.mdx、docs/en/reference/browser/)。
 *
 * 无头运行:线程浏览器的画面通过 screencast 推给右侧面板,不需要、也不应该
 * 在用户桌面上弹出一个真实的 Chromium 窗口。
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { AgentBrowser } from "@mastra/agent-browser";

/**
 * 打包态附带的 Chromium 可执行文件。
 *
 * electron-builder 把 Playwright 下载的浏览器目录放到 PLAYWRIGHT_BROWSERS_PATH,
 * 结构是 <root>/chromium-<版本号>/<平台目录>/<可执行文件>。这里必须解析到
 * **可执行文件**本身 —— 传一个目录进去只会让启动失败。
 * 返回 undefined 时交给 Playwright 自己的默认查找链(开发态即 node_modules 里
 * 那份),这也是开发机上看到 "Google Chrome for Testing" 的来源。
 */
function resolveBundledChromium(): string | undefined {
  const browserRoot = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!browserRoot) return undefined;
  try {
    const browserDir = readdirSync(browserRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^chromium-\d+$/.test(entry.name))
      .map((entry) => entry.name)
      .sort()
      .at(-1);
    if (!browserDir) return undefined;
    const relativePath =
      process.platform === "win32"
        ? join(browserDir, "chrome-win64", "chrome.exe")
        : process.platform === "darwin"
          ? join(browserDir, "chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium")
          : join(browserDir, "chrome-linux", "chrome");
    const executable = join(browserRoot, relativePath);
    return existsSync(executable) ? executable : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 每条会话线程独占一个 Chromium 上下文(scope: "thread")。浏览器工具由
 * Agent.browser 官方接入点自动注册;screencast 供右侧面板复用同一个真实页面,
 * 参数与 /work/threads/:id/browser/screencast 路由保持一致。
 */
export const workBrowser = new AgentBrowser({
  // 以下三项为官方默认值,见 docs/en/reference/browser/agent-browser.mdx:
  //   headless defaultValue='true'、viewport defaultValue='{width:1280,height:720}'、
  //   timeout defaultValue='30000'。
  headless: true,
  executablePath: resolveBundledChromium(),
  scope: "thread",
  viewport: { width: 1280, height: 720 },
  timeout: 30_000,
  screencast: {
    format: "jpeg",
    // quality 官方示例(docs/en/docs/browser.mdx)用 80,此处取 78 略低以减小 screencast 带宽。
    quality: 78,
    maxWidth: 1280,
    maxHeight: 720,
    everyNthFrame: 1,
  },
});
