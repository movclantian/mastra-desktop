import type { RequestContext } from "@mastra/core/request-context";
import { resolveAgentSkills } from "@mastra/core/skills";
import { type AgentProfile, DEFAULT_AGENT_PROFILE_ID } from "../../shared/agent-contract";
import type { PluginBinding } from "../../shared/plugin-contract";
import { getProvidersConfig, resolveAgentModel, resolveRequestModel } from "../models/providers";
import { userIdFromContext } from "../storage/database";
import { WORKSPACE_PATH_CONTEXT_KEY } from "../workspace/workspace-manager";
import {
  listPluginSkills,
  needsPluginExecutionConsent,
  pluginBinding,
  recordPluginStatus,
} from "./registry";
import {
  activePluginComponents,
  expandPluginText,
  requirePluginBinding,
  resolvePluginToolNames,
} from "./runtime";

export const pluginProfileId = (componentId: string) => `plugin-agent-${componentId}`;
export async function pluginAgentProfiles(owner?: string): Promise<AgentProfile[]> {
  const entries = await activePluginComponents(owner, "agents");
  return entries.flatMap(({ plugin, component, binding }) => {
    if (
      needsPluginExecutionConsent(component) &&
      plugin.executionGrants?.[component.id] !== plugin.current.digest
    )
      return [];
    const definition = component.agent;
    if (!definition) return [];
    const ids = (kind: "skill" | "mcp", names?: string[]) =>
      plugin.current.components
        .filter((item) => item.kind === kind && (!names || names.includes(item.name)))
        .map((item) => item.id);
    return [
      {
        id: pluginProfileId(component.id),
        type: "agent" as const,
        name: `${plugin.current.name}:${component.name}`,
        displayName: `${plugin.current.name}:${component.name}`,
        profession: "Plugin Agent",
        description: component.description,
        instructions: definition.instructions,
        skills: ids("skill", definition.skills),
        mcpServers: ids("mcp", definition.mcpServers),
        pluginAgentIds: definition.delegates.map((name) =>
          pluginProfileId(
            plugin.current.components.find((item) => item.kind === "agents" && item.name === name)
              ?.id ?? "missing",
          ),
        ),
        members: [],
        tags: ["plugin"],
        quickPrompts: [],
        enabled: true,
        plugin: binding,
        createdAt: plugin.createdAt,
        updatedAt: `${plugin.updatedAt}:${binding.digest}:${binding.revision ?? ""}`,
      },
    ];
  });
}
export async function pluginAgentDefinition(
  binding: PluginBinding,
  context?: { get(key: string): unknown },
) {
  const owner = userIdFromContext(context);
  const { plugin, component } = await requirePluginBinding(binding, owner);
  if (!component.agent || !owner) throw new Error("Plugin agent definition is unavailable");
  for (const [kind, names] of [
    ["skill", component.agent.skills ?? []],
    ["mcp", component.agent.mcpServers ?? []],
    ["agents", component.agent.delegates],
  ] as const)
    for (const name of names) {
      const target = plugin.current.components.find(
        (item) => item.kind === kind && item.name === name,
      );
      if (!target) throw new Error(`Missing plugin capability: ${name}`);
      await requirePluginBinding(pluginBinding(plugin, target), owner);
    }
  return {
    plugin,
    component,
    definition: {
      ...component.agent,
      tools: resolvePluginToolNames(plugin, component.agent.tools),
      disallowedTools: resolvePluginToolNames(plugin, component.agent.disallowedTools),
    },
  };
}
export async function resolvePluginAgentModel(
  binding: PluginBinding,
  requestContext?: { get(key: string): unknown },
) {
  const owner = userIdFromContext(requestContext);
  if (!owner) throw new Error("Authenticated plugin owner is required");
  try {
    const { definition } = await pluginAgentDefinition(binding, requestContext);
    const model = await resolvePluginModel(definition.model, requestContext);
    recordPluginStatus(owner, binding, "ready");
    return model;
  } catch (error) {
    recordPluginStatus(
      owner,
      binding,
      "needs-configuration",
      "Configure the Agent's model and required capabilities",
    );
    throw error;
  }
}
export async function resolvePluginModel(
  model: string | undefined,
  requestContext?: { get(key: string): unknown },
) {
  if (!model || model === "inherit") return resolveAgentModel({ requestContext });
  const owner = userIdFromContext(requestContext);
  if (!owner) throw new Error("Plugin model requires an authenticated owner");
  const { providers } = await getProvidersConfig(owner);
  const candidates = providers
    .filter((provider) => !provider.disabled && provider.hasCredential)
    .flatMap((provider) =>
      provider.enabledModels
        .filter(
          (item) =>
            item.kind === "language" &&
            (`${provider.id}/${item.id}` === model ||
              item.id === model ||
              (["sonnet", "opus", "haiku"].includes(model) && item.id.includes(model))),
        )
        .map((item) => `${provider.id}/${item.id}`),
    );
  if (candidates.length !== 1)
    throw new Error(
      `Plugin model ${model} must match exactly one enabled model; configure its provider/model ID`,
    );
  const resolved = await resolveRequestModel({ id: candidates[0] }, owner);
  if (!resolved) throw new Error(`Plugin model is unavailable: ${model}`);
  return resolved;
}
export async function pluginAgentInstructions(profile: AgentProfile, context: RequestContext) {
  if (!profile.plugin) return profile.instructions;
  const { plugin, definition } = await pluginAgentDefinition(profile.plugin, context);
  const instructions = await expandPluginText(
    definition.instructions,
    plugin,
    userIdFromContext(context) as string,
    context.get(WORKSPACE_PATH_CONTEXT_KEY) as string | undefined,
  );
  const owner = userIdFromContext(context);
  const skills = (await listPluginSkills(owner)).filter(
    (skill) =>
      skill.pluginId === plugin.id &&
      skill.enabled &&
      plugin.current.components.some(
        (item) => item.id === skill.id && definition.skills?.includes(item.name),
      ),
  );
  const resolver = resolveAgentSkills(skills.map((skill) => skill.path));
  const loaded = await Promise.all(
    skills.map(async (skill) => {
      const content = await resolver.get(skill.name);
      if (!content) throw new Error(`Required plugin skill is unavailable: ${skill.displayName}`);
      return `Required skill ${skill.displayName}:\n${content.instructions}`;
    }),
  );
  return [instructions, ...loaded].join("\n\n");
}
export function withPluginDelegates(profile: AgentProfile, plugins: AgentProfile[]) {
  return profile.id === DEFAULT_AGENT_PROFILE_ID
    ? { ...profile, pluginAgentIds: plugins.map((item) => item.id) }
    : profile;
}
