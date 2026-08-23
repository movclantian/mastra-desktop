/**
 * 子 Agent 的模型选择经 RequestContext 传递:主线程把 SUBAGENT_MODELS_CONTEXT_KEY
 * 写进上下文,这里在 model 回调里读取并解析(见 chat / session 路由)。
 */
import { Agent } from "@mastra/core/agent";
import { REQUEST_MODEL_CONTEXT_KEY, resolveDefaultModelId, resolveRequestModel } from "../models";

export const SUBAGENT_MODELS_CONTEXT_KEY = "mastra-work:subagent-models";

/**
 * 探索子 Agent (docs/en/docs/subagents.mdx):
 * 快速搜集信息、探查环境与资料。
 */
const explorerAgent = new Agent({
  id: "explorer",
  name: "Explorer",
  description: "快速搜集信息、探查环境与资料,并给出结构化汇总。",
  instructions:
    "你是探索子 Agent (Explorer)。\n专注于迅速探查指定目录、文档或网络信息,用清晰、简短的结构化列表返回事实与关键结论。",
  model: async ({ requestContext }) => {
    const model = await resolveRequestModel(requestContext.get(REQUEST_MODEL_CONTEXT_KEY));
    if (model) return model;
    const defaultModel = await resolveDefaultModelId();
    if (defaultModel) return defaultModel;
    throw new Error("Explorer 子 Agent 未能解析到可用模型,请在设置中配置供应商");
  },
});

/**
 * 审查子 Agent (docs/en/docs/subagents.mdx):
 * 审查代码变更、规范与缺陷。
 */
const reviewerAgent = new Agent({
  id: "reviewer",
  name: "Reviewer",
  description: "审查代码变更、规范、边界条件与缺陷风险,给出针对性的改进建议。",
  instructions:
    "你是审查子 Agent (Reviewer)。\n专注于静态分析、逻辑校验、架构一致性与安全隐患排查,输出严谨的技术评审意见。",
  model: async ({ requestContext }) => {
    const model = await resolveRequestModel(requestContext.get(REQUEST_MODEL_CONTEXT_KEY));
    if (model) return model;
    const defaultModel = await resolveDefaultModelId();
    if (defaultModel) return defaultModel;
    throw new Error("Reviewer 子 Agent 未能解析到可用模型,请在设置中配置供应商");
  },
});

export const workSubagents = {
  explorer: explorerAgent,
  reviewer: reviewerAgent,
};
