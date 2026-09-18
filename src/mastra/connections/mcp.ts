/**
 * MCP (Model Context Protocol) 连接模块。
 * 官方文档:docs/en/docs/connections/mcp.mdx(传输 / 工具审批 / 安全)、
 * docs/en/reference/tools/mcp-client.mdx(MCPClient API)。
 * 支持 HTTP (SSE) 与 Stdio (子进程) 双传输,配置存 app_config 表
 * (key = "mcp"),按配置哈希缓存 MCPClient,变更后重建并动态注入 Agent 工具集。
 */
import { createHash, randomUUID } from "node:crypto";
import type { ToolsInput } from "@mastra/core/agent";
import type { StorageMCPServerConfig } from "@mastra/core/storage";
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
import { appStorage, deleteAppConfig, getAppConfig, setAppConfig } from "../storage";

type McpTransport = "http" | "stdio";

export interface McpServerConfig {
  id: string;
  name: string;
  enabled: boolean;
  transport: McpTransport;
  url?: string;
  headerCredential?: CredentialPointer;
  headerKeys?: string[];
  /** HTTP 传输的 SSRF 防护:mcp.mdx「Security」,仅允许重定向落到这些主机 */
  allowedHosts?: string[];
  command?: string;
  args?: string[];
  envCredential?: CredentialPointer;
  envKeys?: string[];
  inheritDefaultEnv?: boolean;
  /** mcp.mdx「Tool approval」:外部工具默认逐次审批 */
  requireToolApproval?: boolean;
  oauth?: {
    enabled: boolean;
    redirectUrl?: string;
    clientName?: string;
    clientId?: string;
    clientSecretCredential?: CredentialPointer;
    scopes?: string[];
  };
}

interface McpConfig {
  servers: McpServerConfig[];
}

interface McpServerSummary extends McpServerConfig {
  headerKeys: string[];
  envKeys: string[];
}

const MCP_CONFIG_KEY = "mcp";
const EMPTY_CONFIG: McpConfig = { servers: [] };
const STORED_MCP_PREFIX = "mastrawork-";
const STORED_MCP_MARKER = "mastrawork-configured";
const mcpSyncedScopes = new Set<string>();

function storedMcpId(serverId: string, resourceId?: string): string {
  const scope = storedMcpOwner(resourceId);
  const digest = createHash("sha256").update(scope).digest("hex").slice(0, 12);
  return `${STORED_MCP_PREFIX}${digest}-${serverId}`;
}

interface McpRuntime {
  cachedHash: string;
  cachedClient: MCPClient | null;
  cachedTools: ToolsInput;
  authorizationUrlPromise?: Promise<string>;
  resolveAuthorizationUrl?: (url: string) => void;
  authentication?: Promise<void>;
}

const runtimeByScope = new Map<string, McpRuntime>();

function getRuntime(resourceId?: string): McpRuntime {
  const key = resourceId?.trim() || "__system__";
  let runtime = runtimeByScope.get(key);
  if (!runtime) {
    runtime = { cachedHash: "", cachedClient: null, cachedTools: {} };
    runtimeByScope.set(key, runtime);
  }
  return runtime;
}

function normalizeServer(value: unknown): McpServerConfig | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  const name = typeof raw.name === "string" ? raw.name.trim() : id;
  const transport = raw.transport === "stdio" ? "stdio" : raw.transport === "http" ? "http" : null;
  if (!id || !/^[a-zA-Z0-9_-]{1,64}$/.test(id) || !transport) return null;
  const server: McpServerConfig = {
    id,
    name: name || id,
    enabled: raw.enabled !== false,
    transport,
    requireToolApproval: raw.requireToolApproval !== false,
  };
  if (transport === "http") {
    if (typeof raw.url !== "string") return null;
    try {
      const url = new URL(raw.url);
      if (!/^https?:$/.test(url.protocol)) return null;
      server.url = url.toString();
    } catch {
      return null;
    }
    const headerCredential = CredentialPointerSchema.safeParse(raw.headerCredential);
    if (headerCredential.success) server.headerCredential = headerCredential.data;
    server.headerKeys = Array.isArray(raw.headerKeys)
      ? raw.headerKeys.filter((item): item is string => typeof item === "string")
      : [];
    server.allowedHosts = Array.isArray(raw.allowedHosts)
      ? raw.allowedHosts.filter(
          (item): item is string => typeof item === "string" && item.trim().length > 0,
        )
      : [];
    if (raw.oauth && typeof raw.oauth === "object" && !Array.isArray(raw.oauth)) {
      const oauth = raw.oauth as Record<string, unknown>;
      server.oauth = {
        enabled: oauth.enabled === true,
        ...(typeof oauth.redirectUrl === "string" ? { redirectUrl: oauth.redirectUrl } : {}),
        ...(typeof oauth.clientName === "string" ? { clientName: oauth.clientName } : {}),
        ...(typeof oauth.clientId === "string" ? { clientId: oauth.clientId } : {}),
        ...(CredentialPointerSchema.safeParse(oauth.clientSecretCredential).success
          ? {
              clientSecretCredential: CredentialPointerSchema.parse(oauth.clientSecretCredential),
            }
          : {}),
        ...(Array.isArray(oauth.scopes)
          ? { scopes: oauth.scopes.filter((item): item is string => typeof item === "string") }
          : {}),
      };
    }
  } else {
    const command = typeof raw.command === "string" ? raw.command.trim() : "";
    if (!command) return null;
    server.command = command;
    server.args = Array.isArray(raw.args)
      ? raw.args.filter((item): item is string => typeof item === "string")
      : [];
    const envCredential = CredentialPointerSchema.safeParse(raw.envCredential);
    if (envCredential.success) server.envCredential = envCredential.data;
    server.envKeys = Array.isArray(raw.envKeys)
      ? raw.envKeys.filter((item): item is string => typeof item === "string")
      : [];
    server.inheritDefaultEnv = raw.inheritDefaultEnv !== false;
  }
  return server;
}

export function parseMcpServerConfig(value: unknown): McpServerConfig {
  const server = normalizeServer(value);
  if (!server) throw new Error("MCP 配置无效");
  return server;
}

export async function getMcpConfig(resourceId?: string): Promise<McpConfig> {
  const raw = await getAppConfig(MCP_CONFIG_KEY, resourceId);
  let config = EMPTY_CONFIG;
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as { servers?: unknown };
      config = {
        servers: Array.isArray(parsed.servers)
          ? parsed.servers
              .map(normalizeServer)
              .filter((item): item is McpServerConfig => Boolean(item))
          : [],
      };
    } catch {
      config = EMPTY_CONFIG;
    }
  }
  const scope = storedMcpOwner(resourceId);
  if (!mcpSyncedScopes.has(scope)) {
    await syncStoredMcpClients(config.servers, resourceId)
      .then(() => mcpSyncedScopes.add(scope))
      .catch(() => undefined);
  }
  return config;
}

export async function saveMcpConfig(config: McpConfig, resourceId?: string): Promise<void> {
  const servers = config.servers
    .map(normalizeServer)
    .filter((item): item is McpServerConfig => Boolean(item));
  if (servers.length !== config.servers.length) throw new Error("MCP 配置无效");
  if (new Set(servers.map((server) => server.id)).size !== servers.length)
    throw new Error("MCP ID 不能重复");
  await Promise.all(
    servers.flatMap((server) => [
      resolveSecretRecord(server.headerCredential, mcpCredentialPurpose(server.id, "headers")),
      resolveSecretRecord(server.envCredential, mcpCredentialPurpose(server.id, "env")),
      server.oauth?.clientSecretCredential
        ? resolveCredential(
            server.oauth.clientSecretCredential.credentialRef,
            mcpCredentialPurpose(server.id, "client-secret"),
          )
        : undefined,
    ]),
  );
  const current = await getMcpConfig(resourceId);
  await syncStoredMcpClients(servers, resourceId);
  await setAppConfig(MCP_CONFIG_KEY, JSON.stringify({ servers }, null, 2), resourceId);
  mcpSyncedScopes.add(storedMcpOwner(resourceId));
  const runtime = getRuntime(resourceId);
  await runtime.cachedClient?.disconnect().catch(() => undefined);
  runtime.cachedHash = "";
  runtime.cachedClient = null;
  runtime.cachedTools = {};
  const nextById = new Map(servers.map((server) => [server.id, server]));
  await Promise.all(
    current.servers.flatMap((server) => {
      const next = nextById.get(server.id);
      const stale: Array<Promise<void>> = [];
      if (
        server.headerCredential &&
        next?.headerCredential?.credentialRef !== server.headerCredential.credentialRef
      ) {
        stale.push(
          deleteCredential(
            server.headerCredential.credentialRef,
            mcpCredentialPurpose(server.id, "headers"),
          ),
        );
      }
      if (
        server.envCredential &&
        next?.envCredential?.credentialRef !== server.envCredential.credentialRef
      ) {
        stale.push(
          deleteCredential(
            server.envCredential.credentialRef,
            mcpCredentialPurpose(server.id, "env"),
          ),
        );
      }
      if (
        server.oauth?.clientSecretCredential &&
        next?.oauth?.clientSecretCredential?.credentialRef !==
          server.oauth.clientSecretCredential.credentialRef
      ) {
        stale.push(
          deleteCredential(
            server.oauth.clientSecretCredential.credentialRef,
            mcpCredentialPurpose(server.id, "client-secret"),
          ),
        );
      }
      if (!next) stale.push(deleteOAuthCredentials(server.id, resourceId));
      return stale.map((operation) => operation.catch(() => undefined));
    }),
  );
}

function storedMcpOwner(resourceId?: string): string {
  return resourceId?.trim() || "__system__";
}

function storedMcpServer(server: McpServerConfig): StorageMCPServerConfig {
  // Editor storage is returned to Studio; never copy app_config credentials or OAuth state there.
  if (server.transport === "http") {
    if (!server.url) throw new Error(`MCP 服务 ${server.id} 缺少 URL`);
    return { type: "http", url: server.url };
  }
  if (!server.command) throw new Error(`MCP 服务 ${server.id} 缺少启动命令`);
  return {
    type: "stdio",
    command: server.command,
    args: server.args,
  };
}

/** Mirror configured servers into the official Editor domain consumed by Studio /mcps. */
async function syncStoredMcpClients(
  servers: McpServerConfig[],
  resourceId?: string,
): Promise<void> {
  const store = await appStorage.getStore("mcpClients");
  if (!store) throw new Error("MCP clients storage domain is not available");
  const owner = storedMcpOwner(resourceId);
  const desiredIds = new Set<string>();

  for (const server of servers) {
    const id = storedMcpId(server.id, resourceId);
    desiredIds.add(id);
    const snapshot = {
      name: server.name,
      description: "MastraWork configured MCP server",
      servers: { [server.id]: storedMcpServer(server) },
    };
    const metadata = {
      mastrawork: STORED_MCP_MARKER,
      mastraworkEnabled: server.enabled ? "true" : "false",
      mastra_resource_id: owner,
    };
    const existing = await store.getById(id);
    if (existing && existing.metadata?.mastrawork !== STORED_MCP_MARKER) continue;
    if (!existing) {
      await store.create({ mcpClient: { id, authorId: owner, metadata, ...snapshot } });
    } else {
      const latest = await store.getLatestVersion(id);
      const unchanged =
        latest?.name === snapshot.name &&
        latest.description === snapshot.description &&
        JSON.stringify(latest.servers) === JSON.stringify(snapshot.servers);
      if (!unchanged) {
        await store.createVersion({
          id: randomUUID(),
          mcpClientId: id,
          versionNumber: (latest?.versionNumber ?? 0) + 1,
          ...snapshot,
          changedFields: ["name", "description", "servers"],
          changeMessage: "MastraWork MCP configuration updated",
        });
      }
      await store.update({ id, authorId: owner, metadata });
    }
    const current = await store.getLatestVersion(id);
    if (current) await store.update({ id, status: "published", activeVersionId: current.id });
  }

  const published = await store.list({
    perPage: false,
    authorId: owner,
    metadata: { mastrawork: STORED_MCP_MARKER, mastra_resource_id: owner },
    status: "published",
  });
  await Promise.all(
    published.mcpClients
      .filter((client) => !desiredIds.has(client.id))
      .map((client) => store.delete(client.id)),
  );
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
    ...(server.oauth.clientId
      ? {
          clientInformation: {
            client_id: server.oauth.clientId,
            ...(server.oauth.clientSecretCredential
              ? {
                  client_secret: await resolveCredential(
                    server.oauth.clientSecretCredential.credentialRef,
                    mcpCredentialPurpose(server.id, "client-secret"),
                  ),
                }
              : {}),
          },
        }
      : {}),
    storage: new AppOAuthStorage(`mcp:oauth:${server.id}`, resourceId),
    onRedirectToAuthorization: async (url) => {
      getRuntime(resourceId).resolveAuthorizationUrl?.(url.toString());
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
      requestInit: { headers },
      eventSourceInit: {
        fetch(input: Request | URL | string, init?: RequestInit) {
          const merged = new Headers(init?.headers);
          for (const [key, value] of Object.entries(headers)) merged.set(key, value);
          return fetch(input, { ...init, headers: merged });
        },
      },
      ...(authProvider ? { authProvider } : {}),
      requireToolApproval: server.requireToolApproval,
    } as MastraMCPServerDefinition;
  }
  if (!server.command) throw new Error(`MCP 服务 ${server.id} 缺少启动命令`);
  const env = await resolveSecretRecord(
    server.envCredential,
    mcpCredentialPurpose(server.id, "env"),
  );
  return {
    command: server.command,
    args: server.args,
    env,
    requireToolApproval: server.requireToolApproval,
    ...(server.inheritDefaultEnv === false ? { inheritDefaultEnv: false } : {}),
  } as MastraMCPServerDefinition;
}

async function createClient(servers: McpServerConfig[], resourceId?: string): Promise<MCPClient> {
  const definitions = await Promise.all(
    servers.map(async (server) => [server.id, await toDefinition(server, resourceId)] as const),
  );
  return new MCPClient({
    id: "mastra-work-configured-mcp",
    timeout: 30_000,
    servers: Object.fromEntries(definitions),
  });
}

export async function testMcpServer(server: McpServerConfig, resourceId?: string) {
  const client = await createClient([server], resourceId);
  try {
    const { toolsets, errors } = await client.listToolsetsWithErrors();
    const tools = Object.values(toolsets).flatMap((toolset) => Object.keys(toolset));
    const error = errors[server.id];
    return { ok: !error, toolCount: tools.length, tools, error };
  } finally {
    await client.disconnect().catch(() => undefined);
  }
}

export async function getConfiguredMcpTools(resourceId?: string): Promise<ToolsInput> {
  const config = await getMcpConfig(resourceId);
  const runtime = getRuntime(resourceId);
  const enabled = config.servers.filter((server) => server.enabled);
  const hash = JSON.stringify(enabled);
  if (hash === runtime.cachedHash) return runtime.cachedTools;
  if (runtime.cachedClient) await runtime.cachedClient.disconnect().catch(() => undefined);
  runtime.cachedClient = null;
  runtime.cachedTools = {};
  runtime.cachedHash = hash;
  if (enabled.length === 0) return runtime.cachedTools;
  try {
    runtime.cachedClient = await createClient(enabled, resourceId);
    const { toolsets } = await runtime.cachedClient.listToolsetsWithErrors();
    runtime.cachedTools = Object.assign({}, ...Object.values(toolsets));
  } catch {
    await runtime.cachedClient?.disconnect().catch(() => undefined);
    runtime.cachedClient = null;
    runtime.cachedTools = {};
  }
  return runtime.cachedTools;
}

/** Start the official MCPClient loopback OAuth flow and expose its redirect URL. */
export async function authenticateMcpServer(
  serverId: string,
  resourceId?: string,
): Promise<{ authorizationUrl?: string; authenticated: boolean }> {
  const config = await getMcpConfig(resourceId);
  const server = config.servers.find((item) => item.id === serverId);
  if (!server) throw new Error(`MCP 服务 ${serverId} 不存在`);
  if (!server.oauth?.enabled) throw new Error(`MCP 服务 ${serverId} 未启用 OAuth`);
  const runtime = getRuntime(resourceId);
  const enabled = config.servers.filter((item) => item.enabled);
  const hash = JSON.stringify(enabled);
  if (!runtime.cachedClient || runtime.cachedHash !== hash) {
    await runtime.cachedClient?.disconnect().catch(() => undefined);
    runtime.cachedClient = await createClient(enabled, resourceId);
    runtime.cachedHash = hash;
  }
  if (!runtime.authentication) {
    runtime.authorizationUrlPromise = new Promise<string>((resolve) => {
      runtime.resolveAuthorizationUrl = resolve;
    });
    runtime.authentication = runtime.cachedClient.authenticate(serverId).finally(() => {
      runtime.authentication = undefined;
      runtime.authorizationUrlPromise = undefined;
      runtime.resolveAuthorizationUrl = undefined;
      runtime.cachedHash = "";
      runtime.cachedTools = {};
    });
  }
  const authentication = runtime.authentication;
  const authorizationUrlPromise = runtime.authorizationUrlPromise;
  if (!authentication || !authorizationUrlPromise) throw new Error("MCP OAuth 状态无效");
  return await Promise.race([
    authorizationUrlPromise.then((authorizationUrl) => ({
      authorizationUrl,
      authenticated: false,
    })),
    authentication.then(() => ({ authenticated: true })),
  ]);
}
