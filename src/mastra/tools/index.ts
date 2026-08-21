/**
 * Tools 模块入口 (docs/en/reference/tools/ & docs/en/integrations/tools/):
 * - web-search: 联网检索工具 (Tavily / Firecrawl / AnySearch / Provider 原生检索)
 * - code-mode: Code Mode 沙箱编排工具 (docs/en/reference/tools/create-code-mode.mdx)
 * - connections/mcp: MCP 动态工具集 (docs/en/reference/tools/mcp-client.mdx)
 */

export {
  askUserTool,
  createCodeMode,
  createTool,
  submitPlanTool,
  webFetchTool,
  webSearchTool,
} from "@mastra/core/tools";
export {
  getConfiguredMcpTools,
  getMcpConfig,
  type McpConfig,
  type McpServerConfig,
  type McpServerSummary,
  type McpTransport,
  saveMcpConfig,
  summarizeMcpServer,
  testMcpServer,
} from "../connections";
export {
  CODE_MODE_EXTERNAL_TOOL_NAMES,
  CODE_MODE_EXTERNAL_TOOLS,
  codeMode,
} from "./code-mode";
export {
  getToolsConfig,
  isEngineConfigured,
  MODEL_FAMILY_CONTEXT_KEY,
  PROVIDER_SEARCH_FAMILIES,
  parseWebSearchSelection,
  resolveWebSearchTools,
  SEARCH_DEPTHS,
  SEARCH_ENGINES,
  type SearchDepth,
  type SearchEngine,
  saveToolsConfig,
  supportsProviderSearch,
  type ToolsUserConfig,
  WEB_SEARCH_CONTEXT_KEY,
  type WebSearchSelection,
  webSearchInstructions,
} from "./web-search";
