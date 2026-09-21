import { rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const packageOutput = join(projectRoot, "dist");

if (dirname(packageOutput) !== projectRoot || packageOutput !== join(projectRoot, "dist")) {
  throw new Error(`拒绝清理非项目 dist 目录: ${packageOutput}`);
}

await rm(packageOutput, { recursive: true, force: true });
console.log(`[clean-package] removed ${packageOutput}`);
