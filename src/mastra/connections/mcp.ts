/**
 * MCP (Model Context Protocol) 连接模块。
 * 官方文档:docs/en/docs/connections/mcp.mdx(传输 / 工具审批 / 安全)、
 * docs/en/reference/tools/mcp-client.mdx(MCPClient API)。
 * 支持 HTTP (SSE) 与 Stdio (子进程) 双传输,配置存 app_config 表
 * (key = "mcp"),按配置哈希缓存 MCPClient,变更后重建并动态注入 Agent 工具集。
 */
import type { ToolsInput } from "@mastra/core/agent";
import {
  getCallbackUrlCandidates,
  type MastraMCPServerDefinition,
  MCPClient,
  MCPOAuthClientProvider,
  type OAuthStorage,
} from "@mastra/mcp";
import { stringRecord } from "../config/normalize";
import { deleteAppConfig, getAppConfig, setAppConfig } from "../storage";

type McpTransport = "http" | "stdio";

export interface McpServerConfig {
  id: string;
  name: string;
  enabled: boolean;
  transport: McpTransport;
  url?: string;
  headers?: Record<string, string>;
  /** HTTP 传输的 SSRF 防护:mcp.mdx「Security」,仅允许重定向落到这些主机 */
  allowedHosts?: string[];
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  inheritDefaultEnv?: boolean;
  /** mcp.mdx「Tool approval」:外部工具默认逐次审批 */
  requireToolApproval?: boolean;
  oauth?: {
    enabled: boolean;
    redirectUrl?: string;
    clientName?: string;
    clientId?: string;
    clientSecret?: string;
    scopes?: string[];
  };
}

interface McpConfig {
  servers: McpServerConfig[];
}

interface McpServerSummary extends Omit<McpServerConfig, "headers" | "env"> {
  headerKeys: string[];
  envKeys: string[];
}

const MCP_CONFIG_KEY = "mcp";
const EMPTY_CONFIG: McpConfig = { servers: [] };

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
    server.headers = stringRecord(raw.headers);
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
        ...(typeof oauth.clientSecret === "string" ? { clientSecret: oauth.clientSecret } : {}),
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
    server.env = stringRecord(raw.env);
    server.inheritDefaultEnv = raw.inheritDefaultEnv !== false;
  }
  return server;
}

export async function getMcpConfig(resourceId?: string): Promise<McpConfig> {
  const raw = await getAppConfig(MCP_CONFIG_KEY, resourceId);
  if (!raw) return EMPTY_CONFIG;
  try {
    const parsed = JSON.parse(raw) as { servers?: unknown };
    return {
      servers: Array.isArray(parsed.servers)
        ? parsed.servers
            .map(normalizeServer)
            .filter((item): item is McpServerConfig => Boolean(item))
        : [],
    };
  } catch {
    return EMPTY_CONFIG;
  }
}

export async function saveMcpConfig(config: McpConfig, resourceId?: string): Promise<void> {
  const servers = config.servers
    .map(normalizeServer)
    .filter((item): item is McpServerConfig => Boolean(item));
  if (servers.length !== config.servers.length) throw new Error("MCP 配置无效");
  if (new Set(servers.map((server) => server.id)).size !== servers.length)
    throw new Error("MCP ID 不能重复");
  await setAppConfig(MCP_CONFIG_KEY, JSON.stringify({ servers }, null, 2), resourceId);
  const runtime = getRuntime(resourceId);
  await runtime.cachedClient?.disconnect().catch(() => undefined);
  runtime.cachedHash = "";
  runtime.cachedClient = null;
  runtime.cachedTools = {};
}

export function summarizeMcpServer(server: McpServerConfig): McpServerSummary {
  const { headers, env, oauth, ...safe } = server;
  const safeOauth = oauth
    ? {
        enabled: oauth.enabled,
        ...(oauth.redirectUrl !== undefined ? { redirectUrl: oauth.redirectUrl } : {}),
        ...(oauth.clientName !== undefined ? { clientName: oauth.clientName } : {}),
        ...(oauth.scopes !== undefined ? { scopes: oauth.scopes } : {}),
      }
    : undefined;
  return {
    ...safe,
    ...(safeOauth ? { oauth: safeOauth } : {}),
    headerKeys: Object.keys(headers ?? {}),
    envKeys: Object.keys(env ?? {}),
  };
}

class AppOAuthStorage implements OAuthStorage {
  constructor(
    private readonly prefix: string,
    private readonly resourceId?: string,
  ) {}
  set(key: string, value: string) {
    return setAppConfig(`${this.prefix}:${key}`, value, this.resourceId);
  }
  async get(key: string) {
    return (await getAppConfig(`${this.prefix}:${key}`, this.resourceId)) || undefined;
  }
  delete(key: string) {
    return deleteAppConfig(`${this.prefix}:${key}`, this.resourceId);
  }
}

function oauthProvider(
  server: McpServerConfig,
  resourceId?: string,
): MCPOAuthClientProvider | undefined {
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
            ...(server.oauth.clientSecret ? { client_secret: server.oauth.clientSecret } : {}),
          },
        }
      : {}),
    storage: new AppOAuthStorage(`mcp:oauth:${server.id}`, resourceId),
    onRedirectToAuthorization: async (url) => {
      getRuntime(resourceId).resolveAuthorizationUrl?.(url.toString());
    },
  });
}

function toDefinition(server: McpServerConfig, resourceId?: string): MastraMCPServerDefinition {
  if (server.transport === "http") {
    const headers = server.headers ?? {};
    if (!server.url) throw new Error(`MCP 服务 ${server.id} 缺少 URL`);
    const authProvider = oauthProvider(server, resourceId);
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
  return {
    command: server.command,
    args: server.args,
    env: server.env,
    requireToolApproval: server.requireToolApproval,
    ...(server.inheritDefaultEnv === false ? { inheritDefaultEnv: false } : {}),
  } as MastraMCPServerDefinition;
}

async function createClient(servers: McpServerConfig[], resourceId?: string): Promise<MCPClient> {
  return new MCPClient({
    id: "mastra-work-configured-mcp",
    timeout: 30_000,
    servers: Object.fromEntries(
      servers.map((server) => [server.id, toDefinition(server, resourceId)]),
    ),
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
