/**
 * MCP 配置路由(/work/mcp):读写服务器清单 + 连通性测试。
 * 配置主体见 src/mastra/connections/mcp.ts(docs/en/docs/connections/mcp.mdx)。
 */

import { MASTRA_RESOURCE_ID_KEY } from "@mastra/core/request-context";
import { registerApiRoute } from "@mastra/core/server";
import { errorText, workError } from "../errors";
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
    const resourceId = c.get("requestContext").get(MASTRA_RESOURCE_ID_KEY) as string;
    const config = await getMcpConfig(resourceId);
    return c.json({ servers: config.servers.map(summarizeMcpServer) });
  },
});

export const getMcpServerRoute = registerApiRoute("/work/mcp/:id", {
  method: "GET",
  handler: async (c) => {
    const id = c.req.param("id");
    const resourceId = c.get("requestContext").get(MASTRA_RESOURCE_ID_KEY) as string;
    const config = await getMcpConfig(resourceId);
    const server = config.servers.find((item) => item.id === id);
    if (!server) throw workError("MCP_SERVER_NOT_FOUND");
    return c.json({ server });
  },
});

export const saveMcpConfigRoute = registerApiRoute("/work/mcp", {
  method: "POST",
  handler: async (c) => {
    try {
      const payload = (await c.req.json()) as { server?: unknown };
      const server = payload.server as McpServerConfig | undefined;
      if (!server) throw workError("MCP_CONFIG_MISSING");
      const resourceId = c.get("requestContext").get(MASTRA_RESOURCE_ID_KEY) as string;
      const config = await getMcpConfig(resourceId);
      const next = config.servers.filter((item) => item.id !== server.id);
      next.push(server);
      await saveMcpConfig({ servers: next }, resourceId);
      return c.json({ server: summarizeMcpServer(server) }, 201);
    } catch (error) {
      throw workError("MCP_CONFIG_INVALID", {
        text: errorText(error, "保存 MCP 配置失败"),
        cause: error,
      });
    }
  },
});

export const deleteMcpConfigRoute = registerApiRoute("/work/mcp/:id", {
  method: "DELETE",
  handler: async (c) => {
    const id = c.req.param("id");
    const resourceId = c.get("requestContext").get(MASTRA_RESOURCE_ID_KEY) as string;
    const config = await getMcpConfig(resourceId);
    if (!config.servers.some((server) => server.id === id)) throw workError("MCP_SERVER_NOT_FOUND");
    await saveMcpConfig(
      { servers: config.servers.filter((server) => server.id !== id) },
      resourceId,
    );
    return c.json({ ok: true });
  },
});

export const testMcpConfigRoute = registerApiRoute("/work/mcp/test", {
  method: "POST",
  handler: async (c) => {
    try {
      const payload = (await c.req.json()) as { server?: McpServerConfig };
      if (!payload.server) throw workError("MCP_CONFIG_MISSING");
      return c.json(
        await testMcpServer(
          payload.server,
          c.get("requestContext").get(MASTRA_RESOURCE_ID_KEY) as string,
        ),
      );
    } catch (error) {
      return c.json(
        {
          ok: false,
          toolCount: 0,
          tools: [],
          error: errorText(error, "连接测试失败"),
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
      return c.json(
        await authenticateMcpServer(
          c.req.param("id"),
          c.get("requestContext").get(MASTRA_RESOURCE_ID_KEY) as string,
        ),
      );
    } catch (error) {
      throw workError("MCP_CONNECTION_FAILED", {
        text: errorText(error, "MCP OAuth 授权失败"),
        cause: error,
      });
    }
  },
});
