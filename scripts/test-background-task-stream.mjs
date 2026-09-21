import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import vm from "node:vm";

const source = (process.env.REGRESSION_BASELINE
  ? execFileSync("git", ["show", `${process.env.REGRESSION_BASELINE}:src/renderer/src/widgets/chat-panel/model/background-task-stream.ts`], { encoding: "utf8", cwd: new URL("../", import.meta.url) })
  : readFileSync(
  new URL(
    "../src/renderer/src/widgets/chat-panel/model/background-task-stream.ts",
    import.meta.url,
  ),
  "utf8",
))
  .replace(/^import .*;\r?\n/gm, "")
  .replace(
    "export function subscribeBackgroundTaskStream",
    "function subscribeBackgroundTaskStream",
  );
const code = stripTypeScriptTypes(source);
const flush = () => new Promise((resolve) => setImmediate(resolve));

test("Late fetch response after unsubscribe is cancelled without delivery", async () => {
  let resolve;
  let cancelled = false;
  const pending = new Promise((done) => {
    resolve = done;
  });
  const h = harness([pending]);
  h.stop();
  resolve(
    new Response(
      new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
    ),
  );
  await flush();
  assert.equal(cancelled, true);
  assert.equal(h.events.length, 0);
  assert.equal(h.timers.size, 0);
});

test("Real loopback HTTP recovers from 503, delivers SSE and closes on unsubscribe", {
  timeout: 8000,
}, async () => {
  let requests = 0;
  let disconnected;
  const closed = new Promise((resolve) => {
    disconnected = resolve;
  });
  const server = createServer((_req, res) => {
    requests++;
    if (requests === 1) {
      res.writeHead(503);
      res.end();
      return;
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(
      `data: ${JSON.stringify({ type: "background-task-completed", payload: { taskId: "network-task", result: "ok" } })}\n\n`,
    );
    res.on("close", disconnected);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  let stop = () => {};
  let deadline;
  try {
    const subscribe = vm.runInNewContext(`${code}\nsubscribeBackgroundTaskStream`, {
      AbortController,
      TextDecoder,
      apiFetch: fetch,
      MASTRA_SERVER_URL: `http://127.0.0.1:${server.address().port}`,
      asRecord: (value) =>
        value && typeof value === "object" && !Array.isArray(value) ? value : undefined,
      window: { setTimeout, clearTimeout },
    });
    const received = new Promise((resolve) => {
      stop = subscribe("t", "r", resolve);
    });
    const result = await Promise.race([
      received,
      new Promise((_, reject) => {
        deadline = setTimeout(() => reject(new Error("No recovered SSE event")), 5000);
      }),
    ]);
    assert.equal(result.id, "network-task");
    assert.equal(result.status, "completed");
    assert.equal(requests, 2);
    stop();
    await closed;
  } finally {
    clearTimeout(deadline);
    stop();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

function harness(responses) {
  const timers = new Map();
  const delays = [];
  const events = [];
  let calls = 0;
  let timerId = 0;
  const subscribe = vm.runInNewContext(`${code}\nsubscribeBackgroundTaskStream`, {
    AbortController,
    TextDecoder,
    MASTRA_SERVER_URL: "http://fixture.invalid",
    asRecord: (value) =>
      value && typeof value === "object" && !Array.isArray(value) ? value : undefined,
    apiFetch: async () => {
      const response = responses[calls++];
      if (response instanceof Error) throw response;
      assert.ok(response, "Unexpected extra request");
      return response;
    },
    window: {
      setTimeout(callback, delay) {
        delays.push(delay);
        timers.set(++timerId, callback);
        return timerId;
      },
      clearTimeout(id) {
        timers.delete(id);
      },
    },
  });
  const stop = subscribe("thread", "resource", (event) => events.push(event));
  return {
    stop,
    events,
    timers,
    delays,
    calls: () => calls,
    async tick() {
      assert.equal(timers.size, 1, "Expected one pending reconnect");
      const [id, callback] = timers.entries().next().value;
      timers.delete(id);
      callback();
      await flush();
    },
  };
}

test("Transient HTTP failure reconnects and stop cancels its timer", async () => {
  const h = harness([new Response(null, { status: 503 }), new Error("offline")]);
  try {
    await flush();
    await h.tick();
    assert.equal(h.calls(), 2);
    assert.deepEqual(h.delays, [1000, 2000]);
  } finally {
    h.stop();
  }
  assert.equal(h.timers.size, 0);
});

test("Authentication failure does not retry", async () => {
  const h = harness([new Response(null, { status: 401 })]);
  await flush();
  h.stop();
  assert.equal(h.calls(), 1);
  assert.equal(h.timers.size, 0);
});

test("EOF and read errors release their stream locks", async () => {
  for (const error of [false, true]) {
    const body = new ReadableStream({
      start(controller) {
        if (error) controller.error(new Error("read failed"));
        else controller.close();
      },
    });
    const h = harness([new Response(body)]);
    try {
      await flush();
      assert.equal(body.locked, false);
    } finally {
      h.stop();
    }
  }
});

test("Unsubscribe cancels pending read and prevents late events", async () => {
  let cancelled = false;
  const body = new ReadableStream({
    cancel() {
      cancelled = true;
    },
  });
  const h = harness([new Response(body)]);
  await flush();
  h.stop();
  await flush();
  assert.equal(cancelled, true);
  assert.equal(body.locked, false);
  assert.equal(h.events.length, 0);
  assert.equal(h.timers.size, 0);
});

test("Split SSE frames preserve completion events after recovery", async () => {
  const frame = `data: ${JSON.stringify({ type: "background-task-completed", payload: { taskId: "t", result: "完成" } })}\r\n\r\n`;
  const bytes = new TextEncoder().encode(frame);
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.slice(0, bytes.length - 8));
      controller.enqueue(bytes.slice(bytes.length - 8));
      controller.close();
    },
  });
  const h = harness([new Error("offline"), new Response(body)]);
  try {
    await flush();
    await h.tick();
    assert.equal(h.events.length, 1);
    assert.equal(h.events[0].status, "completed");
    assert.equal(h.events[0].result, "完成");
    assert.equal(body.locked, false);
  } finally {
    h.stop();
  }
});
