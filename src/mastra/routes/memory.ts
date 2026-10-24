import { createHash } from "node:crypto";
import { registerApiRoute } from "@mastra/core/server";
import type { MemoryProfile } from "../../shared/agent-contract";
import { workError, workValidationError } from "../errors";
import { hasActiveMemorySession } from "./shutdown";
/**
 * 记忆路由:读写用户可配置的 Memory 参数(数据库 app_config 表,保存后实时生效)。
 * Memory 主体见 src/mastra/memory/memory-runtime.ts,
 * 参数语义参考 docs/en/docs/memory/{overview,semantic-recall,working-memory}.mdx。
 */

import { getThreadOMMetadata } from "@mastra/core/memory";
import { MASTRA_RESOURCE_ID_KEY } from "@mastra/core/request-context";
import { createRoute } from "@mastra/server/server-adapter";
import { z } from "zod";

import { getMemoryConfig, memoryConfigSchema, saveMemoryConfig } from "../memory/memory-runtime";
import { getOwnedThread, getWorkMemory, withThreadWrite } from "./threads/shared";

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

function workingSnapshot(
  scope: string,
  content: string | null,
  config: {
    workingMemoryFormat: string;
    workingMemorySchema: string;
    workingMemory: boolean;
    readOnly: boolean;
  },
) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        scope,
        content,
        config.workingMemoryFormat,
        config.workingMemorySchema,
        config.workingMemory,
        config.readOnly,
      ]),
    )
    .digest("hex");
}

/** Explicit thread selection prevents thread-scoped memory masquerading as a global profile. */
export const memoryProfileRoute = createRoute({
  queryParamSchema: z.object({ threadId: z.string().min(1).max(256).optional() }).strict(),
  path: "/work/memory/profile",
  responseType: "json",
  onValidationError: workValidationError,
  method: "GET",
  handler: async ({ requestContext, threadId }) => {
    const resourceId = requestContext.get(MASTRA_RESOURCE_ID_KEY) as string;
    if (!resourceId) throw workError("AUTH_REQUIRED");
    const memory = await getWorkMemory(requestContext);
    const { threads: all } = await memory.listThreads({
      filter: { resourceId },
      perPage: false,
      orderBy: { field: "updatedAt", direction: "DESC" },
    });
    const threads = all.filter(
      (thread) => thread.metadata?.goalJudge !== true && thread.metadata?.phoneReceipts !== true,
    );
    const selected = threadId ? threads.find((thread) => thread.id === threadId) : threads[0];
    if (threadId && !selected) throw workError("THREAD_NOT_FOUND");
    const config = await getMemoryConfig(resourceId);
    const scope = config.workingMemoryScope;
    const workingMemory = selected
      ? await memory.getWorkingMemory({
          threadId: selected.id,
          resourceId,
          memoryConfig: { workingMemory: { enabled: config.workingMemory, scope } },
        })
      : null;
    const names = new Map(
      config.omExtractors.map((item) => [
        item.name
          .replace(/[^a-z0-9]+/gi, "-")
          .replace(/^-|-$/g, "")
          .toLowerCase(),
        item.name,
      ]),
    );
    const extractors = new Map<string, MemoryProfile["extractors"][number]>();
    for (const thread of threadId && selected ? [selected] : threads) {
      const values = getThreadOMMetadata(thread.metadata)?.extracted;
      if (!values || typeof values !== "object") continue;
      for (const [slug, value] of Object.entries(values)) {
        if (value === null || value === "" || extractors.has(slug)) continue;
        extractors.set(slug, {
          slug,
          name: names.get(slug) ?? slug,
          value,
          threadId: thread.id,
          threadTitle: thread.title || thread.id,
          updatedAt: thread.updatedAt.toISOString(),
        });
      }
    }
    return {
      workingMemory,
      scope,
      format: config.workingMemoryFormat,
      enabled: config.workingMemory,
      readOnly: config.readOnly,
      source: selected
        ? { threadId: selected.id, threadTitle: selected.title || selected.id }
        : null,
      snapshot: workingSnapshot(scope, workingMemory, config),
      threads: threads.map((thread) => ({ id: thread.id, title: thread.title || thread.id })),
      extractors: [...extractors.values()],
      threadCount: threads.length,
    } satisfies MemoryProfile;
  },
});

/** Human correction replaces only working memory through Mastra's native API. */
export const updateMemoryProfileRoute = registerApiRoute("/work/memory/profile/working", {
  method: "POST",
  handler: async (c) => {
    const resourceId = c.get("requestContext").get(MASTRA_RESOURCE_ID_KEY) as string;
    if (!resourceId) throw workError("AUTH_REQUIRED");
    const input = z
      .object({
        threadId: z.string().min(1).max(256),
        scope: z.enum(["thread", "resource"]),
        snapshot: z.string().regex(/^[a-f0-9]{64}$/),
        workingMemory: z.string().max(100_000),
        confirmed: z.literal(true),
        clear: z.boolean(),
      })
      .strict()
      .parse(await c.req.json());
    return withThreadWrite(resourceId, "working-memory-correction", () =>
      withThreadWrite(resourceId, input.threadId, async () => {
        const config = await getMemoryConfig(resourceId);
        if (!config.workingMemory || config.readOnly || config.workingMemoryScope !== input.scope)
          throw workError("VALIDATION_FAILED", {
            text: "Memory configuration changed, disabled or read-only. Reload before editing.",
          });
        if (
          hasActiveMemorySession(resourceId, input.scope === "thread" ? input.threadId : undefined)
        )
          throw workError("VALIDATION_FAILED", {
            text: "Wait for active conversations to finish before correcting memory.",
          });
        const memory = await getWorkMemory(c.get("requestContext"));
        await memory.settled();
        if (!(await getOwnedThread(memory, input.threadId, resourceId)))
          throw workError("THREAD_NOT_FOUND");
        const memoryConfig = { workingMemory: { enabled: true, scope: input.scope } };
        const current = await memory.getWorkingMemory({
          threadId: input.threadId,
          resourceId,
          memoryConfig,
        });
        if (workingSnapshot(input.scope, current, config) !== input.snapshot)
          throw workError("VALIDATION_FAILED", {
            text: "Working memory changed. Reload and review before saving.",
          });
        let value = input.clear ? "" : input.workingMemory;
        if (!input.clear && !value.trim())
          throw workError("VALIDATION_FAILED", {
            text: "Use the explicit clear action for empty working memory.",
          });
        if (!input.clear && config.workingMemoryFormat === "schema") {
          try {
            const parsed: unknown = JSON.parse(value);
            z.fromJSONSchema(JSON.parse(config.workingMemorySchema)).parse(parsed);
            value = JSON.stringify(parsed, null, 2);
          } catch {
            throw workError("VALIDATION_FAILED", {
              text: "Working memory must match the configured JSON Schema.",
            });
          }
        }
        if (
          hasActiveMemorySession(resourceId, input.scope === "thread" ? input.threadId : undefined)
        )
          throw workError("VALIDATION_FAILED", {
            text: "A conversation started while preparing this change. Try after it finishes.",
          });
        await memory.updateWorkingMemory({
          threadId: input.threadId,
          resourceId,
          workingMemory: value,
          memoryConfig,
        });
        return c.json({ ok: true });
      }),
    );
  },
});
