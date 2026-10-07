import { z } from "zod";
/**
 * 工具路由:读写三个联网检索引擎(Tavily / Firecrawl / AnySearch)的 API Key。
 * 存数据库 app_config 表(key = "tools"),工具在每次请求时按当前配置实例化,
 * 因此改 Key 立即生效、无需重启服务。工具主体见 src/mastra/tools/web-search.ts。
 */

import { MASTRA_RESOURCE_ID_KEY } from "@mastra/core/request-context";
import { createRoute } from "@mastra/server/server-adapter";
import { ComputerConfigSchema } from "../../shared/computer-contract";
import {
  closeComputerConnections,
  getComputerConfig,
  probeComputer,
  saveComputerConfig,
} from "../connections/computer";
import { workValidationError } from "../errors";
import { getToolsConfig, saveToolsConfig } from "../tools/tool-registry";
import { toolsConfigSchema } from "../tools/web-search";

// GET /work/tools — 读取当前工具配置
export const toolsConfigRoute = createRoute({
  queryParamSchema: z.object({}).strict(),
  path: "/work/tools",
  responseType: "json",
  onValidationError: workValidationError,
  method: "GET",
  handler: async (params) => {
    return await getToolsConfig(params.requestContext.get(MASTRA_RESOURCE_ID_KEY) as string);
  },
});

// POST /work/tools — 写入工具配置
export const saveToolsConfigRoute = createRoute({
  queryParamSchema: z.object({}).strict(),
  path: "/work/tools",
  responseType: "json",
  onValidationError: workValidationError,
  method: "POST",
  bodySchema: toolsConfigSchema.transform((config) => ({ config })),
  handler: async (params) => {
    await saveToolsConfig(
      params.config,
      params.requestContext.get(MASTRA_RESOURCE_ID_KEY) as string,
    );
    return { ok: true };
  },
});

export const computerRoutes = [
  createRoute({
    path: "/work/computer",
    method: "GET",
    responseType: "json",
    queryParamSchema: z.object({}).strict(),
    onValidationError: workValidationError,
    handler: ({ requestContext }) =>
      getComputerConfig(requestContext.get(MASTRA_RESOURCE_ID_KEY) as string),
  }),
  createRoute({
    path: "/work/computer",
    method: "POST",
    responseType: "json",
    queryParamSchema: z.object({}).strict(),
    onValidationError: workValidationError,
    bodySchema: z.object({ config: ComputerConfigSchema }).strict(),
    handler: ({ config, requestContext }) =>
      saveComputerConfig(config, requestContext.get(MASTRA_RESOURCE_ID_KEY) as string),
  }),
  createRoute({
    path: "/work/computer/probe",
    method: "POST",
    responseType: "json",
    queryParamSchema: z.object({}).strict(),
    onValidationError: workValidationError,
    bodySchema: z.object({ config: ComputerConfigSchema }).strict(),
    handler: ({ config }) => probeComputer(config),
  }),
  createRoute({
    path: "/work/computer/disconnect",
    method: "POST",
    responseType: "json",
    queryParamSchema: z.object({}).strict(),
    bodySchema: z.object({}).strict(),
    onValidationError: workValidationError,
    handler: async ({ requestContext }) => {
      await closeComputerConnections(requestContext.get(MASTRA_RESOURCE_ID_KEY) as string);
      return { ok: true };
    },
  }),
];
