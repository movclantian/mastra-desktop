import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("thread transfer recovery reconciles real Memory ownership after process restart", async () => {
  const storageDirectory = await mkdtemp(join(tmpdir(), "mastrawork-thread-memory-recovery-"));
  const databasePath = join(storageDirectory, "mastra.db").replaceAll("\\", "/");
  const probePath = join(
    dirname(fileURLToPath(import.meta.url)),
    "thread-transfer-recovery-probe.mjs",
  );

  const runPhase = (phase) => {
    const result = spawnSync(
      process.execPath,
      ["--import", "jiti/register", probePath],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          MASTRA_STORAGE_URL: `file:${databasePath}`,
          THREAD_TRANSFER_RECOVERY_PHASE: phase,
        },
        encoding: "utf8",
        timeout: 60_000,
      },
    );
    assert.equal(
      result.status,
      0,
      `phase ${phase} failed (status ${result.status}, signal ${result.signal})\n${result.stdout}\n${result.stderr}`,
    );
  };

  try {
    runPhase("prepare-source-owner");
    runPhase("recover-source-owner");
    runPhase("prepare-partial-clone");
    runPhase("recover-partial-clone");
    runPhase("prepare-target-owner");
    runPhase("recover-target-owner");
    runPhase("prepare-target-owner-moved");
    runPhase("recover-target-owner-moved");
  } finally {
    await rm(storageDirectory, { recursive: true, force: true });
  }
});
