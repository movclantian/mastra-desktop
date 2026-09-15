/**
 * 记忆路由:读写用户可配置的 Memory 参数(数据库 app_config 表,保存后实时生效)。
 * Memory 主体见 src/mastra/memory/index.ts,
 * 参数语义参考 docs/en/docs/memory/{overview,semantic-recall,working-memory}.mdx。
 */

import { getThreadOMMetadata } from "@mastra/core/memory";
import { MASTRA_RESOURCE_ID_KEY } from "@mastra/core/request-context";
import { registerApiRoute } from "@mastra/core/server";
import { z } from "zod";
import { workError } from "../errors";
import { getMemoryConfig, type MemoryUserConfig, saveMemoryConfig } from "../memory";
import { getOwnedThread, getWorkMemory, getWorkMemoryForThread } from "./threads/shared";

// GET /work/memory — 读取当前记忆配置
export const memoryConfigRoute = registerApiRoute("/work/memory", {
  method: "GET",
  handler: async (c) => {
    return c.json(
      await getMemoryConfig(c.get("requestContext").get(MASTRA_RESOURCE_ID_KEY) as string),
    );
  },
});

// POST /work/memory — 写入记忆配置
export const saveMemoryConfigRoute = registerApiRoute("/work/memory", {
  method: "POST",
  handler: async (c) => {
    await saveMemoryConfig(
      await c.req.json<MemoryUserConfig>(),
      c.get("requestContext").get(MASTRA_RESOURCE_ID_KEY) as string,
    );
    return c.json({ ok: true });
  },
});

/**
 * GET /work/memory/profile — 当前用户的工作记忆与 OM extractor 结果。
 * Extractors 按线程持久化在 thread.metadata.mastra.om.extracted,因此这里按
 * 最近更新时间合并同一 resource 下的线程,并返回来源线程供设置页追溯。
 */
export const memoryProfileRoute = registerApiRoute("/work/memory/profile", {
  method: "GET",
  handler: async (c) => {
    const resourceId = c.get("requestContext").get(MASTRA_RESOURCE_ID_KEY) as string;
    if (!resourceId) return c.json({ workingMemory: null, extractors: [] });

    const memory = await getWorkMemory(c.get("requestContext"));
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
    return c.json({
      workingMemory,
      extractors: [...extracted.values()],
      threadCount: threads.length,
    });
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

export const observationalMemoryConfigRoute = registerApiRoute(
  "/work/threads/:threadId/observational-memory-config",
  {
    method: "GET",
    handler: async (c) => {
      const threadId = c.req.param("threadId");
      const resourceId = c.get("requestContext").get(MASTRA_RESOURCE_ID_KEY) as string;
      if (!resourceId) throw workError("AUTH_REQUIRED");
      const memory = await getWorkMemoryForThread(c.get("requestContext"), threadId, resourceId);
      if (!(await getOwnedThread(memory, threadId, resourceId)))
        throw workError("THREAD_NOT_FOUND");
      const om = await memory.omEngine;
      if (!om) return c.json({ config: {} });
      const status = await om.getStatus({ threadId, resourceId });
      return c.json({
        config: {
          observation: { messageTokens: status.threshold },
          reflection: { observationTokens: status.effectiveObservationTokensThreshold },
        },
      });
    },
  },
);

export const updateObservationalMemoryConfigRoute = registerApiRoute(
  "/work/threads/:threadId/observational-memory-config",
  {
    method: "PUT",
    handler: async (c) => {
      const threadId = c.req.param("threadId");
      const resourceId = c.get("requestContext").get(MASTRA_RESOURCE_ID_KEY) as string;
      if (!resourceId) throw workError("AUTH_REQUIRED");
      const parsed = z.object({ config: threadOmConfigSchema }).safeParse(await c.req.json());
      if (!parsed.success) throw workError("VALIDATION_FAILED", { text: "观察记忆阈值无效" });
      const memory = await getWorkMemoryForThread(c.get("requestContext"), threadId, resourceId);
      if (!(await getOwnedThread(memory, threadId, resourceId)))
        throw workError("THREAD_NOT_FOUND");
      const om = await memory.omEngine;
      if (!om) return c.json({ error: "Observational Memory is disabled" }, 409);
      await om.getStatus({ threadId, resourceId });
      await memory.updateObservationalMemoryConfig({
        threadId,
        resourceId,
        config: parsed.data.config,
      });
      const status = await om.getStatus({ threadId, resourceId });
      return c.json({
        ok: true,
        config: {
          observation: { messageTokens: status.threshold },
          reflection: { observationTokens: status.effectiveObservationTokensThreshold },
        },
      });
    },
  },
);
