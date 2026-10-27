import { z } from "zod";
import { redactDiagnosticText } from "../../shared/credential-contract";
import { applicationTool } from "../tools/application";
import {
  authenticateMcpServer,
  deleteMcpServer,
  getMcpConfig,
  type McpServerConfig,
  mcpServerConfigSchema,
  saveMcpServer,
  summarizeMcpServer,
  testMcpServer,
} from "./mcp";

const fields = mcpServerConfigSchema.in.shape;
const target = z.object({ id: fields.id }).strict();
const publicInput = z
  .object({
    id: fields.id,
    name: fields.name,
    transport: fields.transport,
    url: fields.url,
    command: fields.command,
    args: fields.args,
    enabled: fields.enabled,
    timeout: fields.timeout,
    oauth: fields.oauth.unwrap().omit({ clientSecretCredential: true }).optional(),
  })
  .strict();

async function findServer(resourceId: string, id: string) {
  const server = (await getMcpConfig(resourceId)).servers.find(
    (item) => item.id === id && !item.builtin,
  );
  if (!server) throw new Error("MCP server not found");
  return server;
}

export async function publicMcpServer(server: McpServerConfig, resourceId: string) {
  const summary = await summarizeMcpServer(server, resourceId);
  const url = server.url && URL.canParse(server.url) ? new URL(server.url) : undefined;
  return {
    id: server.id,
    name: server.name,
    transport: server.transport,
    enabled: server.enabled,
    endpoint: url ? `${url.origin}${url.pathname}` : undefined,
    command: server.command ? redactDiagnosticText(server.command) : undefined,
    argumentCount: server.args?.length ?? 0,
    timeout: server.timeout,
    headerKeys: summary.headerKeys,
    envKeys: summary.envKeys,
    oauthEnabled: server.oauth?.enabled === true,
    pluginId: server.plugin?.id,
    componentId: server.plugin?.componentId,
    toolCount: summary.toolCount,
    configured: !summary.configurationError,
    connected: summary.connectionError ? false : summary.toolCount === undefined ? null : true,
    needsAttention: !!(summary.configurationError || summary.connectionError),
    configurationError: summary.configurationError
      ? redactDiagnosticText(summary.configurationError)
      : undefined,
    connectionError: summary.connectionError
      ? redactDiagnosticText(summary.connectionError)
      : undefined,
  };
}

const tools = [
  applicationTool({
    id: "app_read_mcp_servers",
    domain: "mcp",
    description:
      "List MCP connections and readiness without exposing credentials. Plugin-owned connections are managed through their plugin/component. A configured connection is not necessarily connected.",
    inputSchema: z.object({}).strict(),
    execute: async (_input, { resourceId }) => ({
      servers: await Promise.all(
        (await getMcpConfig(resourceId)).servers
          .filter((item) => !item.builtin)
          .map((server) => publicMcpServer(server, resourceId)),
      ),
    }),
  }),
  applicationTool({
    id: "app_manage_mcp_save",
    domain: "mcp",
    description:
      "Add or update a standalone MCP connection using a full public configuration. Reuses stored credentials; never accepts secret values or credential references. List first. Secret-bearing destinations cannot be changed here. User sign-in/key entry remains a secure user interaction.",
    inputSchema: publicInput,
    execute: async (input, { resourceId, mastra }) => {
      const previous = (await getMcpConfig(resourceId)).servers.find(
        (server) => server.id === input.id,
      );
      if (previous?.builtin || previous?.plugin)
        throw new Error("Use the owning plugin or built-in settings for this connection");
      if (
        previous &&
        (previous.headerCredential || previous.envCredential || previous.oauth?.enabled)
      ) {
        if (
          input.transport !== previous.transport ||
          input.url !== previous.url ||
          input.command !== previous.command ||
          JSON.stringify(input.args ?? []) !== JSON.stringify(previous.args ?? []) ||
          JSON.stringify(
            input.oauth
              ? { ...input.oauth, clientSecretCredential: previous.oauth?.clientSecretCredential }
              : previous.oauth,
          ) !== JSON.stringify(previous.oauth)
        )
          throw new Error(
            "A connection holding credentials keeps its destination, command and OAuth configuration; change these in secure settings",
          );
      }
      const server = await saveMcpServer(
        mcpServerConfigSchema.parse({
          ...previous,
          ...input,
          ...(previous?.oauth && input.oauth
            ? { oauth: { ...previous.oauth, ...input.oauth } }
            : {}),
        }),
        resourceId,
      );
      mastra?.getEditor()?.mcp.clearCache(server.clientId);
      return {
        server: await publicMcpServer(server, resourceId),
        effective: "next_run",
        next: "Test this saved connection; use authentication if required.",
      };
    },
  }),
  applicationTool({
    id: "app_manage_mcp_enabled",
    domain: "mcp",
    description:
      "Enable or disable a standalone MCP connection. This changes which tools are available to subsequent runs. Plugin-owned MCPs must be toggled through their plugin component.",
    inputSchema: target.extend({ enabled: z.boolean() }),
    execute: async ({ id, enabled }, { resourceId, mastra }) => {
      const previous = await findServer(resourceId, id);
      if (previous.plugin) throw new Error("Toggle this MCP's plugin component instead");
      const server = await saveMcpServer({ ...previous, enabled }, resourceId);
      mastra?.getEditor()?.mcp.clearCache(server.clientId);
      return { server: await publicMcpServer(server, resourceId), effective: "next_run" };
    },
  }),
  applicationTool({
    id: "app_manage_mcp_test",
    domain: "mcp",
    description:
      "Test a saved MCP connection and discover its tools. Stdio testing can start the configured executable. Does not expose credential values. Test again after the user signs in or adds a key.",
    inputSchema: target,
    execute: async ({ id }, { resourceId }) => {
      const server = await findServer(resourceId, id);
      const result = await testMcpServer(server, resourceId);
      return {
        ok: result.ok,
        toolCount: result.toolCount,
        error: result.error ? redactDiagnosticText(result.error) : undefined,
        server: await publicMcpServer(server, resourceId),
        ...(result.ok
          ? { tools: result.tools }
          : {
              next: "Connection test failed. Review this connection's configuration and authentication in MCP settings.",
            }),
      };
    },
  }),
  applicationTool({
    id: "app_manage_mcp_authenticate",
    domain: "mcp",
    description:
      "Start sign-in for an owned MCP connection with OAuth configured. Return the authorization link to the user; never collect passwords or API keys in chat. Test again after sign-in.",
    inputSchema: target,
    execute: async ({ id }, { resourceId }) => {
      await findServer(resourceId, id);
      return authenticateMcpServer(id, resourceId);
    },
  }),
  applicationTool({
    id: "app_delete_mcp_server",
    domain: "mcp",
    description:
      "Remove a standalone MCP connection and its stored credentials when explicitly requested. Use disable to stop using it temporarily; plugin-owned servers belong to the plugin lifecycle.",
    inputSchema: target,
    execute: async ({ id }, { resourceId, mastra }) => {
      const server = await findServer(resourceId, id);
      if (server.plugin) throw new Error("Remove the owning plugin instead");
      await deleteMcpServer(id, resourceId);
      mastra?.getEditor()?.mcp.clearCache(server.clientId);
      return { deleted: true, id };
    },
  }),
];
export const mcpApplicationTools = Object.fromEntries(tools.map((tool) => [tool.id, tool]));
