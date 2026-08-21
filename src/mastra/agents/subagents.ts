import { Agent, type AgentExecutionOptions } from "@mastra/core/agent";
import { RequestContext } from "@mastra/core/request-context";
import { REQUEST_MODEL_CONTEXT_KEY, resolveRequestModel } from "../models";

export const SUBAGENT_MODELS_CONTEXT_KEY = "mastra-work:subagent-models";

export interface SubagentModelsContext {
  explorer?: unknown;
  reviewer?: unknown;
}

export function subagentStreamOptions(
  options: AgentExecutionOptions | undefined,
  role: keyof SubagentModelsContext,
): AgentExecutionOptions {
  const requestContext = options?.requestContext ?? new RequestContext();
  const subagentModels = requestContext.get(SUBAGENT_MODELS_CONTEXT_KEY) as
    | SubagentModelsContext
    | undefined;
  const configured = subagentModels?.[role];
  if (configured) requestContext.set(REQUEST_MODEL_CONTEXT_KEY, configured);
  return { ...options, requestContext };
}

/**
 * 探索子 Agent (docs/en/reference/agents/subagents.mdx):
 * 快速搜集信息、探查环境与资料。
 */
export const explorerAgent = new Agent({
  id: "explorer",
  name: "Explorer",
  description: "快速搜集信息、探查环境与资料,并给出结构化汇总。",
  instructions: ({ requestContext }) => {
    const raw = requestContext.get(REQUEST_MODEL_CONTEXT_KEY);
    return [
      "你是探索子 Agent (Explorer)。",
      "专注于迅速探查指定目录、文档或网络信息,用清晰、简短的结构化列表返回事实与关键结论。",
      raw ? "优先使用调用方注入的模型完成任务。" : "",
    ]
      .filter(Boolean)
      .join("\n");
  },
  model: async ({ requestContext }) => {
    const model = await resolveRequestModel(requestContext.get(REQUEST_MODEL_CONTEXT_KEY));
    if (model) return model;
    throw new Error("Explorer 子 Agent 未能解析到可用模型,请在设置中配置供应商");
  },
});

/**
 * 审查子 Agent (docs/en/reference/agents/subagents.mdx):
 * 审查代码变更、规范与缺陷。
 */
export const reviewerAgent = new Agent({
  id: "reviewer",
  name: "Reviewer",
  description: "审查代码变更、规范、边界条件与缺陷风险,给出针对性的改进建议。",
  instructions: ({ requestContext }) => {
    const raw = requestContext.get(REQUEST_MODEL_CONTEXT_KEY);
    return [
      "你是审查子 Agent (Reviewer)。",
      "专注于静态分析、逻辑校验、架构一致性与安全隐患排查,输出严谨的技术评审意见。",
      raw ? "优先使用调用方注入的模型完成任务。" : "",
    ]
      .filter(Boolean)
      .join("\n");
  },
  model: async ({ requestContext }) => {
    const model = await resolveRequestModel(requestContext.get(REQUEST_MODEL_CONTEXT_KEY));
    if (model) return model;
    throw new Error("Reviewer 子 Agent 未能解析到可用模型,请在设置中配置供应商");
  },
});

export const workSubagents = {
  explorer: explorerAgent,
  reviewer: reviewerAgent,
};
