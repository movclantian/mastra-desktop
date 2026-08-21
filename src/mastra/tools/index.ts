/**
 * Tools 模块入口 (docs/en/reference/tools/ & docs/en/integrations/tools/):
 * - web-search: 联网检索工具 (Tavily / Firecrawl / AnySearch / Provider 原生检索)
 * - code-mode: Code Mode 沙箱编排工具 (docs/en/reference/tools/create-code-mode.mdx)
 * - connections/mcp: MCP 动态工具集 (docs/en/reference/tools/mcp-client.mdx)
 */

export {
  getConfiguredMcpTools,
  getMcpConfig,
  type McpServerConfig,
  saveMcpConfig,
  summarizeMcpServer,
  testMcpServer,
} from "../connections/mcp";
export { CODE_MODE_EXTERNAL_TOOL_NAMES, codeMode } from "./code-mode";
export {
  getToolsConfig,
  MODEL_FAMILY_CONTEXT_KEY,
  parseWebSearchSelection,
  resolveWebSearchTools,
  saveToolsConfig,
  type ToolsUserConfig,
  WEB_SEARCH_CONTEXT_KEY,
  webSearchInstructions,
} from "./web-search";
