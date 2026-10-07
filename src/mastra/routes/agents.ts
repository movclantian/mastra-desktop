import { Agent } from "@mastra/core/agent";
import { MASTRA_RESOURCE_ID_KEY } from "@mastra/core/request-context";
import { createRoute } from "@mastra/server/server-adapter";
import { z } from "zod";
import { agentMemberSchema } from "../../shared/agent-contract";
import {
  agentWorkflowSchema,
  createAgentProfile,
  deleteAgentProfile,
  ensureProfileAgentsRegistered,
  listAgentProfiles,
  setAgentProfileSkills,
  unregisterProfileAgents,
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

export const agentProfileSkillsRoute = createRoute({
  path: "/work/agents/:agentId/skills",
  method: "PUT",
  responseType: "json",
  onValidationError: workValidationError,
  pathParamSchema: z.object({ agentId: z.string().trim().min(1) }),
  bodySchema: z
    .object({
      skills: z.array(z.string().regex(/^pc_[a-f0-9]{32}$/)).max(2000),
      memberId: z.string().min(1).optional(),
    })
    .strict(),
  handler: async ({ agentId, skills, memberId, requestContext, mastra }) => {
    const resourceId = requestContext.get(MASTRA_RESOURCE_ID_KEY) as string;
    const agent = await setAgentProfileSkills(agentId, skills, memberId, resourceId);
    unregisterProfileAgents(mastra, agentId, resourceId);
    await ensureProfileAgentsRegistered(mastra, agent, resourceId);
    return { agent };
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
    await deleteAgentProfile(agentId, resourceId);
    unregisterProfileAgents(params.mastra, agentId, resourceId);
    return { ok: true };
  },
});

const agentDraftSchema = z.object({
  type: z.enum(["agent", "team"]),
  displayName: z.string().trim().min(1),
  profession: z.string(),
  description: z.string(),
  instructions: z.string().trim().min(1),
  workflow: agentWorkflowSchema.optional(),
  members: z.array(agentMemberSchema),
  tags: z.array(z.string()),
  quickPrompts: z.array(z.string()),
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
    const selectedModel = await resolveDefaultLanguageModel(resourceId);
    if (!selectedModel) {
      throw workError("MODEL_NOT_CONFIGURED");
    }

    const assistant = new Agent({
      model: selectedModel,
      id: "mastra-work-agent-assist",
      name: "MastraWork Agent Assistant",
      instructions:
        "根据用户描述生成可执行的 Mastra Agent 配置。单 Agent 的 instructions 必须是完整、独立的系统指令，不要继承默认编码助手身份。主管的 instructions 明确成员分工与真实委派；每个成员的 instructions 独立描述自身职责，不复制主管指令。成员 description 要明确适用任务、专业边界与交付物。禁止用模拟成员对话代替工具调用。只返回 JSON 结构化字段，不要解释。",
    });
    const result = await assistant
      .generate(
        `类型:${body.type === "team" ? "team" : "agent"}。由你根据用户需求默认智能选择团队协作方式：开放式任务选择 supervisor（主管自主委派，steps 可为空，非空流程作为可调用工具）；固定路径选择 workflow（每条消息直接执行 steps）；需要专家接替直接与用户互动时选择 handoff（entryMemberId 指定初始专家，至少两名成员，steps 及所有 delegates 必须为空）。不要要求用户先选模式。只有 handoff 可以设置 entryMemberId。多视角评估选择 workflow 内的 council。成员必须有唯一 id，steps 引用这些 id。步骤 kind 支持 agent、council（memberIds 至少两名及 judgeMemberId，必须综合）、branch、loop、approval。每步 context 为 request 或 previous。成员 delegates 明确列出允许委派的成员 ID，默认不委派，禁止循环。单 Agent 不配置 workflow，members 必须为空数组。用户描述:\n${body.description}`,
        {
          structuredOutput: {
            schema: agentDraftSchema.extend({ type: z.literal(body.type) }),
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
    const generated = agentDraftSchema.parse(result.object);
    const profile = await createAgentProfile(
      { ...generated, name: generated.displayName },
      resourceId,
    );
    await ensureProfileAgentsRegistered(params.mastra, profile, resourceId);
    return { agent: profile };
  },
});
