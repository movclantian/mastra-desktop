import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const source = readFileSync(
  new URL("../src/renderer/src/widgets/chat-panel/ui/assistant-trace.tsx", import.meta.url),
  "utf8",
);
const ast = ts.createSourceFile(
  "assistant-trace.tsx",
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
const hook = ast.statements.find(
  (statement) =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === "useTraceDisclosure",
);
assert.ok(hook, "Trace disclosures must share one policy");
const compiled = ts.transpile(hook.getText(ast).replace(/^export\s+/, ""), {
  target: ts.ScriptTarget.ESNext,
});

function disclosure(initialPreference, initialStreaming) {
  let state;
  let dirty = false;
  const context = vm.createContext({
    React: {
      useState(initial) {
        state ??= initial;
        return [
          state,
          (next) => {
            state = typeof next === "function" ? next(state) : next;
            dirty = true;
          },
        ];
      },
      useCallback: (callback) => callback,
    },
  });
  vm.runInContext(compiled, context);
  const evaluate = context.useTraceDisclosure;
  const render = (preference, streaming) => {
    let result;
    let attempts = 0;
    do {
      dirty = false;
      result = evaluate(preference, streaming);
      assert.ok(++attempts < 4, "Disclosure reset must settle before commit");
    } while (dirty);
    return result;
  };
  return { render, initial: render(initialPreference, initialStreaming) };
}

for (const enabled of [false, true]) {
  const instance = disclosure(enabled, false);
  assert.equal(instance.initial[0], enabled);
  instance.initial[1](!enabled);
  assert.equal(instance.render(enabled, false)[0], !enabled, "Manual toggle persists");
  const running = instance.render(enabled, true);
  assert.equal(running[0], enabled, "A new run reapplies the preference");
  running[1](!enabled);
  assert.equal(
    instance.render(enabled, true)[0],
    !enabled,
    "Tokens cannot override a manual toggle",
  );
  assert.equal(
    instance.render(enabled, false)[0],
    !enabled,
    "Completion preserves the chosen state",
  );
  assert.equal(instance.render(!enabled, false)[0], !enabled, "Setting changes apply immediately");
}

const loading = disclosure(false, true);
assert.equal(
  loading.render(true, true)[0],
  true,
  "Loaded settings open an already streaming trace",
);
assert.equal(loading.render(false, true)[0], false, "Disabling settings closes a running trace");
assert.equal(
  source.match(/= useTraceDisclosure\(showDetails, isStreaming\)/g)?.length,
  6,
  "Overview, reasoning, tool group, tool detail, sandbox and stack trace must share the preference",
);
console.log("Trace disclosure checks passed.");
const memberSource = readFileSync(
  new URL("../src/renderer/src/widgets/chat-panel/ui/agent-member-stream.tsx", import.meta.url),
  "utf8",
);
assert.ok(
  memberSource.includes("useTraceDisclosure(showDetails, running)"),
  "Subagent traces must use the same disclosure preference",
);

const modelSource = readFileSync(
  new URL("../src/renderer/src/widgets/chat-panel/model/types.ts", import.meta.url),
  "utf8",
);
const modelAst = ts.createSourceFile("types.ts", modelSource, ts.ScriptTarget.Latest, true);
const functions = [
  "getTraceStepStatus",
  "getToolTraceState",
  "asRecord",
  "withTerminalEvent",
  "mergeToolPart",
];
const modelContext = vm.createContext({
  getToolName: (part) => (part.type === "dynamic-tool" ? part.toolName : part.type.slice(5)),
  isToolUIPart: (part) => part.type === "dynamic-tool" || part.type.startsWith("tool-"),
});
for (const name of functions) {
  const statement = modelAst.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === name,
  );
  assert.ok(statement, `${name} must exist`);
  vm.runInContext(
    ts.transpile(statement.getText(modelAst).replace(/^export\s+/, ""), {
      target: ts.ScriptTarget.ESNext,
    }),
    modelContext,
  );
}
const tool = (state, extra = {}, name = "test") => ({
  type: `tool-${name}`,
  toolCallId: "call",
  state,
  ...extra,
});
for (const state of ["input-streaming", "input-available", "approval-responded"]) {
  const part = tool(state, state === "approval-responded" ? { approval: { approved: true } } : {});
  assert.equal(modelContext.getToolTraceState(part, true).active, true);
  assert.equal(modelContext.getToolTraceState(part, false).failed, true);
}
for (const part of [
  tool("output-denied"),
  tool("approval-responded", { approval: { approved: false } }),
]) {
  const state = modelContext.getToolTraceState(part, true);
  assert.equal(state.denied, true);
  assert.equal(state.active, false);
  assert.equal(state.failed, false);
}
assert.equal(
  modelContext.getToolTraceState(tool("output-available", { preliminary: true }), true).active,
  true,
);
assert.equal(
  modelContext.getToolTraceState(tool("output-available", { output: "done" }), false).failed,
  false,
);
assert.equal(modelContext.getToolTraceState(tool("output-error"), false).failed, true);
assert.equal(
  modelContext.getToolTraceState(
    tool("output-available", { output: { success: false } }, "execute_typescript"),
    false,
  ).failed,
  true,
);
for (const output of ["failed\nExit code: 2", "Error: spawn failed"]) {
  assert.equal(
    modelContext.getToolTraceState(
      tool("output-available", { output }, "mastra_workspace_execute_command"),
      false,
    ).failed,
    true,
  );
}
assert.equal(
  modelContext.getToolTraceState(
    tool("output-available", { output: "Exit code: 0" }, "mastra_workspace_execute_command"),
    false,
  ).failed,
  false,
);

const initialCommand = tool(
  "input-available",
  { input: { command: "pnpm build" } },
  "mastra_workspace_execute_command",
);
const stdout = modelContext.withTerminalEvent([initialCommand], {
  type: "shell_output",
  toolCallId: "call",
  output: "first\n",
});
const stderr = modelContext.withTerminalEvent(stdout, {
  type: "shell_output",
  toolCallId: "call",
  output: "second\n",
});
assert.equal(initialCommand.terminal, undefined, "Stream updates cannot mutate source parts");
assert.equal(stderr[0].terminal.output, "first\nsecond\n");
const exited = modelContext.withTerminalEvent(stderr, {
  type: "command_exit",
  toolCallId: "call",
  exitCode: 2,
});
assert.equal(modelContext.getToolTraceState(exited[0], true).failed, true);
assert.equal(modelContext.getToolTraceState(exited[0], true).active, false);
const replayed = modelContext.mergeToolPart(exited[0], initialCommand);
assert.equal(replayed.terminal.exitCode, 2, "Native snapshots must preserve terminal state");
const capped = modelContext.withTerminalEvent([initialCommand], {
  type: "shell_output",
  toolCallId: "call",
  output: "x".repeat(100_000),
});
assert.equal(capped[0].terminal.output.length, 64 * 1024);
assert.equal(
  modelContext.withTerminalEvent([initialCommand], {
    type: "shell_output",
    toolCallId: "other",
    output: "ignored",
  })[0],
  initialCommand,
);
assert.equal(
  modelContext.getToolTraceState(
    tool(
      "output-available",
      { output: "Error: just printed text", terminal: { output: "", exitCode: 0 } },
      "mastra_workspace_execute_command",
    ),
    false,
  ).failed,
  false,
);
modelContext.normalizeTraceParts = (parts) => parts;
modelContext.getCompletedInteraction = () => undefined;
modelContext.isPromptManagedToolName = (name) => ["ask_user", "submit_plan"].includes(name);
const segmentation = modelAst.statements.find(
  (node) => ts.isFunctionDeclaration(node) && node.name?.text === "getAssistantSegments",
);
assert.ok(segmentation);
vm.runInContext(
  ts.transpile(segmentation.getText(modelAst).replace(/^export\s+/, ""), {
    target: ts.ScriptTarget.ESNext,
  }),
  modelContext,
);
const segments = modelContext.getAssistantSegments(
  [
    tool("approval-requested"),
    tool("input-available", {}, "ask_user"),
    tool("output-available", { output: "truncated" }, "mastra_workspace_execute_command"),
    { type: "data-workspace-log", id: "call", data: { exitCode: 3 } },
  ],
  "message",
);
assert.equal(segments.length, 1);
assert.equal(segments[0].parts.length, 1, "Pending interactions stay outside Trace");
assert.equal(
  modelContext.getToolTraceState(segments[0].parts[0], false).exitCode,
  3,
  "Archive metadata supplies the historical exit code",
);

const citationSource = readFileSync(
  new URL("../src/renderer/src/widgets/chat-panel/lib/citation-utils.ts", import.meta.url),
  "utf8",
);
const citationAst = ts.createSourceFile(
  "citation-utils.ts",
  citationSource,
  ts.ScriptTarget.Latest,
  true,
);
const citationContext = vm.createContext({ URL });
for (const name of ["getMessageSources", "hostnameOf", "isUsableUrl"]) {
  const statement = citationAst.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === name,
  );
  assert.ok(statement);
  vm.runInContext(
    ts.transpile(statement.getText(citationAst).replace(/^export\s+/, ""), {
      target: ts.ScriptTarget.ESNext,
    }),
    citationContext,
  );
}
const sources = citationContext.getMessageSources(
  [
    { type: "source-url", url: "https://example.com", title: "Duplicate" },
    { type: "source-url", url: "https://example.org", title: "Second" },
    { type: "source-url", url: "javascript:alert(1)" },
  ],
  new Map([["ref", [{ url: "https://example.com", title: "Cited" }]]]),
);
assert.equal(sources.length, 2);
assert.equal(sources[0].title, "Cited");
console.log("Tool states and source deduplication checks passed.");
