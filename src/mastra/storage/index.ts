import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, parse, resolve } from "node:path";
import { type Client, createClient } from "@libsql/client";
import { MastraCompositeStore } from "@mastra/core/storage";
import { DuckDBStore } from "@mastra/duckdb";
import { LibSQLStore } from "@mastra/libsql";

/**
 * 项目根目录定位。
 * mastra dev 服务进程的 cwd 是 src/mastra/public 而非项目根,
 * 任何基于 cwd 的路径(node_modules/配置文件/数据库)都会落错位置,
 * 因此统一从 import.meta.dirname(dev 下为 <root>/.mastra/output)
 * 向上查找 pnpm-lock.yaml 锚定项目根,cwd 仅作兜底。
 */
function findProjectRoot(): string {
  let dir = import.meta.dirname;
  while (dir && dir !== parse(dir).root) {
    if (existsSync(join(dir, "pnpm-lock.yaml"))) return dir;
    dir = dirname(dir);
  }
  return process.cwd();
}

export const PROJECT_ROOT = findProjectRoot();

/**
 * 存储位置配置:
 * `MASTRA_STORAGE_URL` 环境变量优先,其次读取 storage-location.json,
 * 默认落到 <项目根>/src/mastra/public/mastra.db(与 Studio 共享同一份数据)。
 *
 * 注意:libsql 本地文件在 Windows 下必须使用绝对路径 + 正斜杠的 `file:` URL,
 * 相对路径会抛 SQLITE_CANTOPEN(错误码 14)。
 */
const STORAGE_CONFIG_FILE = join(PROJECT_ROOT, "storage-location.json");

/** 规整为 libsql 可用的绝对 file: URL(正斜杠) */
function toFileUrl(filePath: string): string {
  const absolute = resolve(PROJECT_ROOT, filePath).replace(/\\/g, "/");
  return `file:${absolute}`;
}

export function getStorageUrl(): string {
  let url = process.env.MASTRA_STORAGE_URL;
  if (!url && existsSync(STORAGE_CONFIG_FILE)) {
    try {
      const config = JSON.parse(readFileSync(STORAGE_CONFIG_FILE, "utf-8")) as {
        url?: string;
      };
      url = config.url;
    } catch {
      // 配置文件损坏时回落到默认位置
    }
  }
  if (!url) {
    url = "file:./src/mastra/public/mastra.db";
  }
  if (url.startsWith("file:")) {
    return toFileUrl(url.slice("file:".length));
  }
  return url; // 远程 libsql(http://...)原样返回
}

export function getStorageDirectory(): string {
  const url = getStorageUrl();
  if (!url.startsWith("file:")) {
    return "";
  }
  return dirname(url.slice("file:".length));
}

function ensureDirectory(): void {
  const directory = getStorageDirectory();
  if (directory) {
    mkdirSync(directory, { recursive: true });
  }
}
ensureDirectory();

// 参考 docs/en/docs/storage.mdx — MastraCompositeStore 按 domain 路由存储后端
export const appStorage = new MastraCompositeStore({
  id: "composite-storage",
  default: new LibSQLStore({
    id: "mastra-storage",
    url: getStorageUrl(),
  }),
  domains: {
    // @mastra/duckdb 官方示例:作为组合存储的 observability 后端
    observability: new DuckDBStore({
      path: join(getStorageDirectory(), "mastra.duckdb").replace(/\\/g, "/"),
    }).observability,
  },
});

/**
 * 应用配置 kv 存储(app_config 表,与业务数据同库同引擎)。
 * 供"配置本身也要进数据库"的设置项使用(如记忆参数)。
 * 唯一例外:存储位置(storage-location.json)—— 数据库地址无法存于数据库自身,
 * 该文件保留为引导配置。
 */
const APP_CONFIG_TABLE = "app_config";

async function withConfigClient<T>(run: (client: Client) => Promise<T>): Promise<T> {
  const client = createClient({ url: getStorageUrl() });
  try {
    await client.execute(
      `CREATE TABLE IF NOT EXISTS ${APP_CONFIG_TABLE} (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
    );
    return await run(client);
  } finally {
    client.close();
  }
}

/** 读取应用配置;不存在返回 null */
export async function getAppConfig(key: string): Promise<string | null> {
  const result = await withConfigClient((client) =>
    client.execute({
      sql: `SELECT value FROM ${APP_CONFIG_TABLE} WHERE key = ?`,
      args: [key],
    }),
  );
  const value = result.rows[0]?.value;
  return typeof value === "string" ? value : null;
}

/** 写入应用配置(upsert) */
export async function setAppConfig(key: string, value: string): Promise<void> {
  await withConfigClient((client) =>
    client.execute({
      sql: `INSERT INTO ${APP_CONFIG_TABLE} (key, value) VALUES (?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      args: [key, value],
    }),
  );
}
