import { resolveModelConfig } from "@mastra/core/llm";
import type { Processor } from "@mastra/core/processors";
import type { RequestContext } from "@mastra/core/request-context";
import type { PublicSchema } from "@mastra/core/schema";
import { toStandardSchema } from "@mastra/core/schema";
import type { ToolExecutionContext, ToolHooks } from "@mastra/core/tools";
import type { ToolSet } from "ai";
import {
  type AgentProfile,
  DEFAULT_AGENT_PROFILE_ID,
  isUserChatMessage,
} from "../../shared/agent-contract";
import type {
  InstalledPlugin,
  PluginBinding,
  PluginCommandDefinition,
  PluginComponent,
} from "../../shared/plugin-contract";
import { requestToolApproval } from "../agents/permissions";
import { userIdFromContext } from "../storage/database";
import { WORKSPACE_PATH_CONTEXT_KEY } from "../workspace/workspace-manager";
import { pluginAgentDefinition, pluginProfileId, resolvePluginModel } from "./agents";
import { pluginShellCommands } from "./components";
import { runPluginHooks, startPluginSession } from "./hooks";
import { pluginBinding, recordPluginStatus } from "./registry";
import {
  activePluginComponents,
  executePluginCommand,
  expandPluginText,
  pluginToolAllowed,
  requirePluginBinding,
  resolvePluginToolNames,
} from "./runtime";

export async function listPluginCommands(owner?: string) {
  return (await activePluginComponents(owner, "commands")).map(({ plugin, component }) => ({
    id: component.id,
    name: pluginCommandName(plugin, component),
    description: component.description,
    argumentHint: component.command?.argumentHint ?? "",
    pluginId: plugin.id,
  }));
}

function pluginCommandName(plugin: InstalledPlugin, component: PluginComponent) {
  const namespace = plugin.listing?.key ?? plugin.current.name;
  return `${/^[\w-]+$/.test(namespace) ? namespace : plugin.id}:${component.name}`;
}

/** Parse quoted positional arguments; never evaluate shell syntax. */
export function commandArguments(value: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote = "";
  let started = false;
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (char === "\\" && quote !== "'" && i + 1 < value.length && /[\s"'\\]/.test(value[i + 1])) {
      current += value[++i];
      started = true;
    } else if (quote) {
      if (char === quote) quote = "";
      else current += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) {
        args.push(current);
        current = "";
        started = false;
      }
    } else {
      current += char;
      started = true;
    }
  }
  if (quote) throw new Error("Unclosed quote in plugin command arguments");
  if (started) args.push(current);
  return args;
}
export function expandCommandArguments(text: string, raw: string) {
  const args = commandArguments(raw);
  const pattern = /\$ARGUMENTS(?:\[(\d+)\])?|\$(\d+)/g;
  const hasArguments = pattern.test(text);
  pattern.lastIndex = 0;
  const expanded = text.replace(
    pattern,
    (_match, index: string | undefined, position: string | undefined) =>
      index !== undefined
        ? (args[Number(index)] ?? "")
        : position !== undefined
          ? (args[Number(position)] ?? "")
          : raw,
  );
  return !hasArguments && raw ? `${expanded}\n\nArguments: ${raw}` : expanded;
}

export const PLUGIN_COMMAND_CONTEXT_KEY = "mastra-work:plugin-command";
export interface CommandInvocation {
  binding: PluginBinding;
  definition: PluginCommandDefinition;
  prompt: string;
  agentId?: string;
  dispatched?: boolean;
}
async function prepareCommand(
  text: string,
  context: RequestContext,
  signal?: AbortSignal,
): Promise<CommandInvocation | undefined> {
  const parsed = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!parsed) return;
  const owner = userIdFromContext(context);
  const entries = await activePluginComponents(owner, "commands");
  const matches = entries.filter(
    ({ plugin, component }) => pluginCommandName(plugin, component) === parsed[1],
  );
  if (!matches.length) {
    if (parsed[1].includes(":"))
      throw new Error("Plugin command is unavailable; refresh the command menu");
    return;
  }
  if (matches.length !== 1 || !owner)
    throw new Error("Ambiguous plugin command; rename or disable the conflicting plugin");
  const { plugin, component, binding } = matches[0];
  const definition = component.command;
  if (!definition) throw new Error("Missing command definition");
  const target = definition.agent
    ? plugin.current.components.find(
        (item) => item.kind === "agents" && item.name === definition.agent,
      )
    : undefined;
  if (definition.agent && !target) throw new Error("The command's agent is unavailable");
  if (target) {
    await requirePluginBinding(pluginBinding(plugin, target), owner);
    if (
      target.agent?.hooks?.length &&
      plugin.executionGrants?.[target.id] !== plugin.current.digest
    )
      throw new Error("Authorize the command's Agent before invoking this command");
  }
  if (definition.model) await resolvePluginModel(definition.model, context);
  const promptHook = await runPluginHooks(
    "UserPromptSubmit",
    context,
    { prompt: text },
    { binding, global: false, signal },
  );
  if (promptHook.blocked) throw new Error(promptHook.blocked);
  let template = "";
  let offset = 0;
  for (const { command, start, end } of pluginShellCommands(definition.instructions)) {
    if (/\$ARGUMENTS|\$\d/.test(command))
      throw new Error("Pass user arguments through hook stdin, not shell interpolation");
    const result = await executePluginCommand(
      binding,
      command,
      context,
      { arguments: parsed[2] ?? "", argv: commandArguments(parsed[2] ?? "") },
      60,
      signal,
    );
    if (result.exitCode !== 0) throw new Error("Plugin command preprocessing failed");
    template += definition.instructions.slice(offset, start) + result.stdout;
    offset = end;
  }
  template += definition.instructions.slice(offset);
  template = await expandPluginText(
    template,
    plugin,
    owner,
    context.get(WORKSPACE_PATH_CONTEXT_KEY) as string | undefined,
  );
  recordPluginStatus(owner, binding, "ready");
  return {
    binding,
    definition: { ...definition, tools: resolvePluginToolNames(plugin, definition.tools) },
    prompt: [expandCommandArguments(template, parsed[2] ?? ""), ...promptHook.context].join("\n\n"),
    agentId: target ? pluginProfileId(target.id) : undefined,
  };
}

/** Native hooks protect even direct tool calls; the processor wraps all tool sources, including Code Mode. */
const wrappedTools = new WeakMap<RequestContext, Set<string>>();
export function pluginAgentHooks(binding?: PluginBinding): ToolHooks {
  return {
    beforeToolCall: async ({ toolName, input, context }) => {
      const execution = context as ToolExecutionContext | undefined;
      const requestContext = execution?.requestContext;
      if (!requestContext) return;
      if (binding) {
        const { definition } = await pluginAgentDefinition(binding, requestContext);
        if (!pluginToolAllowed(toolName, definition.tools, definition.disallowedTools, input))
          return { proceed: false, output: "Tool denied by plugin Agent permissions" };
      }
      if (wrappedTools.get(requestContext)?.has(toolName)) return;
      const result = await runPluginHooks(
        "PreToolUse",
        requestContext,
        { tool_name: toolName, tool_input: input },
        { binding, signal: execution?.abortSignal },
      );
      if (result.blocked) return { proceed: false, output: result.blocked };
      if (result.updatedInput || result.context.length)
        throw new Error(
          "This provider-executed tool cannot apply hook input/context changes; use an executable tool instead",
        );
    },
    afterToolCall: async ({ toolName, input, output, error, context }) => {
      const execution = context as ToolExecutionContext | undefined;
      const requestContext = execution?.requestContext;
      if (!requestContext || wrappedTools.get(requestContext)?.has(toolName)) return;
      const result = await runPluginHooks(
        error ? "PostToolUseFailure" : "PostToolUse",
        requestContext,
        {
          tool_name: toolName,
          tool_input: input,
          tool_response: output,
          ...(error ? { error: "Tool failed" } : {}),
        },
        { binding, signal: execution?.abortSignal },
      );
      if (result.blocked || result.updatedOutput !== undefined || result.context.length)
        throw new Error(
          result.blocked ?? "This provider-executed tool cannot apply hook result changes",
        );
    },
  };
}

type ExecutionProcessor = Processor &
  Required<Pick<Processor, "processInputStep" | "processOutputResult">>;
const processors = new WeakMap<RequestContext, Map<string, ExecutionProcessor>>();
export function pluginExecutionProcessor(
  profile?: AgentProfile,
  context?: RequestContext,
): ExecutionProcessor {
  const key = profile?.id ?? DEFAULT_AGENT_PROFILE_ID;
  const cached = context ? processors.get(context)?.get(key) : undefined;
  if (cached) return cached;
  let command: CommandInvocation | undefined;
  let commandAgentDispatched = false;
  let submitted = false;
  let stopped = false;
  const guarded = new WeakSet<object>();
  const processor: ExecutionProcessor = {
    id: "plugin-execution",
    async processInputStep({
      requestContext,
      messages,
      tools,
      activeTools,
      abortSignal,
      abort,
      sendSignal,
    }) {
      if (!requestContext) return;
      const owner = userIdFromContext(requestContext);
      const agentDefinition = profile?.plugin
        ? (await pluginAgentDefinition(profile.plugin, requestContext)).definition
        : undefined;
      if (!submitted) {
        submitted = true;
        const start = await startPluginSession(requestContext, abortSignal);
        if (start.blocked) abort(start.blocked, { retry: false });
        if (start.context.length)
          await sendSignal?.({
            type: "reactive",
            transient: true,
            contents: start.context.join("\n"),
          });
        const userMessage = messages.toReversed().find(isUserChatMessage);
        const signal = userMessage?.content.metadata?.signal as
          | { metadata?: { pluginUserText?: unknown } }
          | undefined;
        const text =
          (typeof signal?.metadata?.pluginUserText === "string"
            ? signal.metadata.pluginUserText
            : userMessage?.content.parts
                .flatMap((part) => (part.type === "text" ? [part.text] : []))
                .join("\n")) ?? "";
        const inherited = requestContext.get(PLUGIN_COMMAND_CONTEXT_KEY) as
          | CommandInvocation
          | undefined;
        const delegated = typeof requestContext.get("mastra-work:team-invocation") === "string";
        const result = delegated
          ? { context: [] as string[], blocked: undefined }
          : await runPluginHooks(
              "UserPromptSubmit",
              requestContext,
              { prompt: text },
              { binding: profile?.plugin, signal: abortSignal },
            );
        if (result.blocked) abort(result.blocked, { retry: false });
        command =
          inherited ??
          (!delegated ? await prepareCommand(text, requestContext, abortSignal) : undefined);
        if (command && !inherited) requestContext.set(PLUGIN_COMMAND_CONTEXT_KEY, command);
        commandAgentDispatched = delegated || command?.dispatched === true;
        if (command || result.context.length)
          await sendSignal?.({
            type: "reactive",
            transient: true,
            contents: [
              ...(command
                ? [
                    `The user explicitly invoked this plugin command. Execute it with these instructions:\n${command.prompt}`,
                    ...(command.agentId && !inherited
                      ? [`Delegate this command to agent-${command.agentId}.`]
                      : []),
                  ]
                : []),
              ...result.context,
            ].join("\n\n"),
          });
      }
      if (command) await requirePluginBinding(command.binding, owner);
      const bindings = [
        ...(profile?.plugin ? [profile.plugin] : []),
        ...(command ? [command.binding] : []),
      ];
      const scoped = { ...tools } as ToolSet;
      wrappedTools.set(
        requestContext,
        new Set(
          Object.entries(scoped)
            .filter(([, tool]) => !!tool.execute)
            .map(([name]) => name),
        ),
      );
      const permitted = (name: string, input?: unknown) =>
        pluginToolAllowed(name, agentDefinition?.tools, agentDefinition?.disallowedTools, input) &&
        ((!commandAgentDispatched && name === `agent-${command?.agentId}`) ||
          pluginToolAllowed(name, command?.definition.tools, undefined, input));
      for (const [name, tool] of Object.entries(scoped)) {
        const execute = tool.execute;
        if (!execute || guarded.has(execute)) continue;
        const wrapped: typeof execute = async (input, context) => {
          for (const binding of bindings) await requirePluginBinding(binding, owner);
          if (!permitted(name, input)) throw new Error("Tool denied by plugin permissions");
          const signal = (context as { abortSignal?: AbortSignal }).abortSignal ?? abortSignal;
          const before = await runPluginHooks(
            "PreToolUse",
            requestContext,
            { tool_name: name, tool_input: input, tool_use_id: context.toolCallId },
            {
              bindings: [profile?.plugin, command?.binding].filter(
                (binding): binding is PluginBinding => !!binding,
              ),
              signal,
            },
          );
          if (before.blocked) return { error: before.blocked };
          let args = input;
          if (before.updatedInput) {
            const schema = tool.inputSchema;
            if (!schema) throw new Error("Cannot validate a hook's updated tool input");
            const validated = await toStandardSchema(schema as PublicSchema)["~standard"].validate(
              before.updatedInput,
            );
            if (validated.issues) throw new Error("Hook returned invalid tool input");
            args = validated.value;
            if (!permitted(name, args))
              throw new Error("Hook input violates plugin tool permissions");
            if (
              await requestToolApproval({
                toolName: name,
                args,
                requestContext: Object.fromEntries(requestContext.entries()),
              })
            )
              throw new Error("Hook changed an input requiring approval; submit a new tool call");
            const approval = (
              tool as {
                needsApprovalFn?: (input: unknown, ctx: unknown) => boolean | Promise<boolean>;
              }
            ).needsApprovalFn;
            if (
              approval &&
              (await approval(args, {
                requestContext: Object.fromEntries(requestContext.entries()),
              }))
            )
              throw new Error("Updated hook input requires a new explicit tool approval");
          }
          if (before.context.length)
            await sendSignal?.({
              type: "reactive",
              transient: true,
              contents: before.context.join("\n"),
            });
          let output: unknown;
          try {
            output = await execute(args, context);
          } catch (error) {
            await runPluginHooks(
              "PostToolUseFailure",
              requestContext,
              {
                tool_name: name,
                tool_input: args,
                error: "Tool execution failed",
                tool_use_id: context.toolCallId,
              },
              {
                bindings: [profile?.plugin, command?.binding].filter(
                  (binding): binding is PluginBinding => !!binding,
                ),
                signal,
              },
            );
            throw error;
          }
          const after = await runPluginHooks(
            "PostToolUse",
            requestContext,
            {
              tool_name: name,
              tool_input: args,
              tool_response: output,
              tool_use_id: context.toolCallId,
            },
            {
              bindings: [profile?.plugin, command?.binding].filter(
                (binding): binding is PluginBinding => !!binding,
              ),
              signal,
            },
          );
          if (after.context.length)
            await sendSignal?.({
              type: "reactive",
              transient: true,
              contents: after.context.join("\n"),
            });
          if (after.blocked) throw new Error(after.blocked);
          return after.updatedOutput ?? output;
        };
        guarded.add(wrapped);
        scoped[name] = { ...tool, execute: wrapped };
      }
      const selected = (activeTools ?? Object.keys(scoped)).filter((name) => permitted(name));
      if (command?.agentId && !commandAgentDispatched) {
        const name = `agent-${command.agentId}`;
        if (!scoped[name] || !selected.includes(name))
          abort("Command agent is outside this Agent's delegation scope", { retry: false });
        // The flag changes only after execution, not after proposing a tool that may need approval.
        const execute = scoped[name].execute;
        if (execute)
          scoped[name] = {
            ...scoped[name],
            execute: async (input, options) => {
              const result = await execute(input, options);
              commandAgentDispatched = true;
              if (command) {
                command = { ...command, dispatched: true };
                requestContext.set(PLUGIN_COMMAND_CONTEXT_KEY, command);
              }
              return result;
            },
          };
        return { tools: scoped, activeTools: [name], toolChoice: { type: "tool", toolName: name } };
      }
      const model = command?.definition.model
        ? await resolveModelConfig(
            await resolvePluginModel(command.definition.model, requestContext),
            requestContext,
          )
        : undefined;
      if (model?.specificationVersion === "v1")
        throw new Error("Plugin commands require a current model protocol");
      return {
        tools: scoped,
        activeTools: selected,
        ...(model ? { model } : {}),
      };
    },
    async processOutputResult({ requestContext, result, abort, abortSignal, messages }) {
      if (!requestContext) return messages;
      const outcome = await runPluginHooks(
        "Stop",
        requestContext,
        { last_assistant_message: result.text, stop_hook_active: stopped },
        {
          bindings: [profile?.plugin, command?.binding].filter(
            (binding): binding is PluginBinding => !!binding,
          ),
          signal: abortSignal,
          global: typeof requestContext.get("mastra-work:team-invocation") !== "string",
        },
      );
      stopped = true;
      if (outcome.blocked) abort(outcome.blocked, { retry: true });
      requestContext.delete(PLUGIN_COMMAND_CONTEXT_KEY);
      if (context) processors.get(context)?.delete(key);
      return messages;
    },
  };
  if (context) {
    const cache = processors.get(context) ?? new Map();
    cache.set(key, processor);
    processors.set(context, cache);
  }
  return processor;
}
