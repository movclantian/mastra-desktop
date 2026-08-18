import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { MastraCompositeStore } from "@mastra/core/storage";
import { DuckDBStore } from "@mastra/duckdb";
import { LibSQLStore } from "@mastra/libsql";

/**
 * 存储位置配置:
 * `MASTRA_STORAGE_URL` 环境变量优先,其次读取 storage-location.json,
 * 默认落到 <cwd>/src/mastra/public/mastra.db(与 Studio 共享同一份数据)。
 *
 * 注意:libsql 本地文件在 Windows 下必须使用绝对路径 + 正斜杠的 `file:` URL,
 * 相对路径会抛 SQLITE_CANTOPEN(错误码 14)。
 */
const STORAGE_CONFIG_FILE = join(process.cwd(), "storage-location.json");

/** 规整为 libsql 可用的绝对 file: URL(正斜杠) */
function toFileUrl(filePath: string): string {
  const absolute = resolve(process.cwd(), filePath).replace(/\\/g, "/");
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
