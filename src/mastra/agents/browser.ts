/**
 * 浏览器运行时(docs/en/docs/browser.mdx、docs/en/reference/browser/):
 * AgentBrowser 有头模式;优先探测系统 / 打包附带的 Chromium,
 * 可执行路径交由 @mastra/agent-browser 的探测与回退链处理。
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { AgentBrowser } from "@mastra/agent-browser";
import { PROJECT_ROOT } from "../storage";

/**
 * 浏览器运行时环境 (docs/en/reference/browser/):
 * 优先探测系统/打包附带的 Chromium，回退至 puppeteer 自动下载。
 */

function resolveBundledChromium(): string | undefined {
  const possiblePaths = [
    join(PROJECT_ROOT, "node_modules", "puppeteer", ".local-chromium"),
    join(PROJECT_ROOT, "resources", "chromium"),
    process.env.PUPPETEER_EXECUTABLE_PATH,
  ].filter((p): p is string => Boolean(p));

  for (const path of possiblePaths) {
    if (existsSync(path)) return path;
  }
  return undefined;
}

export const workBrowser = new AgentBrowser({
  headless: false,
  executablePath: resolveBundledChromium(),
});
