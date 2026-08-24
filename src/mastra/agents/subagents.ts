/**
 * 子 Agent 的模型选择经 RequestContext 传递:主线程把 SUBAGENT_MODELS_CONTEXT_KEY
 * 写进上下文,这里在 model 回调里读取并解析(见 chat / session 路由)。
 */
import { Agent, type ToolsInput } from "@mastra/core/agent";
import { askUserTool, submitPlanTool } from "@mastra/core/tools";
import { getNotificationInboxTool } from "../harness";
import { getMemory } from "../memory";
import {
  REQUEST_MODEL_CONTEXT_KEY,
  resolveConfiguredModel,
  resolveDefaultModelId,
  splitRouterId,
} from "../models/providers";
import {
  libraryDocumentChunkerTool,
  libraryGraphSearchTool,
  libraryVectorSearchTool,
} from "../rag";
import {
  codeMode,
  getConfiguredMcpTools,
  MODEL_FAMILY_CONTEXT_KEY,
  parseWebSearchSelection,
  resolveWebSearchTools,
  WEB_SEARCH_CONTEXT_KEY,
} from "../tools";
import {
  getThreadWorkspace,
  isWorkspaceEnabled,
  WORKSPACE_PATH_CONTEXT_KEY,
  WORKSPACE_THREAD_ID_CONTEXT_KEY,
} from "../workspace";
import { workBrowser } from "./browser";
import {
  buildGuardrailErrorProcessors,
  buildGuardrailInputProcessors,
  buildGuardrailOutputProcessors,
  getGuardrailsRuntimeConfig,
} from "./guardrails";
import {
  agentsMdProcessor,
  editorStateProcessor,
  libraryAttachmentProcessor,
  promptCacheProcessor,
  terminalStateProcessor,
  workbenchStateProcessor,
} from "./processors";

export const SUBAGENT_MODELS_CONTEXT_KEY = "mastra-work:subagent-models";

type RequestContextLike = { get: (key: string) => unknown };

type ResolvedModel = Awaited<ReturnType<typeof resolveConfiguredModel>>;

function requestModelFromContext(requestContext: RequestContextLike): ResolvedModel | undefined {
  const model = requestContext.get(REQUEST_MODEL_CONTEXT_KEY);
  return typeof model === "object" && model !== null ? (model as ResolvedModel) : undefined;
}

export async function resolveSubagentModel(requestContext: RequestContextLike, agentType: string) {
  const selected = requestContext.get(SUBAGENT_MODELS_CONTEXT_KEY);
  if (typeof selected !== "object" || selected === null) return undefined;
  const models = selected as Record<string, unknown>;
  const configured = models[agentType] ?? models.default;
  if (configured === undefined || configured === null || configured === "") return undefined;

  const routerId =
    typeof configured === "string"
      ? configured.trim()
      : typeof configured === "object"
        ? (() => {
            const value = configured as Record<string, unknown>;
            const providerId = typeof value.providerId === "string" ? value.providerId : "";
            const modelId = typeof value.modelId === "string" ? value.modelId : "";
            return providerId && modelId ? `${providerId}/${modelId}` : "";
          })()
        : "";
  if (!routerId) {
    throw new Error(`子 Agent ${agentType} 的模型配置无效,需要 provider/model 路由。`);
  }
  const { providerId, modelId } = splitRouterId(routerId);
  const model = await resolveConfiguredModel(providerId, modelId);
  if (!model) {
    throw new Error(`子 Agent ${agentType} 的模型 ${routerId} 未配置或已被禁用。`);
  }
  return model;
}

function createSubagentModelResolver(agentType: string) {
  return async ({ requestContext }: { requestContext: RequestContextLike }) => {
    const selectedModel = await resolveSubagentModel(requestContext, agentType);
    if (selectedModel) return selectedModel;
    const model = requestModelFromContext(requestContext);
    if (model) return model;
    const defaultModel = await resolveDefaultModelId();
    if (defaultModel) return defaultModel;
    throw new Error(`${agentType} 子 Agent 未能解析到可用模型,请在设置中配置供应商`);
  };
}

async function resolveSubagentTools(requestContext: RequestContextLike): Promise<ToolsInput> {
  return {
    ask_user: askUserTool,
    submit_plan: submitPlanTool,
    execute_typescript: codeMode.tool,
    library_vector_search: libraryVectorSearchTool,
    library_graph_search: libraryGraphSearchTool,
    library_document_chunker: libraryDocumentChunkerTool,
    notification_inbox: await getNotificationInboxTool(),
    ...(await resolveWebSearchTools(
      parseWebSearchSelection(requestContext.get(WEB_SEARCH_CONTEXT_KEY)),
      requestContext.get(MODEL_FAMILY_CONTEXT_KEY),
    )),
    ...(await getConfiguredMcpTools()),
  };
}

function resolveSubagentWorkspace(requestContext: RequestContextLike) {
  if (!isWorkspaceEnabled()) return undefined;
  const path = requestContext.get(WORKSPACE_PATH_CONTEXT_KEY);
  if (typeof path !== "string" || !path) return undefined;
  const threadId = requestContext.get(WORKSPACE_THREAD_ID_CONTEXT_KEY);
  return getThreadWorkspace(path, typeof threadId === "string" ? threadId : undefined);
}

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
  model: createSubagentModelResolver("explorer"),
  tools: ({ requestContext }) => resolveSubagentTools(requestContext),
  memory: ({ requestContext }) => getMemory({ requestContext }),
  inputProcessors: async ({ requestContext }) => [
    libraryAttachmentProcessor,
    editorStateProcessor,
    terminalStateProcessor,
    workbenchStateProcessor,
    agentsMdProcessor,
    ...(await buildGuardrailInputProcessors(requestContext)),
    promptCacheProcessor,
  ],
  outputProcessors: async () => buildGuardrailOutputProcessors(),
  errorProcessors: async () => buildGuardrailErrorProcessors(),
  defaultOptions: async () => {
    const maxProcessorRetries = getGuardrailsRuntimeConfig().maxProcessorRetries;
    return maxProcessorRetries > 0 ? { maxProcessorRetries } : {};
  },
  workspace: ({ requestContext }) => resolveSubagentWorkspace(requestContext),
  browser: workBrowser,
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
  model: createSubagentModelResolver("reviewer"),
  tools: ({ requestContext }) => resolveSubagentTools(requestContext),
  memory: ({ requestContext }) => getMemory({ requestContext }),
  inputProcessors: async ({ requestContext }) => [
    libraryAttachmentProcessor,
    editorStateProcessor,
    terminalStateProcessor,
    workbenchStateProcessor,
    agentsMdProcessor,
    ...(await buildGuardrailInputProcessors(requestContext)),
    promptCacheProcessor,
  ],
  outputProcessors: async () => buildGuardrailOutputProcessors(),
  errorProcessors: async () => buildGuardrailErrorProcessors(),
  defaultOptions: async () => {
    const maxProcessorRetries = getGuardrailsRuntimeConfig().maxProcessorRetries;
    return maxProcessorRetries > 0 ? { maxProcessorRetries } : {};
  },
  workspace: ({ requestContext }) => resolveSubagentWorkspace(requestContext),
  browser: workBrowser,
});

export const workSubagents = {
  explorer: explorerAgent,
  reviewer: reviewerAgent,
};
