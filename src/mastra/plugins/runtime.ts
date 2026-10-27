import { join } from "node:path";
import type { RequestContext } from "@mastra/core/request-context";
import { type LSPConfig, WORKSPACE_TOOLS } from "@mastra/core/workspace";
import type { InstalledPlugin, PluginBinding, PluginComponent } from "../../shared/plugin-contract";
import {
  PERMISSION_RULES_CONTEXT_KEY,
  parsePermissionRules,
  resolveRequestMode,
  SESSION_TOOL_POLICY_CONTEXT_KEY,
  toolCategoryOf,
} from "../agents/permissions";
import { userIdFromContext } from "../storage/database";
import {
  getInstalledPlugin,
  listInstalledPlugins,
  pluginBinding,
  pluginComponentEnabled,
  pluginsDirectory,
  pluginVersionDirectory,
  recordPluginStatus,
  resolvePluginConfiguration,
  trackPluginOperation,
} from "./registry";

export async function requirePluginBinding(binding: PluginBinding, owner?: string) {
  const plugin = owner ? await getInstalledPlugin(binding.pluginId, owner) : undefined;
  const component = plugin?.current.components.find((item) => item.id === binding.componentId);
  if (
    !plugin ||
    !component ||
    !pluginComponentEnabled(plugin, component) ||
    plugin.current.digest !== binding.digest ||
    plugin.configuration?.revision !== binding.revision
  )
    throw new Error(
      "Plugin component changed, is disabled, or is unavailable; refresh this conversation",
    );
  return { plugin, component };
}
export async function activePluginComponents(owner?: string, kind?: PluginComponent["kind"]) {
  if (!owner) return [];
  return (await listInstalledPlugins(owner)).flatMap((plugin) =>
    plugin.current.components
      .filter(
        (component) =>
          (!kind || component.kind === kind) && pluginComponentEnabled(plugin, component),
      )
      .map((component) => ({ plugin, component, binding: pluginBinding(plugin, component) })),
  );
}

export const pluginToolAliases: Record<string, string[]> = {
  Read: [WORKSPACE_TOOLS.FILESYSTEM.READ_FILE],
  Write: [WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE],
  Edit: [WORKSPACE_TOOLS.FILESYSTEM.EDIT_FILE, WORKSPACE_TOOLS.FILESYSTEM.AST_EDIT],
  MultiEdit: [WORKSPACE_TOOLS.FILESYSTEM.AST_EDIT],
  Glob: [WORKSPACE_TOOLS.FILESYSTEM.LIST_FILES],
  Grep: [WORKSPACE_TOOLS.FILESYSTEM.GREP, WORKSPACE_TOOLS.SEARCH.SEARCH],
  Bash: [WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND],
  Agent: ["agent-*"],
  Task: ["agent-*"],
  Skill: ["skill", "skill_read", "skill_search", "search_skills", "load_skill"],
  WebFetch: ["web_fetch"],
  WebSearch: ["tavily_search", "firecrawl_search", "anysearch_search"],
  AskUserQuestion: ["ask_user"],
};
export function pluginGlob(pattern: string, value: string) {
  return new RegExp(
    `^${pattern
      .split("*")
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*")}$`,
  ).test(value);
}
export function pluginToolMatches(pattern: string, name: string, input?: unknown): boolean {
  const match = /^([^()]+)(?:\((.*)\))?$/.exec(pattern);
  if (!match) return false;
  if (!(pluginToolAliases[match[1]] ?? [match[1]]).some((value) => pluginGlob(value, name)))
    return false;
  if (match[2] === undefined || input === undefined) return true;
  if (["Agent", "Task"].includes(match[1])) return true; // Delegates are resolved to exact component IDs separately.
  const command = (input as { command?: unknown })?.command;
  return (
    match[1] === "Bash" &&
    typeof command === "string" &&
    pluginGlob(match[2].replace(/:\*$/, " *"), command)
  );
}
export function resolvePluginToolNames(plugin: InstalledPlugin, names?: string[]) {
  return names?.map((name) => {
    const match = /^mcp__([^_]+(?:_[^_]+)*)__([\s\S]*)$/.exec(name);
    if (!match) return name;
    const server = plugin.current.components.find(
      (item) => item.kind === "mcp" && item.name === match[1],
    );
    if (!server) throw new Error(`Unknown plugin MCP tool namespace: ${match[1]}`);
    return `mcp_${server.id}_${match[2]}`;
  });
}
export function pluginToolAllowed(
  name: string,
  tools?: string[],
  denied?: string[],
  input?: unknown,
): boolean {
  return (
    (!tools || tools.some((rule) => pluginToolMatches(rule, name, input))) &&
    !denied?.some((rule) => pluginToolMatches(rule, name, input))
  );
}
export function requirePluginExecution(
  plugin: InstalledPlugin,
  component: PluginComponent,
  context: RequestContext,
) {
  const rules = parsePermissionRules(context.get(PERMISSION_RULES_CONTEXT_KEY));
  const name = WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND;
  const resolver = context.get(SESSION_TOOL_POLICY_CONTEXT_KEY);
  const policy =
    typeof resolver === "function"
      ? resolver(name)
      : (rules.tools[name] ?? rules.categories[toolCategoryOf(name)]);
  if (
    plugin.executionGrants?.[component.id] !== plugin.current.digest ||
    resolveRequestMode(context).id !== "build" ||
    policy !== "allow"
  ) {
    const owner = userIdFromContext(context);
    if (owner)
      recordPluginStatus(
        owner,
        pluginBinding(plugin, component),
        "needs-authorization",
        "Authorize this component version and allow command execution in Build mode",
      );
    throw new Error(
      "Plugin execution requires component authorization and allowed command execution in Build mode",
    );
  }
}
export async function expandPluginText(
  text: string,
  plugin: InstalledPlugin,
  owner: string,
  projectPath?: string,
  includeSecrets = false,
): Promise<string> {
  const values = await resolvePluginConfiguration(plugin);
  return text.replace(
    /\$\{(PLUGIN_ROOT|CLAUDE_PLUGIN_ROOT|PLUGIN_DATA|CLAUDE_PLUGIN_DATA|CLAUDE_PROJECT_DIR|user_config\.[^}]+)\}/g,
    (_match, key: string) => {
      if (key.endsWith("PLUGIN_ROOT")) return join(pluginVersionDirectory(plugin, owner), "source");
      if (key.endsWith("PLUGIN_DATA")) return join(pluginsDirectory(owner), plugin.id, "data");
      if (key === "CLAUDE_PROJECT_DIR") {
        if (!projectPath) throw new Error("Plugin requires a bound workspace");
        return projectPath;
      }
      const name = key.slice("user_config.".length);
      if (!plugin.current.userConfig?.[name]) throw new Error(`Undeclared plugin option: ${name}`);
      if (plugin.current.userConfig[name].sensitive && !includeSecrets)
        return `[sensitive:${name}]`;
      const value = values[name] ?? "";
      return Array.isArray(value) ? JSON.stringify(value) : String(value);
    },
  );
}

/** Use the existing workspace process manager: stdin, cancellation, bounds and process-tree cleanup. */
export async function executePluginCommand(
  binding: PluginBinding,
  command: string,
  context: RequestContext,
  input: unknown,
  timeout: number,
  signal?: AbortSignal,
) {
  const { getThreadWorkspace, WORKSPACE_PATH_CONTEXT_KEY, WORKSPACE_THREAD_ID_CONTEXT_KEY } =
    await import("../workspace/workspace-manager");
  const owner = userIdFromContext(context);
  if (!owner) throw new Error("Plugin execution requires authentication");
  const { plugin, component } = await requirePluginBinding(binding, owner);
  requirePluginExecution(plugin, component, context);
  const path = context.get(WORKSPACE_PATH_CONTEXT_KEY);
  const threadId = context.get(WORKSPACE_THREAD_ID_CONTEXT_KEY);
  if (typeof path !== "string" || typeof threadId !== "string")
    throw new Error("Plugin execution requires a bound workspace and thread");
  const workspace = await getThreadWorkspace(path, threadId, owner);
  const sandbox = await workspace.resolveSandbox({ requestContext: context });
  if (!sandbox?.processes)
    throw new Error("Enable the workspace sandbox before running plugin commands");
  const expanded = await expandPluginText(command, plugin, owner, path, true);
  const current = await requirePluginBinding(binding, owner);
  requirePluginExecution(current.plugin, current.component, context);
  signal?.throwIfAborted();
  const operation = trackPluginOperation(owner, binding, timeout, signal);
  const abortSignal = operation.signal;
  const root = join(pluginVersionDirectory(plugin, owner), "source");
  const data = join(pluginsDirectory(owner), plugin.id, "data");
  const handle = await sandbox.processes
    .spawn(expanded, {
      cwd: path,
      abortSignal,
      timeout: timeout * 1000,
      stdinMode: "pipe",
      maxRetainedBytes: 262144,
      env: {
        PLUGIN_ROOT: root,
        PLUGIN_DATA: data,
        CLAUDE_PLUGIN_ROOT: root,
        CLAUDE_PLUGIN_DATA: data,
        CLAUDE_PROJECT_DIR: path,
      },
    })
    .catch((error) => {
      operation.dispose();
      throw error;
    });
  try {
    await handle.sendStdin(JSON.stringify(input));
    await handle.closeStdin();
    const result = await handle.wait();
    abortSignal.throwIfAborted();
    if (result.stdoutTruncated || result.stderrTruncated)
      throw new Error("Plugin output exceeded 256 KiB");
    return result;
  } finally {
    try {
      await handle.kill();
    } finally {
      sandbox.processes.release(handle.pid);
      operation.dispose();
    }
  }
}

/** Mastra accepts a shell command, so quote each executable/argument for the actual host shell. */
function quoteArgument(value: string) {
  if (process.platform !== "win32") return `'${value.replaceAll("'", "'\\''")}'`;
  if (/["%\r\n!]/.test(value))
    throw new Error("LSP arguments containing cmd expansion or quotes are unsupported on Windows");
  return `"${value}"`;
}
export async function pluginLspServers(
  owner: string | undefined,
  workspacePath: string,
  sandboxEnabled: boolean,
) {
  const servers: NonNullable<LSPConfig["servers"]> = {};
  const bindings: PluginBinding[] = [];
  for (const { plugin, component, binding } of await activePluginComponents(owner, "lsp")) {
    if (!component.lsp || !owner) continue;
    if (!sandboxEnabled) {
      recordPluginStatus(
        owner,
        binding,
        "needs-configuration",
        "Enable the workspace sandbox for plugin LSP",
      );
      continue;
    }
    if (plugin.executionGrants?.[component.id] !== plugin.current.digest) continue;
    try {
      const definition = component.lsp;
      const root = join(pluginVersionDirectory(plugin, owner), "source");
      const executable = definition.command.startsWith("./")
        ? join(root, definition.command)
        : definition.command;
      const command = (
        await Promise.all(
          [executable, ...definition.args].map((value) =>
            expandPluginText(value, plugin, owner, workspacePath),
          ),
        )
      )
        .map(quoteArgument)
        .join(" ");
      for (const language of new Set(Object.values(definition.extensionToLanguage))) {
        const id = `${component.id}-${language}`;
        servers[id] = {
          id,
          name: `${plugin.current.name}:${component.name}`,
          languageIds: [language],
          extensions: Object.entries(definition.extensionToLanguage)
            .filter(([, value]) => value === language)
            .map(([extension]) => extension),
          markers: [],
          command,
          initializationOptions: definition.initializationOptions,
        };
      }
      bindings.push(binding);
      recordPluginStatus(
        owner,
        binding,
        "installed",
        "Registered in the workspace; readiness is checked on first LSP query",
      );
    } catch {
      recordPluginStatus(
        owner,
        binding,
        "failed",
        "Invalid LSP executable or arguments for this platform",
      );
    }
  }
  return { servers, bindings };
}
