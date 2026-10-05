/**
 * 存储路由:目录展示。
 * 存储后端(LibSQL + DuckDB 复合存储)见 src/mastra/storage/index.ts;
 * 位置迁移(含文件搬迁与服务重启)由 Electron 主进程的 migrate-storage IPC 承担。
 */
import { createRoute } from "@mastra/server/server-adapter";
import { z } from "zod";
import { workValidationError } from "../errors";
import { getStorageDirectory, getStorageUrl } from "../storage";

// GET /work/storage — 存储信息
export const storageInfoRoute = createRoute({
  queryParamSchema: z.object({}).strict(),
  path: "/work/storage",
  responseType: "json",
  onValidationError: workValidationError,
  method: "GET",
  handler: async () => {
    return {
      url: getStorageUrl(),
      directory: getStorageDirectory(),
    };
  },
});
