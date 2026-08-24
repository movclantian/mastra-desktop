/**
 * 记忆路由:读写用户可配置的 Memory 参数(数据库 app_config 表,保存后实时生效)。
 * Memory 主体见 src/mastra/memory/index.ts,
 * 参数语义参考 docs/en/docs/memory/{overview,semantic-recall,working-memory}.mdx。
 */
import { registerApiRoute } from "@mastra/core/server";
import { workError } from "../errors";
import {
  embeddingModelKey,
  getMemoryConfig,
  type MemoryUserConfig,
  saveMemoryConfig,
} from "../memory";
import { getWorkMemory } from "./threads/shared";

function parseObservationGroups(observations: string) {
  const groups: Array<{ id: string; range: string; text: string }> = [];
  const pattern = /<observation-group\b([^>]*)>([\s\S]*?)<\/observation-group>/g;
  for (const match of observations.matchAll(pattern)) {
    const attributes = Object.fromEntries(
      [...match[1].matchAll(/([A-Za-z][A-Za-z0-9_-]*)="([^"]*)"/g)].map((item) => [
        item[1],
        item[2],
      ]),
    );
    if (attributes.id && attributes.range) {
      groups.push({ id: attributes.id, range: attributes.range, text: match[2].trim() });
    }
  }
  return groups;
}

function rangeMessageIds(range: string): string[] {
  return range
    .split(",")
    .flatMap((segment) => segment.split(":"))
    .map((id) => id.trim())
    .filter(Boolean);
}

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

// POST /work/memory/reindex — 在新的 model/version/dimension 向量空间重建消息索引
export const rebuildMemoryIndexRoute = registerApiRoute("/work/memory/reindex", {
  method: "POST",
  handler: async (c) => {
    const user = c.get("requestContext")?.get("user") as { id?: unknown } | undefined;
    const resourceId = typeof user?.id === "string" ? user.id : undefined;
    if (!resourceId) throw workError("AUTH_REQUIRED");
    const config = await getMemoryConfig();
    const memory = await getWorkMemory(c.get("requestContext"));
    if (!memory.vector) {
      throw workError("VALIDATION_FAILED", { text: "Memory vector index is not configured" });
    }
    const vector = memory.vector;
    await memory.settled();
    const threads = await memory.listThreads({
      filter: { resourceId },
      perPage: false,
    });
    let indexedMessages = 0;
    const messageThreadIds = new Map<string, string>();
    for (const thread of threads.threads) {
      const recalled = await memory.recall({
        threadId: thread.id,
        resourceId,
        perPage: false,
      });
      for (const message of recalled.messages) messageThreadIds.set(message.id, thread.id);
      if (recalled.messages.length === 0) continue;
      await memory.updateMessages({
        messages: recalled.messages.map((message) => ({
          id: message.id,
          content: message.content,
        })),
        memoryConfig: { semanticRecall: true },
      });
      indexedMessages += recalled.messages.length;
    }
    await memory.settled();

    const indexesBeforeRebuild = await vector.listIndexes();
    const modelKey = embeddingModelKey(config.embeddingModel);
    const messagePrefix = `memory_messages_v${config.embeddingIndexVersion}_${modelKey}`;
    const observationPrefix = `memory_observations_v${config.embeddingIndexVersion}_${modelKey}`;
    if (config.omRetrievalVector) {
      const om = await memory.omEngine;
      if (om) {
        const records = new Map<string, NonNullable<Awaited<ReturnType<typeof om.getRecord>>>>();
        for (const thread of threads.threads) {
          const record = await om.getRecord(thread.id, resourceId);
          if (record) records.set(record.id, record);
        }
        const currentObservationIndexes = indexesBeforeRebuild.filter(
          (index) => index === observationPrefix || index.startsWith(`${observationPrefix}_`),
        );
        await Promise.all(
          currentObservationIndexes.map((indexName) => vector.deleteIndex({ indexName })),
        );
        for (const record of records.values()) {
          for (const group of parseObservationGroups(record.activeObservations)) {
            const threadId =
              record.threadId ??
              rangeMessageIds(group.range)
                .map((messageId) => messageThreadIds.get(messageId))
                .find((id): id is string => Boolean(id));
            if (!threadId) continue;
            await memory.indexObservation({
              text: group.text,
              groupId: group.id,
              range: group.range,
              threadId,
              resourceId,
              ...(record.lastObservedAt ? { observedAt: record.lastObservedAt } : {}),
            });
          }
        }
        await memory.settled();
      }
    }

    const indexes = await vector.listIndexes();
    const dimensionIndexes = indexes.filter(
      (index) =>
        index === messagePrefix ||
        index.startsWith(`${messagePrefix}_`) ||
        index === observationPrefix ||
        index.startsWith(`${observationPrefix}_`),
    );
    let embeddingDimension = config.embeddingDimension;
    const dimensions = new Set<number>();
    for (const index of dimensionIndexes) {
      dimensions.add((await vector.describeIndex({ indexName: index })).dimension);
    }
    if (dimensions.size > 1) {
      throw workError("VALIDATION_FAILED", {
        text: "Multiple embedding dimensions exist in the current index version",
      });
    }
    const [detectedDimension] = dimensions;
    const knownDimension =
      config.embeddingModel === "small" ? 384 : config.embeddingModel === "base" ? 768 : undefined;
    if (detectedDimension && knownDimension && detectedDimension !== knownDimension) {
      throw workError("VALIDATION_FAILED", {
        text: `Embedding index dimension ${detectedDimension} does not match ${config.embeddingModel} (${knownDimension})`,
      });
    }
    if (detectedDimension) {
      embeddingDimension = detectedDimension;
    }
    await saveMemoryConfig(
      {
        ...config,
        embeddingDimension,
        embeddingRebuildStatus: "ready",
      },
      { completeEmbeddingRebuild: true },
    );
    return c.json({
      ok: true,
      embeddingIndexVersion: config.embeddingIndexVersion,
      embeddingDimension,
      indexedMessages,
    });
  },
});
