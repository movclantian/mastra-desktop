import type { ToolsInput } from "@mastra/core/agent";
import type { InputProcessorOrWorkflow } from "@mastra/core/processors";
import type { RequestContext } from "@mastra/core/request-context";
import { MASTRA_RESOURCE_ID_KEY } from "@mastra/core/request-context";
import { askUserTool, submitPlanTool } from "@mastra/core/tools";
import { getNotificationInboxTool } from "../harness";
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
import { buildGuardrailInputProcessors } from "./guardrails";
import {
  agentsMdProcessor,
  editorStateProcessor,
  libraryAttachmentProcessor,
  promptCacheProcessor,
  terminalStateProcessor,
  workbenchStateProcessor,
} from "./processors";

export type RequestContextLike = { get: (key: string) => unknown };

/** Tools available to both the primary agent and its built-in subagents. */
export async function resolveSharedTools(requestContext?: RequestContextLike): Promise<ToolsInput> {
  return {
    ask_user: askUserTool,
    submit_plan: submitPlanTool,
    execute_typescript: codeMode.tool,
    library_vector_search: libraryVectorSearchTool,
    library_graph_search: libraryGraphSearchTool,
    library_document_chunker: libraryDocumentChunkerTool,
    notification_inbox: await getNotificationInboxTool(),
    ...(await resolveWebSearchTools(
      parseWebSearchSelection(requestContext?.get(WEB_SEARCH_CONTEXT_KEY)),
      requestContext?.get(MODEL_FAMILY_CONTEXT_KEY),
      requestContext?.get(MASTRA_RESOURCE_ID_KEY) as string | undefined,
    )),
    ...(await getConfiguredMcpTools(
      requestContext?.get(MASTRA_RESOURCE_ID_KEY) as string | undefined,
    )),
  };
}

/**
 * Shared processor order. promptCacheProcessor must remain last: guardrails'
 * ProviderHistoryCompat and ToolCallFilter can replace the outbound prompt,
 * which would otherwise discard the cache providerOptions.
 */
export async function buildInputPipeline(
  requestContext?: RequestContextLike,
): Promise<InputProcessorOrWorkflow[]> {
  return [
    libraryAttachmentProcessor,
    editorStateProcessor,
    terminalStateProcessor,
    workbenchStateProcessor,
    agentsMdProcessor,
    ...(await buildGuardrailInputProcessors(requestContext as RequestContext | undefined)),
    promptCacheProcessor,
  ];
}
