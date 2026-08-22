import { registerApiRoute } from "@mastra/core/server";
import { z } from "zod";
import { mastraWorkAgent } from "../../agents";
import {
  deleteAgentProfile,
  listAgentProfiles,
  upsertAgentProfile,
  type AgentProfile,
} from "../../agents/custom";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "Agent 配置无效";
}

const agentProfileInputSchema = z.object({
  id: z.string().optional(),
  type: z.enum(["agent", "team"]),
  name: z.string().optional(),
  displayName: z.string().min(1),
  profession: z.string().optional(),
  description: z.string().optional(),
  instructions: z.string().min(1),
  model: z.object({ providerId: z.string(), modelId: z.string() }).optional(),
  skills: z.array(z.string()).optional(),
  workflow: z
    .object({
      strategy: z.enum(["supervisor", "sequence", "parallel"]),
      steps: z.array(
        z.object({ id: z.string(), memberId: z.string(), prompt: z.string().optional() }),
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
        model: z.object({ providerId: z.string(), modelId: z.string() }).optional(),
        skills: z.array(z.string()).optional(),
        tools: z.array(z.string()).optional(),
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
    const agents = await listAgentProfiles();
    const registered = c.get("mastra").listAgents();
    return c.json({
      agents,
      registeredAgentIds: Object.values(registered).map((agent) => agent.id),
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
      const profile = await upsertAgentProfile(parsed.data as Partial<AgentProfile>);
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
      await deleteAgentProfile(c.req.param("agentId"));
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
      strategy: z.enum(["supervisor", "sequence", "parallel"]),
      steps: z.array(
        z.object({ id: z.string(), memberId: z.string(), prompt: z.string().optional() }),
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
      tools: z.array(z.string()).optional(),
      memoryScope: z.enum(["thread", "resource"]).optional(),
    }),
  ),
  tags: z.array(z.string()),
  quickPrompts: z.array(z.string()),
});

export const assistAgentProfileRoute = registerApiRoute("/work/agents/assist", {
  method: "POST",
  handler: async (c) => {
    const body = (await c.req.json()) as { description?: unknown; type?: unknown };
    if (typeof body.description !== "string" || !body.description.trim()) {
      return c.json({ error: "请描述想创建的 Agent 或 Agent 团队" }, 400);
    }
    try {
      const result = await mastraWorkAgent.generate(
        `根据用户描述生成一个可执行的 Mastra Agent 配置草稿。只返回结构化字段,不要解释。类型:${body.type === "team" ? "team" : "agent"}。用户描述:\n${body.description}`,
        {
          structuredOutput: {
            schema: agentDraftSchema,
          },
          maxSteps: 2,
        },
      );
      return c.json({ draft: result.object });
    } catch (error) {
      return c.json({ error: `AI 创建失败: ${errorText(error)}。请先在设置中配置可用模型。` }, 503);
    }
  },
});
