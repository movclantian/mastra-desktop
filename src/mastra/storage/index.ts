/**
 * 存储层:MastraCompositeStore 组合存储 + 共享 LibSQL 客户端 + 应用配置 KV。
 * 官方文档:docs/en/docs/storage.mdx(存储后端选型)、
 * docs/en/reference/storage/composite.mdx(按 domain 路由存储后端)。
 * 默认域走 LibSQL(与 Studio 共享 src/mastra/public/mastra.db),
 * observability 域走 DuckDB(OLAP 指标,docs/en/docs/observability/metrics/overview.mdx)。
 */
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
// DuckDB 运行期间持有写前日志(WAL);放在 src/mastra/public 之外,
// 避免 Mastra 打包器把活跃数据库当静态资产、在构建时复制被锁的 WAL 文件。
const OBSERVABILITY_STORAGE_DIRECTORY = join(PROJECT_ROOT, ".mastra", "observability");

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
  mkdirSync(OBSERVABILITY_STORAGE_DIRECTORY, { recursive: true });
}
ensureDirectory();

/** 组合存储(composite.mdx):默认域 LibSQL,observability 域 DuckDB */
export const appStorage = new MastraCompositeStore({
  id: "composite-storage",
  default: new LibSQLStore({
    id: "mastra-storage",
    url: getStorageUrl(),
  }),
  domains: {
    observability: new DuckDBStore({
      path: join(OBSERVABILITY_STORAGE_DIRECTORY, "mastra.duckdb").replace(/\\/g, "/"),
    }).observability,
  },
});

/**
 * 共享 LibSQL 客户端:与业务库同文件,进程存活期内复用连接
 * (libsql 为长连接设计,逐调用新建/关闭是反模式)。
 */
let sharedClientPromise: Promise<Client> | null = null;

export function getLibsqlClient(): Promise<Client> {
  sharedClientPromise ??= Promise.resolve(createClient({ url: getStorageUrl() }));
  return sharedClientPromise;
}

/**
 * 应用配置 kv 存储(app_config 表,与业务数据同库同引擎)。
 * 供"配置本身也要进数据库"的设置项使用(如记忆参数)。
 * 唯一例外:存储位置(storage-location.json)—— 数据库地址无法存于数据库自身,
 * 该文件保留为引导配置。
 */
const APP_CONFIG_TABLE = "app_config";
let appConfigTableReady: Promise<void> | undefined;

function ensureAppConfigTable(): Promise<void> {
  appConfigTableReady ??= getLibsqlClient().then(async (client) => {
    await client.execute(
      `CREATE TABLE IF NOT EXISTS ${APP_CONFIG_TABLE} (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
    );
  });
  return appConfigTableReady;
}

/** 读取应用配置;不存在返回 null */
export async function getAppConfig(key: string): Promise<string | null> {
  await ensureAppConfigTable();
  const result = await (await getLibsqlClient()).execute({
    sql: `SELECT value FROM ${APP_CONFIG_TABLE} WHERE key = ?`,
    args: [key],
  });
  const value = result.rows[0]?.value;
  return typeof value === "string" ? value : null;
}

/** 写入应用配置(upsert) */
export async function setAppConfig(key: string, value: string): Promise<void> {
  await ensureAppConfigTable();
  await (await getLibsqlClient()).execute({
    sql: `INSERT INTO ${APP_CONFIG_TABLE} (key, value) VALUES (?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    args: [key, value],
  });
}
