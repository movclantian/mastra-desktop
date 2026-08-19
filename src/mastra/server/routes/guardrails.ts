import { registerApiRoute } from "@mastra/core/server";
import type { GuardrailsUserConfig } from "../../agents/guardrails";

/**
 * 护栏路由:读写「护栏与处理器」配置(数据库 app_config 表 key="guardrails",
 * 保存后实时生效),以及一个运行时可用性探测。
 *
 * 管线主体见 src/mastra/agents/guardrails.ts,
 * 参数语义参考 docs/en/docs/agents/{guardrails,processors}.mdx
 * 与 docs/en/reference/processors/*.mdx。
 */

// GET /work/guardrails — 读取当前护栏配置
export const guardrailsConfigRoute = registerApiRoute("/work/guardrails", {
  method: "GET",
  handler: async (c) => {
    const { getGuardrailsConfig } = await import("../../agents/guardrails");
    return c.json(await getGuardrailsConfig());
  },
});

// POST /work/guardrails — 写入护栏配置
export const saveGuardrailsConfigRoute = registerApiRoute("/work/guardrails", {
  method: "POST",
  handler: async (c) => {
    const config = (await c.req.json()) as GuardrailsUserConfig;
    const { saveGuardrailsConfig } = await import("../../agents/guardrails");
    await saveGuardrailsConfig(config);
    return c.json({ ok: true });
  },
});

/**
 * GET /work/guardrails/status — 前置条件探测。
 *
 * 面板据此提示「为什么某个护栏不会生效」,而不是等到用户发消息才发现:
 * - modelReady:需要 LLM 的检测器(注入/语言/审核/PII/清洗)是否有模型可用
 * - costMetricsReady:TokenCostControl 依赖观测存储的 getMetricAggregate
 * - workspaceReady:SkillSearchProcessor 依赖每线程 Workspace 实例
 */
export const guardrailsStatusRoute = registerApiRoute("/work/guardrails/status", {
  method: "GET",
  handler: async (c) => {
    const [{ getGuardrailsConfig }, { resolveDefaultModelId }, { isWorkspaceEnabled }] =
      await Promise.all([
        import("../../agents/guardrails"),
        import("../../agents/llm"),
        import("../../workspace"),
      ]);
    const config = await getGuardrailsConfig();
    // 组合存储按 domain 路由:经 getStore('observability') 取观测域接口
    const observability = (await c.get("mastra").getStorage()?.getStore("observability")) as
      | { getMetricAggregate?: unknown }
      | undefined;
    return c.json({
      modelReady: Boolean(config.model.trim() || (await resolveDefaultModelId())),
      costMetricsReady: typeof observability?.getMetricAggregate === "function",
      workspaceReady: isWorkspaceEnabled(),
    });
  },
});
