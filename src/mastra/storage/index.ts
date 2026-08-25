/**
 * 存储层:MastraCompositeStore 组合存储 + 共享 LibSQL 客户端 + 应用配置 KV。
 * 官方文档:docs/en/docs/storage.mdx(存储后端选型)、
 * docs/en/reference/storage/composite.mdx(按 domain 路由存储后端)。
 * 默认域走 LibSQL(与 Studio 共享 src/mastra/public/mastra.db),
 * observability 域走 DuckDB(OLAP 指标,docs/en/docs/observability/metrics/overview.mdx)。
 * 外部内容归档写入 Workspace allowedPaths 可读的用户目录。
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { access, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { type Client, createClient } from "@libsql/client";
import { MASTRA_RESOURCE_ID_KEY } from "@mastra/core/request-context";
import { MastraCompositeStore } from "@mastra/core/storage";
import { DuckDBStore } from "@mastra/duckdb";
import { LibSQLStore } from "@mastra/libsql";

export interface RequestContextLike {
  get?: (key: string) => unknown;
}

/** Resolve the authenticated tenant from Mastra's official request context. */
export function resourceIdFromContext(context?: RequestContextLike): string | undefined {
  const value = context?.get?.(MASTRA_RESOURCE_ID_KEY);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

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

/** 默认用户业务数据根目录:用户家目录下的 .mastrawork 文件夹 */
export const DEFAULT_MASTRA_DATA_DIRECTORY = join(homedir(), ".mastrawork");

/**
 * 存储位置配置:
 * `MASTRA_STORAGE_URL` 环境变量优先,其次读取 storage-location.json,
 * 默认落到 <用户家目录>/.mastrawork/mastra.db。
 *
 * 注意:libsql 本地文件在 Windows 下必须使用绝对路径 + 正斜杠的 `file:` URL,
 * 相对路径会抛 SQLITE_CANTOPEN(错误码 14)。
 */
const STORAGE_CONFIG_FILE = join(DEFAULT_MASTRA_DATA_DIRECTORY, "storage-location.json");

/** 规整为 libsql 可用的绝对 file: URL(正斜杠) */
function toFileUrl(filePath: string): string {
  const normalized = filePath.startsWith("file:") ? filePath.slice(5) : filePath;
  const absolute = (
    isAbsolute(normalized) ? normalized : resolve(PROJECT_ROOT, normalized)
  ).replace(/\\/g, "/");
  return `file:${absolute}`;
}

function filePathFromUrl(url: string): string {
  return url.slice(5);
}

export function getStorageUrl(): string {
  let url = process.env.MASTRA_STORAGE_URL;
  if (!url) {
    if (existsSync(STORAGE_CONFIG_FILE)) {
      try {
        const config = JSON.parse(readFileSync(STORAGE_CONFIG_FILE, "utf-8")) as { url?: string };
        url = config.url;
      } catch {
        // 配置文件损坏时回落到默认位置
      }
    }
  }
  if (!url) {
    url = toFileUrl(join(DEFAULT_MASTRA_DATA_DIRECTORY, "mastra.db"));
  }
  return url.startsWith("file:") ? toFileUrl(url) : url;
}

export function getStorageDirectory(): string {
  const url = getStorageUrl();
  if (!url.startsWith("file:")) {
    return DEFAULT_MASTRA_DATA_DIRECTORY;
  }
  return dirname(filePathFromUrl(url));
}

function ensureDirectory(): void {
  const directory = getStorageDirectory() || DEFAULT_MASTRA_DATA_DIRECTORY;
  mkdirSync(directory, { recursive: true });
  mkdirSync(join(directory, "observability"), { recursive: true });
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
      path: join(
        getStorageDirectory() || DEFAULT_MASTRA_DATA_DIRECTORY,
        "observability",
        "mastra.duckdb",
      ).replace(/\\/g, "/"),
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
function scopedConfigKey(key: string, resourceId?: string): string {
  const scope = resourceId?.trim();
  return scope ? `${scope}\u0000${key}` : key;
}

/** Write a file through a same-directory temporary file and atomic rename. */
export async function atomicWrite(filePath: string, data: string | Uint8Array): Promise<void> {
  const directory = dirname(filePath);
  await mkdir(directory, { recursive: true });
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, data, { flag: "wx" });
    try {
      await rename(temporaryPath, filePath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "EPERM") throw error;
      await access(filePath);
      await rm(filePath, { force: true });
      await rename(temporaryPath, filePath);
    }
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

function ensureAppConfigTable(): Promise<void> {
  appConfigTableReady ??= getLibsqlClient().then(async (client) => {
    await client.execute(
      `CREATE TABLE IF NOT EXISTS ${APP_CONFIG_TABLE} (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
    );
  });
  return appConfigTableReady;
}

/** 读取应用配置;不存在返回 null */
export async function getAppConfig(key: string, resourceId?: string): Promise<string | null> {
  await ensureAppConfigTable();
  const result = await (await getLibsqlClient()).execute({
    sql: `SELECT value FROM ${APP_CONFIG_TABLE} WHERE key = ?`,
    args: [scopedConfigKey(key, resourceId)],
  });
  const value = result.rows[0]?.value;
  return typeof value === "string" ? value : null;
}

/** 写入应用配置(upsert) */
export async function setAppConfig(key: string, value: string, resourceId?: string): Promise<void> {
  await ensureAppConfigTable();
  await (await getLibsqlClient()).execute({
    sql: `INSERT INTO ${APP_CONFIG_TABLE} (key, value) VALUES (?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    args: [scopedConfigKey(key, resourceId), value],
  });
}

/** Remove an application configuration value from the scoped store. */
export async function deleteAppConfig(key: string, resourceId?: string): Promise<void> {
  await ensureAppConfigTable();
  await (await getLibsqlClient()).execute({
    sql: `DELETE FROM ${APP_CONFIG_TABLE} WHERE key = ?`,
    args: [scopedConfigKey(key, resourceId)],
  });
}

export * from "./content-objects";
