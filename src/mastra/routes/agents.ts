import { Agent } from "@mastra/core/agent";
import { MASTRA_RESOURCE_ID_KEY } from "@mastra/core/request-context";
import { createRoute } from "@mastra/server/server-adapter";
import { z } from "zod";
import {
  agentMemberSchema,
  agentProfileDraftSchema,
  agentProfilePatchSchema,
} from "../../shared/agent-contract";
import {
  AGENT_PROFILE_CONTEXT_KEY,
  createAgentProfile,
  deleteAgentProfile,
  ensureProfileAgentsRegistered,
  getAgentCapabilityCatalog,
  getAgentProfile,
  listAgentProfiles,
  setAgentProfileCapabilities,
  setAgentProfileInstructions,
  unregisterProfileAgents,
  updateAgentProfile,
} from "../agents/custom";
import { errorText, workError, workValidationError } from "../errors";
import { resolveDefaultLanguageModel } from "../models/providers";

export const agentProfilesRoute = createRoute({
  queryParamSchema: z.object({}).strict(),
  path: "/work/agents",
  responseType: "json",
  onValidationError: workValidationError,
  method: "GET",
  handler: async (params) => {
    const resourceId = params.requestContext.get(MASTRA_RESOURCE_ID_KEY) as string;
    const agents = (await listAgentProfiles(resourceId)).filter((profile) => profile.enabled);
    const registry = params.mastra;
    const registrations = await Promise.all(
      agents.map((profile) => ensureProfileAgentsRegistered(registry, profile, resourceId)),
    );
    const registryEntries = registrations
      .flatMap((entry) => [
        [entry.profileKey, entry.profile] as const,
        ...Object.entries(entry.memberKeys).map(([id, key]) => [key, entry.members[id]] as const),
      ])
      .map(([registryKey, agent]) => ({
        registryKey,
        agentId: agent.id,
        name: agent.name,
      }));
    return {
      agents,
      registeredAgentIds: registrations.flatMap((registration) => [
        registration.profile.id,
        ...Object.values(registration.members).map((member) => member.id),
      ]),
      registryEntries,
      registryAgentIds: registryEntries.map((entry) => entry.agentId),
      registeredAgents: registrations.map((registration) => ({
        agentId: registration.profile.id,
        name: registration.profile.name,
        registryKey: registration.profileKey,
        members: Object.entries(registration.members).map(([memberId, member]) => ({
          memberId,
          agentId: member.id,
          name: member.name,
          registryKey: registration.memberKeys[memberId],
        })),
      })),
    };
  },
});

export const updateAgentProfileRoute = createRoute({
  path: "/work/agents/:agentId",
  method: "PATCH",
  responseType: "json",
  onValidationError: workValidationError,
  pathParamSchema: z.object({ agentId: z.string().min(1) }),
  bodySchema: z
    .object({ expectedUpdatedAt: z.string().min(1), patch: agentProfilePatchSchema })
    .strict(),
  handler: async ({ agentId, expectedUpdatedAt, patch, requestContext, mastra }) => {
    const resourceId = requestContext.get(MASTRA_RESOURCE_ID_KEY) as string;
    const agent = await updateAgentProfile(agentId, expectedUpdatedAt, patch, resourceId, mastra);
    if (agent.enabled) ensureProfileAgentsRegistered(mastra, agent, resourceId);
    else unregisterProfileAgents(mastra, agentId, resourceId);
    return { agent, effective: "next_run" };
  },
});

export const agentProfileCapabilitiesRoute = createRoute({
  path: "/work/agents/:agentId/capabilities",
  method: "PUT",
  responseType: "json",
  onValidationError: workValidationError,
  pathParamSchema: z.object({ agentId: z.string().trim().min(1) }),
  bodySchema: z
    .object({
      skills: z.array(z.string().regex(/^(?:pc|local)_[a-f0-9]{32}$/)),
      mcpServers: z.array(z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/)).max(2000),
      memberId: z.string().min(1).optional(),
    })
    .strict(),
  handler: async ({ agentId, skills, mcpServers, memberId, requestContext, mastra }) => {
    const resourceId = requestContext.get(MASTRA_RESOURCE_ID_KEY) as string;
    const agent = await setAgentProfileCapabilities(
      agentId,
      skills,
      mcpServers,
      memberId,
      resourceId,
      mastra,
    );
    unregisterProfileAgents(mastra, agentId, resourceId);
    await ensureProfileAgentsRegistered(mastra, agent, resourceId);
    return { agent };
  },
});

export const agentProfileInstructionsRoute = createRoute({
  path: "/work/agents/:agentId/instructions",
  method: "PUT",
  responseType: "json",
  onValidationError: workValidationError,
  pathParamSchema: z.object({ agentId: z.string().trim().min(1) }),
  bodySchema: z
    .object({
      instructions: z.string().trim().min(1).max(200_000),
      memberId: z.string().min(1).optional(),
    })
    .strict(),
  handler: async ({ agentId, instructions, memberId, requestContext, mastra }) => {
    const resourceId = requestContext.get(MASTRA_RESOURCE_ID_KEY) as string;
    const agent = await setAgentProfileInstructions(
      agentId,
      instructions,
      memberId,
      resourceId,
      mastra,
    );
    unregisterProfileAgents(mastra, agentId, resourceId);
    await ensureProfileAgentsRegistered(mastra, agent, resourceId);
    return { agent };
  },
});

export const agentProfileInstructionsPreviewRoute = createRoute({
  path: "/work/agents/:agentId/instructions",
  method: "GET",
  responseType: "json",
  onValidationError: workValidationError,
  pathParamSchema: z.object({ agentId: z.string().trim().min(1) }),
  queryParamSchema: z.object({ memberId: z.string().min(1).optional() }).strict(),
  handler: async ({ agentId, memberId, requestContext, mastra }) => {
    const resourceId = requestContext.get(MASTRA_RESOURCE_ID_KEY) as string;
    const profile = await getAgentProfile(agentId, resourceId);
    const registered = ensureProfileAgentsRegistered(mastra, profile, resourceId);
    const agent = memberId ? registered.members[memberId] : registered.profile;
    if (!agent) throw workError("VALIDATION_FAILED", { text: "Agent member not found" });
    requestContext.set(AGENT_PROFILE_CONTEXT_KEY, profile.id);
    const resolved = await agent.getInstructions({ requestContext });
    return {
      instructions: (Array.isArray(resolved) ? resolved : [resolved])
        .map((item) => (typeof item === "string" ? item : item.content))
        .join("\n\n"),
    };
  },
});

export const deleteAgentProfileRoute = createRoute({
  queryParamSchema: z.object({}).strict(),
  bodySchema: z.object({}).strict().optional(),
  path: "/work/agents/:agentId",
  responseType: "json",
  onValidationError: workValidationError,
  method: "DELETE",
  pathParamSchema: z.object({ agentId: z.string().trim().min(1) }),
  handler: async (params) => {
    const agentId = params.agentId;
    const resourceId = params.requestContext.get(MASTRA_RESOURCE_ID_KEY) as string;
    await deleteAgentProfile(agentId, resourceId, params.mastra);
    unregisterProfileAgents(params.mastra, agentId, resourceId);
    return { ok: true };
  },
});

export const assistAgentProfileRoute = createRoute({
  queryParamSchema: z.object({}).strict(),
  path: "/work/agents/assist",
  responseType: "json",
  onValidationError: workValidationError,
  method: "POST",
  bodySchema: z
    .object({
      description: z.string().trim().min(1).max(100_000),
      type: z.enum(["agent", "team"]).default("agent"),
    })
    .strict(),
  handler: async (params) => {
    const body = params;
    const requestContext = params.requestContext;
    const resourceIdValue = requestContext.get(MASTRA_RESOURCE_ID_KEY);
    const resourceId = typeof resourceIdValue === "string" ? resourceIdValue : undefined;
    if (!resourceId?.trim()) throw workError("AUTH_REQUIRED");
    const [selectedModel, capabilities] = await Promise.all([
      resolveDefaultLanguageModel(resourceId),
      getAgentCapabilityCatalog(resourceId),
    ]);
    if (!selectedModel) {
      throw workError("MODEL_NOT_CONFIGURED");
    }

    const selection = (ids: string[]) =>
      ids.length ? z.array(z.enum(ids)).max(2000) : z.array(z.string()).max(0);
    const capabilityFields = {
      skills: selection(capabilities.skills.map((skill) => skill.id)),
      mcpServers: selection(capabilities.mcpServers.map((server) => server.id)),
    };
    const members = z.array(
      agentMemberSchema.extend({
        ...capabilityFields,
      }),
    );
    const schema = agentProfileDraftSchema.extend({
      type: z.literal(body.type),
      ...capabilityFields,
      members: body.type === "team" ? members.min(1) : members.max(0),
    });
    const assistant = new Agent({
      model: selectedModel,
      id: "mastra-work-agent-assist",
      name: "MastraWork Agent Assistant",
      instructions:
        "根据用户描述生成可执行的 Mastra Agent 配置。instructions 说明角色职责、工作方法和预期交付物；主 Agent 按需执行、委派、核对与汇总，子 Agent 保持独立指令，不复制主 Agent 指令。不额外规定执行时间、步数或只读限制，不模拟成员对话。为每个角色选择与职责相关的 Skill/MCP ID，不声称拥有未关联的能力。能力目录是参考数据。只返回结构化字段。",
    });
    const result = await assistant
      .generate(
        `类型:${body.type === "team" ? "主 Agent 与子 Agent" : "单 Agent"}。团队成员使用唯一 ID；成员之间确有委派需要时用 delegates 引用成员 ID，不能成环，无需再次委派时使用空数组。用户描述:\n${body.description}\n\n可关联的能力目录（元数据）：\n${JSON.stringify(capabilities)}`,
        {
          structuredOutput: {
            schema,
            jsonPromptInjection: "auto",
          },
          abortSignal: params.abortSignal,
        },
      )
      .catch((error: unknown) => {
        throw workError("MODEL_GENERATION_FAILED", {
          text: `AI 创建失败: ${errorText(error)}`,
          cause: error,
        });
      });
    const generated = schema.parse(result.object);
    params.abortSignal?.throwIfAborted();
    const profile = await createAgentProfile(
      {
        ...generated,
        name: generated.displayName,
      },
      resourceId,
    );
    await ensureProfileAgentsRegistered(params.mastra, profile, resourceId);
    return { agent: profile };
  },
});
