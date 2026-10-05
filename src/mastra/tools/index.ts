/**
 * Code Mode 工具(docs/en/docs/agents/code-mode.mdx、
 * docs/en/reference/tools/create-code-mode.mdx):
 * 只把适合批量编排的只读能力(资料库检索三件套)放进沙箱 allow-list。
 */
import { createCodeMode } from "@mastra/core/tools";
import { LocalSandbox } from "@mastra/core/workspace";
import {
  libraryDocumentChunkerTool,
  libraryGraphSearchTool,
  libraryVectorSearchTool,
} from "../rag/tools";
import { DEFAULT_MASTRA_DATA_DIRECTORY, getStorageDirectory } from "../storage";

/**
 * Code Mode 工具 (docs/en/docs/agents/code-mode.mdx, reference/tools/create-code-mode.mdx):
 * 只把适合批量编排的只读能力放进沙箱 allow-list。
 */
const CODE_MODE_EXTERNAL_TOOLS = {
  library_vector_search: libraryVectorSearchTool,
  library_graph_search: libraryGraphSearchTool,
  library_document_chunker: libraryDocumentChunkerTool,
} as const;

export const CODE_MODE_EXTERNAL_TOOL_NAMES = Object.keys(CODE_MODE_EXTERNAL_TOOLS);

export const codeMode = createCodeMode({
  tools: CODE_MODE_EXTERNAL_TOOLS,
  sandbox: new LocalSandbox({
    env: {},
    timeout: 30_000,
    workingDirectory: getStorageDirectory() || DEFAULT_MASTRA_DATA_DIRECTORY,
  }),
  timeout: 30_000,
});

/**
 * Tools 模块入口 (docs/en/reference/tools/ & docs/en/integrations/tools/):
 * - web-search: 联网检索工具 (Tavily / Firecrawl / AnySearch / Provider 原生检索)
 * - code-mode: Code Mode 沙箱编排工具 (docs/en/reference/tools/create-code-mode.mdx)
 */

export {
  getToolsConfig,
  parseWebSearchSelection,
  resolveWebSearchTools,
  saveToolsConfig,
  type ToolsUserConfig,
  WEB_SEARCH_CONTEXT_KEY,
  webSearchInstructions,
} from "./web-search";
