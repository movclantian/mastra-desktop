import type { ToolsInput } from "@mastra/core/agent";
/** 子 Agent 与主 Agent 共用当前请求模型。 */
import { Agent } from "@mastra/core/agent";
import type { InputProcessorOrWorkflow, Processor } from "@mastra/core/processors";
import type { RequestContext } from "@mastra/core/request-context";
import { askUserTool, createTool, submitPlanTool } from "@mastra/core/tools";
import type { ToolSet } from "ai";
import type { AgentMemberDefinition, AgentProfile } from "../../shared/agent-contract";
import { COMPUTER_TOOL_PREFIX } from "../../shared/computer-contract";
import { getComputerTools } from "../connections/computer";
import { getConfiguredMcpTools } from "../connections/mcp";
import { getNotificationInboxTool } from "../harness/signals";
import { getMemory } from "../memory/memory-runtime";
import { resolveAgentModel } from "../models/providers";
import { listPluginSkills } from "../plugins/registry";
import {
  libraryDocumentChunkerTool,
  libraryGraphSearchTool,
  libraryVectorSearchTool,
} from "../rag/tools";
import { userIdFromContext } from "../storage/database";
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
  PERMISSION_RULES_CONTEXT_KEY,
  type PermissionPolicy,
  parsePermissionRules,
  READ_ONLY_EXPERT_CONTEXT_KEY,
  requestToolApproval,
  resolveAgentActiveTools,
  resolveRequestMode,
  SESSION_TOOL_POLICY_CONTEXT_KEY,
} from "./permissions";
import {
  agentsMdProcessor,
  libraryAttachmentProcessor,
  libraryContextProcessor,
} from "./processors";
import { teamInvocationProcessor } from "./team-activity";

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
    teamInvocationProcessor,
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
      maxProcessorRetries,
      requireToolApproval: requestToolApproval,
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
    teamInvocationProcessor,
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
      maxProcessorRetries,
      requireToolApproval: requestToolApproval,
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
export async function resolveSharedTools(
  requestContext?: RequestContextLike,
  mcpServerIds?: string[],
): Promise<ToolsInput> {
  const tools = {
    ask_user: askUserTool,
    submit_plan: submitPlanTool,
    ...(isCodeModeAvailable(requestContext) ? { execute_typescript: codeMode.tool } : {}),
    library_vector_search: libraryVectorSearchTool,
    library_graph_search: libraryGraphSearchTool,
    library_document_chunker: libraryDocumentChunkerTool,
    notification_inbox: await getNotificationInboxTool(),
    ...(await resolveWebSearchTools(
      parseWebSearchSelection(requestContext?.get(WEB_SEARCH_CONTEXT_KEY)),
      userIdFromContext(requestContext),
    )),
    ...(await getConfiguredMcpTools(userIdFromContext(requestContext), undefined, mcpServerIds)),
    ...(await getComputerTools(requestContext)),
  };
  // Preserve computer-specific approval settings; other tools use the shared session policy.
  return Object.fromEntries(
    Object.entries(tools).map(([name, tool]) => [
      name,
      name.startsWith(COMPUTER_TOOL_PREFIX)
        ? tool
        : createTool({
            ...tool,
            id: name,
            execute: tool.execute
              ? async (input, context) =>
                  tool.execute?.(input, { ...context, observe: context.observe })
              : undefined,
            requireApproval: async (args, context) => {
              const required = await requestToolApproval({
                toolName: name,
                args,
                requestContext: context?.requestContext,
              });
              if (required || !(name.startsWith("mcp_") || name.startsWith("anysearch_")))
                return required;
              return typeof tool.requireApproval === "function"
                ? tool.requireApproval(args, context)
                : tool.requireApproval === true;
            },
          }),
    ]),
  );
}

/** An unattended run exposes only tools authorized by its persisted mode and permission rules. */
function scopedToolPolicy(profile?: AgentProfile, member?: AgentMemberDefinition) {
  const guarded = new WeakSet<object>();
  return {
    id: "scoped-tool-policy",
    processInputStep({ requestContext, tools, activeTools }) {
      const scheduled = requestContext?.get(SCHEDULE_RUN_CONTEXT_KEY) === true;
      if (!requestContext) return;
      const rules = parsePermissionRules(requestContext.get(PERMISSION_RULES_CONTEXT_KEY));
      const mode = resolveRequestMode(requestContext);
      const scopedTools = { ...tools } as ToolSet;
      for (const name of ["skill", "skill_read"]) {
        const tool = scopedTools[name];
        const execute = tool?.execute;
        if (!execute || guarded.has(execute)) continue;
        const guardedExecute: typeof execute = async (input, context) => {
          const runtimeName = name === "skill" ? input.name : input.skillName;
          if (typeof runtimeName === "string" && /^skill-[a-f0-9]{20}$/.test(runtimeName)) {
            const skill = (await listPluginSkills(userIdFromContext(requestContext))).find(
              (item) => item.name === runtimeName,
            );
            if (!skill?.enabled)
              throw new Error("This plugin skill is disabled or no longer installed");
          }
          return execute(input, context);
        };
        guarded.add(guardedExecute);
        scopedTools[name] = { ...tool, execute: guardedExecute };
      }
      return {
        tools: scopedTools,
        activeTools: resolveAgentActiveTools({
          tools: Object.keys(tools ?? {}),
          activeTools,
          mode,
          rules,
          profile,
          member,
          scheduled,
          readOnlyExpert: requestContext.get(READ_ONLY_EXPERT_CONTEXT_KEY) === true,
        }),
      };
    },
  } satisfies Processor;
}

/** Resolve attachments before processing model input. */
export async function buildInputPipeline(
  requestContext?: RequestContextLike,
  profile?: AgentProfile,
  member?: AgentMemberDefinition,
): Promise<InputProcessorOrWorkflow[]> {
  return [
    teamInvocationProcessor,
    scopedToolPolicy(profile, member),
    libraryContextProcessor,
    libraryAttachmentProcessor,
    agentsMdProcessor,
    ...(await buildGuardrailInputProcessors(requestContext as RequestContext | undefined)),
  ];
}
