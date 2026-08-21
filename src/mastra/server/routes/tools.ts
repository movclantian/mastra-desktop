import { registerApiRoute } from "@mastra/core/server";
import type { ToolsUserConfig } from "../../tools";

/**
 * 工具路由:读写三个联网检索引擎(Tavily / Firecrawl / AnySearch)的 API Key。
 * 存数据库 app_config 表(key = "tools"),工具在每次请求时按当前配置实例化,
 * 因此改 Key 立即生效、无需重启服务。工具主体见 src/mastra/agents/tools.ts。
 */

// GET /work/tools — 读取当前工具配置
export const toolsConfigRoute = registerApiRoute("/work/tools", {
  method: "GET",
  handler: async (c) => {
    const { getToolsConfig } = await import("../../tools");
    return c.json(await getToolsConfig());
  },
});

// POST /work/tools — 写入工具配置
export const saveToolsConfigRoute = registerApiRoute("/work/tools", {
  method: "POST",
  handler: async (c) => {
    const config = (await c.req.json()) as ToolsUserConfig;
    const { saveToolsConfig } = await import("../../tools");
    await saveToolsConfig(config);
    return c.json({ ok: true });
  },
});
