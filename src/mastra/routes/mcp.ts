/** MCP 配置和连通性接口，传输、OAuth 与工具发现由官方 MCPClient 提供。 */
import { MASTRA_RESOURCE_ID_KEY } from "@mastra/core/request-context";
import { createRoute } from "@mastra/server/server-adapter";
import { z } from "zod";
import {
  authenticateMcpServer,
  getMcpConfig,
  mcpServerConfigSchema,
  saveMcpConfig,
  summarizeMcpServer,
  testMcpServer,
} from "../connections/mcp";
import { workError, workValidationError } from "../errors";

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
    return { servers: config.servers.map(summarizeMcpServer) };
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
  handler: async ({ server, requestContext }) => {
    const resourceId = requestContext.get(MASTRA_RESOURCE_ID_KEY) as string;
    const config = await getMcpConfig(resourceId);
    await saveMcpConfig(
      { servers: [...config.servers.filter((item) => item.id !== server.id), server] },
      resourceId,
    );
    return { server: summarizeMcpServer(server) };
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
  handler: async ({ id, requestContext }) => {
    const resourceId = requestContext.get(MASTRA_RESOURCE_ID_KEY) as string;
    const config = await getMcpConfig(resourceId);
    if (!config.servers.some((server) => server.id === id)) throw workError("MCP_SERVER_NOT_FOUND");
    await saveMcpConfig(
      { servers: config.servers.filter((server) => server.id !== id) },
      resourceId,
    );
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
