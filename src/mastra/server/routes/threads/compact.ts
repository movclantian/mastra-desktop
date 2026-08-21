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
import { workError } from "../../../errors";
import { getConfiguredMemoryExtractors } from "../../../memory";
import { resolveRequestModel } from "../../../models";
import { getOwnedThread, getWorkMemory } from "./shared";

// POST /work/threads/:threadId/summarize
export const summarizeThreadRoute = registerApiRoute("/work/threads/:threadId/summarize", {
  method: "POST",
  handler: async (c) => {
    const threadId = c.req.param("threadId");
    // model 为前端 buildRequestModel 的 BYOK 对象;resolveRequestModel 统一解析为
    // 官方端点的 LanguageModel 实例(自定义网关)或 model router 对象(内置供应商)
    const body = (await c.req.json()) as {
      model?: unknown;
      resourceId?: string;
      /** 压缩后保留的近期消息条数,默认 4 */
      keepMessages?: number;
    };
    if (!body.resourceId) {
      throw workError("VALIDATION_RESOURCE_ID_REQUIRED");
    }
    const model = await resolveRequestModel(body.model);
    if (!model) {
      throw workError("VALIDATION_FAILED", { text: "model is required" });
    }
    const memory = await getWorkMemory();
    // 观察记忆的 observe/reflect 循环在 Agent 运行返回后仍在后台写库,而本路由要
    // deleteMessages 重写线程 —— 必须先等后台落盘,否则观察写入会与删除竞争
    // (@mastra/memory 1.27 的 memory.settled(),同时覆盖 deleteMessages 的向量清理)。
    await memory.settled();
    const thread = await getOwnedThread(memory, threadId, body.resourceId);
    if (!thread) {
      throw workError("THREAD_NOT_FOUND");
    }

    const keep = Math.max(0, body.keepMessages ?? 4);
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
    const extractors = getConfiguredMemoryExtractors();
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
    const compactionId = `compaction-${threadId}-${Date.now()}`;
    const foldedIds = folded.map((m) => m.id);
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
          id: `compacted-${threadId}-${Date.now()}`,
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
              ...(windowStart ? { windowStart } : {}),
              ...(windowEnd ? { windowEnd } : {}),
            },
          },
        },
      ],
    });
    await memory.deleteMessages(foldedIds);

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
