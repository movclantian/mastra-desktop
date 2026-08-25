import { MASTRA_RESOURCE_ID_KEY } from "@mastra/core/request-context";
import { registerApiRoute } from "@mastra/core/server";
import { generateText, Output } from "ai";
import { z } from "zod";
import {
  type AgentProfile,
  deleteAgentProfile,
  ensureProfileAgentsRegistered,
  listAgentProfiles,
  unregisterProfileAgents,
  upsertAgentProfile,
} from "../agents/custom";
import { errorText } from "../errors";
import { resolveDefaultLanguageModel } from "../models";

const agentProfileInputSchema = z.object({
  id: z.string().optional(),
  type: z.enum(["agent", "team"]),
  name: z.string().optional(),
  displayName: z.string().min(1),
  profession: z.string().optional(),
  description: z.string().optional(),
  instructions: z.string().min(1),
  skills: z.array(z.string()).optional(),
  workflow: z
    .object({
      strategy: z.enum(["supervisor", "handoff", "workflow", "council"]),
      steps: z.array(
        z.object({
          id: z.string(),
          memberId: z.string().optional(),
          kind: z.enum(["agent", "approval", "branch", "loop"]).optional(),
          prompt: z.string().optional(),
          retries: z.number().int().min(0).max(5).optional(),
          condition: z
            .object({
              operator: z.enum(["contains", "equals", "not_contains"]),
              value: z.string(),
            })
            .optional(),
          branch: z.object({ onTrueMemberId: z.string(), onFalseMemberId: z.string() }).optional(),
          loop: z
            .object({
              mode: z.enum(["until", "while", "foreach"]),
              maxIterations: z.number().int().min(1).max(20),
              concurrency: z.number().int().min(1).max(8).optional(),
            })
            .optional(),
          approval: z.object({ title: z.string(), description: z.string() }).optional(),
        }),
      ),
      synthesis: z.boolean(),
    })
    .optional(),
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
});

export const agentProfilesRoute = registerApiRoute("/work/agents", {
  method: "GET",
  handler: async (c) => {
    const resourceId = c.get("requestContext").get(MASTRA_RESOURCE_ID_KEY) as string;
    const agents = await listAgentProfiles(resourceId);
    const registry = c.get("mastra");
    const registrations = await Promise.all(
      agents.map((profile) => ensureProfileAgentsRegistered(registry, profile, resourceId)),
    );
    const registryEntries = Object.entries(registry.listAgents()).map(([registryKey, agent]) => ({
      registryKey,
      agentId: agent.id,
      name: agent.name,
    }));
    return c.json({
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
    });
  },
});

export const saveAgentProfileRoute = registerApiRoute("/work/agents", {
  method: "POST",
  handler: async (c) => {
    try {
      const parsed = agentProfileInputSchema.safeParse(await c.req.json());
      if (!parsed.success) return c.json({ error: "Agent 配置字段无效" }, 400);
      if (
        parsed.data.type === "team" &&
        (!parsed.data.members || parsed.data.members.length === 0)
      ) {
        return c.json({ error: "Agent 团队至少需要一位成员" }, 400);
      }
      const resourceId = c.get("requestContext").get(MASTRA_RESOURCE_ID_KEY) as string;
      const profile = await upsertAgentProfile(parsed.data as Partial<AgentProfile>, resourceId);
      if (profile.enabled)
        await ensureProfileAgentsRegistered(c.get("mastra"), profile, resourceId);
      else unregisterProfileAgents(c.get("mastra"), profile.id, resourceId);
      return c.json({ agent: profile });
    } catch (error) {
      return c.json({ error: errorText(error) }, 400);
    }
  },
});

export const deleteAgentProfileRoute = registerApiRoute("/work/agents/:agentId", {
  method: "DELETE",
  handler: async (c) => {
    try {
      const agentId = c.req.param("agentId");
      const resourceId = c.get("requestContext").get(MASTRA_RESOURCE_ID_KEY) as string;
      unregisterProfileAgents(c.get("mastra"), agentId, resourceId);
      await deleteAgentProfile(agentId, resourceId);
      return c.json({ ok: true });
    } catch (error) {
      return c.json({ error: errorText(error) }, 400);
    }
  },
});

const agentDraftSchema = z.object({
  type: z.enum(["agent", "team"]),
  displayName: z.string(),
  profession: z.string(),
  description: z.string(),
  instructions: z.string(),
  workflow: z
    .object({
      strategy: z.enum(["supervisor", "handoff", "workflow", "council"]),
      steps: z.array(
        z.object({
          id: z.string(),
          memberId: z.string().optional(),
          kind: z.enum(["agent", "approval", "branch", "loop"]).optional(),
          prompt: z.string().optional(),
          retries: z.number().int().min(0).max(5).optional(),
          condition: z
            .object({ operator: z.enum(["contains", "equals", "not_contains"]), value: z.string() })
            .optional(),
          branch: z.object({ onTrueMemberId: z.string(), onFalseMemberId: z.string() }).optional(),
          loop: z
            .object({
              mode: z.enum(["until", "while", "foreach"]),
              maxIterations: z.number().int().min(1).max(20),
              concurrency: z.number().int().min(1).max(8).optional(),
            })
            .optional(),
          approval: z.object({ title: z.string(), description: z.string() }).optional(),
        }),
      ),
      synthesis: z.boolean(),
    })
    .optional(),
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

export const assistAgentProfileRoute = registerApiRoute("/work/agents/assist", {
  method: "POST",
  handler: async (c) => {
    const body = (await c.req.json()) as {
      description?: unknown;
      type?: unknown;
    };
    if (typeof body.description !== "string" || !body.description.trim()) {
      return c.json({ error: "请描述想创建的 Agent 或 Agent 团队" }, 400);
    }
    try {
      const requestContext = c.get("requestContext");
      const resourceIdValue = requestContext.get(MASTRA_RESOURCE_ID_KEY);
      const resourceId = typeof resourceIdValue === "string" ? resourceIdValue : undefined;
      const selectedModel = await resolveDefaultLanguageModel(resourceId);
      if (!selectedModel) {
        return c.json(
          {
            error: "当前用户尚未配置可用模型,请先在设置中启用供应商并选定模型",
          },
          400,
        );
      }

      const result = await generateText({
        model: selectedModel,
        output: Output.object({ schema: agentDraftSchema }),
        prompt: `根据用户描述生成一个可执行的 Mastra Agent 配置草稿。只返回结构化字段,不要解释。类型:${body.type === "team" ? "team" : "agent"}。团队 workflow.strategy 只能使用官方四类名称: supervisor(主 Agent 动态委派)、handoff(成员之间按顺序交接)、workflow(显式 Workflow 编排,支持分支/循环/审批)、council(多个成员并行评议后汇总)。用户描述:\n${body.description}`,
        abortSignal: c.req.raw.signal,
      });
      return c.json({ draft: result.output });
    } catch (error) {
      return c.json({ error: `AI 创建失败: ${errorText(error)}` }, 503);
    }
  },
});
