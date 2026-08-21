/**
 * Connections 模块入口 (docs/en/docs/connections/):
 * - mcp: MCPClient 与服务定义 (docs/en/docs/connections/mcp.mdx)
 */

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
} from "./mcp";
