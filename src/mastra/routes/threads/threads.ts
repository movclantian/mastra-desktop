/** Desktop thread lifecycle hooks around the built-in Memory API. */
import type { MastraDBMessage } from "@mastra/core/agent";
import { MASTRA_RESOURCE_ID_KEY, RequestContext } from "@mastra/core/request-context";
import { type ContextWithMastra, registerApiRoute } from "@mastra/core/server";
import { Extractor } from "@mastra/memory";
import { z } from "zod";
import { getBrowserForResource } from "../../agents/browser";
import { authUserFromContext, findUserById, listAuthUsers } from "../../auth";
import { workError } from "../../errors";
import { workPollingSignals, workWebhookSignals } from "../../harness";
import { resolveDefaultLanguageModel, resolveRequestModel } from "../../models";
import { attachAssetReference, getLibraryAssetId, listAssets } from "../../rag";
import { queueAssetIndex } from "../../rag/document/indexing";
import { getLibrarySettings } from "../../rag/settings";
import {
  commitThreadAssetTransfer,
  cleanupUnregisteredThreadAssetTransferCopies,
  decideThreadAssetTransferRequest,
  failThreadAssetTransfer,
  getThreadAssetTransfer,
  listThreadAssetTransfersForResource,
  markThreadAssetTransferMemoryMoved,
  markThreadAssetTransferMessagesRewritten,
  requestThreadAssetTransfer,
  rollbackThreadAssetReferences,
  ThreadAssetTransferRequestConflict,
  ThreadAssetTransferCleanupPending,
  type ThreadAssetTransferRecord,
  type ThreadAssetTransferItem,
  transferThreadAssetReferences,
  withThreadAssetTransferLock,
} from "../../rag/storage/assets";
import { appStorage } from "../../storage";
import { deleteThreadWorkspace } from "../../workspace";
import { workbenchMessages } from "./messages";
import {
  clearTransferredWorkspaceBinding,
  recoverPendingThreadTransfers,
  rewriteTransferredThreadMessages,
} from "./transfer-recovery";
import {
  getOwnedThread,
  getWorkMemory,
  getWorkMemoryForThread,
  normalizeChatHistoryMessages,
} from "./shared";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const searchThreadsRoute = registerApiRoute("/work/threads/search", {
  method: "GET",
  handler: async (c) => {
    const resourceId = c.get("requestContext").get(MASTRA_RESOURCE_ID_KEY) as string;
    const query = z.string().trim().min(1).parse(c.req.query("searchQuery"));
    const limit = z.coerce.number().int().min(1).max(50).default(20).parse(c.req.query("limit"));
    const memory = await getWorkMemory(c.get("requestContext"));
    const { threads } = await memory.listThreads({
      filter: { resourceId },
      perPage: false,
      orderBy: { field: "updatedAt", direction: "DESC" },
    });
    const needle = query.toLocaleLowerCase();
    const results: Array<{
      id: string;
      threadId: string;
      threadTitle: string;
      role: string;
      content: string;
      createdAt: string;
    }> = [];

    for (const thread of threads) {
      if (results.length >= limit) break;
      const messages = normalizeChatHistoryMessages(
        (await memory.recall({ threadId: thread.id, resourceId, perPage: false })).messages,
      );
      for (const message of messages) {
        const content = message.content.parts
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n")
          .trim();
        if (!content?.toLocaleLowerCase().includes(needle)) continue;
        results.push({
          id: message.id,
          threadId: thread.id,
          threadTitle: thread.title?.trim() || "New Chat",
          role: message.role,
          content,
          createdAt: message.createdAt.toISOString(),
        });
        if (results.length >= limit) break;
      }
    }

    return c.json({ results, searchType: "text" });
  },
});

// Automatic titles use Memory.generateTitle; this route handles an explicit user request.
export const generateThreadTitleRoute = registerApiRoute("/work/threads/:threadId/generate-title", {
  method: "POST",
  handler: async (c) => {
    const { resourceId } = z.object({ resourceId: z.string().min(1) }).parse(await c.req.json());
    const threadId = c.req.param("threadId");
    const memory = await getWorkMemoryForThread(c.get("requestContext"), threadId, resourceId);
    await memory.settled();
    const thread = await getOwnedThread(memory, threadId, resourceId);
    if (!thread) throw workError("THREAD_NOT_FOUND");
    const recalled = await memory.recall({ threadId, resourceId, perPage: false });
    const message = normalizeChatHistoryMessages(recalled.messages).find(
      (entry) => entry.role === "user",
    );
    if (!message) throw workError("SESSION_INPUT_REQUIRED");
    const text = message.content.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join(" ");
    const title = await c
      .get("mastra")
      .getAgentById("mastra-work-agent")
      .generateTitleFromUserMessage({
        message: text,
        requestContext: c.get("requestContext"),
      });
    await memory.updateThread({
      id: threadId,
      title,
      metadata: { ...thread.metadata, draft: false },
    });
    return c.json({ title });
  },
});

interface StoredReaction {
  emoji: string;
  userIds: string[];
}

function parseStoredReactions(raw: unknown): StoredReaction[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (reaction): reaction is StoredReaction =>
      typeof reaction === "object" &&
      reaction !== null &&
      typeof (reaction as { emoji?: unknown }).emoji === "string" &&
      Array.isArray((reaction as { userIds?: unknown }).userIds) &&
      (reaction as { userIds: unknown[] }).userIds.every((id) => typeof id === "string"),
  );
}

/**
 * 消息表情反应(官方 BubbleReactions 的业务落点):持久化到消息
 * metadata.reactions。刻意直接走存储 store 而不是 Memory.updateMessages ——
 * 后者在 semanticRecall 开启时会把"无 text parts"的更新当成清空内容,
 * 顺手删掉该消息的向量嵌入。store.updateMessages 只传 reactions 一个键,
 * LibSQL 在写时与库中现有 metadata 浅合并,不会覆盖并发写入的其他键。
 */
export const toggleMessageReactionRoute = registerApiRoute(
  "/work/threads/:threadId/messages/:messageId/reactions",
  {
    method: "POST",
    handler: async (c) => {
      const { resourceId, emoji } = z
        .object({ resourceId: z.string().min(1), emoji: z.string().min(1).max(16) })
        .parse(await c.req.json());
      const threadId = c.req.param("threadId");
      const messageId = c.req.param("messageId");
      const memory = await getWorkMemoryForThread(c.get("requestContext"), threadId, resourceId);
      await memory.settled();
      const thread = await getOwnedThread(memory, threadId, resourceId);
      if (!thread) throw workError("THREAD_NOT_FOUND");
      const store = await appStorage.getStore("memory");
      if (!store) throw new Error("Memory storage is not configured");
      const { messages } = await store.listMessagesById({ messageIds: [messageId] });
      const message = messages.find((entry) => entry.threadId === threadId);
      if (!message) throw workError("MESSAGE_NOT_FOUND");
      const previous = parseStoredReactions(message.content.metadata?.reactions);
      const existing = previous.find((reaction) => reaction.emoji === emoji);
      const isAdding = !existing?.userIds.includes(resourceId);
      const next = existing
        ? existing.userIds.includes(resourceId)
          ? previous
              .map((reaction) =>
                reaction.emoji === emoji
                  ? { ...reaction, userIds: reaction.userIds.filter((id) => id !== resourceId) }
                  : reaction,
              )
              .filter((reaction) => reaction.userIds.length > 0)
          : previous.map((reaction) =>
              reaction.emoji === emoji
                ? { ...reaction, userIds: [...reaction.userIds, resourceId] }
                : reaction,
            )
        : [...previous, { emoji, userIds: [resourceId] }];
      await store.updateMessages({
        // 类型要求 content 带 format/parts(从读到的消息回填);metadata 只传
        // reactions 一个键,LibSQL 写时与库中现有 metadata 浅合并,不覆盖其他键
        messages: [
          { id: messageId, content: { ...message.content, metadata: { reactions: next } } },
        ],
      });

      if (message.role === "assistant" && isAdding) {
        const mastra = c.get("mastra");
        const observability = mastra.observability;
        const traceId = message.content.metadata?.traceId;
        const feedback =
          emoji === "👍" || emoji === "👎"
            ? { feedbackType: "thumbs", value: emoji === "👍" ? 1 : -1 }
            : { feedbackType: "reaction", value: emoji };
        const telemetry: Promise<unknown>[] = [];

        if (typeof traceId === "string" && typeof observability?.addFeedback === "function") {
          telemetry.push(
            observability.addFeedback({
              traceId,
              feedback: {
                feedbackSource: "user",
                ...feedback,
              },
            }),
          );
        }

        const signal = mastra.getAgentById("mastra-work-agent").sendSignal(
          {
            type: "reactive",
            tagName: "user-feedback",
            contents:
              emoji === "👎"
                ? "用户对上一条回答标记了不满（点踩 👎）。"
                : `用户对上一条回答添加了表情反应（${emoji}）。`,
            attributes: { targetMessageId: messageId, reaction: emoji },
          },
          {
            resourceId,
            threadId,
            ifIdle: { behavior: "persist" },
            ifActive: { behavior: "deliver" },
          },
        );
        telemetry.push(signal.persisted ?? signal.accepted);

        const results = await Promise.allSettled(telemetry);
        for (const result of results) {
          if (result.status === "rejected") {
            mastra.getLogger().warn("Message reaction telemetry failed", { error: result.reason });
          }
        }
      }
      return c.json({ reactions: next });
    },
  },
);

/**
 * 会话克隆/分叉(官方 cloneThread / copyThread):完整克隆不带 upToMessageId,
 * 从某条消息分叉时按时间正序取「截至该消息(含)」的全部消息 id 作为
 * messageFilter。只用新线程 id,故走 copyThread(消息内容不进 Node 堆)。
 *
 * LibSQL 的 copyThread 对 metadata 是整体替换而非继承源线程,因此显式回填
 * 会话设置(模式/审批规则/模型快照);隐式工作区目录**不**跟随 —— 删除线程
 * 会物理清理隐式目录,共享会把原会话的工作区文件一并删掉,显式绑定的外部
 * 项目目录才可安全共享。
 */
export const cloneThreadRoute = registerApiRoute("/work/threads/:threadId/clone", {
  method: "POST",
  handler: async (c) => {
    const { resourceId, upToMessageId } = z
      .object({
        resourceId: z.string().min(1),
        upToMessageId: z.string().min(1).optional(),
      })
      .parse(await c.req.json());
    const threadId = c.req.param("threadId");
    const memory = await getWorkMemoryForThread(c.get("requestContext"), threadId, resourceId);
    await memory.settled();
    const thread = await getOwnedThread(memory, threadId, resourceId);
    if (!thread) throw workError("THREAD_NOT_FOUND");

    let options: { messageFilter: { messageIds: string[] } } | undefined;
    if (upToMessageId) {
      const recalled = await memory.recall({ threadId, resourceId, perPage: false });
      const ids = recalled.messages.map((message) => message.id);
      const index = ids.indexOf(upToMessageId);
      if (index === -1) throw workError("MESSAGE_NOT_FOUND");
      options = { messageFilter: { messageIds: ids.slice(0, index + 1) } };
    }

    const { workspacePath, workspaceExplicit, ...restMetadata } = thread.metadata ?? {};
    const { thread: clone } = await memory.copyThread({
      sourceThreadId: threadId,
      resourceId,
      title: `分支 · ${thread.title}`,
      metadata: {
        ...restMetadata,
        ...(workspaceExplicit && workspacePath ? { workspacePath, workspaceExplicit } : {}),
        draft: false,
        pinned: false,
        archivedAt: null,
      },
      ...(options ? { options } : {}),
    });
    await memory.settled();
    return c.json({ thread: clone });
  },
});

/** 分支来源(官方 isClone / getSourceThread):分支会话顶部「派生自 …」导航条的数据源 */
export const threadSourceRoute = registerApiRoute("/work/threads/:threadId/source", {
  method: "GET",
  handler: async (c) => {
    const resourceId = z.string().min(1).parse(c.req.query("resourceId"));
    const threadId = c.req.param("threadId");
    const memory = await getWorkMemoryForThread(c.get("requestContext"), threadId, resourceId);
    await memory.settled();
    const thread = await getOwnedThread(memory, threadId, resourceId);
    if (!thread) throw workError("THREAD_NOT_FOUND");
    if (!memory.isClone(thread)) return c.json({ source: null });
    const source = await memory.getSourceThread(threadId);
    return c.json({ source: source ? { id: source.id, title: source.title } : null });
  },
});

/**
 * 消息分页(官方 message-scroller-load-history 的后端落点)。
 * 直接用 store.listMessages 显式 DESC:page 0 = 最新一页,hasMore 指向更旧的页
 * (向上滚动加载历史)。workbenchMessages 会把每页转换为时间正序的 UI 数组,
 * 客户端按页倒序拼接后即可得到完整的时间正序会话。
 */
export const threadMessagesPageRoute = registerApiRoute("/work/threads/:threadId/messages/page", {
  method: "GET",
  handler: async (c) => {
    const resourceId = z.string().min(1).parse(c.req.query("resourceId"));
    const page = z.coerce
      .number()
      .int()
      .min(0)
      .default(0)
      .parse(c.req.query("page") ?? "0");
    const perPage = z.coerce
      .number()
      .int()
      .min(1)
      .max(200)
      .default(50)
      .parse(c.req.query("perPage") ?? "50");
    const threadId = c.req.param("threadId");
    const memory = await getWorkMemoryForThread(c.get("requestContext"), threadId, resourceId);
    await memory.settled();
    const thread = await getOwnedThread(memory, threadId, resourceId);
    if (!thread) throw workError("THREAD_NOT_FOUND");
    const store = await appStorage.getStore("memory");
    if (!store) throw new Error("Memory storage is not configured");
    const result = await store.listMessages({
      threadId,
      resourceId,
      page,
      perPage,
      orderBy: { field: "createdAt", direction: "DESC" },
    });
    return c.json({
      uiMessages: workbenchMessages(result.messages),
      hasMore: result.hasMore,
      page,
      perPage,
    });
  },
});

/** 纪要提取的「核心待办」Extractor:结构化输出,不写入 OM metadata(路由自己返回) */
const threadTodosExtractor = new Extractor({
  name: "thread-todos",
  instructions: "从对话中提取仍然待办或需要跟进的核心事项,按优先级排列;没有待办则返回空数组。",
  schema: z.object({ todos: z.array(z.string()) }),
  metadataKeyPath: false,
});

/**
 * 会话纪要(官方 summarizeThread):一次性蒸馏整段对话并运行 Extractor,
 * 分页加载消息(从最新往前,受 maxInputTokens 约束),不回写 memory。
 */
export const summarizeThreadRoute = registerApiRoute("/work/threads/:threadId/summarize", {
  method: "POST",
  handler: async (c) => {
    const { resourceId, model: rawModel } = z
      .object({ resourceId: z.string().min(1), model: z.unknown().optional() })
      .parse(await c.req.json());
    const threadId = c.req.param("threadId");
    const memory = await getWorkMemoryForThread(c.get("requestContext"), threadId, resourceId);
    await memory.settled();
    const thread = await getOwnedThread(memory, threadId, resourceId);
    if (!thread) throw workError("THREAD_NOT_FOUND");
    const model =
      (rawModel !== undefined ? await resolveRequestModel(rawModel, resourceId) : undefined) ??
      (await resolveDefaultLanguageModel(resourceId));
    if (!model) throw workError("MODEL_NOT_CONFIGURED");
    const result = await memory.summarizeThread({
      model,
      threadId,
      resourceId,
      instructions:
        "用简体中文总结这次工作台对话:提炼关键决策、产出物与未尽事项,便于用户快速回顾。",
      extract: [threadTodosExtractor],
    });
    const extracted = result.extracted["thread-todos"];
    const todos = Array.isArray(
      extracted && typeof extracted === "object" ? (extracted as { todos?: unknown }).todos : null,
    )
      ? (extracted as { todos: unknown[] }).todos.filter(
          (item): item is string => typeof item === "string",
        )
      : [];
    return c.json({ summary: result.summary, todos, usage: result.usage ?? null });
  },
});

/** Complete the accepted request under the source account's memory scope. */
async function executeThreadAssetTransferUnlocked(
  c: ContextWithMastra,
  transfer: ThreadAssetTransferRecord,
): Promise<"committed" | "reconciliation_pending"> {
  const { threadId, sourceResourceId, targetResourceId } = transfer;
  const sourceContext = new RequestContext();
  sourceContext.setRaw(MASTRA_RESOURCE_ID_KEY, sourceResourceId);
  sourceContext.setRaw("userId", sourceResourceId);
  let memory: Awaited<ReturnType<typeof getWorkMemoryForThread>>;
  let sourceThreadTitle = "New Chat";
  let sourceThreadMetadata: Record<string, unknown> = {};
  try {
    memory = await getWorkMemoryForThread(sourceContext, threadId, sourceResourceId);
    await memory.settled();
    const thread = await getOwnedThread(memory, threadId, sourceResourceId);
    if (!thread) throw workError("THREAD_NOT_FOUND");
    sourceThreadTitle = thread.title?.trim() || "New Chat";
    sourceThreadMetadata =
      thread.metadata && typeof thread.metadata === "object"
        ? { ...thread.metadata }
        : {};

    for (const agent of Object.values(c.get("mastra").listAgents())) {
      await agent.abortThreadStream({ resourceId: sourceResourceId, threadId });
    }
    await c
      .get("mastra")
      .getAgentController("workbench")
      ?.deleteSession({
        resourceId: sourceResourceId,
        scope: JSON.stringify(["workbench", threadId]),
      });
    await memory.settled();
  } catch (error) {
    await failThreadAssetTransfer(transfer.id, targetResourceId, errorMessage(error)).catch(
      () => undefined,
    );
    throw error;
  }

  let transferredAssets: Awaited<ReturnType<typeof transferThreadAssetReferences>> = [];
  try {
    // Older chats can contain a global-library URL without a thread-scoped
    // reference row. Materialize that ownership edge before transfer mapping.
    await ensureThreadAssetReferences(threadId, sourceResourceId, transfer.id);
    transferredAssets = await transferThreadAssetReferences(
      sourceResourceId,
      targetResourceId,
      threadId,
      { transferId: transfer.id },
    );
  } catch (error) {
    await failThreadAssetTransfer(
      transfer.id,
      targetResourceId,
      errorMessage(error),
      error instanceof ThreadAssetTransferCleanupPending,
    ).catch(() => undefined);
    throw error;
  }

  let updated: Awaited<ReturnType<typeof memory.updateThreadResourceId>> | undefined;
  try {
    updated = await memory.updateThreadResourceId({ threadId, resourceId: targetResourceId });
    await memory.settled();
    await clearTransferredWorkspaceBinding(
      memory,
      { id: threadId, title: sourceThreadTitle, metadata: sourceThreadMetadata },
      threadId,
    );
    await rewriteTransferredThreadMessages(threadId, targetResourceId, transferredAssets);
    await markThreadAssetTransferMemoryMoved(transfer.id, targetResourceId);
    await markThreadAssetTransferMessagesRewritten(transfer.id, targetResourceId);
  } catch (error) {
    let actualThread: Awaited<ReturnType<typeof memory.getThreadById>> | null;
    try {
      await memory.settled();
      actualThread = await memory.getThreadById({ threadId });
    } catch (inspectionError) {
      await failThreadAssetTransfer(
        transfer.id,
        targetResourceId,
        `${errorMessage(error)}; owner inspection failed: ${errorMessage(inspectionError)}`,
        true,
      ).catch(() => undefined);
      throw error;
    }

    if (actualThread?.resourceId === targetResourceId) {
      // Memory may commit the owner change and then reject while flushing its
      // internal queue. Never roll library assets back until ownership itself
      // is authoritatively back at the source.
      await recoverPendingThreadTransfers({
        transferId: transfer.id,
        getMemory: async () => memory,
      });
      const reconciled = await getThreadAssetTransfer(transfer.id);
      return reconciled?.status === "committed" ? "committed" : "reconciliation_pending";
    }

    if (actualThread && actualThread.resourceId !== sourceResourceId) {
      await failThreadAssetTransfer(
        transfer.id,
        targetResourceId,
        `Thread owner ${actualThread.resourceId} does not match either transfer participant`,
        true,
      ).catch(() => undefined);
      throw error;
    }

    try {
      if (actualThread) {
        await memory.updateThread({
          id: threadId,
          title: sourceThreadTitle,
          metadata: sourceThreadMetadata,
        });
        await memory.settled();
      }
      // Restore source URLs before deleting cloned/linked target references.
      await rewriteTransferredThreadMessages(
        threadId,
        sourceResourceId,
        transferredAssets.map((item) => ({
          ...item,
          sourceAssetId: item.targetAssetId,
          targetAssetId: item.sourceAssetId,
        })),
      );
      await rollbackThreadAssetReferences(
        sourceResourceId,
        targetResourceId,
        threadId,
        transferredAssets,
      );
      await cleanupUnregisteredThreadAssetTransferCopies(transfer);
      await failThreadAssetTransfer(transfer.id, targetResourceId, errorMessage(error));
    } catch (rollbackError) {
      await failThreadAssetTransfer(
        transfer.id,
        targetResourceId,
        `${errorMessage(error)}; rollback failed: ${errorMessage(rollbackError)}`,
        true,
      ).catch(() => undefined);
    }
    throw error;
  }

  // If the process exits between stores, startup reconciliation uses the
  // persisted source→target asset map and Memory's authoritative owner.
  let transferStatus: "committed" | "reconciliation_pending" = "committed";
  try {
    await commitThreadAssetTransfer(transfer.id, targetResourceId);
  } catch (error) {
    try {
      // This request has already moved this thread in Memory and rewritten its
      // messages. Reconcile only this transfer; a global scan could roll back
      // a different transfer that is currently executing in another request.
      await recoverPendingThreadTransfers({
        transferId: transfer.id,
        getMemory: getWorkMemory,
      });
      if ((await getThreadAssetTransfer(transfer.id))?.status !== "committed") {
        transferStatus = "reconciliation_pending";
      }
    } catch (reconciliationError) {
      transferStatus = "reconciliation_pending";
      console.warn("[thread-transfer] durable commit marker deferred", {
        transferId: transfer.id,
        error,
        reconciliationError,
      });
    }
  }
  if (transferredAssets.length > 0) {
    try {
      const settings = await getLibrarySettings(targetResourceId);
      for (const item of transferredAssets) {
        if (item.asset.status === "unsupported") continue;
        void queueAssetIndex(item.asset, item.asset.extractedText ?? "", settings).catch(
          () => undefined,
        );
      }
    } catch {
      // The transferred binary remains readable; indexing can be retried later.
    }
  }
  if (!updated) throw new Error("线程迁移未返回更新后的线程");
  return transferStatus;
}

async function executeThreadAssetTransfer(
  c: ContextWithMastra,
  transfer: ThreadAssetTransferRecord,
): Promise<"committed" | "reconciliation_pending"> {
  return withThreadAssetTransferLock(transfer.threadId, transfer.sourceResourceId, () =>
    executeThreadAssetTransferUnlocked(c, transfer),
  );
}

function collectLibraryAssetIds(value: unknown, ids = new Set<string>()): Set<string> {
  if (typeof value === "string") {
    if (value.includes("/work/library/assets/")) {
      const assetId = getLibraryAssetId(value);
      if (assetId) ids.add(assetId);
    }
    return ids;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectLibraryAssetIds(item, ids);
    return ids;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectLibraryAssetIds(item, ids);
  }
  return ids;
}

async function ensureThreadAssetReferences(
  threadId: string,
  resourceId: string,
  transferId: string,
): Promise<void> {
  const store = await appStorage.getStore("memory");
  if (!store) throw new Error("Memory storage is not configured");
  const { messages } = await store.listMessages({ threadId, resourceId, perPage: false });
  const referencedIds = collectLibraryAssetIds(messages);
  if (referencedIds.size === 0) return;
  const ownedAssetIds = new Set((await listAssets(resourceId)).map((asset) => asset.id));
  for (const assetId of referencedIds) {
    if (ownedAssetIds.has(assetId)) {
      await attachAssetReference(resourceId, assetId, undefined, threadId, { transferId });
    }
  }
}

/** Admin requests ownership transfer; assets and Memory remain unchanged until recipient accepts. */
export const transferThreadRoute = registerApiRoute("/work/threads/:threadId/transfer", {
  method: "POST",
  handler: async (c) => {
    const currentUser = authUserFromContext(c.get("requestContext")?.get("user"));
    if (!currentUser) throw workError("AUTH_REQUIRED");
    if (currentUser.role !== "admin") throw workError("AUTH_FORBIDDEN");
    const { targetResourceId } = z
      .object({ targetResourceId: z.string().min(1) })
      .parse(await c.req.json());
    const resourceId = c.get("requestContext").get(MASTRA_RESOURCE_ID_KEY);
    if (typeof resourceId !== "string" || resourceId !== currentUser.id) {
      throw workError("AUTH_REQUIRED");
    }
    const threadId = c.req.param("threadId");
    if (targetResourceId === resourceId) {
      throw workError("VALIDATION_FAILED", { text: "目标账户不能是当前账户" });
    }
    const target = await findUserById(targetResourceId);
    if (!target) throw workError("VALIDATION_FAILED", { text: "目标用户不存在" });
    const memory = await getWorkMemoryForThread(c.get("requestContext"), threadId, resourceId);
    await memory.settled();
    const thread = await getOwnedThread(memory, threadId, resourceId);
    if (!thread) throw workError("THREAD_NOT_FOUND");
    try {
      const transfer = await requestThreadAssetTransfer({
        threadId,
        sourceResourceId: resourceId,
        targetResourceId,
        initiatedBy: currentUser.id,
        threadTitle: thread.title?.trim() || "New Chat",
      });
      return c.json({ transfer: { id: transfer.id, status: transfer.status } }, 202);
    } catch (error) {
      if (error instanceof ThreadAssetTransferRequestConflict) {
        throw workError("THREAD_TRANSFER_REQUEST_PENDING");
      }
      throw error;
    }
  },
});

/** Only the addressed recipient may accept or reject the transfer request. */
export const decideThreadTransferRoute = registerApiRoute(
  "/work/thread-transfers/:transferId/decision",
  {
    method: "POST",
    handler: async (c) => {
      const currentUser = authUserFromContext(c.get("requestContext")?.get("user"));
      if (!currentUser) throw workError("AUTH_REQUIRED");
      const transferId = c.req.param("transferId");
      const transfer = await getThreadAssetTransfer(transferId);
      if (!transfer || transfer.targetResourceId !== currentUser.id) {
        throw workError("THREAD_TRANSFER_NOT_FOUND");
      }
      const { decision } = z
        .object({ decision: z.enum(["accept", "reject"]) })
        .parse(await c.req.json());
      const changed = await decideThreadAssetTransferRequest(
        transferId,
        currentUser.id,
        decision,
      );
      if (!changed) throw workError("THREAD_TRANSFER_DECISION_CONFLICT");
      if (decision === "reject") return c.json({ status: "rejected" });

      const acceptedTransfer = await getThreadAssetTransfer(transferId);
      if (!acceptedTransfer) throw workError("THREAD_TRANSFER_NOT_FOUND");
      const status = await executeThreadAssetTransfer(c, acceptedTransfer);
      return c.json({ status, threadId: transfer.threadId });
    },
  },
);

/** Incoming requests and audit history are scoped to the authenticated local account. */
export const threadTransferHistoryRoute = registerApiRoute("/work/thread-transfers", {
  method: "GET",
  handler: async (c) => {
    const currentUser = authUserFromContext(c.get("requestContext")?.get("user"));
    if (!currentUser) throw workError("AUTH_REQUIRED");
    const resourceId = c.get("requestContext").get(MASTRA_RESOURCE_ID_KEY);
    if (resourceId !== currentUser.id) throw workError("AUTH_REQUIRED");
    const transfers = await listThreadAssetTransfersForResource(currentUser.id);
    const userIds = new Set(
      transfers.flatMap((transfer) => [transfer.sourceResourceId, transfer.targetResourceId]),
    );
    const users = await Promise.all([...userIds].map((id) => findUserById(id)));
    const names = new Map(users.flatMap((user) => (user ? [[user.id, user.name] as const] : [])));
    return c.json({
      transfers: transfers.map((transfer) => ({
        id: transfer.id,
        threadId: transfer.threadId,
        threadTitle: transfer.threadTitle,
        sourceResourceId: transfer.sourceResourceId,
        sourceName: names.get(transfer.sourceResourceId) ?? transfer.sourceResourceId,
        targetResourceId: transfer.targetResourceId,
        targetName: names.get(transfer.targetResourceId) ?? transfer.targetResourceId,
        status: transfer.status,
        createdAt: transfer.createdAt,
        updatedAt: transfer.updatedAt,
        completedAt: transfer.completedAt,
        events: transfer.events,
      })),
    });
  },
});

export async function memoryThreadMiddleware(c: ContextWithMastra, next: () => Promise<void>) {
  const resourceId = c.get("requestContext").get(MASTRA_RESOURCE_ID_KEY) as string;
  if (c.req.path === "/api/memory/messages/delete" && c.req.method === "POST") {
    if (!resourceId) throw workError("AUTH_REQUIRED");
    const body = z
      .object({
        messageIds: z.union([
          z.string().min(1),
          z.object({ id: z.string().min(1) }),
          z.array(z.union([z.string().min(1), z.object({ id: z.string().min(1) })])).min(1),
        ]),
      })
      .parse(await c.req.raw.clone().json());
    const ids = (Array.isArray(body.messageIds) ? body.messageIds : [body.messageIds]).map((id) =>
      typeof id === "string" ? id : id.id,
    );
    const store = await appStorage.getStore("memory");
    if (!store) throw new Error("Memory storage is not configured");
    const { messages } = await store.listMessagesById({ messageIds: ids });
    if (new Set(messages.map((message) => message.id)).size !== new Set(ids).size)
      throw workError("MESSAGE_NOT_FOUND");
    const memory = await getWorkMemoryForThread(c.get("requestContext"), "", resourceId);
    const threadIds = [...new Set(messages.map((message) => message.threadId))];
    for (const threadId of threadIds) {
      if (!threadId || !(await getOwnedThread(memory, threadId, resourceId)))
        throw workError("THREAD_NOT_FOUND");
    }
    await memory.settled();
    for (const threadId of threadIds) {
      if (!threadId) throw workError("THREAD_NOT_FOUND");
      for (const agent of Object.values(c.get("mastra").listAgents())) {
        await agent.abortThreadStream({ resourceId, threadId });
      }
      await memory.settled();
      await (await memory.omEngine)?.clear(threadId, resourceId);
    }
    await next();
    await memory.settled();
    return;
  }
  const match = c.req.path.match(/^\/api\/memory\/threads(?:\/([^/]+))?(\/messages)?$/);
  if (!match) return next();
  if (!resourceId) throw workError("AUTH_REQUIRED");
  const threadId = match[1] ? decodeURIComponent(match[1]) : undefined;
  const memory = await getWorkMemoryForThread(c.get("requestContext"), threadId ?? "", resourceId);
  const thread = threadId ? await getOwnedThread(memory, threadId, resourceId) : undefined;
  if (threadId && !thread) throw workError("THREAD_NOT_FOUND");
  const include = c.req.query("include");
  if (match[2] && include) {
    const includes = z
      .array(z.object({ id: z.string(), threadId: z.string().optional() }))
      .parse(JSON.parse(include));
    const store = await appStorage.getStore("memory");
    if (!store) throw new Error("Memory storage is not configured");
    const { messages } = await store.listMessagesById({
      messageIds: includes.map((item) => item.id),
    });
    for (const id of new Set([
      ...includes.map((item) => item.threadId).filter(Boolean),
      ...messages.map((item) => item.threadId),
    ])) {
      if (!id || !(await getOwnedThread(memory, id, resourceId)))
        throw workError("THREAD_NOT_FOUND");
    }
  }
  if (!match[2] && (c.req.method === "POST" || c.req.method === "PATCH")) {
    const body = z
      .object({ metadata: z.record(z.string(), z.unknown()).optional() })
      .parse(await c.req.raw.clone().json());
    const metadata = body.metadata;
    // Workspace identity is set by the first chat turn, never by generic CRUD.
    for (const key of ["workspacePath", "workspaceExplicit"]) {
      if (metadata && metadata[key] !== thread?.metadata?.[key]) {
        throw workError("VALIDATION_FAILED", {
          text: "Workspace binding is owned by the first chat turn",
        });
      }
    }
  }
  if (threadId && c.req.method === "DELETE") {
    for (const agent of Object.values(c.get("mastra").listAgents())) {
      await agent.abortThreadStream({ resourceId, threadId });
    }
    await c
      .get("mastra")
      .getAgentController("workbench")
      ?.deleteSession({
        resourceId,
        scope: JSON.stringify(["workbench", threadId]),
      });
    await memory.settled();
  }
  await next();
  if (!c.res.ok) return;
  if (match[2] && c.req.method === "GET") {
    const payload = (await c.res.clone().json()) as { messages: MastraDBMessage[] };
    c.res = c.json({ ...payload, uiMessages: workbenchMessages(payload.messages) });
  }
  if (threadId && thread && c.req.method === "DELETE") {
    await memory.settled();
    const browser = await getBrowserForResource(resourceId);
    if (browser.hasThreadSession(threadId)) await browser.closeThreadSession(threadId);
    await Promise.all([
      workWebhookSignals.removeThread({ threadId, resourceId }),
      workPollingSignals.removeThread({ threadId, resourceId }),
      deleteThreadWorkspace(threadId, thread.metadata, resourceId),
    ]);
  }
  if (!threadId && c.req.method === "GET") {
    const payload = (await c.res.clone().json()) as {
      threads: Array<{ id: string; metadata?: Record<string, unknown> }>;
    };
    const runs = Object.values(c.get("mastra").listAgents()).flatMap((agent) =>
      agent.listActiveThreadRuns(),
    );
    const active = new Map(
      runs.filter((run) => run.resourceId === resourceId).map((run) => [run.threadId, run.runId]),
    );
    c.res = c.json({
      ...payload,
      threads: payload.threads.map((item: { id: string; metadata?: Record<string, unknown> }) => ({
        ...item,
        metadata: {
          ...item.metadata,
          isWorking: active.has(item.id),
          activeRunId: active.get(item.id) ?? null,
        },
      })),
    });
  }
}
