import { Agent } from "@mastra/core/agent";
import { appMemory } from "../../memory/overview";

// 参考 docs/en/docs/agents/overview.mdx — Agent 构造
// 模型默认占位:BYOK 模式下,客户端每次请求通过 chatRoute 的
// AgentExecutionOptions.model(model router 对象)动态传入用户自选模型。
export const mastraWorkAgent = new Agent({
  id: "mastra-work-agent",
  name: "MastraWork",
  instructions: `You are MastraWork, a helpful personal AI work assistant.

You support multi-user, workspace-scoped conversations:
- Every conversation belongs to a workspace (or no workspace)
- Keep answers relevant to the user's current workspace context
- Be concise but informative, respond in the user's language`,
  model: "openai/gpt-4o",
  memory: appMemory,
});
