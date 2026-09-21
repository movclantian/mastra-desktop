import { existsSync, readdirSync, statSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const packageJson = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8"));
const distDir = resolve(projectRoot, process.env.PACKAGE_DIST_DIR ?? "dist");
const target = (process.env.PACKAGE_TARGET ?? inferTarget()).toLowerCase();
const mode = (process.argv.includes("--dir") ? "dir" : process.env.PACKAGE_MODE ?? "release").toLowerCase();
const failures = [];

function inferTarget() {
  if (existsSync(join(distDir, `${packageJson.name}-${packageJson.version}-setup.exe`))) return "win";
  if (readdirSafe().some((name) => name.endsWith(".dmg"))) return "mac";
  if (readdirSafe().some((name) => name.endsWith(".AppImage"))) return "linux-appimage";
  return process.platform === "win32" ? "win" : process.platform === "darwin" ? "mac" : "linux";
}

function readdirSafe() {
  try {
    return readdirSync(distDir);
  } catch {
    return [];
  }
}

function fileInfo(relativePath) {
  const absolutePath = join(distDir, relativePath);
  if (!existsSync(absolutePath)) return undefined;
  const stats = statSync(absolutePath);
  if (!stats.isFile() || stats.size === 0) return undefined;
  return { absolutePath, mtimeMs: stats.mtimeMs, size: stats.size };
}

function requireFile(relativePath, label = relativePath) {
  const info = fileInfo(relativePath);
  if (!info) {
    failures.push(`${label} missing or empty: ${relativePath}`);
    return undefined;
  }
  return info;
}

function requireDirectory(relativePath, label = relativePath) {
  const absolutePath = join(distDir, relativePath);
  if (!existsSync(absolutePath) || !statSync(absolutePath).isDirectory()) {
    failures.push(`${label} missing: ${relativePath}`);
    return undefined;
  }
  return absolutePath;
}

function chromiumExecutableRelativePath() {
  try {
    const manifest = JSON.parse(
      readFileSync(join(projectRoot, "node_modules", "playwright-core", "browsers.json"), "utf8"),
    );
    const revision = manifest.browsers?.find((browser) => browser.name === "chromium")?.revision;
    if (revision) {
      return join(
        "win-unpacked",
        "resources",
        "app.asar.unpacked",
        "resources",
        "browsers",
        `chromium-${revision}`,
        "chrome-win64",
        "chrome.exe",
      );
    }
  } catch {
    // The missing manifest is reported by the required runtime file check below.
  }
  return join("win-unpacked", "resources", "app.asar.unpacked", "resources", "browsers");
}

function formatBytes(bytes) {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 2)} ${units[unit]}`;
}

function verifyWindows() {
  if (mode === "dir") {
    const unpacked = requireFile(`win-unpacked/${packageJson.name}.exe`, "Windows unpacked executable");
    const asar = requireFile("win-unpacked/resources/app.asar", "Windows app.asar");
    const chromium = requireFile(chromiumExecutableRelativePath(), "Windows packaged Chromium");
    requireDirectory("win-unpacked/resources/app.asar.unpacked/resources/browsers", "Windows unpacked browser resources");
    requireDirectory("win-unpacked/resources/app.asar.unpacked/resources/builtin-skills", "Windows unpacked built-in skills");
    const duplicatedIcon = join(
      distDir,
      "win-unpacked",
      "resources",
      "app.asar.unpacked",
      "resources",
      "icon.png",
    );
    if (existsSync(duplicatedIcon)) {
      failures.push("Windows icon is duplicated in app.asar.unpacked/resources/icon.png");
    }
    return [
      ["unpacked", unpacked],
      ["app.asar", asar],
      ["chromium", chromium],
    ];
  }

  const baseName = `${packageJson.name}-${packageJson.version}`;
  const setup = requireFile(`${baseName}-setup.exe`, "Windows setup");
  const blockmap = requireFile(`${baseName}-setup.exe.blockmap`, "Windows blockmap");
  const unpacked = requireFile(`win-unpacked/${packageJson.name}.exe`, "Windows unpacked executable");

  if (setup && blockmap && unpacked) {
    // A stale setup.exe can survive a failed local electron-builder run. Allow a
    // small timestamp skew, but never accept an installer older than the
    // unpacked executable that the same run should have produced.
    const allowedSkewMs = 30 * 60 * 1000;
    if (setup.mtimeMs + allowedSkewMs < unpacked.mtimeMs) {
      failures.push(
        `Windows setup is stale: ${new Date(setup.mtimeMs).toISOString()} < unpacked executable ${new Date(unpacked.mtimeMs).toISOString()}`,
      );
    }
  }

  return [
    ["setup", setup],
    ["blockmap", blockmap],
    ["unpacked", unpacked],
  ];
}

function verifyMac() {
  const matches = readdirSafe().filter((name) => name.endsWith(".dmg"));
  if (matches.length === 0) {
    failures.push("macOS DMG missing or empty");
    return [];
  }
  return matches.map((name) => [name, fileInfo(name)]);
}

function verifyLinux() {
  const suffix = target.includes("deb") ? ".deb" : target.includes("snap") ? ".snap" : ".AppImage";
  const matches = readdirSafe().filter((name) => name.endsWith(suffix));
  if (matches.length === 0) {
    failures.push(`Linux ${suffix} artifact missing or empty`);
    return [];
  }
  return matches.map((name) => [name, fileInfo(name)]);
}

if (!existsSync(distDir)) failures.push(`dist directory missing: ${distDir}`);

let artifacts;
if (target === "win" || target === "windows") {
  artifacts = verifyWindows();
} else if (target === "mac" || target === "macos") {
  artifacts = verifyMac();
} else if (target.startsWith("linux")) {
  artifacts = verifyLinux();
} else {
  failures.push(`unsupported PACKAGE_TARGET: ${target}`);
  artifacts = [];
}

console.log(`[verify-package] target=${target} mode=${mode} dist=${distDir}`);
for (const [label, info] of artifacts) {
  if (info) console.log(`[verify-package] ${label}: ${formatBytes(info.size)} mtime=${new Date(info.mtimeMs).toISOString()}`);
}

if (failures.length > 0) {
  console.error(`[verify-package] FAILED\n- ${failures.join("\n- ")}`);
  process.exitCode = 1;
} else {
  console.log("[verify-package] package artifacts and freshness checks passed");
}
