// Ensure Electron itself is installed. Browser automation uses Electron or Firecrawl.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const electronDir = join(projectRoot, "node_modules", "electron");

const ELECTRON_MIRROR = "https://cdn.npmmirror.com/binaries/electron/";

const truthy = (value) => ["1", "true", "yes"].includes((value ?? "").trim().toLowerCase());
const useMirror = process.env.INSTALL_PREPARE_NO_MIRROR !== "1";

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
function officialEnv() {
  const env = { ...process.env };
  delete env.ELECTRON_MIRROR;
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
