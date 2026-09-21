import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import vm from "node:vm";
import { MDocument } from "@mastra/rag";
import { getToolName as getAISDKToolName, isToolUIPart } from "ai";

// Load the actual pure functions without initializing the app's database,
// embedding runtime or browser-only i18n. This is a function regression test,
// not an Electron or end-to-end test.
function loadFunctions(relativePath, names, globals = {}) {
  const source = process.env.REGRESSION_BASELINE
    ? execFileSync("git", ["show", `${process.env.REGRESSION_BASELINE}:${relativePath.replace(/^\.\.\//, "")}`], { encoding: "utf8", cwd: new URL("../", import.meta.url) })
    : readFileSync(new URL(relativePath, import.meta.url), "utf8");
  // These top-level declarations have unindented closing braces. Fail loudly
  // if their shape changes; do not add a parser dependency just for this probe.
  const declarations = names.map((name) => {
    const matches = [...source.matchAll(new RegExp(`^(?:export )?((?:async )?function ${name}\\b[\\s\\S]*?^})`, "gm"))];
    assert.equal(matches.length, 1, `Expected one top-level function: ${name}`);
    return matches[0][1];
  });
  const outputText = stripTypeScriptTypes(
    declarations.join("\n"),
  );
  return vm.runInNewContext(`${outputText}\n({${names.join(",")}})`, globals);
}

const { chunkDocument } = loadFunctions(
  "../src/mastra/rag/document/indexing.ts", ["chunkDocument"],
);
const { getActiveToolsFromMessages } = loadFunctions(
  "../src/renderer/src/widgets/chat-panel/model/types.ts",
  ["getToolName", "getActiveToolsFromMessages"],
  { isToolUIPart, getAISDKToolName },
);
const { normalizeAgentTasks } = loadFunctions(
  "../src/renderer/src/widgets/chat-panel/model/types.ts", ["normalizeAgentTasks"],
);
const { normalizeAgentTools } = loadFunctions(
  "../src/renderer/src/widgets/chat-panel/model/types.ts", ["normalizeAgentTools"],
);
const { buildDisplayMessages } = loadFunctions(
  "../src/renderer/src/widgets/chat-panel/lib/display.ts", ["buildDisplayMessages"],
  { isToolUIPart },
);

test("Merged assistant rows show one tool call with its latest result", () => {
  const input = tool("shared-call", "input-available");
  const output = tool("shared-call", "output-available");
  const first = assistant("a1", [input]);
  const second = assistant("a2", [output]);
  const displayed = buildDisplayMessages([first, second]);
  assert.equal(displayed.length, 1);
  assert.equal(displayed[0].message.parts.length, 1);
  assert.equal(displayed[0].message.parts[0], output);
  assert.equal(first.parts[0], input);
  assert.equal(first.parts.length, 1);
  assert.deepEqual(Array.from(displayed[0].sourceIds), ["a1", "a2"]);
});

test("Tool projection keeps text order, stable group identity and separate user turns", () => {
  const messages = [
    assistant("a1", [tool("t", "input-available"), { type: "text", text: "between" }]),
    assistant("a2", [tool("t", "output-error"), tool("other", "output-available")]),
    user("u2"), assistant("a3", [tool("t", "input-available")]),
  ];
  const displayed = buildDisplayMessages(messages);
  assert.equal(displayed.length, 3);
  assert.equal(displayed[0].message.id, "a1");
  assert.deepEqual(Array.from(displayed[0].message.parts, (part) => part.toolCallId ?? part.text), ["t", "between", "other"]);
  assert.equal(displayed[2].message.parts[0].state, "input-available");
});

test("Single-row dynamic tools deduplicate without removing repeated text or mutating input", () => {
  const before = Object.freeze({ type: "dynamic-tool", toolName: "read_file", toolCallId: "d", state: "input-available", input: {} });
  const after = Object.freeze({ ...before, state: "output-available", output: "done" });
  const text = Object.freeze({ type: "text", text: "repeat" });
  const parts = Object.freeze([before, text, after, text]);
  const message = Object.freeze(assistant("frozen", parts));
  const [entry] = buildDisplayMessages(Object.freeze([message]));
  assert.equal(entry.message.parts.length, 3);
  assert.equal(entry.message.parts[0], after);
  assert.equal(entry.message.parts[1], text);
  assert.equal(entry.message.parts[2], text);
  assert.equal(parts.length, 4);
});
const settings = { chunkStrategy: "markdown", chunkSize: 100, chunkOverlap: 0 };
const assistant = (id, parts) => ({ id, role: "assistant", parts });
const user = (id) => ({ id, role: "user", parts: [{ type: "text", text: "next" }] });
const tool = (toolCallId, state) => ({
  type: "tool-read_file", toolCallId, state, input: {}, output: "done",
});

test("Markdown chunker preserves all six heading levels and their metadata", async () => {
  const text = Array.from({ length: 6 }, (_, i) => `${"#".repeat(i + 1)} 标题${i + 1}\n\n正文${i + 1}`).join("\n\n");
  const chunks = await chunkDocument(MDocument.fromMarkdown(text), settings);
  assert.ok(!chunks.some((chunk) => chunk.text.includes("#{1,6}")));
  for (let level = 1; level <= 6; level++) {
    assert.ok(chunks.some((chunk) => chunk.text.includes(`${"#".repeat(level)} 标题${level}`)));
    assert.ok(chunks.some((chunk) => chunk.metadata[`Header ${level}`] === `标题${level}`));
  }
});

test("Markdown keeps code-fence headings literal and respects chunk size", async () => {
  const text = ["# Title", "```md\n## literal\n```", "some body text ".repeat(60)].join("\n\n");
  const chunks = await chunkDocument(MDocument.fromMarkdown(text), settings);
  assert.ok(chunks.some((chunk) => chunk.text.includes("## literal")));
  assert.ok(chunks.every((chunk) => chunk.metadata["Header 2"] === undefined));
  assert.ok(chunks.every((chunk) => chunk.text.length <= settings.chunkSize));
});

test("A new user turn does not revive unfinished historical tools", () => {
  const messages = [user("u1"), assistant("a1", [tool("old", "input-available")]), user("u2")];
  assert.equal(getActiveToolsFromMessages(messages).length, 0);
  messages.push(assistant("a2", [tool("current", "input-streaming")]));
  assert.deepEqual(Array.from(getActiveToolsFromMessages(messages), (item) => item.toolCallId), ["current"]);
});

test("Current-turn tool completion, failure and approval denial clear active state", () => {
  for (const state of ["output-available", "output-error", "output-denied"]) {
    const messages = [user("u"), assistant("a1", [tool("t", "input-available")]), assistant("a2", [tool("t", state)])];
    assert.equal(getActiveToolsFromMessages(messages).length, 0);
  }
  assert.equal(getActiveToolsFromMessages([assistant("a", [tool("t", "approval-requested")])]).length, 1);
});

test("Task snapshots keep stable order and the latest duplicate status", () => {
  const tasks = normalizeAgentTasks([
    { id: "a", content: "first", activeForm: "run", status: "in_progress" },
    { id: "b", content: "second", activeForm: "run", status: "pending" },
    { id: "a", content: "first", activeForm: "done", status: "completed" },
  ]);
  assert.equal(Array.from(tasks, (task) => task.id).join(","), "a,b");
  assert.equal(tasks[0].status, "completed");
  assert.equal(tasks[0].activeForm, "done");
});

test("Queue tool snapshots keep stable order and latest duplicate state", () => {
  const tools = normalizeAgentTools([
    { toolCallId: "call-a", name: "read_file", status: "running" },
    { toolCallId: "call-b", name: "grep", status: "running" },
    { toolCallId: "call-a", name: "read_file", status: "completed" },
  ]);
  assert.deepEqual(Array.from(tools, (tool) => tool.toolCallId), ["call-a", "call-b"]);
  assert.equal(tools[0].status, "completed");
});
