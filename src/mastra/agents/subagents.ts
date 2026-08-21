import { Agent } from "@mastra/core/agent";
import {
  libraryDocumentChunkerTool,
  libraryGraphSearchTool,
  libraryVectorSearchTool,
} from "../library";
import { getMemory } from "../memory";
import { getThreadWorkspace, isWorkspaceEnabled, WORKSPACE_PATH_CONTEXT_KEY } from "../workspace";
import { type GatewayLanguageModel, REQUEST_MODEL_CONTEXT_KEY, resolveDefaultModelId } from "./llm";
import { toolCategoryOf } from "./permissions";

export const SUBAGENT_MODELS_CONTEXT_KEY = "mastra-work:subagent-models";

async function subagentModel(
  requestContext: { get(key: string): unknown } | undefined,
  agentType: string,
) {
  const selections = requestContext?.get(SUBAGENT_MODELS_CONTEXT_KEY) as
    | Record<string, string | GatewayLanguageModel | { id: `${string}/${string}`; apiKey: string }>
    | undefined;
  const override = selections?.[agentType] ?? selections?.default;
  if (override) {
    if (typeof override !== "string") return override;
    return (
      override.startsWith("mastra-work/") ? override : `mastra-work/${override}`
    ) as `${string}/${string}`;
  }
  const parentModel = requestContext?.get(REQUEST_MODEL_CONTEXT_KEY) as
    | GatewayLanguageModel
    | { id: `${string}/${string}`; apiKey: string }
    | undefined;
  if (parentModel) return parentModel;
  const modelId = await resolveDefaultModelId();
  if (!modelId) throw new Error("No model is configured for the delegated agent");
  return modelId;
}

const sharedReadTools = {
  library_vector_search: libraryVectorSearchTool,
  library_graph_search: libraryGraphSearchTool,
  library_document_chunker: libraryDocumentChunkerTool,
};

const readOnlyOptions = {
  hooks: {
    beforeToolCall: ({ toolName }: { toolName: string }) =>
      toolCategoryOf(toolName) === "read"
        ? undefined
        : {
            proceed: false as const,
            output: `Tool "${toolName}" is unavailable to this read-only subagent.`,
          },
  },
};

function subagentWorkspace(requestContext: { get(key: string): unknown } | undefined) {
  if (!isWorkspaceEnabled()) return undefined;
  const path = requestContext?.get(WORKSPACE_PATH_CONTEXT_KEY);
  return typeof path === "string" && path ? getThreadWorkspace(path) : undefined;
}

export const explorerAgent = new Agent({
  id: "mastra-work-explorer",
  name: "Explorer",
  description:
    "Investigates a focused question using read-only workspace, library, and configured MCP tools, then returns concise evidence with file paths or citations.",
  instructions:
    "Investigate only the delegated question. Read before concluding, do not modify the workspace, and return a compact evidence-backed report for the parent agent.",
  model: ({ requestContext }) => subagentModel(requestContext, "explorer"),
  memory: ({ requestContext }) => getMemory({ requestContext }),
  tools: sharedReadTools,
  workspace: ({ requestContext }) => subagentWorkspace(requestContext),
  defaultOptions: readOnlyOptions,
});

export const reviewerAgent = new Agent({
  id: "mastra-work-reviewer",
  name: "Reviewer",
  description:
    "Reviews an implementation or plan for correctness, security, regressions, and missing verification; returns actionable findings ordered by severity.",
  instructions:
    "Review the delegated target without changing it. Lead with concrete findings, cite the affected files or evidence, and say clearly when no issue is found.",
  model: ({ requestContext }) => subagentModel(requestContext, "reviewer"),
  memory: ({ requestContext }) => getMemory({ requestContext }),
  tools: sharedReadTools,
  workspace: ({ requestContext }) => subagentWorkspace(requestContext),
  defaultOptions: readOnlyOptions,
});

export const workSubagents = {
  explorer: explorerAgent,
  reviewer: reviewerAgent,
};
