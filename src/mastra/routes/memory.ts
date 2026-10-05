/**
 * 记忆路由:读写用户可配置的 Memory 参数(数据库 app_config 表,保存后实时生效)。
 * Memory 主体见 src/mastra/memory/memory-runtime.ts,
 * 参数语义参考 docs/en/docs/memory/{overview,semantic-recall,working-memory}.mdx。
 */

import { getThreadOMMetadata } from "@mastra/core/memory";
import { MASTRA_RESOURCE_ID_KEY } from "@mastra/core/request-context";
import { createRoute } from "@mastra/server/server-adapter";
import { z } from "zod";
import { workError, workValidationError } from "../errors";
import { getMemoryConfig, memoryConfigSchema, saveMemoryConfig } from "../memory/memory-runtime";
import { getOwnedThread, getWorkMemory } from "./threads/shared";

// GET /work/memory — 读取当前记忆配置
export const memoryConfigRoute = createRoute({
  queryParamSchema: z.object({}).strict(),
  path: "/work/memory",
  responseType: "json",
  onValidationError: workValidationError,
  method: "GET",
  handler: async (params) => {
    return await getMemoryConfig(params.requestContext.get(MASTRA_RESOURCE_ID_KEY) as string);
  },
});

// POST /work/memory — 写入记忆配置
export const saveMemoryConfigRoute = createRoute({
  queryParamSchema: z.object({}).strict(),
  path: "/work/memory",
  responseType: "json",
  onValidationError: workValidationError,
  method: "POST",
  bodySchema: memoryConfigSchema.transform((config) => ({ config })),
  handler: async (params) => {
    await saveMemoryConfig(
      params.config,
      params.requestContext.get(MASTRA_RESOURCE_ID_KEY) as string,
    );
    return { ok: true };
  },
});

/**
 * GET /work/memory/profile — 当前用户的工作记忆与 OM extractor 结果。
 * Extractors 按线程持久化在 thread.metadata.mastra.om.extracted,因此这里按
 * 最近更新时间合并同一 resource 下的线程,并返回来源线程供设置页追溯。
 */
export const memoryProfileRoute = createRoute({
  queryParamSchema: z.object({}).strict(),
  path: "/work/memory/profile",
  responseType: "json",
  onValidationError: workValidationError,
  method: "GET",
  handler: async (params) => {
    const resourceId = params.requestContext.get(MASTRA_RESOURCE_ID_KEY) as string;
    if (!resourceId) return { workingMemory: null, extractors: [] };

    const memory = await getWorkMemory(params.requestContext);
    const { threads } = await memory.listThreads({
      filter: { resourceId },
      perPage: false,
      orderBy: { field: "updatedAt", direction: "DESC" },
    });
    const config = await getMemoryConfig(resourceId);
    const configuredExtractors = new Map(
      config.omExtractors.map((extractor) => [extractor.name.toLowerCase(), extractor.name]),
    );
    const extracted = new Map<
      string,
      {
        slug: string;
        name: string;
        value: unknown;
        threadId: string;
        threadTitle: string;
        updatedAt: string;
      }
    >();

    for (const thread of [...threads].sort(
      (left, right) => right.updatedAt.getTime() - left.updatedAt.getTime(),
    )) {
      const values = getThreadOMMetadata(thread.metadata)?.extracted;
      if (!values || typeof values !== "object") continue;
      for (const [slug, value] of Object.entries(values)) {
        if (value === null || value === "" || extracted.has(slug)) continue;
        const configuredName = [...configuredExtractors.entries()].find(
          ([name]) =>
            slug ===
            name
              .replace(/[^a-z0-9]+/gi, "-")
              .replace(/^-|-$/g, "")
              .toLowerCase(),
        )?.[1];
        extracted.set(slug, {
          slug,
          name: configuredName ?? slug,
          value,
          threadId: thread.id,
          threadTitle: thread.title?.trim() || "New Chat",
          updatedAt: thread.updatedAt.toISOString(),
        });
      }
    }

    const workingMemory = threads[0]
      ? await memory.getWorkingMemory({
          threadId: threads[0].id,
          resourceId,
        })
      : null;
    return {
      workingMemory,
      extractors: [...extracted.values()],
      threadCount: threads.length,
    };
  },
});

const threadOmConfigSchema = z
  .object({
    observation: z
      .object({ messageTokens: z.number().int().min(1).max(250_000).optional() })
      .optional(),
    reflection: z
      .object({ observationTokens: z.number().int().min(1).max(2_000_000).optional() })
      .optional(),
  })
  .refine(
    (config) =>
      config.observation?.messageTokens !== undefined ||
      config.reflection?.observationTokens !== undefined,
  );

export const observationalMemoryConfigRoute = createRoute({
  queryParamSchema: z.object({}).strict(),
  path: "/work/threads/:threadId/observational-memory-config",
  responseType: "json",
  onValidationError: workValidationError,
  method: "GET",
  pathParamSchema: z.object({ threadId: z.string().trim().min(1) }),
  handler: async (params) => {
    const threadId = params.threadId;
    const resourceId = params.requestContext.get(MASTRA_RESOURCE_ID_KEY) as string;
    if (!resourceId) throw workError("AUTH_REQUIRED");
    const memory = await getWorkMemory(params.requestContext);
    if (!(await getOwnedThread(memory, threadId, resourceId))) throw workError("THREAD_NOT_FOUND");
    const om = await memory.omEngine;
    if (!om) return { config: {} };
    const status = await om.getStatus({ threadId, resourceId });
    return {
      config: {
        observation: { messageTokens: status.threshold },
        reflection: { observationTokens: status.effectiveObservationTokensThreshold },
      },
    };
  },
});

export const updateObservationalMemoryConfigRoute = createRoute({
  queryParamSchema: z.object({}).strict(),
  path: "/work/threads/:threadId/observational-memory-config",
  responseType: "json",
  onValidationError: workValidationError,
  method: "PUT",
  pathParamSchema: z.object({ threadId: z.string().trim().min(1) }),
  bodySchema: z.object({ config: threadOmConfigSchema }).strict(),
  handler: async (params) => {
    const threadId = params.threadId;
    const resourceId = params.requestContext.get(MASTRA_RESOURCE_ID_KEY) as string;
    if (!resourceId) throw workError("AUTH_REQUIRED");
    const memory = await getWorkMemory(params.requestContext);
    if (!(await getOwnedThread(memory, threadId, resourceId))) throw workError("THREAD_NOT_FOUND");
    const om = await memory.omEngine;
    if (!om) throw workError("OBSERVATIONAL_MEMORY_DISABLED");
    await om.getStatus({ threadId, resourceId });
    await memory.updateObservationalMemoryConfig({
      threadId,
      resourceId,
      config: params.config,
    });
    const status = await om.getStatus({ threadId, resourceId });
    return {
      ok: true,
      config: {
        observation: { messageTokens: status.threshold },
        reflection: { observationTokens: status.effectiveObservationTokensThreshold },
      },
    };
  },
});
