/**
 * 默认工作 Agent 注册表。
 * 打破 agents/index.ts -> harness/session.ts -> agents/index.ts 的循环依赖:
 * session.ts 不再静态导入 mastraWorkAgent, 而是在创建 WorkSession 时从
 * 此处读取 —— 注册由 agents/index.ts 在模块加载时完成, 而 WorkSession 的
 * 实例化总是发生在服务启动(agent 已注册)之后。
 */
import type { Agent } from "@mastra/core/agent";

let defaultWorkAgent: Agent | undefined;

export function setDefaultWorkAgent(agent: Agent): void {
  defaultWorkAgent = agent;
}

export function getDefaultWorkAgent(): Agent | undefined {
  return defaultWorkAgent;
}
