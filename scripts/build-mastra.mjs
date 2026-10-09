import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Electron packages resolve production dependencies from the app-level
// node_modules; electron-builder intentionally excludes .mastra/output's
// duplicate node_modules. Avoid a second, unpinned network install there.
const result = spawnSync(
  process.execPath,
  [fileURLToPath(new URL("../node_modules/mastra/dist/index.js", import.meta.url)), "build"],
  {
    // Match the desktop runtime so CLI builds do not create ~/.mastra either.
    env: { ...process.env, MASTRA_BUILD_SKIP_INSTALL: "1", MASTRA_TELEMETRY_DISABLED: "1" },
    stdio: "inherit",
  },
);

if (result.error) throw result.error;
if (result.status !== 0) process.exitCode = result.status ?? 1;
