import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("thread transfer requests are recipient-gated, idempotent, and auditable", async () => {
  const storageDirectory = await mkdtemp(join(tmpdir(), "mastrawork-thread-transfer-"));
  const databasePath = join(storageDirectory, "mastra.db").replaceAll("\\", "/");
  const probePath = join(dirname(fileURLToPath(import.meta.url)), "thread-transfer-storage-probe.mjs");

  try {
    const result = spawnSync(
      process.execPath,
      ["--import", "jiti/register", probePath],
      {
        cwd: process.cwd(),
        env: { ...process.env, MASTRA_STORAGE_URL: `file:${databasePath}` },
        encoding: "utf8",
        timeout: 30_000,
      },
    );
    assert.equal(
      result.status,
      0,
      `database probe failed (status ${result.status}, signal ${result.signal})\n${result.stdout}\n${result.stderr}`,
    );
  } finally {
    await rm(storageDirectory, { recursive: true, force: true });
  }
});
