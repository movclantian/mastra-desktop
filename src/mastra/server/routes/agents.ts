import { registerApiRoute } from "@mastra/core/server";
import { deleteAgentProfile, listAgentProfiles, upsertAgentProfile } from "../../agents/custom";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "Agent 配置无效";
}

export const agentProfilesRoute = registerApiRoute("/work/agents", {
  method: "GET",
  handler: async (c) => c.json({ agents: await listAgentProfiles() }),
});

export const saveAgentProfileRoute = registerApiRoute("/work/agents", {
  method: "POST",
  handler: async (c) => {
    try {
      const profile = await upsertAgentProfile(await c.req.json());
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
