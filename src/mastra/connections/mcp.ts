/**
 * MCP (Model Context Protocol) 连接模块。
 * 官方文档:docs/en/docs/connections/mcp.mdx(传输 / 工具审批 / 安全)、
 * docs/en/reference/tools/mcp-client.mdx(MCPClient API)。
 * HTTP/stdio 连接统一使用官方 mcpClients 版本化存储，Studio 与桌面读取同一份配置。
 * 凭据仅存主进程凭据库；运行时通过官方 MCPClient 应用请求头、OAuth 和审批策略。
 */
import { createHash, randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import type { ToolsInput } from "@mastra/core/agent";
import { type AnySpan, resolveCurrentSpan, SpanType } from "@mastra/core/observability";
import { MASTRA_RESOURCE_ID_KEY } from "@mastra/core/request-context";
import type { ContextWithMastra } from "@mastra/core/server";
import type { StorageMCPServerConfig, StorageResolvedMCPClientType } from "@mastra/core/storage";
import {
  getCallbackUrlCandidates,
  type MastraMCPServerDefinition,
  MCPClient,
  MCPOAuthClientProvider,
  type OAuthStorage,
} from "@mastra/mcp";
import {
  handleAutoVersioning,
  MCP_CLIENT_SNAPSHOT_CONFIG_FIELDS,
} from "@mastra/server/handlers/version-helpers";
import { z } from "zod";
import {
  type CredentialPointer,
  CredentialPointerSchema,
  mcpCredentialPurpose,
} from "../../shared/credential-contract";
import type { InstalledPlugin } from "../../shared/plugin-contract";
import {
  deleteCredential,
  oauthCredentialPurpose,
  resolveCredential,
  storeCredential,
} from "../credential-broker";
import { errorText, workError } from "../errors";
import { withinRoot } from "../plugins/packages";
import {
  getInstalledPlugin,
  listInstalledPlugins,
  pluginComponentEnabled,
  pluginsDirectory,
  pluginVersionDirectory,
  resolvePluginConfiguration,
  withPluginOperation,
} from "../plugins/registry";
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
    plugin: z
      .object({
        id: z.string(),
        componentId: z.string(),
        digest: z.string(),
        configurationRevision: z.string().optional(),
      })
      .strict()
      .optional(),
    status: z.enum(["draft", "published", "archived"]).optional(),
    version: z.string().optional(),
    timeout: z.number().int().positive().optional(),
    tools: z.record(z.string(), z.object({ description: z.string().optional() })).optional(),
    enabled: z.boolean().default(true),
    transport: z.enum(["http", "stdio"]),
    url: z.string().min(1).optional(),
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
    if (
      server.url &&
      !(server.plugin && /\$\{[^}]+\}/.test(server.url)) &&
      !z.url({ protocol: /^https?$/ }).safeParse(server.url).success
    )
      context.addIssue({ code: "custom", path: ["url"], message: "Invalid HTTP MCP URL" });
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
  configurationError?: string;
  configurationKeys?: string[];
  connectionError?: string;
  toolCount?: number;
  headerKeys: string[];
  envKeys: string[];
}

const ANYSEARCH_MCP_URL = "https://api.anysearch.com/mcp";
const OWNER_KEY = "mastra_resource_id";
const OPTIONS_KEY = "desktopMcp";
const scopeOf = (resourceId?: string) => resourceId?.trim() || "__system__";
const toolNamespace = (server: McpServerConfig) =>
  server.builtin === "anysearch" ? "anysearch" : `mcp_${server.id}`;
const stableId = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 24);

interface McpRuntime {
  clients: Map<
    string,
    {
      hash: string;
      promise: Promise<MCPClient>;
      error?: string;
      toolCount?: number;
      discovery?: ReturnType<MCPClient["listToolsWithErrors"]>;
      retryAfter?: number;
    }
  >;
  redirects: Map<
    string,
    { client: MCPClient; url: Promise<string>; resolve: (url: string) => void }
  >;
}
const runtimeByScope = new Map<string, McpRuntime>();
// Dynamic tools are resolved repeatedly within one run; refresh discovery on the next run.
const discoveriesByRun = new WeakMap<
  AnySpan,
  WeakMap<MCPClient, ReturnType<MCPClient["listToolsWithErrors"]>>
>();
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
function connectionOptions(
  client: StorageResolvedMCPClientType,
): Record<string, Partial<McpServerConfig>> {
  return z
    .record(z.string(), z.record(z.string(), z.unknown()))
    .parse(client.metadata?.[OPTIONS_KEY] ?? {});
}
function connectionsOf(client: StorageResolvedMCPClientType): McpServerConfig[] {
  const options = connectionOptions(client);
  return Object.entries(client.servers).map(([serverName, server]) =>
    mcpServerConfigSchema.parse({
      ...options[serverName],
      id: options[serverName]?.id ?? stableId(JSON.stringify([client.id, serverName])),
      builtin:
        client.id === `anysearch-${stableId(String(client.metadata?.[OWNER_KEY]))}` &&
        serverName === "anysearch"
          ? "anysearch"
          : undefined,
      clientId: client.id,
      serverName,
      name:
        Object.keys(client.servers).length === 1
          ? client.name
          : (options[serverName]?.name ?? serverName),
      status: client.status,
      version: `${client.resolvedVersionId}:${client.updatedAt.toISOString()}`,
      enabled:
        client.status === "published" &&
        (Object.keys(client.servers).length === 1 || options[serverName]?.enabled !== false),
      transport: server.type,
      url: server.url,
      command: server.command,
      args: server.args,
      timeout: server.timeout,
      tools: server.tools,
      envKeys: [
        ...new Set([...Object.keys(server.env ?? {}), ...(options[serverName]?.envKeys ?? [])]),
      ],
    }),
  );
}
async function ownedClient(id: string, resourceId?: string): Promise<StorageResolvedMCPClientType> {
  const client = await (await mcpStore()).getByIdResolved(id);
  if (!client || client.metadata?.[OWNER_KEY] !== scopeOf(resourceId))
    throw workError("MCP_SERVER_NOT_FOUND");
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
      await store.create({
        mcpClient: {
          id,
          name: "AnySearch",
          authorId: scope,
          description:
            "Built-in web search connection. Choose search depth in the composer; manage credentials here.",
          servers: { anysearch: { type: "http", url: ANYSEARCH_MCP_URL } },
          metadata: {
            [OWNER_KEY]: scope,
            [OPTIONS_KEY]: {
              anysearch: {
                id,
                builtin: "anysearch",
                enabled: true,
                requireToolApproval: false,
                allowedHosts: ["api.anysearch.com"],
              },
            },
          },
        },
      });
      const version = await store.getLatestVersion(id);
      if (!version) throw new Error("MCP initial version was not created");
      await store.update({ id, activeVersionId: version.id, status: "published" });
    })().finally(() => preparingAnysearch.delete(scope));
    preparingAnysearch.set(scope, pending);
  }
  await pending;
}

/** The same official storage domain is used by Studio's MCP Clients and the desktop manager. */
async function storedMcpServers(resourceId?: string): Promise<McpServerConfig[]> {
  await ensureAnysearchConnection(resourceId);
  const store = await mcpStore();
  const pages = await Promise.all(
    (["published", "draft", "archived"] as const).map((status) =>
      store.listResolved({
        perPage: false,
        metadata: { [OWNER_KEY]: scopeOf(resourceId) },
        status,
      }),
    ),
  );
  return pages.flatMap((page) => page.mcpClients.flatMap(connectionsOf));
}

export async function getMcpConfig(resourceId?: string): Promise<McpConfig> {
  const plugins = new Map(
    (resourceId ? await listInstalledPlugins(resourceId) : []).map((plugin) => [plugin.id, plugin]),
  );
  const servers = await storedMcpServers(resourceId);
  return {
    servers: servers.map((server) => {
      if (!server.plugin) return server;
      const plugin = plugins.get(server.plugin.id);
      const component = plugin?.current.components.find(
        (item) => item.id === server.plugin?.componentId,
      );
      return {
        ...server,
        enabled:
          server.enabled &&
          !!plugin &&
          !!component &&
          plugin.current.digest === server.plugin.digest &&
          plugin.configuration?.revision === server.plugin.configurationRevision &&
          pluginComponentEnabled(plugin, component),
      };
    }),
  };
}

/** Update one connection without replacing another client's configuration or losing sibling servers. */
export async function saveMcpServer(
  input: McpServerConfig,
  resourceId?: string,
  managedPlugin = false,
): Promise<McpServerConfig> {
  return input.plugin && resourceId && !managedPlugin
    ? withPluginOperation(resourceId, input.plugin.id, () =>
        saveMcpServerRecord(input, resourceId, false),
      )
    : saveMcpServerRecord(input, resourceId, managedPlugin);
}

async function saveMcpServerRecord(
  input: McpServerConfig,
  resourceId: string | undefined,
  managedPlugin: boolean,
): Promise<McpServerConfig> {
  const server = mcpServerConfigSchema.parse(input);
  const store = await mcpStore();
  const current = server.clientId ? await ownedClient(server.clientId, resourceId) : undefined;
  if (!current && (await storedMcpServers(resourceId)).some((entry) => entry.id === server.id))
    throw workError("MCP_CONFIG_INVALID", { text: "MCP connection ID already exists" });
  const rawOptions = current ? connectionOptions(current) : {};
  const options = current
    ? Object.fromEntries(
        connectionsOf(current).map((entry) => [
          entry.serverName ?? "",
          {
            ...rawOptions[entry.serverName ?? ""],
            id: entry.id,
            enabled: entry.enabled,
          },
        ]),
      )
    : {};
  const serverName = server.serverName ?? `mcp_${server.id}`;
  if (current && !current.servers[serverName]) throw workError("MCP_SERVER_NOT_FOUND");
  const previous = options[serverName];
  if (!managedPlugin) {
    if (JSON.stringify(server.plugin) !== JSON.stringify(previous?.plugin))
      throw workError("MCP_CONFIG_INVALID", {
        text: "Plugin ownership is managed by the plugin installer",
      });
    if (previous?.plugin && current) {
      const plugin = resourceId
        ? await getInstalledPlugin(previous.plugin.id, resourceId)
        : undefined;
      if (
        !plugin ||
        plugin.current.digest !== previous.plugin.digest ||
        !plugin.current.components.some((component) => component.id === server.id)
      )
        throw workError("MCP_CONFIG_INVALID", {
          text: "Plugin component changed or was removed; reopen its configuration",
        });
      const definition = current.servers[serverName];
      const component = plugin.current.components.find((item) => item.id === server.id);
      if (
        server.transport !== definition.type ||
        server.url !== definition.url ||
        server.command !== definition.command ||
        server.enabled !==
          (previous.enabled && !!component && pluginComponentEnabled(plugin, component)) ||
        server.name !== current.name ||
        JSON.stringify(server.args ?? []) !== JSON.stringify(definition.args ?? [])
      )
        throw workError("MCP_CONFIG_INVALID", {
          text: "Edit plugin connection credentials here; package definitions are immutable",
        });
      server.enabled = previous.enabled;
    }
  }
  const currentEntry = current
    ? connectionsOf(current).find((entry) => entry.serverName === serverName)
    : undefined;
  if (currentEntry && server.version && server.version !== currentEntry.version)
    throw workError("MCP_CONFIG_INVALID", {
      text: "MCP configuration changed; reload it before saving",
    });
  if (currentEntry?.builtin === "anysearch") {
    server.builtin = "anysearch";
    if (
      server.transport !== "http" ||
      server.url !== ANYSEARCH_MCP_URL ||
      serverName !== "anysearch" ||
      server.oauth?.enabled
    )
      throw workError("MCP_CONFIG_INVALID", {
        text: "AnySearch uses its built-in HTTP endpoint and API key authentication",
      });
    server.allowedHosts = ["api.anysearch.com"];
  } else if (server.builtin)
    throw workError("MCP_CONFIG_INVALID", {
      text: "Built-in identity is managed by the application",
    });
  if (currentEntry && currentEntry.id !== server.id)
    throw workError("MCP_CONFIG_INVALID", { text: "MCP connection ID cannot change" });
  // Plugin configuration patches retain keys that were not edited in the credentials form.
  if (currentEntry?.plugin && !managedPlugin) {
    for (const field of ["headers", "env"] as const) {
      const pointerKey = field === "headers" ? "headerCredential" : "envCredential";
      const keysKey = field === "headers" ? "headerKeys" : "envKeys";
      const before = currentEntry[pointerKey];
      const next = server[pointerKey];
      if (!before || !next || before.credentialRef === next.credentialRef) continue;
      const purpose = mcpCredentialPurpose(server.id, field);
      const merged = {
        ...(await resolveSecretRecord(before, purpose)),
        ...(await resolveSecretRecord(next, purpose)),
      };
      server[pointerKey] = await storeCredential(
        JSON.stringify(merged),
        purpose,
        next.credentialRef,
      );
      server[keysKey] = Object.keys(merged);
    }
  }
  await Promise.all([
    resolveSecretRecord(server.headerCredential, mcpCredentialPurpose(server.id, "headers")),
    resolveSecretRecord(server.envCredential, mcpCredentialPurpose(server.id, "env")),
    server.oauth?.clientSecretCredential
      ? resolveCredential(
          server.oauth.clientSecretCredential.credentialRef,
          mcpCredentialPurpose(server.id, "client-secret"),
        )
      : undefined,
  ]);
  const id = current?.id ?? randomUUID();
  const definition: StorageMCPServerConfig = {
    type: server.transport,
    ...(server.transport === "http"
      ? { url: server.url }
      : { command: server.command, args: server.args, env: current?.servers[serverName]?.env }),
    timeout: server.timeout,
    tools: server.tools,
  };
  const {
    clientId: _clientId,
    serverName: _serverName,
    version: _version,
    status: _status,
    transport: _transport,
    url: _url,
    command: _command,
    args: _args,
    timeout: _timeout,
    tools: _tools,
    ...security
  } = server;
  const metadata = {
    ...current?.metadata,
    [OWNER_KEY]: scopeOf(resourceId),
    [OPTIONS_KEY]: { ...options, [serverName]: security },
  };
  const snapshot = {
    name: current && Object.keys(current.servers).length > 1 ? current.name : server.name,
    description: current?.description,
    servers: { ...current?.servers, [serverName]: definition },
  };
  if (current) {
    const updated = await store.update({ id, metadata });
    await handleAutoVersioning(
      store as unknown as Parameters<typeof handleAutoVersioning>[0],
      id,
      "mcpClientId",
      MCP_CLIENT_SNAPSHOT_CONFIG_FIELDS,
      current,
      updated,
      snapshot,
    );
  } else
    await store.create({ mcpClient: { id, ...snapshot, metadata, authorId: scopeOf(resourceId) } });
  const latest = await store.getLatestVersion(id);
  if (!latest) throw new Error("MCP version is missing");
  const enabled =
    Object.keys(snapshot.servers).length === 1
      ? server.enabled
      : Object.values({ ...options, [serverName]: security }).some(
          (entry) => entry.enabled !== false,
        );
  await store.update({
    id,
    activeVersionId: latest.id,
    status: enabled ? "published" : "archived",
  });
  await closeMcpConnections(resourceId);
  await deleteReplacedCredentials(currentEntry, server, resourceId);
  const saved = connectionsOf(await ownedClient(id, resourceId)).find(
    (entry) => entry.serverName === serverName,
  );
  if (!saved) throw new Error("Saved MCP connection is missing");
  return saved;
}

async function deleteReplacedCredentials(
  previous?: Partial<McpServerConfig>,
  next?: McpServerConfig,
  resourceId?: string,
) {
  if (!previous?.id) return;
  const stale: Promise<void>[] = [];
  for (const kind of ["headers", "env", "client-secret"] as const) {
    const oldPointer =
      kind === "headers"
        ? previous.headerCredential
        : kind === "env"
          ? previous.envCredential
          : previous.oauth?.clientSecretCredential;
    const pointer =
      kind === "headers"
        ? next?.headerCredential
        : kind === "env"
          ? next?.envCredential
          : next?.oauth?.clientSecretCredential;
    if (oldPointer && oldPointer.credentialRef !== pointer?.credentialRef)
      stale.push(
        deleteCredential(oldPointer.credentialRef, mcpCredentialPurpose(previous.id, kind)),
      );
  }
  await Promise.all(stale.map((operation) => operation.catch(() => undefined)));
  if (
    !next ||
    previous.transport !== next.transport ||
    previous.url !== next.url ||
    JSON.stringify(previous.oauth) !== JSON.stringify(next.oauth)
  )
    await deleteOAuthCredentials(previous.id, resourceId);
}

export async function deleteMcpServer(
  id: string,
  resourceId?: string,
  managedPlugin = false,
  keepCredentials = false,
): Promise<void> {
  const server = (await storedMcpServers(resourceId)).find((entry) => entry.id === id);
  if (!server?.clientId || !server.serverName) throw workError("MCP_SERVER_NOT_FOUND");
  if (server.plugin && !managedPlugin)
    throw workError("MCP_CONFIG_INVALID", {
      text: "Remove plugin components through the plugin manager",
    });
  if (server.builtin)
    throw workError("MCP_CONFIG_INVALID", {
      text: "Built-in connections can be disabled, not deleted",
    });
  const current = await ownedClient(server.clientId, resourceId);
  const store = await mcpStore();
  const { [server.serverName]: _removed, ...servers } = current.servers;
  if (Object.keys(servers).length === 0) await store.delete(current.id);
  else {
    const options = connectionOptions(current);
    delete options[server.serverName];
    const updated = await store.update({
      id: current.id,
      metadata: { ...current.metadata, [OPTIONS_KEY]: options },
    });
    await handleAutoVersioning(
      store as unknown as Parameters<typeof handleAutoVersioning>[0],
      current.id,
      "mcpClientId",
      MCP_CLIENT_SNAPSHOT_CONFIG_FIELDS,
      current,
      updated,
      { servers },
    );
    const latest = await store.getLatestVersion(current.id);
    if (latest && current.status !== "draft")
      await store.update({
        id: current.id,
        activeVersionId: latest.id,
        status:
          current.status === "published" &&
          !Object.keys(servers).some((name) => options[name]?.enabled !== false)
            ? "archived"
            : current.status,
      });
  }
  await closeMcpConnections(resourceId);
  if (!keepCredentials) await deleteReplacedCredentials(server, undefined, resourceId);
}

/** Initialize built-ins for native Studio reads and invalidate live clients after its writes. */
export async function mcpManagementMiddleware(c: ContextWithMastra, next: () => Promise<void>) {
  const resourceId = c.get("requestContext").get(MASTRA_RESOURCE_ID_KEY) as string | undefined;
  if (!resourceId) throw workError("AUTH_REQUIRED");
  await ensureAnysearchConnection(resourceId);
  const path = c.req.path;
  const id = path.match(/^\/api\/stored\/mcp-clients\/([^/]+)/)?.[1];
  if (id === `anysearch-${stableId(scopeOf(resourceId))}`) {
    if (c.req.method === "DELETE" && path.endsWith(id))
      throw workError("MCP_CONFIG_INVALID", {
        text: "Built-in connections can be archived, not deleted",
      });
    if (c.req.method === "PATCH") {
      const body = (await c.req.raw.clone().json()) as {
        servers?: Record<string, StorageMCPServerConfig>;
      };
      if (
        body.servers &&
        (Object.keys(body.servers).length !== 1 ||
          body.servers.anysearch?.type !== "http" ||
          body.servers.anysearch?.url !== ANYSEARCH_MCP_URL)
      )
        throw workError("MCP_CONFIG_INVALID", {
          text: "The built-in AnySearch endpoint cannot be replaced",
        });
    }
  }
  const mutation = !["GET", "HEAD"].includes(c.req.method);
  const previous = mutation && id ? await (await mcpStore()).getByIdResolved(id) : null;
  if (previous && connectionsOf(previous).some((server) => server.plugin))
    throw workError("MCP_CONFIG_INVALID", {
      text: "Manage plugin-owned connections through the plugin manager",
    });
  if (mutation && c.req.header("content-type")?.includes("application/json")) {
    const body = await c.req.raw
      .clone()
      .json()
      .catch(() => undefined);
    const metadata =
      body && typeof body === "object" && "metadata" in body ? body.metadata : undefined;
    const options =
      metadata && typeof metadata === "object" && OPTIONS_KEY in metadata
        ? metadata[OPTIONS_KEY]
        : undefined;
    if (
      options &&
      typeof options === "object" &&
      Object.values(options).some(
        (entry) => entry && typeof entry === "object" && "plugin" in entry,
      )
    )
      throw workError("MCP_CONFIG_INVALID", {
        text: "Plugin ownership can only be assigned by the plugin installer",
      });
  }
  await next();
  if (c.res.ok && mutation) {
    c.get("mastra").getEditor()?.mcp.clearCache(id);
    await closeMcpConnections(resourceId);
    if (previous?.metadata?.[OWNER_KEY] === scopeOf(resourceId)) {
      const updated = await (await mcpStore()).getByIdResolved(previous.id);
      const next = new Map(
        (updated ? connectionsOf(updated) : []).map((server) => [server.id, server]),
      );
      for (const server of connectionsOf(previous)) {
        await deleteReplacedCredentials(server, next.get(server.id), resourceId);
      }
    }
  }
}

export async function summarizeMcpServer(
  server: McpServerConfig,
  resourceId?: string,
): Promise<McpServerSummary> {
  const runtime = getRuntime(resourceId).clients.get(server.id);
  const plugin =
    server.plugin && resourceId
      ? await getInstalledPlugin(server.plugin.id, resourceId)
      : undefined;
  const component = plugin?.current.components.find(
    (item) => item.id === server.plugin?.componentId,
  );
  let configurationError =
    [...(plugin?.configurationErrors ?? []), ...(plugin?.dependencyErrors ?? [])].join("; ") ||
    undefined;
  if (server.enabled && !configurationError) {
    try {
      await toDefinition(server, resourceId);
    } catch (error) {
      configurationError = errorText(error, "Invalid plugin configuration");
    }
  }
  return {
    configurationError,
    configurationKeys: component?.configurationKeys,
    ...(runtime?.hash === JSON.stringify(server)
      ? { connectionError: runtime.error, toolCount: runtime.toolCount }
      : {}),
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
  preparedPlugin?: InstalledPlugin,
): Promise<MastraMCPServerDefinition> {
  const plugin =
    preparedPlugin ??
    (server.plugin && resourceId
      ? await getInstalledPlugin(server.plugin.id, resourceId)
      : undefined);
  const component = plugin?.current.components.find(
    (item) => item.id === server.plugin?.componentId,
  );
  if (
    server.plugin &&
    (!plugin ||
      !component ||
      !pluginComponentEnabled(plugin, component) ||
      plugin.configuration?.revision !== server.plugin.configurationRevision ||
      plugin.current.digest !== server.plugin.digest)
  )
    throw workError("MCP_CONFIG_INVALID", {
      text:
        plugin?.configurationErrors?.join("; ") ||
        plugin?.dependencyErrors?.join("; ") ||
        "Plugin component is disabled or no longer installed",
    });
  const env = await resolveSecretRecord(
    server.envCredential,
    mcpCredentialPurpose(server.id, "env"),
  );
  const options = plugin ? await resolvePluginConfiguration(plugin) : {};
  const root =
    plugin && resourceId ? join(pluginVersionDirectory(plugin, resourceId), "source") : undefined;
  const data =
    plugin && resourceId ? join(pluginsDirectory(resourceId), plugin.id, "data") : undefined;
  const expand = (value: string) =>
    value.replace(/\$\{([^}]+)\}/g, (match, key: string) => {
      if (
        (key === "PLUGIN_ROOT" ||
          (plugin?.current.format !== "portable" && key === "CLAUDE_PLUGIN_ROOT")) &&
        root
      )
        return root;
      if (
        (key === "PLUGIN_DATA" ||
          (plugin?.current.format !== "portable" && key === "CLAUDE_PLUGIN_DATA")) &&
        data
      )
        return data;
      if (plugin?.current.format === "portable") return match;
      if (key.startsWith("user_config.")) {
        const name = key.slice("user_config.".length);
        if (!plugin?.current.userConfig?.[name])
          throw workError("MCP_CONFIG_INVALID", { text: `Undeclared plugin option: ${name}` });
        const value = options[name] ?? "";
        return Array.isArray(value) ? JSON.stringify(value) : String(value);
      }
      const [name, fallback] = key.split(":-", 2);
      const value =
        env[name] ??
        (server.inheritDefaultEnv !== false ? process.env[name] : undefined) ??
        fallback;
      if (value !== undefined) return value;
      throw workError("MCP_CONFIG_INVALID", { text: `Missing plugin configuration: ${name}` });
    });
  if (
    server.builtin === "anysearch" &&
    (server.transport !== "http" || server.url !== ANYSEARCH_MCP_URL)
  )
    throw workError("MCP_CONFIG_INVALID", {
      text: "The built-in AnySearch endpoint cannot be replaced",
    });
  if (server.transport === "http") {
    const headers = await resolveSecretRecord(
      server.headerCredential,
      mcpCredentialPurpose(server.id, "headers"),
    );
    if (!server.url) throw new Error(`MCP 服务 ${server.id} 缺少 URL`);
    const authProvider = await oauthProvider(server, resourceId);
    const secretHeaders = new Headers(headers);
    const requestHeaders = new Headers();
    for (const [key, value] of Object.entries(component?.mcp?.headers ?? {}))
      requestHeaders.set(
        key,
        plugin?.current.format !== "portable" && !secretHeaders.has(key) ? expand(value) : value,
      );
    if (server.builtin === "anysearch")
      requestHeaders.set("X-Anysearch-Client", "mastra-desktop/1.0");
    secretHeaders.forEach((value, key) => {
      requestHeaders.set(key, value);
    });
    return {
      url: (() => {
        const value = plugin?.current.format !== "portable" ? expand(server.url) : server.url;
        const parsed = z.url({ protocol: /^https?$/ }).safeParse(value);
        if (!parsed.success)
          throw workError("MCP_CONFIG_INVALID", { text: "Invalid configured MCP URL" });
        return new URL(parsed.data);
      })(),
      allowedHosts: server.allowedHosts,
      requestInit: { headers: requestHeaders },
      timeout: server.timeout,
      connectTimeout: server.timeout ?? 30_000,
      onToolError: "throw",
      ...(authProvider ? { authProvider } : {}),
      requireToolApproval: server.requireToolApproval,
    };
  }
  if (!server.command) throw new Error(`MCP 服务 ${server.id} 缺少启动命令`);
  let cwd: string | undefined;
  let command = server.command;
  if (root) {
    const configured = component?.mcp?.cwd;
    const base =
      configured && /^\$\{(?:CLAUDE_)?PLUGIN_DATA\}/.test(configured) && data ? data : root;
    cwd = await realpath(withinRoot(base, configured ? expand(configured) : root));
    withinRoot(await realpath(base), cwd);
    if (command.startsWith("./")) command = await realpath(withinRoot(root, command));
    else if (plugin?.current.format !== "portable") command = expand(command);
    if (server.command.startsWith("./")) withinRoot(await realpath(root), command);
  }
  return {
    command,
    args: root ? server.args?.map(expand) : server.args,
    cwd,
    env: {
      ...(server.clientId && server.serverName
        ? (await ownedClient(server.clientId, resourceId)).servers[server.serverName]?.env
        : {}),
      ...Object.fromEntries(
        Object.entries(component?.mcp?.env ?? {}).map(([key, value]) => [
          key,
          env[key] ?? expand(value),
        ]),
      ),
      ...env,
      ...(root && data
        ? {
            PLUGIN_ROOT: root,
            PLUGIN_DATA: data,
            CLAUDE_PLUGIN_ROOT: root,
            CLAUDE_PLUGIN_DATA: data,
          }
        : {}),
    },
    timeout: server.timeout,
    onToolError: "throw",
    requireToolApproval: server.requireToolApproval,
    ...(server.inheritDefaultEnv === false ? { inheritDefaultEnv: false } : {}),
  };
}

/** Materialize plugin-owned connections in the same native store as manually configured MCP. */
export async function syncPluginMcp(
  plugin: InstalledPlugin,
  resourceId: string,
  current?: InstalledPlugin,
): Promise<void> {
  const existing = (await storedMcpServers(resourceId)).filter(
    (server) => server.plugin?.id === plugin.id,
  );
  const retainedRaw = await readFile(
    withinRoot(pluginsDirectory(resourceId), `${plugin.id}/configuration.json`),
    "utf8",
  ).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  const retained = retainedRaw ? z.array(mcpServerConfigSchema).parse(JSON.parse(retainedRaw)) : [];
  const active = new Set<string>();
  const next: McpServerConfig[] = [];
  for (const component of plugin.current.components) {
    if (component.kind !== "mcp" || !component.supported || !component.mcp) continue;
    active.add(component.id);
    const previous =
      existing.find((server) => server.plugin?.componentId === component.id) ??
      retained.find((server) => server.plugin?.componentId === component.id);
    const definition = component.mcp;
    next.push(
      mcpServerConfigSchema.parse({
        ...previous,
        id: component.id,
        name: `${plugin.current.name}:${component.name}`,
        plugin: {
          id: plugin.id,
          componentId: component.id,
          digest: plugin.current.digest,
          configurationRevision: plugin.configuration?.revision,
        },
        transport: definition.transport,
        command: definition.command,
        args: definition.args,
        url: definition.url,
        allowedHosts:
          previous?.allowedHosts ??
          (definition.url && !/\$\{[^}]+\}/.test(definition.url)
            ? [new URL(definition.url).hostname]
            : undefined),
        enabled: plugin.enabled && plugin.componentEnabled[component.id] !== false,
        requireToolApproval: previous?.requireToolApproval ?? true,
      }),
    );
  }
  // Prepare every enabled connection before publishing any next-version binding.
  if (current && current.current.digest !== plugin.current.digest)
    for (const server of next)
      if (server.enabled) {
        const result = await testMcpServer(server, resourceId, plugin);
        if (!result.ok)
          throw workError("MCP_CONNECTION_FAILED", {
            text: `Update connection failed: ${server.name}`,
          });
      }
  for (const server of next) await saveMcpServer(server, resourceId, true);
  for (const server of existing)
    if (server.plugin && !active.has(server.plugin.componentId))
      await saveMcpServer({ ...server, enabled: false }, resourceId, true);
}

export async function removePluginMcp(
  pluginId: string,
  resourceId: string,
  keepCredentials = false,
): Promise<void> {
  for (const server of await storedMcpServers(resourceId))
    if (server.plugin?.id === pluginId)
      await deleteMcpServer(server.id, resourceId, true, keepCredentials);
}

export async function deletePluginMcpCredentials(
  servers: McpServerConfig[],
  resourceId: string,
): Promise<void> {
  for (const server of servers) await deleteReplacedCredentials(server, undefined, resourceId);
}

/** Reconcile native records to the committed install state after an interrupted write. */
export async function recoverPluginMcp(
  plugins: InstalledPlugin[],
  resourceId: string,
): Promise<void> {
  const ids = new Set(plugins.map((plugin) => plugin.id));
  for (const server of await storedMcpServers(resourceId))
    if (server.plugin && !ids.has(server.plugin.id))
      await deleteMcpServer(server.id, resourceId, true, true);
  for (const plugin of plugins) await syncPluginMcp(plugin, resourceId);
}

async function createClient(
  servers: McpServerConfig[],
  resourceId?: string,
  preparedPlugin?: InstalledPlugin,
): Promise<MCPClient> {
  const definitions = await Promise.all(
    servers.map(
      async (server) =>
        [toolNamespace(server), await toDefinition(server, resourceId, preparedPlugin)] as const,
    ),
  );
  return new MCPClient({
    id: `mastra-work-configured-mcp-${randomUUID()}`,
    timeout: 30_000,
    servers: Object.fromEntries(definitions),
  });
}

function discoveryError(
  server: McpServerConfig,
  result: Awaited<ReturnType<MCPClient["listToolsWithErrors"]>>,
): string | undefined {
  const name = toolNamespace(server);
  const error = result.errors[name];
  if (!error) return undefined;
  const detail = result.errorDetails[name];
  if (detail?.httpStatus === 401 || detail?.httpStatus === 403)
    return `MCP 授权失败（HTTP ${detail.httpStatus}），请检查 API Key、请求头或完成 OAuth 授权。`;
  if (server.transport === "stdio" && detail?.code === "CONNECTION_CLOSED")
    return "MCP 进程已退出，请检查启动命令、运行环境及依赖是否安装；具体原因见进程日志。";
  if (detail?.code === "REQUEST_TIMEOUT")
    return "MCP 连接或工具发现超时，请检查服务状态、网络及超时设置后重试。";
  return server.plugin
    ? "Plugin MCP connection failed; check its connection and configuration"
    : error;
}

export async function testMcpServer(
  server: McpServerConfig,
  resourceId?: string,
  preparedPlugin?: InstalledPlugin,
) {
  const client = await createClient([server], resourceId, preparedPlugin);
  try {
    const result = await client.listToolsWithErrors();
    const tools = Object.keys(result.tools);
    const error = discoveryError(server, result);
    const runtime = getRuntime(resourceId).clients.get(server.id);
    if (!error && runtime?.hash === JSON.stringify(server)) {
      runtime.error = undefined;
      runtime.retryAfter = undefined;
      runtime.toolCount = tools.length;
    }
    return {
      ok: !error,
      toolCount: tools.length,
      tools,
      error,
    };
  } catch (error) {
    throw workError("MCP_CONNECTION_FAILED", {
      text: server.plugin
        ? "Plugin MCP connection failed; check its connection and configuration"
        : errorText(error, "连接测试失败"),
      ...(server.plugin ? {} : { cause: error }),
    });
  } finally {
    await client.disconnect().catch(() => undefined);
  }
}

async function getConfiguredMcpClient(
  server: McpServerConfig,
  resourceId?: string,
): Promise<MCPClient> {
  const runtime = getRuntime(resourceId);
  const hash = JSON.stringify(server);
  const previous = runtime.clients.get(server.id);
  if (previous?.hash === hash) return previous.promise;
  const pending = {
    hash,
    promise: (async () => {
      await (await previous?.promise.catch(() => undefined))?.disconnect();
      return createClient([server], resourceId);
    })(),
  };
  runtime.clients.set(server.id, pending);
  try {
    return await pending.promise;
  } catch (error) {
    if (runtime.clients.get(server.id) === pending) runtime.clients.delete(server.id);
    if (server.plugin)
      throw workError("MCP_CONNECTION_FAILED", {
        text: "Plugin MCP connection could not be prepared",
      });
    throw error;
  }
}

export async function closeMcpConnections(resourceId?: string): Promise<void> {
  const scopes = resourceId === undefined ? [...runtimeByScope.values()] : [getRuntime(resourceId)];
  const pending = scopes.flatMap((scope) => {
    const clients = [...scope.clients.values()];
    scope.clients.clear();
    scope.redirects.clear();
    return clients.map(async ({ promise }) => (await promise.catch(() => undefined))?.disconnect());
  });
  await Promise.all(pending);
}

export async function getConfiguredMcpTools(
  resourceId?: string,
  builtin?: "anysearch",
  allowedIds?: string[],
): Promise<ToolsInput> {
  const span = resolveCurrentSpan();
  const run = span?.type === SpanType.AGENT_RUN ? span : span?.findParent(SpanType.AGENT_RUN);
  let discoveries = run?.isValid ? discoveriesByRun.get(run) : undefined;
  if (run?.isValid && !discoveries) {
    discoveries = new WeakMap();
    discoveriesByRun.set(run, discoveries);
  }
  const config = await getMcpConfig(resourceId);
  const selected = config.servers.filter(
    (server) =>
      server.enabled &&
      server.builtin === builtin &&
      (!allowedIds || allowedIds.includes(server.id)),
  );
  const outcomes = await Promise.allSettled(
    selected.map(async (server) => {
      const client = await getConfiguredMcpClient(server, resourceId);
      const runtime = getRuntime(resourceId).clients.get(server.id);
      // Share concurrent discovery and give failed connections 30 seconds before another attempt.
      if (runtime?.retryAfter && runtime.retryAfter > Date.now()) return {};
      const discovery =
        discoveries?.get(client) ?? runtime?.discovery ?? client.listToolsWithErrors();
      if (runtime) runtime.discovery = discovery;
      discoveries?.set(client, discovery);
      try {
        const result = await discovery;
        const { tools } = result;
        const error = discoveryError(server, result);
        if (error)
          throw workError("MCP_CONNECTION_FAILED", {
            text: `${server.name}: ${error}`,
          });
        const prefix = `${toolNamespace(server)}_`;
        const selectedTools = !server.tools
          ? tools
          : Object.fromEntries(
              Object.entries(tools).flatMap(([name, tool]) => {
                const config = server.tools?.[name.slice(prefix.length)];
                return config
                  ? [
                      [
                        name,
                        config.description ? { ...tool, description: config.description } : tool,
                      ],
                    ]
                  : [];
              }),
            );
        if (runtime) {
          runtime.error = undefined;
          runtime.retryAfter = undefined;
          runtime.toolCount = Object.keys(selectedTools).length;
        }
        return Object.fromEntries(
          Object.entries(selectedTools).map(([name, tool]) => {
            const execute = tool.execute;
            const ownership = server.plugin;
            if (!ownership || !execute) return [name, tool];
            return [
              name,
              {
                ...tool,
                execute: async (...args: Parameters<typeof execute>) => {
                  const plugin = resourceId
                    ? await getInstalledPlugin(ownership.id, resourceId)
                    : undefined;
                  const component = plugin?.current.components.find(
                    (item) => item.id === server.plugin?.componentId,
                  );
                  if (
                    !plugin ||
                    !component ||
                    !pluginComponentEnabled(plugin, component) ||
                    plugin.configuration?.revision !== server.plugin?.configurationRevision ||
                    plugin.current.digest !== server.plugin?.digest
                  )
                    throw workError("MCP_CONFIG_INVALID", {
                      text: "Plugin tool is no longer available; refresh the conversation tools",
                    });
                  return execute(...args);
                },
              },
            ];
          }),
        );
      } catch (error) {
        if (discoveries?.get(client) === discovery) discoveries.delete(client);
        const firstFailure = !runtime?.retryAfter || runtime.retryAfter <= Date.now();
        if (runtime) {
          runtime.error = errorText(error);
          runtime.toolCount = undefined;
          runtime.retryAfter = Date.now() + 30_000;
        }
        if (firstFailure) throw error;
        return {};
      } finally {
        if (runtime?.discovery === discovery) runtime.discovery = undefined;
      }
    }),
  );
  const tools: ToolsInput = {};
  for (const [index, outcome] of outcomes.entries()) {
    if (outcome.status === "fulfilled") Object.assign(tools, outcome.value);
    else {
      console.warn(
        `MCP connection ${selected[index].name} is unavailable`,
        errorText(outcome.reason),
      );
    }
  }
  return tools;
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
  const authentication = client
    .authenticate(toolNamespace(server))
    .then(() => {
      const connection = runtime.clients.get(serverId);
      if (connection?.hash === JSON.stringify(server)) {
        connection.error = undefined;
        connection.retryAfter = undefined;
      }
    })
    .catch((error: unknown) => {
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
