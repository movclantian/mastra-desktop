import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import vm from "node:vm";
import { toAISdkStream } from "@mastra/ai-sdk";
import { MDocument } from "@mastra/rag";

const { transformDeepSeekRequestBody } = await import("../src/mastra/models/create-model.ts");
const { PLAN_TOOL_NAMES, READ_ONLY_TOOL_NAMES, toolCategoryOf } = await import(
  "../src/mastra/agents/permissions.ts"
);

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
test("Upload cleanup is single-flight and throttles both success and failure", async () => {
  let calls = 0;
  let clock = 1000;
  let finish;
  let fail;
  const source = read("src/mastra/rag/storage/db.ts");
  const declaration = source
    .match(/export function cleanupExpiredLibraryUploadSessions[\s\S]*?^}/m)[0]
    .replace("export ", "");
  const cleanup = vm.runInNewContext(
    `${stripTypeScriptTypes(`let uploadCleanupPromise: Promise<void> | undefined; let nextUploadCleanupAt = 0;${declaration}`)}; cleanupExpiredLibraryUploadSessions`,
    {
      Date: { now: () => clock },
      withClient: () => {
        calls++;
        return new Promise((resolve, reject) => {
          finish = resolve;
          fail = reject;
        });
      },
    },
  );
  const first = cleanup();
  assert.equal(cleanup(), first);
  assert.equal(calls, 1);
  finish();
  await first;
  await cleanup();
  assert.equal(calls, 1);
  clock += 300000;
  const second = cleanup();
  assert.equal(calls, 2);
  fail(new Error("cleanup unavailable"));
  await assert.rejects(second, /cleanup unavailable/);
  await cleanup();
  assert.equal(calls, 2);
  clock += 300000;
  const third = cleanup();
  finish();
  await third;
  assert.equal(calls, 3);
});
function load(path, name, globals = {}) {
  const declaration = read(path).match(
    new RegExp(`^(?:export )?((?:async )?function ${name}\\b[\\s\\S]*?^}\\r?$)`, "m"),
  );
  assert.ok(declaration, `Missing ${name}`);
  return vm.runInNewContext(`${stripTypeScriptTypes(declaration[1])}; ${name}`, globals);
}

const settings = { chunkStrategy: "recursive", chunkSize: 1200, chunkOverlap: 160 };
test("Plan mode excludes notification dismissal tools with persistent side effects", () => {
  assert.equal(toolCategoryOf("notification_inbox"), "edit");
  assert.equal(toolCategoryOf("notification-inbox"), "edit");
  assert.equal(PLAN_TOOL_NAMES.includes("notification_inbox"), false);
  assert.equal(PLAN_TOOL_NAMES.includes("notification-inbox"), false);
});
test("Plan and Review never receive tools that mutate the task queue", () => {
  for (const name of ["task_write", "task_update", "task_complete"]) {
    assert.equal(toolCategoryOf(name), "edit");
    assert.equal(READ_ONLY_TOOL_NAMES.includes(name), false);
    assert.equal(PLAN_TOOL_NAMES.includes(name), false);
  }
  assert.equal(READ_ONLY_TOOL_NAMES.includes("task_check"), true);
});
test("Empty delegation summary reports incomplete evidence rather than no findings", () => {
  const describe = load("src/mastra/agents/index.ts", "describeIncompleteDelegation");
  const input = {
    finishReason: "tool-calls",
    subAgentToolResults: Array.from({ length: 15 }, (_, i) => ({
      toolName: "read_file",
      toolCallId: `call-${i}`,
      isError: i === 14,
    })),
  };
  const text = describe(input);
  assert.match(text, /incomplete/);
  assert.match(text, /15 tool results retained/);
  assert.match(text, /tool-calls/);
  assert.match(text, /call-14.*error/);
  assert.doesNotMatch(text, /call-0\)/);
  assert.equal(input.subAgentToolResults.length, 15);
  assert.match(describe({}), /unknown; 0 tool results/);
});
test("Plan history distinguishes approved/rejected/revision/unknown and restores submittedPlan", () => {
  const parse = load(
    "src/renderer/src/widgets/chat-panel/model/types.ts",
    "getCompletedInteraction",
    {
      getToolName: () => "submit_plan",
      asRecord: (value) => (value && typeof value === "object" ? value : undefined),
      asString: (value) => (typeof value === "string" ? value : undefined),
    },
  );
  for (const [content, expected] of [
    ["Plan approved. Proceed with implementation following the approved plan.", "approved"],
    [
      "Plan was not approved. The user will send revision instructions in their next message.",
      "rejected",
    ],
    ["Plan was not approved. The user wants revisions.\n\nUser feedback: update", "revision"],
    ["unrecognized result", "unknown"],
  ]) {
    const item = parse("message", {
      state: "output-available",
      toolCallId: "call",
      input: {},
      output: {
        content,
        submittedPlan: { title: "Original title", path: "plans/example.md", plan: "Plan contents" },
      },
    });
    assert.equal(item.planDecision, expected);
    assert.equal(item.suspendPayload.title, "Original title");
    assert.equal(item.suspendPayload.path, "plans/example.md");
    assert.equal(item.suspendPayload.plan, "Plan contents");
  }
});
const usageMetadata = load("src/mastra/routes/session.ts", "createUsageMetadata");
const trackBackgroundTaskChunk = load("src/mastra/routes/session.ts", "trackBackgroundTaskChunk", {
  BACKGROUND_TASK_START_CHUNKS: new Set([
    "background-task-started",
    "background-task-running",
    "background-task-resumed",
  ]),
  BACKGROUND_TASK_END_CHUNKS: new Set([
    "background-task-completed",
    "background-task-failed",
    "background-task-cancelled",
    "background-task-suspended",
    "background-task-timed-out",
  ]),
});
test("Background task lifecycle survives replay until the terminal event", () => {
  const active = new Set();
  trackBackgroundTaskChunk(active, {
    type: "background-task-started",
    payload: { taskId: "task-1" },
  });
  trackBackgroundTaskChunk(active, {
    type: "background-task-output",
    payload: { taskId: "task-1", payload: { value: "partial" } },
  });
  trackBackgroundTaskChunk(active, {
    type: "finish",
    payload: { stepResult: { reason: "stop" } },
  });
  assert.deepEqual([...active], ["task-1"]);
  trackBackgroundTaskChunk(active, {
    type: "background-task-completed",
    payload: { taskId: "task-1" },
  });
  assert.equal(active.size, 0);
});
test("Reconnect route keeps the background-task lifecycle enabled", () => {
  const source = read("src/mastra/routes/session.ts");
  assert.match(
    source,
    /streamWorkbenchSession\(\s*c,\s*result\.controllerSession[\s\S]*?true,\s*\n?\s*\)/,
  );
});
test("Background task recovery never substitutes a context-free static executor", () => {
  const source = read("src/mastra/routes/background-tasks.ts");
  const startup = read("src/mastra/index.ts");
  const reconciliationStart = startup.indexOf("if (backgroundTaskManager)");
  const reconciliationEnd = startup.indexOf("registerShutdownHandlers()", reconciliationStart);
  const reconciliation = startup.slice(reconciliationStart, reconciliationEnd);
  assert.match(source, /manager\.taskContexts\.has\(task\.id\)/);
  assert.match(source, /markInterruptedTaskFailed\(manager, task\)/);
  assert.doesNotMatch(source, /manager\.getStaticExecutor\(/);
  assert.match(source, /recoverStaleTasksOnStart: false|failInterruptedBackgroundTasksOnStartup/);
  assert.match(source, /await ensureTaskExecutorAvailable\(manager, task\)/);
  assert.match(
    reconciliation,
    /catch \(error\) \{\s*logger\.error\("Interrupted background task reconciliation failed; refusing to start", \{ error \}\);\s*throw error;/,
  );
});
test("A task without its request-scoped executor is persisted as failed", async () => {
  const markFailed = load(
    "src/mastra/routes/background-tasks.ts",
    "markInterruptedTaskFailed",
    {
      INTERRUPTED_TASK_MESSAGE:
        "服务已重启，原任务的请求上下文不能安全恢复。为避免使用错误账户、模型或工作区执行，任务已停止；请重新提交。",
    },
  );
  const ensure = load("src/mastra/routes/background-tasks.ts", "ensureTaskExecutorAvailable", {
    workError: (code) => new Error(code),
    markInterruptedTaskFailed: markFailed,
  });
  const events = [];
  const updates = [];
  const task = {
    id: "task-restart-1",
    agentId: "mastra-work-agent",
    toolName: "explorer",
    status: "suspended",
    createdAt: new Date(0),
  };
  const manager = {
    taskContexts: new Map(),
    getStorage: async () => ({
      updateTask: async (...args) => {
        updates.push(args);
        return true;
      },
    }),
    deregisterTaskContext: (id) => events.push(["deregister", id]),
    publishLifecycleEvent: async (...args) => events.push(args),
  };
  await assert.rejects(ensure(manager, task), /BACKGROUND_TASK_EXECUTOR_UNAVAILABLE/);
  assert.equal(updates.length, 1);
  assert.equal(updates[0][0], task.id);
  assert.equal(updates[0][1].status, "failed");
  assert.equal(updates[0][2].expectedStatus, "suspended");
  assert.match(updates[0][1].error.message, /请求上下文不能安全恢复/);
  assert.deepEqual(events[0], ["deregister", task.id]);
  assert.equal(events[1][0], "task.failed");

  const completedUpdates = [];
  const completedEvents = [];
  const completedTask = { ...task, id: "task-completed", status: "completed" };
  const completedManager = {
    taskContexts: new Map(),
    getStorage: async () => ({ updateTask: async (...args) => completedUpdates.push(args) }),
    deregisterTaskContext: (id) => completedEvents.push(["deregister", id]),
    publishLifecycleEvent: async (...args) => completedEvents.push(args),
  };
  await ensure(completedManager, completedTask);
  assert.deepEqual(completedUpdates, []);
  assert.deepEqual(completedEvents, []);
});
test("Startup marks persisted pending, running, and suspended tasks failed", async () => {
  const reconcile = load(
    "src/mastra/routes/background-tasks.ts",
    "failInterruptedBackgroundTasksOnStartup",
    {
      markInterruptedTaskFailed: load(
        "src/mastra/routes/background-tasks.ts",
        "markInterruptedTaskFailed",
        {
          INTERRUPTED_TASK_MESSAGE:
            "服务已重启，原任务的请求上下文不能安全恢复。为避免使用错误账户、模型或工作区执行，任务已停止；请重新提交。",
        },
      ),
    },
  );
  const records = new Map([
    ["pending", { id: "pending", status: "pending", createdAt: new Date(0) }],
    ["running", { id: "running", status: "running", createdAt: new Date(0) }],
    ["suspended", { id: "suspended", status: "suspended", createdAt: new Date(0) }],
  ]);
  const events = [];
  const manager = {
    listTasks: async () => ({ tasks: [...records.values()], total: records.size }),
    getTask: async (id) => records.get(id),
    getStorage: async () => ({
      updateTask: async (id, update, { expectedStatus }) => {
        const current = records.get(id);
        if (current.status !== expectedStatus) return false;
        records.set(id, { ...current, ...update });
        return true;
      },
    }),
    deregisterTaskContext: () => undefined,
    publishLifecycleEvent: async (...args) => events.push(args),
  };
  assert.equal(await reconcile(manager), 3);
  assert.deepEqual([...records.values()].map((task) => task.status), ["failed", "failed", "failed"]);
  assert.equal(events.length, 3);
});
test("Real AI SDK adapter separates the final request from cumulative run usage", async () => {
  const step = (inputTokens) => ({
    type: "step-finish",
    runId: "usage-test",
    from: "AGENT",
    payload: {
      metadata: {},
      output: { usage: { inputTokens, outputTokens: 10, totalTokens: inputTokens + 10 } },
      stepResult: { reason: "stop" },
    },
  });
  const input = new ReadableStream({
    start(controller) {
      controller.enqueue({ type: "start", payload: {} });
      controller.enqueue(step(800));
      controller.enqueue(step(1200));
      controller.enqueue({
        type: "finish",
        payload: {
          stepResult: { reason: "stop" },
          output: { usage: { inputTokens: 2000, outputTokens: 20, totalTokens: 2020 } },
        },
      });
      controller.close();
    },
  });
  const stream = toAISdkStream(
    { fullStream: input },
    { from: "agent", version: "v7", messageMetadata: usageMetadata() },
  );
  let finish;
  for await (const chunk of stream) if (chunk.type === "finish") finish = chunk.messageMetadata;
  assert.equal(finish.contextUsageVersion, 2);
  assert.equal(finish.contextUsage.inputTokens, 1200);
  assert.equal(finish.usage.inputTokens, 2000);
  assert.equal(finish.usage.outputTokens, 20);
});

test("Windows terminal toolchain preserves PATH order and reads environment keys case-insensitively", () => {
  const source = read("src/main/terminal.ts");
  const start = source.indexOf("const VOLTA_HOME_DIRECTORY_NAMES");
  const end = source.indexOf("\nfunction loadPty", start);
  assert.ok(start >= 0 && end > start, "Volta environment helpers must remain a cohesive block");
  const code = stripTypeScriptTypes(source.slice(start, end));
  const joinWindows = (...parts) => parts.filter(Boolean).join("\\").replace(/\\+/g, "\\");
  const basenameWindows = (value) => value.split(/[\\/]/).filter(Boolean).at(-1) ?? "";
  const dirnameWindows = (value) => value.split(/[\\/]/).slice(0, -1).join("\\");
  const normalize = (existingPaths) =>
    vm.runInNewContext(`${code}; normalizeWindowsToolchain`, {
      Set,
      delimiter: ";",
      join: joinWindows,
      basename: basenameWindows,
      dirname: dirnameWindows,
      existsSync: (value) => existingPaths.has(value.replace(/[\\/]+$/, "").toLowerCase()),
    });

  const explicitHome = "D:\\Toolchain\\Volta";
  const explicitExists = new Set([
    `${explicitHome}\\bin`.toLowerCase(),
    `${explicitHome}\\bin\\volta.exe`.toLowerCase(),
  ]);
  const explicitEnvironment = {
    path: "C:\\Windows;C:\\Tools",
    volta_home: explicitHome,
  };
  normalize(explicitExists)(explicitEnvironment);
  assert.equal(
    explicitEnvironment.path,
    `${explicitHome}\\bin;C:\\Windows;C:\\Tools`,
  );

  const userHome = "C:\\Users\\Chen\\AppData\\Local\\Volta";
  const inferredEnvironment = {
    path: "C:\\Windows",
    localappdata: "C:\\Users\\Chen\\AppData\\Local",
  };
  normalize(
    new Set([
      `${userHome}\\bin`.toLowerCase(),
      `${userHome}\\bin\\volta.exe`.toLowerCase(),
    ]),
  )(inferredEnvironment);
  assert.equal(inferredEnvironment.path, `${userHome}\\bin;C:\\Windows`);
  assert.equal(inferredEnvironment.VOLTA_HOME, userHome);

  const customCli = "C:\\Custom\\VoltaCli";
  const defaultHome = "C:\\Users\\Chen\\AppData\\Local\\Volta";
  const customEnvironment = {
    path: `${customCli};C:\\Windows`,
    localappdata: "C:\\Users\\Chen\\AppData\\Local",
  };
  normalize(
    new Set([
      `${customCli}\\volta.exe`.toLowerCase(),
      `${defaultHome}\\bin`.toLowerCase(),
      `${defaultHome}\\bin\\volta.exe`.toLowerCase(),
    ]),
  )(customEnvironment);
  assert.equal(customEnvironment.path, `${customCli};C:\\Windows`);
  assert.equal(
    Object.keys(customEnvironment).some((key) => key.toLowerCase() === "volta_home"),
    false,
  );

  const msiEnvironment = { path: "C:\\Windows", "programfiles(x86)": "C:\\Program Files" };
  normalize(new Set(["c:\\program files\\volta\\volta.exe"]))(msiEnvironment);
  assert.equal(msiEnvironment.path, "C:\\Program Files\\Volta;C:\\Windows");
});
test("Usage snapshots reset on new runs and never substitute totals for missing steps", () => {
  const metadata = usageMetadata();
  metadata({ part: { type: "finish-step", usage: { inputTokens: 500 } } });
  metadata({ part: { type: "start" } });
  const finish = metadata({ part: { type: "finish", totalUsage: { inputTokens: 9000 } } });
  assert.equal(finish.contextUsage, null);
  assert.equal(finish.usage.inputTokens, 9000);
  metadata({ part: { type: "finish-step", usage: { inputTokens: 300 } } });
  metadata({ part: { type: "finish-step" } });
  assert.equal(metadata({ part: { type: "finish" } }).contextUsage, null);
});
test("DeepSeek thinking requests replay reasoning_content without mutating input", () => {
  const body = {
    model: "deepseek-reasoner",
    messages: [
      { role: "user", content: "run the tool" },
      { role: "assistant", content: null, tool_calls: [{ id: "call-1" }] },
      { role: "tool", tool_call_id: "call-1", content: "done" },
      { role: "assistant", reasoning_content: "existing", content: "next" },
    ],
  };
  const transformed = transformDeepSeekRequestBody(body);
  assert.equal(body.messages[1].reasoning_content, undefined);
  assert.equal(transformed.messages[1].reasoning_content, "");
  assert.equal(transformed.messages[3].reasoning_content, "existing");
  assert.equal(transformed.messages[0], body.messages[0]);
});
test("Thread persistence retains billing, preserves unrelated metadata and rejects unversioned snapshots", async () => {
  let saved;
  const memory = {
    getThreadById: async () => ({ metadata: { workspacePath: "fixture", draft: true } }),
    updateThread: async (value) => {
      saved = value;
    },
  };
  const persist = load("src/mastra/routes/chat.ts", "persistLatestUsage", {
    getWorkMemoryForThread: async () => memory,
    getWorkMemory: async () => memory,
  });
  await persist(
    "test-thread",
    "test-user",
    { usage: { inputTokens: 5000 }, contextUsage: { inputTokens: 1000 }, contextUsageVersion: 2 },
    {},
  );
  assert.equal(saved.metadata.totalUsage.inputTokens, 5000);
  assert.equal(saved.metadata.contextUsage.inputTokens, 1000);
  assert.equal(saved.metadata.workspacePath, "fixture");
  assert.equal(saved.metadata.draft, false);
  await persist(
    "test-thread",
    "test-user",
    { usage: { inputTokens: 5000 }, contextUsage: { inputTokens: 5000 } },
    {},
  );
  assert.equal(saved.metadata.contextUsage, null);
  assert.equal(saved.metadata.totalUsage.inputTokens, 5000);
});
const resolve = load("src/mastra/rag/tools.ts", "resolveChunkerSettings");
test("Small chunk sizes use a valid implicit overlap and split real documents", async () => {
  for (const size of [1, 100, 160, 200, 1200]) {
    const result = resolve(settings, { chunkSize: size });
    assert.ok(result.chunkOverlap >= 0 && result.chunkOverlap < size);
    const chunks = await MDocument.fromText("alpha beta ".repeat(30)).chunk({
      strategy: "recursive",
      maxSize: size,
      overlap: result.chunkOverlap,
    });
    assert.ok(chunks.length > 0);
    assert.ok(chunks.every((chunk) => chunk.text.length <= size));
  }
  assert.equal(resolve(settings, {}).chunkOverlap, 160);
  assert.equal(resolve({ ...settings, chunkOverlap: 300 }, {}).chunkOverlap, 300);
  assert.equal(settings.chunkOverlap, 160);
});
test("Explicit valid overlap is preserved; invalid overlap fails clearly", () => {
  assert.equal(resolve(settings, { chunkSize: 100, chunkOverlap: 99 }).chunkOverlap, 99);
  assert.equal(resolve(settings, { chunkSize: 100, chunkOverlap: 0 }).chunkOverlap, 0);
  for (const overlap of [-1, 100, 160, 1.5])
    assert.throws(
      () => resolve(settings, { chunkSize: 100, chunkOverlap: overlap }),
      /chunkOverlap/,
    );
  for (const size of [0, -1, 1.5])
    assert.throws(() => resolve(settings, { chunkSize: size }), /chunkSize/);
});

const writeFullChunk = load("src/mastra/rag/storage/upload.ts", "writeFullChunk");
test("Partial file writes preserve every byte, and zero writes terminate", async () => {
  const parts = [];
  await writeFullChunk(
    {
      async write(buffer, offset, length) {
        const count = Math.min(3, length);
        parts.push(buffer.subarray(offset, offset + count));
        return { bytesWritten: count };
      },
    },
    Buffer.from("中文-short-write"),
  );
  assert.equal(Buffer.concat(parts).toString(), "中文-short-write");
  await assert.rejects(
    writeFullChunk(
      {
        async write() {
          return { bytesWritten: 0 };
        },
      },
      Buffer.from("x"),
    ),
    /未写入任何字节/,
  );
  await assert.rejects(
    writeFullChunk(
      {
        async write() {
          throw new Error("disk full");
        },
      },
      Buffer.from("x"),
    ),
    /disk full/,
  );
});

const constants = read("src/mastra/rag/types.ts")
  .match(/^export const MAX_LIBRARY_(?:FILE|INLINE_MEDIA)_BYTES = .*;$/gm)
  .join("\n")
  .replaceAll("export ", "");
const limits = vm.runInNewContext(
  `${constants}; ({ MAX_LIBRARY_FILE_BYTES, MAX_LIBRARY_INLINE_MEDIA_BYTES })`,
);
test("Media read contract matches upload limit and restores video reads", async () => {
  assert.equal(limits.MAX_LIBRARY_INLINE_MEDIA_BYTES, limits.MAX_LIBRARY_FILE_BYTES);
  for (const mediaType of ["image/png", "audio/wav", "video/mp4"]) {
    let reads = 0;
    const asset = { mediaType, byteSize: 9 * 1024 * 1024 };
    const get = load("src/mastra/rag/storage/assets.ts", "getAssetContext", {
      ...limits,
      Buffer,
      waitForAssetIndexing: async () => {},
      getLibraryAsset: async () => asset,
      readAssetBytes: async () => {
        reads++;
        return { bytes: Buffer.from("fixture"), asset };
      },
    });
    assert.ok((await get("test", "asset")).dataUrl.startsWith(`data:${mediaType};base64,`));
    asset.byteSize = limits.MAX_LIBRARY_FILE_BYTES;
    assert.ok((await get("test", "asset")).dataUrl);
    asset.byteSize++;
    assert.equal((await get("test", "asset")).skipped, "media-too-large");
    assert.equal(reads, 2);
  }
});
test("Extracted text does not materialize binary media", async () => {
  const get = load("src/mastra/rag/storage/assets.ts", "getAssetContext", {
    ...limits,
    waitForAssetIndexing: async () => {},
    getLibraryAsset: async () => ({ extractedText: "document" }),
    readAssetBytes: async () => {
      throw new Error("unexpected read");
    },
  });
  assert.equal((await get("test", "asset")).text, "document");
});
test("Original built-in skills have discoverable application metadata", () => {
  const parse = load("src/mastra/skills/marketplaces.ts", "parseSkillMarkdown");
  for (const name of ["workspace-tool-check", "windows-terminal"]) {
    const skill = parse(read(`resources/builtin-skills/${name}/SKILL.md`), "missing");
    assert.equal(skill.name, name);
    assert.ok(skill.description.length > 20);
    assert.equal(skill.enabled, true);
    assert.equal(skill.license, "Apache-2.0");
  }
});
