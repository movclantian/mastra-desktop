/**
 * 记忆路由:读写用户可配置的 Memory 参数(数据库 app_config 表,保存后实时生效)。
 * Memory 主体见 src/mastra/memory/index.ts,
 * 参数语义参考 docs/en/docs/memory/{overview,semantic-recall,working-memory}.mdx。
 */
import { registerApiRoute } from "@mastra/core/server";
import { getMemoryConfig, type MemoryUserConfig, saveMemoryConfig } from "../memory";

// GET /work/memory — 读取当前记忆配置
export const memoryConfigRoute = registerApiRoute("/work/memory", {
  method: "GET",
  handler: async (c) => {
    return c.json(await getMemoryConfig());
  },
});

// POST /work/memory — 写入记忆配置
export const saveMemoryConfigRoute = registerApiRoute("/work/memory", {
  method: "POST",
  handler: async (c) => {
    await saveMemoryConfig(await c.req.json<MemoryUserConfig>());
    return c.json({ ok: true });
  },
});
