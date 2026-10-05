import { Agent } from "@mastra/core/agent";
import { MASTRA_RESOURCE_ID_KEY } from "@mastra/core/request-context";
import { createRoute } from "@mastra/server/server-adapter";
import { z } from "zod";
import {
  agentWorkflowSchema,
  deleteAgentProfile,
  ensureProfileAgentsRegistered,
  listAgentProfiles,
  unregisterProfileAgents,
  upsertAgentProfile,
} from "../agents/custom";
import { errorText, workError, workValidationError } from "../errors";
import { resolveDefaultLanguageModel } from "../models/providers";

const agentProfileInputSchema = z
  .object({
    id: z.string().optional(),
    type: z.enum(["agent", "team"]),
    name: z.string().optional(),
    displayName: z.string().min(1),
    profession: z.string().optional(),
    description: z.string().optional(),
    instructions: z.string().min(1),
    skills: z.array(z.string()).optional(),
    workflow: agentWorkflowSchema.optional(),
    members: z
      .array(
        z.object({
          id: z.string().optional(),
          name: z.string().min(1),
          profession: z.string().optional(),
          description: z.string().optional(),
          instructions: z.string().min(1),
          skills: z.array(z.string()).optional(),
          memoryScope: z.enum(["thread", "resource"]).optional(),
        }),
      )
      .optional(),
    tags: z.array(z.string()).optional(),
    quickPrompts: z.array(z.string()).optional(),
    enabled: z.boolean().optional(),
  })
  .refine((profile) => profile.type !== "team" || Boolean(profile.members?.length), {
    path: ["members"],
    message: "Agent 团队至少需要一位成员",
  });

export const agentProfilesRoute = createRoute({
  queryParamSchema: z.object({}).strict(),
  path: "/work/agents",
  responseType: "json",
  onValidationError: workValidationError,
  method: "GET",
  handler: async (params) => {
    const resourceId = params.requestContext.get(MASTRA_RESOURCE_ID_KEY) as string;
    const agents = await listAgentProfiles(resourceId);
    const registry = params.mastra;
    const registrations = await Promise.all(
      agents.map((profile) => ensureProfileAgentsRegistered(registry, profile, resourceId)),
    );
    const registryEntries = Object.entries(registry.listAgents()).map(([registryKey, agent]) => ({
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

export const saveAgentProfileRoute = createRoute({
  queryParamSchema: z.object({}).strict(),
  path: "/work/agents",
  responseType: "json",
  onValidationError: workValidationError,
  method: "POST",
  bodySchema: agentProfileInputSchema.transform((profile) => ({ profile })),
  handler: async (params) => {
    const resourceId = params.requestContext.get(MASTRA_RESOURCE_ID_KEY) as string;
    const profile = await upsertAgentProfile(params.profile, resourceId);
    if (profile.enabled) await ensureProfileAgentsRegistered(params.mastra, profile, resourceId);
    else unregisterProfileAgents(params.mastra, profile.id, resourceId);
    return { agent: profile };
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
    unregisterProfileAgents(params.mastra, agentId, resourceId);
    await deleteAgentProfile(agentId, resourceId);
    return { ok: true };
  },
});

const agentDraftSchema = z.object({
  type: z.enum(["agent", "team"]),
  displayName: z.string(),
  profession: z.string(),
  description: z.string(),
  instructions: z.string(),
  workflow: agentWorkflowSchema.optional(),
  members: z.array(
    z.object({
      name: z.string(),
      profession: z.string(),
      description: z.string(),
      instructions: z.string(),
      skills: z.array(z.string()).optional(),
      memoryScope: z.enum(["thread", "resource"]).optional(),
    }),
  ),
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
      instructions: "根据用户描述生成可执行的 Mastra Agent 配置草稿。只返回结构化字段,不要解释。",
    });
    const result = await assistant
      .generate(
        `类型:${body.type === "team" ? "team" : "agent"}。团队 workflow.strategy 只能使用官方四类名称: supervisor(主 Agent 动态委派)、handoff(成员之间按顺序交接)、workflow(显式 Workflow 编排,支持分支/循环/审批)、council(多个成员并行评议后汇总)。用户描述:\n${body.description}`,
        {
          structuredOutput: {
            schema: agentDraftSchema,
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
    return { draft: result.object };
  },
});
