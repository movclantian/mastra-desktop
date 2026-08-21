import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const browserPath = resolve(projectRoot, "resources", "browsers");
const playwrightCli = join(projectRoot, "node_modules", "playwright-core", "cli.js");

mkdirSync(browserPath, { recursive: true });

// 淘宝镜像：国内直连快且稳定，避免官方源(cdn.playwright.dev→GCS)在代理下频繁 ECONNRESET。
// 可用 INSTALL_BROWSER_MIRROR 覆盖镜像地址；设 INSTALL_BROWSER_NO_MIRROR=1 可跳过镜像直接用官方源。
const MIRROR_HOST =
  process.env.INSTALL_BROWSER_MIRROR ?? "https://cdn.npmmirror.com/binaries/playwright";
const useMirror = process.env.INSTALL_BROWSER_NO_MIRROR !== "1";

function run(env, label) {
  console.log(`[install-browser] 下载源: ${label}`);
  const result = spawnSync(process.execPath, [playwrightCli, "install", "chromium"], {
    env,
    stdio: "inherit",
    windowsHide: true,
  });
  return result;
}

// 镜像为国内 CDN，直连最优：清空代理变量并设 NO_PROXY=*，避免被欧洲出口代理绕路。
const directEnv = {
  ...process.env,
  PLAYWRIGHT_BROWSERS_PATH: browserPath,
  PLAYWRIGHT_DOWNLOAD_HOST: MIRROR_HOST,
  HTTPS_PROXY: "",
  HTTP_PROXY: "",
  https_proxy: "",
  http_proxy: "",
  ALL_PROXY: "",
  all_proxy: "",
  NO_PROXY: "*",
  no_proxy: "*",
};

const officialEnv = {
  ...process.env,
  PLAYWRIGHT_BROWSERS_PATH: browserPath,
};

let result;
if (useMirror) {
  result = run(directEnv, `镜像 ${MIRROR_HOST} (直连)`);
  // 镜像失败则回退官方源（保留系统代理设置）
  if (result.status !== 0) {
    console.warn("[install-browser] 镜像下载失败，回退到官方源…");
    result = run(officialEnv, "官方源 cdn.playwright.dev");
  }
} else {
  result = run(officialEnv, "官方源 cdn.playwright.dev");
}

if (result.error) throw result.error;
if (result.status !== 0) {
  throw new Error(
    `Playwright Chromium installation failed with exit code ${result.status ?? "unknown"}`,
  );
}
