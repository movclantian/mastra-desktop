import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// 启动/构建前的本地运行时就绪检查，两步各自「已就绪则跳过」：
//   1. Electron 二进制：electron 自 v43 起 npm 包不再声明 postinstall，`pnpm install` 只会装上
//      JS 包装而不会下载 node_modules/electron/dist 与 path.txt；electron-vite 只读 path.txt，
//      缺文件即抛 "Electron uninstall"。这里直接调用 electron 自带的 install.js 补齐。
//   2. Playwright Chromium：内嵌浏览器视图与 browser agent 需要 resources/browsers 下的浏览器。
// 可用环境变量：
//   INSTALL_PREPARE_SKIP_ELECTRON=1 / INSTALL_PREPARE_SKIP_BROWSER=1  跳过对应步骤
//   INSTALL_PREPARE_NO_MIRROR=1                                       不走镜像，直连官方源
//   ELECTRON_MIRROR / PLAYWRIGHT_DOWNLOAD_HOST                        覆盖各自的镜像地址
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const browserPath = resolve(projectRoot, "resources", "browsers");
const electronDir = join(projectRoot, "node_modules", "electron");
const playwrightCli = join(projectRoot, "node_modules", "playwright-core", "cli.js");

const ELECTRON_MIRROR = "https://cdn.npmmirror.com/binaries/electron/";
const PLAYWRIGHT_MIRROR = "https://cdn.npmmirror.com/binaries/playwright";

const truthy = (value) => ["1", "true", "yes"].includes((value ?? "").trim().toLowerCase());
const useMirror = process.env.INSTALL_PREPARE_NO_MIRROR !== "1";
const browserEnv = { PLAYWRIGHT_BROWSERS_PATH: browserPath };

mkdirSync(browserPath, { recursive: true });

// 镜像是国内 CDN，直连最优：清空代理变量并设 NO_PROXY=*，避免被出口代理绕路后频繁 ECONNRESET。
const directEnv = { ...process.env };
for (const key of [
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "https_proxy",
  "http_proxy",
  "ALL_PROXY",
  "all_proxy",
]) {
  directEnv[key] = "";
}
directEnv.NO_PROXY = "*";
directEnv.no_proxy = "*";

/** 回退官方源时保留系统代理设置，并清掉镜像变量。 */
function officialEnv(extra) {
  const env = { ...process.env, ...extra };
  delete env.ELECTRON_MIRROR;
  delete env.PLAYWRIGHT_DOWNLOAD_HOST;
  return env;
}

/** 依次尝试各下载源（每项含 source 与 env），全部失败则抛错。 */
function download(label, args, candidates) {
  for (const { source, env } of candidates) {
    console.log(`[install-prepare] ${label} 下载源: ${source}`);
    const { status, error } = spawnSync(process.execPath, args, {
      env,
      stdio: "inherit",
      windowsHide: true,
    });
    if (!error && status === 0) return;
    console.warn(
      `[install-prepare] ${label} 从 ${source} 失败${error ? `（${error.message}）` : `（退出码 ${status}）`}，尝试下一个源…`,
    );
  }
  throw new Error(
    `[install-prepare] ${label} 安装失败：请检查网络后重试，或设 INSTALL_PREPARE_NO_MIRROR=1 直连官方源`,
  );
}

function electronInstalled() {
  try {
    const { version } = JSON.parse(readFileSync(join(electronDir, "package.json"), "utf8"));
    const executable = readFileSync(join(electronDir, "path.txt"), "utf8").trim();
    const distVersion = readFileSync(join(electronDir, "dist", "version"), "utf8").trim();
    return (
      distVersion.replace(/^v/, "") === version && existsSync(join(electronDir, "dist", executable))
    );
  } catch {
    return false;
  }
}

function expectedChromiumExecutable() {
  try {
    const manifest = JSON.parse(
      readFileSync(join(projectRoot, "node_modules", "playwright-core", "browsers.json"), "utf8"),
    );
    const revision = manifest.browsers?.find((browser) => browser.name === "chromium")?.revision;
    if (!revision) return undefined;
    const browserRoot = join(browserPath, `chromium-${revision}`);
    if (process.platform === "win32") return join(browserRoot, "chrome-win64", "chrome.exe");
    if (process.platform === "darwin") {
      return join(browserRoot, "chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium");
    }
    return join(browserRoot, "chrome-linux", "chrome");
  } catch {
    return undefined;
  }
}

const electronScript = join(electronDir, "install.js");
const electronMirror = process.env.ELECTRON_MIRROR ?? ELECTRON_MIRROR;

if (truthy(process.env.INSTALL_PREPARE_SKIP_ELECTRON)) {
  console.log("[install-prepare] 已通过 INSTALL_PREPARE_SKIP_ELECTRON 跳过 Electron 检查");
} else if (!existsSync(electronScript)) {
  throw new Error("[install-prepare] 未找到 electron 依赖，请先执行 pnpm install");
} else if (electronInstalled()) {
  console.log("[install-prepare] 已找到 Electron，跳过下载");
} else {
  download(
    "Electron",
    [electronScript],
    [
      ...(useMirror
        ? [
            {
              source: `镜像 ${electronMirror} (直连)`,
              env: { ...directEnv, ELECTRON_MIRROR: electronMirror },
            },
          ]
        : []),
      { source: "官方源 github.com", env: officialEnv() },
    ],
  );
  // install.js 解压中断时可能仍退出 0，装完再确认一次
  if (!electronInstalled()) {
    throw new Error(
      "[install-prepare] Electron 安装后仍缺少 dist/path.txt，请删除 node_modules/electron 后重试",
    );
  }
  console.log("[install-prepare] Electron 已就绪");
}

const chromiumExecutable = expectedChromiumExecutable();

if (truthy(process.env.INSTALL_PREPARE_SKIP_BROWSER)) {
  console.log("[install-prepare] 已通过 INSTALL_PREPARE_SKIP_BROWSER 跳过 Chromium 检查");
} else if (chromiumExecutable && existsSync(chromiumExecutable)) {
  console.log(`[install-prepare] 已找到 Chromium，跳过下载: ${chromiumExecutable}`);
} else {
  const playwrightMirror = process.env.PLAYWRIGHT_DOWNLOAD_HOST ?? PLAYWRIGHT_MIRROR;
  download(
    "Chromium",
    [playwrightCli, "install", "chromium"],
    [
      ...(useMirror
        ? [
            {
              source: `镜像 ${playwrightMirror} (直连)`,
              env: { ...directEnv, ...browserEnv, PLAYWRIGHT_DOWNLOAD_HOST: playwrightMirror },
            },
          ]
        : []),
      { source: "官方源 cdn.playwright.dev", env: officialEnv(browserEnv) },
    ],
  );
}
