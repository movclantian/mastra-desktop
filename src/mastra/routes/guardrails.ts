import { z } from "zod";
/**
 * 护栏路由:读写「护栏与处理器」配置(数据库 app_config 表 key="guardrails",
 * 保存后实时生效),以及一个运行时可用性探测。
 *
 * 管线主体见 src/mastra/agents/guardrails.ts,
 * 参数语义参考 docs/en/docs/agents/{guardrails,processors}.mdx
 * 与 docs/en/reference/processors/*.mdx。
 */

import { MASTRA_RESOURCE_ID_KEY } from "@mastra/core/request-context";
import { createRoute } from "@mastra/server/server-adapter";
import {
  getGuardrailsConfig,
  guardrailsConfigSchema,
  saveGuardrailsConfig,
} from "../agents/guardrails";
import { workValidationError } from "../errors";
import { resolveDefaultModelId } from "../models/providers";

// GET /work/guardrails — 读取当前护栏配置
export const guardrailsConfigRoute = createRoute({
  queryParamSchema: z.object({}).strict(),
  path: "/work/guardrails",
  responseType: "json",
  onValidationError: workValidationError,
  method: "GET",
  handler: async (params) => {
    return await getGuardrailsConfig(params.requestContext.get(MASTRA_RESOURCE_ID_KEY) as string);
  },
});

// POST /work/guardrails — 写入护栏配置
export const saveGuardrailsConfigRoute = createRoute({
  queryParamSchema: z.object({}).strict(),
  path: "/work/guardrails",
  responseType: "json",
  onValidationError: workValidationError,
  method: "POST",
  bodySchema: guardrailsConfigSchema.transform((config) => ({ config })),
  handler: async (params) => {
    await saveGuardrailsConfig(
      params.config,
      params.requestContext.get(MASTRA_RESOURCE_ID_KEY) as string,
    );
    return { ok: true };
  },
});

/**
 * GET /work/guardrails/status — 前置条件探测。
 *
 * 面板据此提示「为什么某个护栏不会生效」,而不是等到用户发消息才发现:
 * - modelReady:需要 LLM 的检测器(注入/语言/审核/PII/清洗)是否有模型可用
 * - costMetricsReady:TokenCostControl 依赖观测存储的 getMetricAggregate
 * - workspaceReady:每条线程始终绑定 Workspace,无显式路径时以 process.cwd() 为兜底
 */
export const guardrailsStatusRoute = createRoute({
  queryParamSchema: z.object({}).strict(),
  path: "/work/guardrails/status",
  responseType: "json",
  onValidationError: workValidationError,
  method: "GET",
  handler: async (params) => {
    // 组合存储按 domain 路由:经 getStore('observability') 取观测域接口
    const observability = (await params.mastra.getStorage()?.getStore("observability")) as
      | { getMetricAggregate?: unknown }
      | undefined;
    return {
      modelReady: Boolean(
        await resolveDefaultModelId(params.requestContext.get(MASTRA_RESOURCE_ID_KEY) as string),
      ),
      costMetricsReady: typeof observability?.getMetricAggregate === "function",
      workspaceReady: true,
    };
  },
});
