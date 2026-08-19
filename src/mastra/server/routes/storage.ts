import { registerApiRoute } from "@mastra/core/server";
import { getStorageDirectory, getStorageUrl } from "../../storage";

/**
 * 存储路由:目录展示。
 * 存储后端(LibSQL + DuckDB 复合存储)见 src/mastra/storage/index.ts;
 * 位置迁移(含文件搬迁与服务重启)由 Electron 主进程的 migrate-storage IPC 承担。
 */

// GET /work/storage — 存储信息
export const storageInfoRoute = registerApiRoute("/work/storage", {
  method: "GET",
  handler: async (c) => {
    return c.json({
      url: getStorageUrl(),
      directory: getStorageDirectory(),
    });
  },
});
