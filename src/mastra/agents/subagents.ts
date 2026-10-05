import type { ToolsInput } from "@mastra/core/agent";
/** 子 Agent 与主 Agent 共用当前请求模型。 */
import { Agent } from "@mastra/core/agent";
import type { InputProcessorOrWorkflow, Processor } from "@mastra/core/processors";
import type { RequestContext } from "@mastra/core/request-context";
import { askUserTool, submitPlanTool } from "@mastra/core/tools";
import { getConfiguredMcpTools } from "../connections/mcp";
import { getNotificationInboxTool } from "../harness/signals";
import { getMemory } from "../memory/memory-runtime";
import { resolveAgentModel } from "../models/providers";
import {
  libraryDocumentChunkerTool,
  libraryGraphSearchTool,
  libraryVectorSearchTool,
} from "../rag/tools";
import { userIdFromContext } from "../storage/database";
import { writePlanDraftTool } from "../tools/plan-draft";
import {
  CODE_MODE_EXTERNAL_TOOL_NAMES,
  codeMode,
  parseWebSearchSelection,
  resolveWebSearchTools,
  WEB_SEARCH_CONTEXT_KEY,
} from "../tools/tool-registry";
import { webSearchArchiveProcessor } from "../tools/web-search";
import {
  getThreadWorkspace,
  SCHEDULE_RUN_CONTEXT_KEY,
  WORKSPACE_PATH_CONTEXT_KEY,
  WORKSPACE_THREAD_ID_CONTEXT_KEY,
} from "../workspace/workspace-manager";
import {
  buildGuardrailErrorProcessors,
  buildGuardrailInputProcessors,
  buildGuardrailOutputProcessors,
  getGuardrailsConfig,
} from "./guardrails";
import {
  MODE_ID_CONTEXT_KEY,
  PERMISSION_RULES_CONTEXT_KEY,
  type PermissionPolicy,
  parsePermissionRules,
  resolveMode,
  SESSION_TOOL_POLICY_CONTEXT_KEY,
  toolCategoryOf,
} from "./permissions";
import {
  agentsMdProcessor,
  libraryAttachmentProcessor,
  libraryContextProcessor,
} from "./processors";
import { TEAM_WORKFLOW_CONTEXT_KEY } from "./team-workflow";

function resolveSubagentWorkspace(requestContext: RequestContextLike) {
  const resourceId = userIdFromContext(requestContext);
  const path = requestContext.get(WORKSPACE_PATH_CONTEXT_KEY);
  const workspacePath = typeof path === "string" && path.trim() ? path.trim() : process.cwd();
  const threadId = requestContext.get(WORKSPACE_THREAD_ID_CONTEXT_KEY);
  return getThreadWorkspace(
    workspacePath,
    typeof threadId === "string" ? threadId : undefined,
    resourceId,
  );
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
  model: resolveAgentModel,
  tools: ({ requestContext }) => resolveSharedTools(requestContext),
  memory: ({ requestContext }) => getMemory({ requestContext }),
  inputProcessors: async ({ requestContext }) => buildInputPipeline(requestContext),
  outputProcessors: async ({ requestContext }) => [
    webSearchArchiveProcessor,
    ...(await buildGuardrailOutputProcessors(requestContext)),
  ],
  errorProcessorDefaults: false,
  errorProcessors: async ({ requestContext }) =>
    buildGuardrailErrorProcessors(userIdFromContext(requestContext)),
  defaultOptions: async ({ requestContext }) => {
    const { maxProcessorRetries } = await getGuardrailsConfig(userIdFromContext(requestContext));
    return {
      untilIdle: true,
      ...(maxProcessorRetries > 0 ? { maxProcessorRetries } : {}),
    };
  },
  workspace: ({ requestContext }) => resolveSubagentWorkspace(requestContext),
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
  model: resolveAgentModel,
  tools: ({ requestContext }) => resolveSharedTools(requestContext),
  memory: ({ requestContext }) => getMemory({ requestContext }),
  inputProcessors: async ({ requestContext }) => buildInputPipeline(requestContext),
  outputProcessors: async ({ requestContext }) => [
    webSearchArchiveProcessor,
    ...(await buildGuardrailOutputProcessors(requestContext)),
  ],
  errorProcessorDefaults: false,
  errorProcessors: async ({ requestContext }) =>
    buildGuardrailErrorProcessors(userIdFromContext(requestContext)),
  defaultOptions: async ({ requestContext }) => {
    const { maxProcessorRetries } = await getGuardrailsConfig(userIdFromContext(requestContext));
    return {
      untilIdle: true,
      ...(maxProcessorRetries > 0 ? { maxProcessorRetries } : {}),
    };
  },
  workspace: ({ requestContext }) => resolveSubagentWorkspace(requestContext),
});

export const workSubagents = {
  explorer: explorerAgent,
  reviewer: reviewerAgent,
};

export type RequestContextLike = { get: (key: string) => unknown };

export function isCodeModeAvailable(requestContext?: RequestContextLike): boolean {
  const policy = requestContext?.get(SESSION_TOOL_POLICY_CONTEXT_KEY) as
    | ((toolName: string) => PermissionPolicy)
    | undefined;
  return Boolean(
    policy &&
      policy("execute_typescript") !== "deny" &&
      CODE_MODE_EXTERNAL_TOOL_NAMES.every((name) => policy(name) === "allow"),
  );
}

/** Tools available to both the primary agent and its built-in subagents. */
export async function resolveSharedTools(requestContext?: RequestContextLike): Promise<ToolsInput> {
  const planDraft = requestContext?.get(MODE_ID_CONTEXT_KEY) === "plan";
  return {
    ask_user: askUserTool,
    submit_plan: submitPlanTool,
    ...(planDraft ? { write_plan_draft: writePlanDraftTool } : {}),
    ...(isCodeModeAvailable(requestContext) ? { execute_typescript: codeMode.tool } : {}),
    library_vector_search: libraryVectorSearchTool,
    library_graph_search: libraryGraphSearchTool,
    library_document_chunker: libraryDocumentChunkerTool,
    notification_inbox: await getNotificationInboxTool(),
    ...(await resolveWebSearchTools(
      parseWebSearchSelection(requestContext?.get(WEB_SEARCH_CONTEXT_KEY)),
      userIdFromContext(requestContext),
    )),
    ...(await getConfiguredMcpTools(userIdFromContext(requestContext))),
  };
}

/** An unattended run exposes only tools authorized by its persisted mode and permission rules. */
const scopedToolPolicy = {
  id: "scoped-tool-policy",
  processInputStep({ requestContext, tools, activeTools }) {
    const scheduled = requestContext?.get(SCHEDULE_RUN_CONTEXT_KEY) === true;
    if (!scheduled && requestContext?.get(TEAM_WORKFLOW_CONTEXT_KEY) !== true) return;
    const rules = parsePermissionRules(requestContext.get(PERMISSION_RULES_CONTEXT_KEY));
    const mode = resolveMode(requestContext.get(MODE_ID_CONTEXT_KEY));
    return {
      activeTools: (activeTools ?? Object.keys(tools ?? {})).filter(
        (name) =>
          (!scheduled || (name !== "ask_user" && name !== "submit_plan")) &&
          (!mode.availableTools || mode.availableTools.includes(name)) &&
          (scheduled
            ? (rules.tools[name] ?? rules.categories[toolCategoryOf(name)]) === "allow"
            : (rules.tools[name] ?? rules.categories[toolCategoryOf(name)]) !== "deny"),
      ),
    };
  },
} satisfies Processor;

/** Resolve attachments before processing model input. */
export async function buildInputPipeline(
  requestContext?: RequestContextLike,
): Promise<InputProcessorOrWorkflow[]> {
  return [
    scopedToolPolicy,
    libraryContextProcessor,
    libraryAttachmentProcessor,
    agentsMdProcessor,
    ...(await buildGuardrailInputProcessors(requestContext as RequestContext | undefined)),
  ];
}
