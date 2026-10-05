/**
 * MCP (Model Context Protocol) 连接模块。
 * 官方文档:docs/en/docs/connections/mcp.mdx(传输 / 工具审批 / 安全)、
 * docs/en/reference/tools/mcp-client.mdx(MCPClient API)。
 * 支持 Streamable HTTP 与 Stdio (子进程) 双传输,配置存 app_config 表
 * (key = "mcp"),按配置哈希缓存 MCPClient,变更后重建并动态注入 Agent 工具集。
 */
import { randomUUID } from "node:crypto";
import type { ToolsInput } from "@mastra/core/agent";
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
import { deleteAppConfig, getAppConfig, setAppConfig } from "../storage/database";

export const mcpServerConfigSchema = z
  .object({
    id: z
      .string()
      .trim()
      .regex(/^[a-zA-Z0-9_-]{1,64}$/),
    name: z.string().trim().optional(),
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

const MCP_CONFIG_KEY = "mcp";
const EMPTY_CONFIG: McpConfig = { servers: [] };

interface McpRuntime {
  client?: { hash: string; promise: Promise<MCPClient | null> };
  redirects: Map<
    string,
    {
      client: MCPClient;
      url: Promise<string>;
      resolve: (url: string) => void;
    }
  >;
}

const runtimeByScope = new Map<string, McpRuntime>();

function getRuntime(resourceId?: string): McpRuntime {
  const key = resourceId?.trim() || "__system__";
  let runtime = runtimeByScope.get(key);
  if (!runtime) {
    runtime = { redirects: new Map() };
    runtimeByScope.set(key, runtime);
  }
  return runtime;
}

export async function getMcpConfig(resourceId?: string): Promise<McpConfig> {
  const raw = await getAppConfig(MCP_CONFIG_KEY, resourceId);
  return raw
    ? z.object({ servers: z.array(mcpServerConfigSchema) }).parse(JSON.parse(raw))
    : EMPTY_CONFIG;
}

export async function saveMcpConfig(config: McpConfig, resourceId?: string): Promise<void> {
  const servers = config.servers.map((server) => mcpServerConfigSchema.parse(server));
  if (new Set(servers.map((server) => server.id)).size !== servers.length)
    throw workError("MCP_CONFIG_INVALID", { text: "MCP ID 不能重复" });
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
  await setAppConfig(MCP_CONFIG_KEY, JSON.stringify({ servers }, null, 2), resourceId);
  const runtime = getRuntime(resourceId);
  const previous = runtime.client;
  const client = await previous?.promise.catch(() => null);
  await client?.disconnect();
  if (runtime.client === previous) runtime.client = undefined;
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
      requestInit: { headers },
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
    env,
    requireToolApproval: server.requireToolApproval,
    ...(server.inheritDefaultEnv === false ? { inheritDefaultEnv: false } : {}),
  };
}

async function createClient(servers: McpServerConfig[], resourceId?: string): Promise<MCPClient> {
  const definitions = await Promise.all(
    servers.map(
      async (server) => [`mcp_${server.id}`, await toDefinition(server, resourceId)] as const,
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
    const error = result.errors[`mcp_${server.id}`];
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

async function getConfiguredMcpClient(resourceId?: string): Promise<MCPClient | null> {
  const config = await getMcpConfig(resourceId);
  const runtime = getRuntime(resourceId);
  const enabled = config.servers.filter((server) => server.enabled);
  const hash = JSON.stringify(enabled);
  const previous = runtime.client;
  if (previous?.hash === hash) return previous.promise;
  const pending = {
    hash,
    promise: (async () => {
      const client = await previous?.promise.catch(() => null);
      await client?.disconnect();
      return enabled.length ? createClient(enabled, resourceId) : null;
    })(),
  };
  runtime.client = pending;
  try {
    return await pending.promise;
  } catch (error) {
    if (runtime.client === pending) runtime.client = undefined;
    throw error;
  }
}

export async function getConfiguredMcpTools(resourceId?: string): Promise<ToolsInput> {
  const client = await getConfiguredMcpClient(resourceId);
  if (!client) return {};
  const { tools, errors } = await client.listToolsWithErrors();
  if (Object.keys(errors).length) console.warn("MCP tool discovery failed", errors);
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
  const client = await getConfiguredMcpClient(resourceId);
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
  const authentication = client.authenticate(`mcp_${serverId}`).catch((error: unknown) => {
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
