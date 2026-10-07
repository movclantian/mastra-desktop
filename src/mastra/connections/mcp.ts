/**
 * MCP (Model Context Protocol) 连接模块。
 * 官方文档:docs/en/docs/connections/mcp.mdx(传输 / 工具审批 / 安全)、
 * docs/en/reference/tools/mcp-client.mdx(MCPClient API)。
 * HTTP/stdio 连接统一使用官方 mcpClients 版本化存储，Studio 与桌面读取同一份配置。
 * 凭据仅存主进程凭据库；运行时通过官方 MCPClient 应用请求头、OAuth 和审批策略。
 */
import { createHash, randomUUID } from "node:crypto";
import type { ToolsInput } from "@mastra/core/agent";
import type { ContextWithMastra } from "@mastra/core/server";
import { MASTRA_RESOURCE_ID_KEY } from "@mastra/core/request-context";
import type { StorageResolvedMCPClientType, StorageMCPServerConfig } from "@mastra/core/storage";
import { handleAutoVersioning, MCP_CLIENT_SNAPSHOT_CONFIG_FIELDS } from "@mastra/server/handlers/version-helpers";
import {
  getCallbackUrlCandidates,
  type MastraMCPServerDefinition,
  MCPClient,
  MCPOAuthClientProvider,
  type OAuthStorage,
} from "@mastra/mcp";
import { z } from "zod";
import {
  type CredentialPointer,
  CredentialPointerSchema,
  mcpCredentialPurpose,
} from "../../shared/credential-contract";
import {
  deleteCredential,
  oauthCredentialPurpose,
  resolveCredential,
  storeCredential,
} from "../credential-broker";
import { errorText, workError } from "../errors";
import { appStorage, deleteAppConfig, getAppConfig, setAppConfig } from "../storage/database";

export const mcpServerConfigSchema = z
  .object({
    id: z
      .string()
      .trim()
      .regex(/^[a-zA-Z0-9_-]{1,64}$/),
    name: z.string().trim().optional(),
    clientId: z.string().min(1).optional(),
    serverName: z.string().min(1).optional(),
    builtin: z.literal("anysearch").optional(),
    status: z.enum(["draft", "published", "archived"]).optional(),
    version: z.string().optional(),
    timeout: z.number().int().positive().optional(),
    tools: z.record(z.string(), z.object({ description: z.string().optional() })).optional(),
    enabled: z.boolean().default(true),
    transport: z.enum(["http", "stdio"]),
    url: z.url({ protocol: /^https?$/ }).optional(),
    headerCredential: CredentialPointerSchema.optional(),
    headerKeys: z.array(z.string()).optional(),
    /** HTTP 传输重定向只允许落到这些主机。 */
    allowedHosts: z.array(z.string().trim().min(1)).optional(),
    command: z.string().trim().min(1).optional(),
    args: z.array(z.string()).optional(),
    envCredential: CredentialPointerSchema.optional(),
    envKeys: z.array(z.string()).optional(),
    inheritDefaultEnv: z.boolean().default(true),
    /** 外部工具默认逐次审批。 */
    requireToolApproval: z.boolean().default(true),
    oauth: z
      .object({
        enabled: z.boolean(),
        redirectUrl: z.url({ protocol: /^https?$/ }).optional(),
        clientName: z.string().optional(),
        clientId: z.string().trim().optional(),
        clientSecretCredential: CredentialPointerSchema.optional(),
        scopes: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((server, context) => {
    if (server.transport === "http" && !server.url) {
      context.addIssue({ code: "custom", path: ["url"], message: "HTTP MCP 必须填写 URL" });
    }
    if (server.transport === "stdio" && !server.command) {
      context.addIssue({ code: "custom", path: ["command"], message: "Stdio MCP 必须填写命令" });
    }
    if (server.oauth?.enabled && !server.oauth.clientId) {
      context.addIssue({
        code: "custom",
        path: ["oauth", "clientId"],
        message: "启用 OAuth 必须填写已注册的 Client ID",
      });
    }
  })
  .transform((server) => ({ ...server, name: server.name || server.id }));

export type McpServerConfig = z.infer<typeof mcpServerConfigSchema>;

interface McpConfig {
  servers: McpServerConfig[];
}

interface McpServerSummary extends McpServerConfig {
  headerKeys: string[];
  envKeys: string[];
}

export const ANYSEARCH_MCP_URL = "https://api.anysearch.com/mcp";
const OWNER_KEY = "mastra_resource_id";
const OPTIONS_KEY = "desktopMcp";
const scopeOf = (resourceId?: string) => resourceId?.trim() || "__system__";
const stableId = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 24);

interface McpRuntime {
  clients: Map<string, { hash: string; promise: Promise<MCPClient> }>;
  redirects: Map<string, { client: MCPClient; url: Promise<string>; resolve: (url: string) => void }>;
}
const runtimeByScope = new Map<string, McpRuntime>();
function getRuntime(resourceId?: string): McpRuntime {
  const scope = scopeOf(resourceId);
  let runtime = runtimeByScope.get(scope);
  if (!runtime) {
    runtime = { clients: new Map(), redirects: new Map() };
    runtimeByScope.set(scope, runtime);
  }
  return runtime;
}
async function mcpStore() {
  const store = await appStorage.getStore("mcpClients");
  if (!store) throw new Error("MCP clients storage is not configured");
  return store;
}
function connectionOptions(client: StorageResolvedMCPClientType): Record<string, Partial<McpServerConfig>> {
  return z.record(z.string(), z.record(z.string(), z.unknown())).parse(client.metadata?.[OPTIONS_KEY] ?? {});
}
function connectionsOf(client: StorageResolvedMCPClientType): McpServerConfig[] {
  const options = connectionOptions(client);
  return Object.entries(client.servers).map(([serverName, server]) => mcpServerConfigSchema.parse({
    ...options[serverName],
    id: options[serverName]?.id ?? stableId(`${client.id}:${serverName}`),
    clientId: client.id,
    serverName,
    name: Object.keys(client.servers).length === 1 ? client.name : (options[serverName]?.name ?? serverName),
    status: client.status,
    version: `${client.resolvedVersionId}:${client.updatedAt.toISOString()}`,
    enabled: client.status === "published" && options[serverName]?.enabled !== false,
    transport: server.type,
    url: server.url,
    command: server.command,
    args: server.args,
    timeout: server.timeout,
    tools: server.tools,
    envKeys: [...new Set([...Object.keys(server.env ?? {}), ...(options[serverName]?.envKeys ?? [])])],
  }));
}
async function ownedClient(id: string, resourceId?: string): Promise<StorageResolvedMCPClientType> {
  const client = await (await mcpStore()).getByIdResolved(id);
  if (!client || client.metadata?.[OWNER_KEY] !== scopeOf(resourceId)) throw workError("MCP_SERVER_NOT_FOUND");
  return client;
}
const preparingAnysearch = new Map<string, Promise<void>>();
async function ensureAnysearchConnection(resourceId?: string): Promise<void> {
  const scope = scopeOf(resourceId);
  let pending = preparingAnysearch.get(scope);
  if (!pending) {
    pending = (async () => {
      const store = await mcpStore();
      const id = `anysearch-${stableId(scope)}`;
      if (await store.getById(id)) return;
      await store.create({ mcpClient: {
        id, name: "AnySearch", authorId: scope,
        description: "Built-in web search connection. Choose search depth in the composer; manage credentials here.",
        servers: { anysearch: { type: "http", url: ANYSEARCH_MCP_URL } },
        metadata: { [OWNER_KEY]: scope, [OPTIONS_KEY]: { anysearch: {
          id, builtin: "anysearch", enabled: true, requireToolApproval: false,
          allowedHosts: ["api.anysearch.com"],
        } } },
      } });
      const version = await store.getLatestVersion(id);
      if (!version) throw new Error("MCP initial version was not created");
      await store.update({ id, activeVersionId: version.id, status: "published" });
    })().finally(() => preparingAnysearch.delete(scope));
    preparingAnysearch.set(scope, pending);
  }
  await pending;
}

/** The same official storage domain is used by Studio's MCP Clients and the desktop manager. */
export async function getMcpConfig(resourceId?: string): Promise<McpConfig> {
  await ensureAnysearchConnection(resourceId);
  const store = await mcpStore();
  const pages = await Promise.all((["published", "draft", "archived"] as const).map((status) =>
    store.listResolved({ perPage: false, metadata: { [OWNER_KEY]: scopeOf(resourceId) }, status }),
  ));
  return { servers: pages.flatMap((page) => page.mcpClients.flatMap(connectionsOf)) };
}

/** Update one connection without replacing another client's configuration or losing sibling servers. */
export async function saveMcpServer(input: McpServerConfig, resourceId?: string): Promise<McpServerConfig> {
  const server = mcpServerConfigSchema.parse(input);
  const store = await mcpStore();
  const current = server.clientId ? await ownedClient(server.clientId, resourceId) : undefined;
  const options = current ? connectionOptions(current) : {};
  const serverName = server.serverName ?? `mcp_${server.id}`;
  if (current && !current.servers[serverName]) throw workError("MCP_SERVER_NOT_FOUND");
  const previous = options[serverName];
  if (previous?.builtin === "anysearch") {
    server.builtin = "anysearch";
    if (server.transport !== "http" || server.url !== ANYSEARCH_MCP_URL || serverName !== "anysearch" || server.oauth?.enabled)
      throw workError("MCP_CONFIG_INVALID", { text: "AnySearch uses its built-in HTTP endpoint and API key authentication" });
    server.allowedHosts = ["api.anysearch.com"];
  } else if (server.builtin) throw workError("MCP_CONFIG_INVALID", { text: "Built-in identity is managed by the application" });
  if (previous?.id && previous.id !== server.id) throw workError("MCP_CONFIG_INVALID", { text: "MCP connection ID cannot change" });
  await Promise.all([
    resolveSecretRecord(server.headerCredential, mcpCredentialPurpose(server.id, "headers")),
    resolveSecretRecord(server.envCredential, mcpCredentialPurpose(server.id, "env")),
    server.oauth?.clientSecretCredential ? resolveCredential(server.oauth.clientSecretCredential.credentialRef, mcpCredentialPurpose(server.id, "client-secret")) : undefined,
  ]);
  const id = current?.id ?? randomUUID();
  const definition: StorageMCPServerConfig = {
    type: server.transport,
    ...(server.transport === "http" ? { url: server.url } : { command: server.command, args: server.args, env: current?.servers[serverName]?.env }),
    timeout: server.timeout, tools: server.tools,
  };
  const { clientId: _clientId, serverName: _serverName, version: _version, status: _status, transport: _transport, url: _url, command: _command, args: _args, timeout: _timeout, tools: _tools, ...security } = server;
  const metadata = { ...current?.metadata, [OWNER_KEY]: scopeOf(resourceId), [OPTIONS_KEY]: { ...options, [serverName]: security } };
  const snapshot = { name: current && Object.keys(current.servers).length > 1 ? current.name : server.name,
    description: current?.description, servers: { ...current?.servers, [serverName]: definition } };
  if (current) {
    const updated = await store.update({ id, metadata });
    await handleAutoVersioning(store, id, "mcpClientId", MCP_CLIENT_SNAPSHOT_CONFIG_FIELDS, current, updated, snapshot);
  } else await store.create({ mcpClient: { id, ...snapshot, metadata, authorId: scopeOf(resourceId) } });
  const latest = await store.getLatestVersion(id);
  if (!latest) throw new Error("MCP version is missing");
  await store.update({ id, activeVersionId: latest.id, status: "published" });
  await closeMcpConnections(resourceId);
  // Version history may still refer to older credentials; remove secrets only when deleting a connection.
  return connectionsOf(await ownedClient(id, resourceId)).find((entry) => entry.serverName === serverName)!;
}

export async function deleteMcpServer(id: string, resourceId?: string): Promise<void> {
  const server = (await getMcpConfig(resourceId)).servers.find((entry) => entry.id === id);
  if (!server?.clientId || !server.serverName) throw workError("MCP_SERVER_NOT_FOUND");
  if (server.builtin) throw workError("MCP_CONFIG_INVALID", { text: "Built-in connections can be disabled, not deleted" });
  const current = await ownedClient(server.clientId, resourceId);
  const store = await mcpStore();
  const { [server.serverName]: _removed, ...servers } = current.servers;
  if (Object.keys(servers).length === 0) await store.delete(current.id);
  else {
    const options = connectionOptions(current);
    delete options[server.serverName];
    const updated = await store.update({ id: current.id, metadata: { ...current.metadata, [OPTIONS_KEY]: options } });
    await handleAutoVersioning(store, current.id, "mcpClientId", MCP_CLIENT_SNAPSHOT_CONFIG_FIELDS, current, updated, { servers });
    const latest = await store.getLatestVersion(current.id);
    if (latest) await store.update({ id: current.id, activeVersionId: latest.id });
  }
  await closeMcpConnections(resourceId);
  await deleteOAuthCredentials(server.id, resourceId);
}

/** Initialize built-ins for native Studio reads and invalidate live clients after its writes. */
export async function mcpManagementMiddleware(c: ContextWithMastra, next: () => Promise<void>) {
  const resourceId = c.get("requestContext").get(MASTRA_RESOURCE_ID_KEY) as string | undefined;
  if (!resourceId) throw workError("AUTH_REQUIRED");
  await ensureAnysearchConnection(resourceId);
  await next();
  if (c.res.ok && !["GET", "HEAD"].includes(c.req.method)) await closeMcpConnections(resourceId);
}

export function summarizeMcpServer(server: McpServerConfig): McpServerSummary {
  return {
    ...server,
    headerKeys: server.headerKeys ?? [],
    envKeys: server.envKeys ?? [],
  };
}

class AppOAuthStorage implements OAuthStorage {
  constructor(
    private readonly prefix: string,
    private readonly resourceId?: string,
  ) {}
  private async refs(): Promise<Record<string, string>> {
    const raw = await getAppConfig(this.prefix, this.resourceId);
    if (!raw) return {};
    try {
      return z.record(z.string(), z.string()).parse(JSON.parse(raw));
    } catch {
      return {};
    }
  }
  async set(key: string, value: string) {
    const refs = await this.refs();
    const purpose = oauthCredentialPurpose(this.prefix.slice("mcp:oauth:".length), key);
    const credential = await storeCredential(value, purpose, refs[key]);
    await setAppConfig(
      this.prefix,
      JSON.stringify({ ...refs, [key]: credential.credentialRef }),
      this.resourceId,
    );
  }
  async get(key: string) {
    const secretRef = (await this.refs())[key];
    return secretRef
      ? resolveCredential(
          secretRef,
          oauthCredentialPurpose(this.prefix.slice("mcp:oauth:".length), key),
        )
      : undefined;
  }
  async delete(key: string) {
    const refs = await this.refs();
    const secretRef = refs[key];
    if (secretRef) {
      await deleteCredential(
        secretRef,
        oauthCredentialPurpose(this.prefix.slice("mcp:oauth:".length), key),
      );
    }
    delete refs[key];
    if (Object.keys(refs).length > 0) {
      await setAppConfig(this.prefix, JSON.stringify(refs), this.resourceId);
    } else {
      await deleteAppConfig(this.prefix, this.resourceId);
    }
  }
}

async function deleteOAuthCredentials(serverId: string, resourceId?: string): Promise<void> {
  const configKey = `mcp:oauth:${serverId}`;
  const raw = await getAppConfig(configKey, resourceId);
  if (!raw) return;
  const refs = z.record(z.string(), z.string()).parse(JSON.parse(raw));
  await Promise.all(
    Object.entries(refs).map(([key, secretRef]) =>
      deleteCredential(secretRef, oauthCredentialPurpose(serverId, key)),
    ),
  );
  await deleteAppConfig(configKey, resourceId);
}

async function oauthProvider(
  server: McpServerConfig,
  resourceId?: string,
): Promise<MCPOAuthClientProvider | undefined> {
  if (server.transport !== "http" || !server.oauth?.enabled) return undefined;
  const clientId = server.oauth.clientId;
  if (!clientId) throw new Error("启用 OAuth 必须填写已注册的 Client ID");
  const redirectUrl = server.oauth.redirectUrl ?? "http://127.0.0.1:4112/oauth/callback";
  const redirectUris = getCallbackUrlCandidates(redirectUrl).map((url) => url.toString());
  return new MCPOAuthClientProvider({
    redirectUrl,
    clientMetadata: {
      redirect_uris: redirectUris,
      client_name: server.oauth.clientName ?? "MastraWork",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      ...(server.oauth.scopes?.length ? { scope: server.oauth.scopes.join(" ") } : {}),
    },
    clientInformation: {
      client_id: clientId,
      ...(server.oauth.clientSecretCredential
        ? {
            client_secret: await resolveCredential(
              server.oauth.clientSecretCredential.credentialRef,
              mcpCredentialPurpose(server.id, "client-secret"),
            ),
          }
        : {}),
    },
    storage: new AppOAuthStorage(`mcp:oauth:${server.id}`, resourceId),
    onRedirectToAuthorization: async (url) => {
      getRuntime(resourceId).redirects.get(server.id)?.resolve(url.toString());
    },
  });
}

const secretRecordSchema = z.record(z.string().min(1), z.string());

async function resolveSecretRecord(
  credential: CredentialPointer | undefined,
  purpose: string,
): Promise<Record<string, string>> {
  if (!credential) return {};
  return secretRecordSchema.parse(
    JSON.parse(await resolveCredential(credential.credentialRef, purpose)),
  );
}

async function toDefinition(
  server: McpServerConfig,
  resourceId?: string,
): Promise<MastraMCPServerDefinition> {
  if (server.transport === "http") {
    const headers = await resolveSecretRecord(
      server.headerCredential,
      mcpCredentialPurpose(server.id, "headers"),
    );
    if (!server.url) throw new Error(`MCP 服务 ${server.id} 缺少 URL`);
    const authProvider = await oauthProvider(server, resourceId);
    return {
      url: new URL(server.url),
      allowedHosts: server.allowedHosts,
      requestInit: { headers: { ...(server.builtin === "anysearch" ? { "X-Anysearch-Client": "mastra-desktop/1.0" } : {}), ...headers } },
      timeout: server.timeout,
      onToolError: "throw",
      ...(authProvider ? { authProvider } : {}),
      requireToolApproval: server.requireToolApproval,
    };
  }
  if (!server.command) throw new Error(`MCP 服务 ${server.id} 缺少启动命令`);
  const env = await resolveSecretRecord(
    server.envCredential,
    mcpCredentialPurpose(server.id, "env"),
  );
  return {
    command: server.command,
    args: server.args,
    env: { ...(server.clientId && server.serverName ? (await ownedClient(server.clientId, resourceId)).servers[server.serverName]?.env : {}), ...env },
    timeout: server.timeout,
    onToolError: "throw",
    requireToolApproval: server.requireToolApproval,
    ...(server.inheritDefaultEnv === false ? { inheritDefaultEnv: false } : {}),
  };
}

async function createClient(servers: McpServerConfig[], resourceId?: string): Promise<MCPClient> {
  const definitions = await Promise.all(
    servers.map(
      async (server) => [server.serverName ?? `mcp_${server.id}`, await toDefinition(server, resourceId)] as const,
    ),
  );
  return new MCPClient({
    id: `mastra-work-configured-mcp-${randomUUID()}`,
    timeout: 30_000,
    servers: Object.fromEntries(definitions),
  });
}

export async function testMcpServer(server: McpServerConfig, resourceId?: string) {
  const client = await createClient([server], resourceId);
  try {
    const result = await client.listToolsWithErrors();
    const tools = Object.keys(result.tools);
    const error = result.errors[server.serverName ?? `mcp_${server.id}`];
    return { ok: !error, toolCount: tools.length, tools, error };
  } catch (error) {
    throw workError("MCP_CONNECTION_FAILED", {
      text: errorText(error, "连接测试失败"),
      cause: error,
    });
  } finally {
    await client.disconnect().catch(() => undefined);
  }
}

async function getConfiguredMcpClient(server: McpServerConfig, resourceId?: string): Promise<MCPClient> {
  const runtime = getRuntime(resourceId);
  const hash = JSON.stringify(server);
  const previous = runtime.clients.get(server.id);
  if (previous?.hash === hash) return previous.promise;
  const pending = { hash, promise: (async () => {
    await (await previous?.promise.catch(() => undefined))?.disconnect();
    return createClient([server], resourceId);
  })() };
  runtime.clients.set(server.id, pending);
  try { return await pending.promise; }
  catch (error) { if (runtime.clients.get(server.id) === pending) runtime.clients.delete(server.id); throw error; }
}

export async function closeMcpConnections(resourceId?: string): Promise<void> {
  const scopes = resourceId === undefined ? [...runtimeByScope.values()] : [getRuntime(resourceId)];
  const pending = scopes.flatMap((scope) => {
    const clients = [...scope.clients.values()];
    scope.clients.clear(); scope.redirects.clear();
    return clients.map(async ({ promise }) => (await promise.catch(() => undefined))?.disconnect());
  });
  await Promise.all(pending);
}

export async function getConfiguredMcpTools(resourceId?: string, builtin?: "anysearch"): Promise<ToolsInput> {
  const config = await getMcpConfig(resourceId);
  const selected = config.servers.filter((server) => server.enabled && server.builtin === builtin);
  const toolsets = await Promise.all(selected.map(async (server) => {
    const client = await getConfiguredMcpClient(server, resourceId);
    const { tools, errors } = await client.listToolsWithErrors();
    if (Object.keys(errors).length) throw workError("MCP_CONNECTION_FAILED", { text: `${server.name}: ${Object.values(errors).join("; ")}` });
    if (!server.tools) return tools;
    const prefix = `${server.serverName}_`;
    return Object.fromEntries(Object.entries(tools).filter(([name]) => Object.hasOwn(server.tools ?? {}, name.slice(prefix.length))));
  }));
  return Object.assign({}, ...toolsets);
}

/** Start the official MCPClient loopback OAuth flow and expose its redirect URL. */
export async function authenticateMcpServer(
  serverId: string,
  resourceId?: string,
): Promise<{ authorizationUrl?: string; authenticated: boolean }> {
  const config = await getMcpConfig(resourceId);
  const server = config.servers.find((item) => item.id === serverId);
  if (!server) throw workError("MCP_SERVER_NOT_FOUND");
  if (!server.oauth?.enabled)
    throw workError("MCP_CONFIG_INVALID", { text: `MCP 服务 ${serverId} 未启用 OAuth` });
  const runtime = getRuntime(resourceId);
  if (!server.enabled)
    throw workError("MCP_CONFIG_INVALID", { text: `MCP 服务 ${serverId} 未启用` });
  const client = await getConfiguredMcpClient(server, resourceId);
  if (!client) throw workError("MCP_CONFIG_INVALID", { text: "没有启用的 MCP 服务" });
  let redirect = runtime.redirects.get(serverId);
  if (!redirect || redirect.client !== client) {
    let resolveUrl!: (url: string) => void;
    const url = new Promise<string>((resolve) => {
      resolveUrl = resolve;
    });
    redirect = { client, url, resolve: resolveUrl };
    runtime.redirects.set(serverId, redirect);
  }
  // SDK owns the per-server authentication task; this map only delivers its browser URL.
  const authentication = client.authenticate(server.serverName ?? `mcp_${serverId}`).catch((error: unknown) => {
    throw workError("MCP_CONNECTION_FAILED", {
      text: errorText(error, "MCP OAuth 授权失败"),
      cause: error,
    });
  });
  const clearRedirect = () => {
    if (runtime.redirects.get(serverId) === redirect) runtime.redirects.delete(serverId);
  };
  void authentication.then(clearRedirect, clearRedirect);
  return await Promise.race([
    redirect.url.then((authorizationUrl) => ({
      authorizationUrl,
      authenticated: false,
    })),
    authentication.then(() => ({ authenticated: true })),
  ]);
}
