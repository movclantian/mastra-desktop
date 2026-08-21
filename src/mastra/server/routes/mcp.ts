import { registerApiRoute } from "@mastra/core/server";
import {
  getMcpConfig,
  type McpServerConfig,
  saveMcpConfig,
  summarizeMcpServer,
  testMcpServer,
} from "../../tools";

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
      if (!server) return c.json({ error: "缺少 MCP 服务配置" }, 400);
      const config = await getMcpConfig();
      const next = config.servers.filter((item) => item.id !== server.id);
      next.push(server);
      await saveMcpConfig({ servers: next });
      return c.json({ server: summarizeMcpServer(server) }, 201);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "保存 MCP 配置失败" }, 400);
    }
  },
});

export const deleteMcpConfigRoute = registerApiRoute("/work/mcp/:id", {
  method: "DELETE",
  handler: async (c) => {
    const id = c.req.param("id");
    const config = await getMcpConfig();
    if (!config.servers.some((server) => server.id === id))
      return c.json({ error: "MCP 服务不存在" }, 404);
    await saveMcpConfig({ servers: config.servers.filter((server) => server.id !== id) });
    return c.json({ ok: true });
  },
});

export const testMcpConfigRoute = registerApiRoute("/work/mcp/test", {
  method: "POST",
  handler: async (c) => {
    try {
      const payload = (await c.req.json()) as { server?: McpServerConfig };
      if (!payload.server) return c.json({ error: "缺少 MCP 服务配置" }, 400);
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
