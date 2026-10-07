/** MCP 配置和连通性接口，传输、OAuth 与工具发现由官方 MCPClient 提供。 */
import { MASTRA_RESOURCE_ID_KEY } from "@mastra/core/request-context";
import { createRoute } from "@mastra/server/server-adapter";
import { z } from "zod";
import {
  authenticateMcpServer,
  deleteMcpServer,
  getMcpConfig,
  mcpServerConfigSchema,
  saveMcpServer,
  summarizeMcpServer,
  testMcpServer,
} from "../connections/mcp";
import { workError, workValidationError } from "../errors";
import { listInstalledPlugins, withPluginOperation } from "../plugins/registry";

const serverIdSchema = z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/) });
const serverBodySchema = z.object({ server: mcpServerConfigSchema }).strict();

export const mcpConfigRoute = createRoute({
  queryParamSchema: z.object({}).strict(),
  path: "/work/mcp",
  method: "GET",
  responseType: "json",
  onValidationError: workValidationError,
  handler: async ({ requestContext }) => {
    const config = await getMcpConfig(requestContext.get(MASTRA_RESOURCE_ID_KEY) as string);
    const plugins = await listInstalledPlugins(
      requestContext.get(MASTRA_RESOURCE_ID_KEY) as string,
    );
    const visible = config.servers.filter(
      (server) =>
        !server.plugin ||
        plugins.some(
          (plugin) =>
            plugin.id === server.plugin?.id &&
            plugin.current.digest === server.plugin.digest &&
            plugin.current.components.some((component) => component.id === server.id),
        ),
    );
    return {
      servers: await Promise.all(
        visible.map((server) =>
          summarizeMcpServer(server, requestContext.get(MASTRA_RESOURCE_ID_KEY) as string),
        ),
      ),
    };
  },
});

export const getMcpServerRoute = createRoute({
  queryParamSchema: z.object({}).strict(),
  path: "/work/mcp/:id",
  method: "GET",
  responseType: "json",
  pathParamSchema: serverIdSchema,
  onValidationError: workValidationError,
  handler: async ({ id, requestContext }) => {
    const config = await getMcpConfig(requestContext.get(MASTRA_RESOURCE_ID_KEY) as string);
    const server = config.servers.find((item) => item.id === id);
    if (!server) throw workError("MCP_SERVER_NOT_FOUND");
    return { server };
  },
});

export const saveMcpConfigRoute = createRoute({
  queryParamSchema: z.object({}).strict(),
  path: "/work/mcp",
  method: "POST",
  responseType: "json",
  bodySchema: serverBodySchema,
  onValidationError: workValidationError,
  handler: async ({ server, requestContext, mastra }) => {
    const resourceId = requestContext.get(MASTRA_RESOURCE_ID_KEY) as string;
    const saved = server.plugin
      ? await withPluginOperation(resourceId, server.plugin.id, () =>
          saveMcpServer(server, resourceId),
        )
      : await saveMcpServer(server, resourceId);
    mastra.getEditor()?.mcp.clearCache(saved.clientId);
    return { server: await summarizeMcpServer(saved, resourceId) };
  },
});

export const deleteMcpConfigRoute = createRoute({
  queryParamSchema: z.object({}).strict(),
  bodySchema: z.object({}).strict().optional(),
  path: "/work/mcp/:id",
  method: "DELETE",
  responseType: "json",
  pathParamSchema: serverIdSchema,
  onValidationError: workValidationError,
  handler: async ({ id, requestContext, mastra }) => {
    const resourceId = requestContext.get(MASTRA_RESOURCE_ID_KEY) as string;
    await deleteMcpServer(id, resourceId);
    mastra.getEditor()?.mcp.clearCache();
    return { ok: true };
  },
});

export const testMcpConfigRoute = createRoute({
  queryParamSchema: z.object({}).strict(),
  path: "/work/mcp/test",
  method: "POST",
  responseType: "json",
  bodySchema: serverBodySchema,
  onValidationError: workValidationError,
  handler: async ({ server, requestContext }) => {
    return testMcpServer(server, requestContext.get(MASTRA_RESOURCE_ID_KEY) as string);
  },
});

export const authenticateMcpConfigRoute = createRoute({
  queryParamSchema: z.object({}).strict(),
  bodySchema: z.object({}).strict().optional(),
  path: "/work/mcp/:id/authenticate",
  method: "POST",
  responseType: "json",
  pathParamSchema: serverIdSchema,
  onValidationError: workValidationError,
  handler: async ({ id, requestContext }) => {
    return authenticateMcpServer(id, requestContext.get(MASTRA_RESOURCE_ID_KEY) as string);
  },
});
