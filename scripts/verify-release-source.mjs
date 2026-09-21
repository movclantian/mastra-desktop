import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

function readText(relativePath) {
  return readFileSync(join(projectRoot, relativePath), "utf8");
}

function assert(condition, message) {
  if (!condition) throw new Error(`[verify-release] ${message}`);
}

const requiredFiles = [
  "resources/icon.png",
  "build/icon.png",
  "build/icon.ico",
  "build/icon.icns",
  "resources/builtin-skills/README.md",
  "resources/builtin-skills/workspace-tool-check/SKILL.md",
  "resources/builtin-skills/windows-terminal/SKILL.md",
  "src/renderer/public/icon.png",
  "scripts/clean-package-output.mjs",
  "scripts/verify-package-artifacts.mjs",
];
for (const relativePath of requiredFiles) {
  const absolutePath = join(projectRoot, relativePath);
  assert(existsSync(absolutePath), `缺少发布资源: ${relativePath}`);
  assert(statSync(absolutePath).size > 0, `发布资源为空: ${relativePath}`);
}

const pngMagic = readFileSync(join(projectRoot, "resources/icon.png")).subarray(0, 8);
assert(
  pngMagic.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  "resources/icon.png 不是有效 PNG",
);
const rendererIcon = readFileSync(join(projectRoot, "src/renderer/public/icon.png"));
assert(rendererIcon.subarray(0, 8).equals(pngMagic), "src/renderer/public/icon.png 不是有效 PNG");
assert(
  rendererIcon.equals(readFileSync(join(projectRoot, "resources/icon.png"))),
  "renderer icon 与 resources/icon.png 不一致",
);
assert(
  readFileSync(join(projectRoot, "build/icon.ico"))
    .subarray(0, 4)
    .equals(Buffer.from([0, 0, 1, 0])),
  "build/icon.ico 不是有效 ICO",
);
assert(
  readFileSync(join(projectRoot, "build/icon.icns")).subarray(0, 4).toString("ascii") === "icns",
  "build/icon.icns 不是有效 ICNS",
);

const builderConfig = readText("electron-builder.yml");
assert(/^icon:\s*build\/icon\s*$/m.test(builderConfig), "electron-builder 未显式配置 build/icon");
assert(builderConfig.includes("!**/*.map"), "electron-builder 未排除发布包中的 source map");
assert(
  builderConfig.includes("!**/node_modules/@mastra/editor/dist/ee/**"),
  "缺少 dist/ee 打包排除规则",
);
assert(builderConfig.includes("!**/node_modules/@mastra/editor/ee/**"), "缺少 ee 打包排除规则");

const skillsSource = readText("src/mastra/routes/skills.ts");
assert(
  readText("src/renderer/index.html").includes('href="./icon.png"'),
  "renderer favicon 未引用 icon.png",
);
assert(
  !/require\.resolve\([^)]*@mastra\/editor/.test(skillsSource),
  "运行时仍解析 @mastra/editor 路径",
);
assert(!/ee[\\/]workspace[\\/]skills/.test(skillsSource), "运行时仍指向 Enterprise 内置技能路径");

const packageJson = JSON.parse(readText("package.json"));
assert(packageJson.engines?.node === ">=22.0.0 <23", "Node 版本门禁不是 22.x");
assert(packageJson.scripts?.["verify:package:dir"], "缺少目录包 verify:package:dir 命令");
const pnpmConfig = readText("pnpm-workspace.yaml");
const corePatchPath = "patches/@mastra__core@1.67.0.patch";
const corePatch = readFileSync(join(projectRoot, corePatchPath));
assert(pnpmConfig.includes(corePatchPath), "缺少 core 工具修复补丁配置");
assert(!corePatch.includes(13), "core 补丁必须使用 LF 换行");
assert(
  readText("pnpm-lock.yaml").includes(createHash("sha256").update(corePatch).digest("hex")),
  "core 补丁与 lockfile hash 不一致",
);
assert(/^minimumReleaseAge:\s*1440\s*$/m.test(pnpmConfig), "minimumReleaseAge 未恢复为 1440 分钟");
const workflow = readText(".github/workflows/release.yml");
assert(workflow.includes("pnpm run verify:release"), "CI 未执行 verify:release");
assert(workflow.includes("pnpm run clean:package"), "CI 未清理旧的 dist 产物");
assert(workflow.includes("pnpm run verify:package"), "CI 未执行安装包产物门禁");
assert(
  workflow.includes("github.event_name == 'push' && startsWith(github.ref, 'refs/tags/')"),
  "Release 未限制为 tag push",
);

console.log("[verify-release] source, icon and packaging guard checks passed");
