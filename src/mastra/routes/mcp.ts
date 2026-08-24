/**
 * MCP 配置路由(/work/mcp):读写服务器清单 + 连通性测试。
 * 配置主体见 src/mastra/connections/mcp.ts(docs/en/docs/connections/mcp.mdx)。
 */
import { registerApiRoute } from "@mastra/core/server";
import { workError } from "../errors";
import {
  authenticateMcpServer,
  getMcpConfig,
  type McpServerConfig,
  saveMcpConfig,
  summarizeMcpServer,
  testMcpServer,
} from "../tools";

export const mcpConfigRoute = registerApiRoute("/work/mcp", {
  method: "GET",
  handler: async (c) => {
    const config = await getMcpConfig();
    return c.json({ servers: config.servers.map(summarizeMcpServer) });
  },
});

export const saveMcpConfigRoute = registerApiRoute("/work/mcp", {
  method: "POST",
  handler: async (c) => {
    try {
      const payload = (await c.req.json()) as { server?: unknown };
      const server = payload.server as McpServerConfig | undefined;
      if (!server) throw workError("MCP_CONFIG_MISSING");
      const config = await getMcpConfig();
      const next = config.servers.filter((item) => item.id !== server.id);
      next.push(server);
      await saveMcpConfig({ servers: next });
      return c.json({ server: summarizeMcpServer(server) }, 201);
    } catch (error) {
      throw workError("MCP_CONFIG_INVALID", {
        text: error instanceof Error ? error.message : "保存 MCP 配置失败",
        cause: error,
      });
    }
  },
});

export const deleteMcpConfigRoute = registerApiRoute("/work/mcp/:id", {
  method: "DELETE",
  handler: async (c) => {
    const id = c.req.param("id");
    const config = await getMcpConfig();
    if (!config.servers.some((server) => server.id === id)) throw workError("MCP_SERVER_NOT_FOUND");
    await saveMcpConfig({ servers: config.servers.filter((server) => server.id !== id) });
    return c.json({ ok: true });
  },
});

export const testMcpConfigRoute = registerApiRoute("/work/mcp/test", {
  method: "POST",
  handler: async (c) => {
    try {
      const payload = (await c.req.json()) as { server?: McpServerConfig };
      if (!payload.server) throw workError("MCP_CONFIG_MISSING");
      return c.json(await testMcpServer(payload.server));
    } catch (error) {
      return c.json(
        {
          ok: false,
          toolCount: 0,
          tools: [],
          error: error instanceof Error ? error.message : "连接测试失败",
        },
        400,
      );
    }
  },
});

export const authenticateMcpConfigRoute = registerApiRoute("/work/mcp/:id/authenticate", {
  method: "POST",
  handler: async (c) => {
    try {
      return c.json(await authenticateMcpServer(c.req.param("id")));
    } catch (error) {
      throw workError("MCP_CONNECTION_FAILED", {
        text: error instanceof Error ? error.message : "MCP OAuth 授权失败",
        cause: error,
      });
    }
  },
});
