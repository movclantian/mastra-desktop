import { registerApiRoute } from "@mastra/core/server";
import type { MemoryUserConfig } from "../../memory";

/**
 * 记忆路由:读写用户可配置的 Memory 参数(数据库 app_config 表,重启生效)。
 * Memory 主体见 src/mastra/memory/index.ts,
 * 参数语义参考 docs/en/docs/memory/{overview,semantic-recall,working-memory}.mdx。
 */

// GET /work/memory — 读取当前记忆配置
export const memoryConfigRoute = registerApiRoute("/work/memory", {
  method: "GET",
  handler: async (c) => {
    const { getMemoryConfig } = await import("../../memory");
    return c.json(await getMemoryConfig());
  },
});

// POST /work/memory — 写入记忆配置
export const saveMemoryConfigRoute = registerApiRoute("/work/memory", {
  method: "POST",
  handler: async (c) => {
    const config = (await c.req.json()) as MemoryUserConfig;
    const { saveMemoryConfig } = await import("../../memory");
    await saveMemoryConfig(config);
    return c.json({ ok: true });
  },
});
