/**
 * 会话压缩路由(Claude Code / Codex 式真压缩)。
 * @mastra/memory 的 summarizeThread() 只生成摘要("Nothing is written back
 * to memory"),不会改变后续注入模型的上下文;OM 观察记忆亦只是"附加注入"摘要
 * (getContext 的 systemMessage),从不减少消息注入。真压缩需自行重写线程:
 * 1) summarizeThread 生成整线摘要
 * 2) 折叠消息的精简历史(id/role/text/createdAt)存入摘要消息 metadata(可回显)
 * 3) deleteMessages 删除被折叠的旧消息,saveMessages 将摘要消息插入线程头部
 * 此后 recall / Agent 上下文 = [摘要消息, ...保留的近期消息](受 lastMessages 窗口约束),
 * 实际发送 token 随即下降(metadata 不进入模型上下文);压缩详情持久化到线程
 * metadata.compaction,前端 Marker 可点击回看。
 */
import { registerApiRoute } from "@mastra/core/server";
import { workError } from "../../errors";
import { getConfiguredMemoryExtractors, getMemoryConfig } from "../../memory";
import { resolveRequestModel } from "../../models";
import { getOwnedThread, getWorkMemoryForThread } from "./shared";

function remapObservationRanges(observations: string, foldedIds: Set<string>, summaryId: string) {
  return observations.replace(/(range=")([^"]+)(")/g, (_match, prefix, range, suffix) => {
    const remapped = range
      .split(",")
      .map((segment: string) =>
        segment
          .split(":")
          .map((id: string) => (foldedIds.has(id.trim()) ? summaryId : id))
          .join(":"),
      )
      .join(",");
    return `${prefix}${remapped}${suffix}`;
  });
}

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

async function refreshObservationVectors(
  memory: Awaited<ReturnType<typeof getWorkMemoryForThread>>,
  threadId: string,
  resourceId: string,
  observations: string,
  observedAt?: Date,
) {
  const config = await getMemoryConfig(resourceId);
  if (!config.omRetrievalVector || !memory.vector) {
    return;
  }
  const vector = memory.vector;
  const indexes = await vector.listIndexes();
  const vectorFilter =
    config.omScope === "thread" ? { thread_id: threadId } : { resource_id: resourceId };
  await Promise.all(
    indexes
      .filter((index) => index.startsWith("memory_observations"))
      .map((indexName) => vector.deleteVectors({ indexName, filter: vectorFilter })),
  );
  const groups =
    config.omScope === "thread"
      ? parseObservationGroups(observations).map((group) => ({ ...group, threadId }))
      : await (async () => {
          const threads = await memory.listThreads({
            filter: { resourceId },
            perPage: false,
          });
          const messageThreadIds = new Map<string, string>();
          for (const thread of threads.threads) {
            const recalled = await memory.recall({
              threadId: thread.id,
              resourceId,
              perPage: false,
            });
            for (const message of recalled.messages) messageThreadIds.set(message.id, thread.id);
          }
          return parseObservationGroups(observations).flatMap((group) => {
            const groupThreadId = rangeMessageIds(group.range)
              .map((messageId) => messageThreadIds.get(messageId))
              .find((id): id is string => Boolean(id));
            return groupThreadId ? [{ ...group, threadId: groupThreadId }] : [];
          });
        })();
  for (const group of groups) {
    await memory.indexObservation({
      text: group.text,
      groupId: group.id,
      range: group.range,
      threadId: group.threadId,
      resourceId,
      ...(observedAt ? { observedAt } : {}),
    });
  }
}

export async function rewriteObservationalMemoryReferences(
  memory: Awaited<ReturnType<typeof getWorkMemoryForThread>>,
  threadId: string,
  resourceId: string,
  foldedIds: string[],
  summaryId: string,
) {
  const om = await memory.omEngine;
  if (!om) return;
  const record = await om.getRecord(threadId, resourceId);
  if (!record) return;
  const folded = new Set(foldedIds);
  const bufferedReferences = (record.bufferedObservationChunks ?? []).some((chunk) =>
    chunk.messageIds.some((id) => folded.has(id)),
  );
  if (bufferedReferences || (record.bufferedMessageIds ?? []).some((id) => folded.has(id))) {
    throw new Error("OM references buffered raw messages and cannot be safely compacted");
  }
  const observations = remapObservationRanges(record.activeObservations, folded, summaryId);
  const observedMessageIds = record.observedMessageIds?.map((id) =>
    folded.has(id) ? summaryId : id,
  );
  const hasChanged =
    observations !== record.activeObservations ||
    JSON.stringify(observedMessageIds) !== JSON.stringify(record.observedMessageIds);
  if (!hasChanged) return;
  const storage = om.getStorage();
  await storage.updateActiveObservations({
    id: record.id,
    observations,
    tokenCount: record.observationTokenCount,
    lastObservedAt: record.lastObservedAt ?? new Date(),
    ...(observedMessageIds ? { observedMessageIds } : {}),
  });
  const restore = async () => {
    await storage
      .updateActiveObservations({
        id: record.id,
        observations: record.activeObservations,
        tokenCount: record.observationTokenCount,
        lastObservedAt: record.lastObservedAt ?? new Date(),
        ...(record.observedMessageIds ? { observedMessageIds: record.observedMessageIds } : {}),
      })
      .catch(() => undefined);
    await refreshObservationVectors(
      memory,
      threadId,
      resourceId,
      record.activeObservations,
      record.lastObservedAt,
    ).catch(() => undefined);
  };
  try {
    await refreshObservationVectors(
      memory,
      threadId,
      resourceId,
      observations,
      record.lastObservedAt,
    );
  } catch (error) {
    // Do not leave a record pointing at the provisional summary when vector
    // cleanup/reindex fails; raw messages are still present at this point.
    await restore();
    throw error;
  }
  return restore;
}

/** Remove observation groups that still point at raw messages being deleted. */
export async function removeObservationalMemoryReferences(
  memory: Awaited<ReturnType<typeof getWorkMemoryForThread>>,
  threadId: string,
  resourceId: string,
  deletedIds: string[],
) {
  const om = await memory.omEngine;
  if (!om || deletedIds.length === 0) return;
  const record = await om.getRecord(threadId, resourceId);
  if (!record) return;
  const deleted = new Set(deletedIds);
  const bufferedReferences = (record.bufferedObservationChunks ?? []).some((chunk) =>
    chunk.messageIds.some((id) => deleted.has(id)),
  );
  if (bufferedReferences || (record.bufferedMessageIds ?? []).some((id) => deleted.has(id))) {
    throw new Error("OM references buffered raw messages and cannot be safely deleted");
  }
  const observations = record.activeObservations.replace(
    /<observation-group\b([^>]*)>[\s\S]*?<\/observation-group>/g,
    (group, attributes: string) => {
      const range = attributes.match(/\brange="([^"]*)"/)?.[1] ?? "";
      return rangeMessageIds(range).some((id) => deleted.has(id)) ? "" : group;
    },
  );
  const observedMessageIds = record.observedMessageIds?.filter((id) => !deleted.has(id));
  const hasChanged =
    observations !== record.activeObservations ||
    JSON.stringify(observedMessageIds) !== JSON.stringify(record.observedMessageIds);
  if (!hasChanged) return;
  const storage = om.getStorage();
  await storage.updateActiveObservations({
    id: record.id,
    observations,
    tokenCount: record.observationTokenCount,
    lastObservedAt: record.lastObservedAt ?? new Date(),
    ...(observedMessageIds ? { observedMessageIds } : {}),
  });
  const restore = async () => {
    await storage
      .updateActiveObservations({
        id: record.id,
        observations: record.activeObservations,
        tokenCount: record.observationTokenCount,
        lastObservedAt: record.lastObservedAt ?? new Date(),
        ...(record.observedMessageIds ? { observedMessageIds: record.observedMessageIds } : {}),
      })
      .catch(() => undefined);
    await refreshObservationVectors(
      memory,
      threadId,
      resourceId,
      record.activeObservations,
      record.lastObservedAt,
    ).catch(() => undefined);
  };
  try {
    await refreshObservationVectors(
      memory,
      threadId,
      resourceId,
      observations,
      record.lastObservedAt,
    );
  } catch (error) {
    await restore();
    throw error;
  }
  return restore;
}

// POST /work/threads/:threadId/summarize
export const summarizeThreadRoute = registerApiRoute("/work/threads/:threadId/summarize", {
  method: "POST",
  handler: async (c) => {
    const threadId = c.req.param("threadId");
    // model 为前端 buildRequestModel 的 BYOK 对象;resolveRequestModel 按当前资源
    // 统一解析为官方端点的 LanguageModel 实例。
    const body = (await c.req.json()) as {
      model?: unknown;
      resourceId?: string;
      /** 压缩后保留的近期消息条数,默认 4 */
      keepMessages?: number;
    };
    if (!body.resourceId) {
      throw workError("VALIDATION_RESOURCE_ID_REQUIRED");
    }
    const model = await resolveRequestModel(body.model, body.resourceId);
    if (!model) {
      throw workError("VALIDATION_FAILED", { text: "model is required" });
    }
    const memory = await getWorkMemoryForThread(c.get("requestContext"), threadId, body.resourceId);
    // 观察记忆的 observe/reflect 循环在 Agent 运行返回后仍在后台写库,而本路由要
    // deleteMessages 重写线程 —— 必须先等后台落盘,否则观察写入会与删除竞争
    // (@mastra/memory 1.27 的 memory.settled(),同时覆盖 deleteMessages 的向量清理)。
    await memory.settled();
    const thread = await getOwnedThread(memory, threadId, body.resourceId);
    if (!thread) {
      throw workError("THREAD_NOT_FOUND");
    }

    const keep = body.keepMessages ?? 4;
    if (!Number.isInteger(keep) || keep < 0 || keep > 500) {
      throw workError("VALIDATION_FAILED", {
        text: "keepMessages must be an integer between 0 and 500",
      });
    }
    const om = await memory.omEngine;
    if (om) {
      await om.finalize({ threadId, resourceId: body.resourceId });
      // finalize may activate buffered observations or finish a reflection;
      // join those writes before reading and deleting the raw message set.
      await memory.settled();
    }
    const { messages } = await memory.recall({
      threadId,
      resourceId: body.resourceId,
      perPage: false,
    });
    const all = messages ?? [];
    if (all.length <= keep + 1) {
      throw workError("VALIDATION_FAILED", { text: "会话太短,无需压缩" });
    }

    // 1) 生成整线摘要(观察记忆管线)
    const extractors = getConfiguredMemoryExtractors(body.resourceId);
    const { summary, extracted, extractionFailures, usage } = await memory.summarizeThread({
      threadId,
      model: model as never,
      resourceId: body.resourceId,
      ...(extractors.length > 0 ? { extract: extractors } : {}),
    });

    // 2) 折叠旧消息:精简历史(id/role/text/createdAt)存入摘要消息 metadata,
    //    随后从线程删除。metadata 不参与模型上下文注入(仅 text part 进入),
    //    故上下文真的减少;历史仍随摘要消息持久化,前端可展开回显。
    const tail = all.slice(-keep);
    const folded = all.slice(0, all.length - keep);
    const compactedAt = new Date().toISOString();
    const compactionId = `compaction-${memory.generateId()}`;
    const foldedIds = folded.map((m) => m.id);
    const summaryMessageId = `compacted-${memory.generateId()}`;
    // Preserve the complete logical history across repeated compactions. A
    // later compaction physically contains the previous summary message, but
    // that message is only a container for its prior compactedHistory. Do not
    // turn the summary itself into a fake user message or older originals would
    // become impossible to locate for a Clone Thread edit.
    const compactedHistory = folded.flatMap((m) => {
      const metadata = m.content.metadata;
      const previous = metadata?.compactedHistory;
      if (Array.isArray(previous)) {
        return previous.flatMap((entry) => {
          if (typeof entry !== "object" || entry === null) return [];
          const candidate = entry as {
            id?: unknown;
            role?: unknown;
            text?: unknown;
            createdAt?: unknown;
            compactionId?: unknown;
          };
          if (
            typeof candidate.id !== "string" ||
            typeof candidate.role !== "string" ||
            typeof candidate.text !== "string" ||
            typeof candidate.createdAt !== "string"
          ) {
            return [];
          }
          return [
            {
              id: candidate.id,
              role: candidate.role,
              text: candidate.text,
              createdAt: candidate.createdAt,
              ...(typeof candidate.compactionId === "string"
                ? { compactionId: candidate.compactionId }
                : {}),
            },
          ];
        });
      }
      return [
        {
          id: m.id,
          role: m.role,
          text: (m.content.parts ?? [])
            .filter((p) => p.type === "text")
            .map((p) => (p as { text: string }).text)
            .join("\n"),
          createdAt: m.createdAt.toISOString(),
          compactionId,
        },
      ];
    });
    const windowStart = compactedHistory[0]?.createdAt ?? folded[0]?.createdAt.toISOString();
    const windowEnd = tail[0]?.createdAt.toISOString();

    // 3) 摘要消息插入线程头部:createdAt 早于保留尾,保证排序最前
    await memory.saveMessages({
      messages: [
        {
          id: summaryMessageId,
          role: "user",
          createdAt: new Date(new Date(tail[0]?.createdAt ?? Date.now()).getTime() - 1000),
          threadId,
          ...(body.resourceId ? { resourceId: body.resourceId } : {}),
          content: {
            format: 2,
            parts: [
              {
                type: "text",
                text: `[Conversation compacted — earlier messages were summarized to free context window]\n\n${summary}`,
              },
            ],
            metadata: {
              compactedHistory,
              compactionId,
              compactionSummaryMessageId: summaryMessageId,
              ...(windowStart ? { windowStart } : {}),
              ...(windowEnd ? { windowEnd } : {}),
            },
          },
        },
      ],
    });
    let restoreObservations: (() => Promise<void>) | undefined;
    try {
      restoreObservations = await rewriteObservationalMemoryReferences(
        memory,
        threadId,
        body.resourceId,
        foldedIds,
        summaryMessageId,
      );
    } catch (error) {
      // The raw messages remain intact on failure. Remove the provisional
      // summary as well so a retry does not expose a second logical history.
      await memory.deleteMessages([summaryMessageId]).catch(() => undefined);
      await memory.settled();
      throw workError("VALIDATION_FAILED", {
        text: error instanceof Error ? error.message : "OM references cannot be safely compacted",
      });
    }
    try {
      await memory.deleteMessages(foldedIds);
    } catch (error) {
      await restoreObservations?.();
      await memory.deleteMessages([summaryMessageId]).catch(() => undefined);
      await memory.settled();
      throw error;
    }
    await memory.settled();

    // 4) 持久化压缩详情;contextUsage 写入压缩后预估 token(下次真实响应自动覆盖)
    const estimateTailTokens = tail.reduce((sum, m) => {
      const text = (m.content.parts ?? [])
        .filter((p) => p.type === "text")
        .map((p) => (p as { text: string }).text)
        .join(" ");
      return sum + Math.ceil(text.length / 4);
    }, 0);
    const estimatedContextTokens = (usage?.outputTokens ?? 0) + estimateTailTokens;
    await memory.updateThread({
      id: threadId,
      title: thread.title,
      metadata: {
        ...thread.metadata,
        compactedAt,
        compaction: {
          summary,
          ...(Object.keys(extracted).length > 0 ? { extracted } : {}),
          ...(extractionFailures?.length ? { extractionFailures } : {}),
          inputTokens: usage?.inputTokens,
          outputTokens: usage?.outputTokens,
          estimatedContextTokens,
          deletedMessages: foldedIds.length,
          compactedAt,
          ...(windowStart ? { windowStart } : {}),
          ...(windowEnd ? { windowEnd } : {}),
          compactionId,
          summaryMessageId,
        },
        contextUsage: {
          inputTokens: estimatedContextTokens,
          outputTokens: 0,
          totalTokens: estimatedContextTokens,
        },
      },
    });

    return c.json({
      summary,
      extracted,
      ...(extractionFailures?.length ? { extractionFailures } : {}),
      inputTokens: usage?.inputTokens,
      outputTokens: usage?.outputTokens,
      estimatedContextTokens,
      deletedMessages: foldedIds.length,
      keptMessages: tail.length,
    });
  },
});
