import type { ToolsInput } from "@mastra/core/agent";
import { type MastraMCPServerDefinition, MCPClient } from "@mastra/mcp";
import { getAppConfig, setAppConfig } from "../storage";

/**
 * MCP (Model Context Protocol) 连接模块 (docs/en/docs/connections/mcp.mdx, reference/tools/mcp-client.mdx):
 * 支持 HTTP (SSE) 和 Stdio (子进程) 双传输协议, 动态解析并注入 Agent 工具集。
 */

export type McpTransport = "http" | "stdio";

export interface McpServerConfig {
  id: string;
  name: string;
  enabled: boolean;
  transport: McpTransport;
  url?: string;
  headers?: Record<string, string>;
  allowedHosts?: string[];
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  inheritDefaultEnv?: boolean;
  requireToolApproval?: boolean;
}

export interface McpConfig {
  servers: McpServerConfig[];
}

export interface McpServerSummary extends Omit<McpServerConfig, "headers" | "env"> {
  headerKeys: string[];
  envKeys: string[];
}

const MCP_CONFIG_KEY = "mcp";
const EMPTY_CONFIG: McpConfig = { servers: [] };

let cachedHash = "";
let cachedClient: MCPClient | null = null;
let cachedTools: ToolsInput = {};

function cleanRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      ([key, item]) => key.trim().length > 0 && typeof item === "string",
    ),
  ) as Record<string, string>;
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
    server.headers = cleanRecord(raw.headers);
    server.allowedHosts = Array.isArray(raw.allowedHosts)
      ? raw.allowedHosts.filter(
          (item): item is string => typeof item === "string" && item.trim().length > 0,
        )
      : [];
  } else {
    const command = typeof raw.command === "string" ? raw.command.trim() : "";
    if (!command) return null;
    server.command = command;
    server.args = Array.isArray(raw.args)
      ? raw.args.filter((item): item is string => typeof item === "string")
      : [];
    server.env = cleanRecord(raw.env);
    server.inheritDefaultEnv = raw.inheritDefaultEnv !== false;
  }
  return server;
}

export async function getMcpConfig(): Promise<McpConfig> {
  const raw = await getAppConfig(MCP_CONFIG_KEY);
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

export async function saveMcpConfig(config: McpConfig): Promise<void> {
  const servers = config.servers
    .map(normalizeServer)
    .filter((item): item is McpServerConfig => Boolean(item));
  if (servers.length !== config.servers.length) throw new Error("MCP 配置无效");
  if (new Set(servers.map((server) => server.id)).size !== servers.length)
    throw new Error("MCP ID 不能重复");
  await setAppConfig(MCP_CONFIG_KEY, JSON.stringify({ servers }, null, 2));
  cachedHash = "";
}

export function summarizeMcpServer(server: McpServerConfig): McpServerSummary {
  const { headers, env, ...safe } = server;
  return { ...safe, headerKeys: Object.keys(headers ?? {}), envKeys: Object.keys(env ?? {}) };
}

function toDefinition(server: McpServerConfig): MastraMCPServerDefinition {
  if (server.transport === "http") {
    const headers = server.headers ?? {};
    if (!server.url) throw new Error(`MCP 服务 ${server.id} 缺少 URL`);
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

async function createClient(servers: McpServerConfig[]): Promise<MCPClient> {
  return new MCPClient({
    id: "mastra-work-configured-mcp",
    timeout: 30_000,
    servers: Object.fromEntries(servers.map((server) => [server.id, toDefinition(server)])),
  });
}

export async function testMcpServer(server: McpServerConfig) {
  const client = await createClient([server]);
  try {
    const { toolsets, errors } = await client.listToolsetsWithErrors();
    const tools = Object.values(toolsets).flatMap((toolset) => Object.keys(toolset));
    const error = errors[server.id];
    return { ok: !error, toolCount: tools.length, tools, error };
  } finally {
    await client.disconnect().catch(() => undefined);
  }
}

export async function getConfiguredMcpTools(): Promise<ToolsInput> {
  const config = await getMcpConfig();
  const enabled = config.servers.filter((server) => server.enabled);
  const hash = JSON.stringify(enabled);
  if (hash === cachedHash) return cachedTools;
  if (cachedClient) await cachedClient.disconnect().catch(() => undefined);
  cachedClient = null;
  cachedTools = {};
  cachedHash = hash;
  if (enabled.length === 0) return cachedTools;
  try {
    cachedClient = await createClient(enabled);
    const { toolsets } = await cachedClient.listToolsetsWithErrors();
    cachedTools = Object.assign({}, ...Object.values(toolsets));
  } catch {
    await cachedClient?.disconnect().catch(() => undefined);
    cachedClient = null;
    cachedTools = {};
  }
  return cachedTools;
}
