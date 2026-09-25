import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import vm from "node:vm";

test("startup refuses to serve while a thread transfer cannot be reconciled", async () => {
  const source = readFileSync(
    new URL("../src/mastra/routes/threads/transfer-recovery.ts", import.meta.url),
    "utf8",
  );
  const declarationStart = source.indexOf(
    "export async function recoverPendingThreadTransfers(",
  );
  const declarationEnd = source.lastIndexOf("\n}");
  const declaration =
    declarationStart >= 0 && declarationEnd > declarationStart
      ? source.slice(declarationStart, declarationEnd + 2)
      : undefined;
  assert.ok(declaration, "transfer reconciliation must remain a named domain operation");
  const calls = [];
  const recover = vm.runInNewContext(
    `${stripTypeScriptTypes(declaration)}; recoverPendingThreadTransfers`,
    {
      MASTRA_RESOURCE_ID_KEY: "resourceId",
      RequestContext: class {
        setRaw() {}
      },
      listPendingThreadAssetTransfers: async () => [
        {
          id: "transfer-stuck",
          sourceResourceId: "source",
          targetResourceId: "target",
          threadId: "thread",
          status: "prepared",
          assetMappings: {},
          assetIds: [],
        },
      ],
      failThreadAssetTransfer: async (...args) => calls.push(args),
      errorMessage: (error) => (error instanceof Error ? error.message : String(error)),
      console: { warn: (...args) => calls.push(args) },
    },
  );

  await assert.rejects(
    recover({
      throwOnError: true,
      getMemory: async () => {
        throw new Error("memory store unavailable");
      },
    }),
    /transfer-stuck could not be reconciled/,
  );
  assert.equal(calls[0][0], "transfer-stuck");
  assert.equal(calls[0][3], true, "keep the journal pending for a retry on next startup");

  calls.length = 0;
  await assert.rejects(
    recover({
      throwOnError: true,
      getMemory: async () => ({
        settled: async () => undefined,
        getThreadById: async () => ({ resourceId: "third-party" }),
      }),
    }),
    (error) =>
      error?.message === "Thread transfer transfer-stuck could not be reconciled" &&
      error?.cause?.message === "Thread owner third-party does not match transfer participants",
  );
  assert.equal(calls[0][0], "transfer-stuck");
  assert.equal(calls[0][3], true, "retain owner conflicts for startup recovery");

  calls.length = 0;
  await recover({
    getMemory: async () => {
      throw new Error("memory store unavailable");
    },
  });
  assert.equal(calls[0][0], "transfer-stuck");
});

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
