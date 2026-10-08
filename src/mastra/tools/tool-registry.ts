/** Code Mode uses the current step's authorized tools and the official QuickJS boundary. */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { ToolsInput } from "@mastra/core/agent";
import type { InputProcessor } from "@mastra/core/processors";
import { type PublicSchema, toStandardSchema } from "@mastra/core/schema";
import {
  type CoreTool,
  createCodeMode,
  createTool,
  MASTRA_TOOL_MARKER,
  type NeedsApprovalFn,
  type Tool,
  type ToolExecutionContext,
} from "@mastra/core/tools";
import { QuickJsCodeModeTransport } from "@mastra/quickjs";
import { z } from "zod";
import { PERMISSION_RULES_CONTEXT_KEY } from "../../shared/agent-contract.ts";
import {
  type PermissionPolicy,
  parsePermissionRules,
  requestToolApproval,
  SESSION_TOOL_POLICY_CONTEXT_KEY,
  toolCategoryOf,
} from "../agents/permissions.ts";

const CODE_MODE_ID = "execute_typescript";
const CODE_MODE_TIMEOUT = 30_000;
// These tools suspend or end the native agent turn; a Code Mode program cannot resume mid-script.
const DIRECT_TOOL_NAMES = new Set([CODE_MODE_ID, "ask_user", "submit_plan", "handoff"]);
const codeModeTransport = new QuickJsCodeModeTransport({ memoryLimitMb: 128 });
// createCodeMode forwards only base context; preserve each run's agent context for delegation.
const execution = new AsyncLocalStorage<ToolExecutionContext>();
type StepTool = (CoreTool | Tool) & {
  requireApproval?: boolean | NeedsApprovalFn;
  needsApprovalFn?: NeedsApprovalFn;
};

function codeModeSchema(schema: unknown) {
  const source =
    schema && typeof schema === "object" && "jsonSchema" in schema ? schema.jsonSchema : schema;
  return toStandardSchema((source ?? z.unknown()) as PublicSchema);
}

/** Runs after tool policy processors so workspace, browser, MCP, skills and delegates are resolved. */
export function codeModeProcessor(scheduled = false): InputProcessor {
  return {
    id: "workbench-code-mode",
    processInputStep({ tools, activeTools, systemMessages, requestContext }) {
      const rules = () => parsePermissionRules(requestContext?.get(PERMISSION_RULES_CONTEXT_KEY));
      const policy = (name: string): PermissionPolicy => {
        const resolve = requestContext?.get(SESSION_TOOL_POLICY_CONTEXT_KEY);
        if (typeof resolve === "function") return resolve(name);
        const current = rules();
        return current.tools[name] ?? current.categories[toolCategoryOf(name)] ?? "deny";
      };
      const resolved = { ...tools } as Record<string, StepTool>;
      delete resolved[CODE_MODE_ID];
      const active = (activeTools ?? Object.keys(resolved)).filter((name) => name !== CODE_MODE_ID);
      const modePolicy = policy(CODE_MODE_ID);
      if (modePolicy === "deny" || (scheduled && modePolicy !== "allow"))
        return { tools: resolved, activeTools: active };

      const externalTools: ToolsInput = {};
      for (const name of active) {
        const original = resolved[name];
        if (DIRECT_TOOL_NAMES.has(name) || !original?.execute || policy(name) !== "allow") continue;
        const execute = original.execute;
        const approval = original.needsApprovalFn ?? original.requireApproval;
        if (approval === true) continue;
        const native = MASTRA_TOOL_MARKER in original;
        const inputSchema = codeModeSchema(
          "inputSchema" in original ? original.inputSchema : (original as CoreTool).parameters,
        );
        externalTools[name] = createTool({
          id: name,
          description: original.description ?? name,
          inputSchema,
          // The original tool owns output validation; expose its schema without validating side effects twice.
          outputSchema: codeModeSchema(original.outputSchema),
          outputValidation: "warn",
          execute: async (input) => {
            const context = execution.getStore();
            if (!context) throw new Error("Code Mode execution context is unavailable");
            context.abortSignal?.throwIfAborted();
            if (
              input &&
              typeof input === "object" &&
              ("_background" in input ||
                "suspendedToolCallId" in input ||
                "suspendedToolRunId" in input)
            )
              throw new Error(
                `${name} must use the native tool entry for background execution or resuming a suspended call.`,
              );
            const needsApproval =
              typeof approval === "function" &&
              (await approval(input, {
                requestContext: Object.fromEntries(context.requestContext?.entries() ?? []),
                workspace: context.workspace,
              }));
            context.abortSignal?.throwIfAborted();
            if (policy(name) !== "allow" || needsApproval)
              throw new Error(
                `${name} requires approval or is no longer allowed. Call it directly; do not replay completed operations.`,
              );
            const toolCallId = `${CODE_MODE_ID}:${randomUUID()}`;
            const suspend = async () => {
              throw new Error(
                `${name} requires a native interaction. Call it directly; do not replay completed operations.`,
              );
            };
            if (native)
              return (execute as NonNullable<Tool["execute"]>)(input, {
                ...context,
                suspend,
                agent: context.agent ? { ...context.agent, toolCallId, suspend } : undefined,
              });
            return (execute as NonNullable<CoreTool["execute"]>)(input, {
              toolCallId,
              messages: context.agent?.messages ?? [],
              requestContext: context.requestContext,
              abortSignal: context.abortSignal,
              workspace: context.workspace,
              actor: context.actor,
              tracingContext: context.tracingContext,
              observe: context.observe,
              flushMessages: context.agent?.flushMessages,
              getMessages: context.agent?.getMessages,
              suspend,
            });
          },
        });
      }
      const mode = createCodeMode(
        { tools: externalTools, timeout: CODE_MODE_TIMEOUT },
        codeModeTransport,
      );
      const execute = mode.tool.execute;
      if (!execute) throw new Error("Code Mode tool has no executor");
      const tool = createTool({
        ...mode.tool,
        requireApproval: (args, context) =>
          requestToolApproval({ toolName: CODE_MODE_ID, args, ...context }),
        execute: async (input, context) => {
          const controller = new AbortController();
          const abortSignal = AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(CODE_MODE_TIMEOUT),
            ...(context.abortSignal ? [context.abortSignal] : []),
          ]);
          const scopedContext = { ...context, abortSignal };
          try {
            return await execution.run(scopedContext, () => execute(input, scopedContext));
          } finally {
            controller.abort();
          }
        },
      });
      return {
        tools: { ...resolved, [CODE_MODE_ID]: tool },
        activeTools: [...active, CODE_MODE_ID],
        systemMessages: [
          ...systemMessages,
          {
            role: "system",
            content:
              mode.instructions +
              "\nThe program is isolated: no filesystem, network, process or module access. Use only the declared external functions. Tools not declared here remain direct calls, including user questions, approvals, handoffs and provider-executed tools. Use native tool calls for background execution, resuming suspended runs, or work exceeding the 30-second Code Mode budget. If a batch fails after a write or delegation, inspect completed results before retrying; never blindly replay the whole batch.",
          },
        ],
      };
    },
  };
}
