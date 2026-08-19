import { registerApiRoute } from "@mastra/core/server";
import { getOwnedThread, getWorkMemory } from "./shared";

/**
 * 线程克隆路由。
 * 官方 API:Memory.cloneThread()(docs/en/reference/memory/cloneThread.mdx)
 * 分支谱系:clone-utilities.mdx(isClone / getSourceThread / listClones / getCloneHistory)
 */

// POST /work/threads/:threadId/clone — 克隆线程(全量或最近 N 条)
// body.messageLimit:仅克隆最近 N 条消息(options.messageLimit),用于「从此消息克隆」。
export const cloneThreadRoute = registerApiRoute("/work/threads/:threadId/clone", {
  method: "POST",
  handler: async (c) => {
    const threadId = c.req.param("threadId");
    const body = (await c.req.json().catch(() => ({}))) as {
      resourceId?: string;
      title?: string;
      messageLimit?: number;
      messageIds?: string[];
    };
    if (!body.resourceId) return c.json({ error: "resourceId is required" }, 400);
    const memory = await getWorkMemory();
    if (!(await getOwnedThread(memory, threadId, body.resourceId))) {
      return c.json({ error: "Thread not found" }, 404);
    }
    if (body.messageIds && (!Array.isArray(body.messageIds) || body.messageIds.length === 0)) {
      return c.json({ error: "messageIds must be a non-empty array" }, 400);
    }
    if (body.messageIds && typeof body.messageLimit === "number") {
      return c.json({ error: "messageIds and messageLimit are mutually exclusive" }, 400);
    }
    if (body.messageIds) {
      const { messages } = await memory.recall({
        threadId,
        resourceId: body.resourceId,
        perPage: false,
      });
      const ownedMessageIds = new Set((messages ?? []).map((message) => message.id));
      if (body.messageIds.some((messageId) => !ownedMessageIds.has(messageId))) {
        return c.json({ error: "Message not found in source thread" }, 404);
      }
    }
    const { thread } = await memory.cloneThread({
      sourceThreadId: threadId,
      resourceId: body.resourceId,
      ...(body.title ? { title: body.title } : {}),
      ...(body.messageIds
        ? { options: { messageFilter: { messageIds: body.messageIds } } }
        : typeof body.messageLimit === "number"
          ? { options: { messageLimit: body.messageLimit } }
          : {}),
    });
    return c.json({ thread }, 201);
  },
});

/**
 * Edit an entry that was removed by the latest true-compaction pass.
 * A normal AI SDK edit cannot target a deleted Memory row, so create an
 * official clone first and rebuild only the interval represented by the
 * compacted entry through the current tail.
 */
export const cloneCompactedEditRoute = registerApiRoute("/work/threads/:threadId/compacted-edit", {
  method: "POST",
  handler: async (c) => {
    const threadId = c.req.param("threadId");
    const body = (await c.req.json()) as {
      resourceId?: string;
      messageId?: string;
      text?: string;
    };
    if (!body.resourceId || !body.messageId || !body.text?.trim()) {
      return c.json({ error: "resourceId, messageId and text are required" }, 400);
    }
    const memory = await getWorkMemory();
    const sourceThread = await getOwnedThread(memory, threadId, body.resourceId);
    if (!sourceThread) return c.json({ error: "Thread not found" }, 404);
    await memory.settled();
    const source = await memory.recall({
      threadId,
      resourceId: body.resourceId,
      perPage: false,
    });
    const all = source.messages ?? [];
    const compacted = all.find((message) => {
      const metadata = (message.content as { metadata?: unknown } | undefined)?.metadata;
      return (
        typeof metadata === "object" &&
        metadata !== null &&
        Array.isArray((metadata as { compactedHistory?: unknown }).compactedHistory) &&
        (metadata as { compactedHistory: Array<{ id?: unknown }> }).compactedHistory.some(
          (entry) => entry.id === body.messageId,
        )
      );
    });
    if (!compacted) {
      return c.json({ error: "Message is not part of the latest compacted history" }, 409);
    }
    const history = ((compacted.content as { metadata?: { compactedHistory?: unknown } }).metadata
      ?.compactedHistory ?? []) as Array<{
      id?: string;
      role?: string;
      text?: string;
      createdAt?: string;
      compactionId?: string;
    }>;
    const targetEntry = history.find((entry) => entry.id === body.messageId);
    const windowHistory = targetEntry?.compactionId
      ? history.filter((entry) => entry.compactionId === targetEntry.compactionId)
      : history;
    const entryIndex = windowHistory.findIndex((entry) => entry.id === body.messageId);
    if (entryIndex < 0) return c.json({ error: "Compacted message not found" }, 404);
    if (windowHistory[entryIndex]?.role !== "user") {
      return c.json({ error: "Only compacted user messages can be edited" }, 400);
    }

    const { thread: clone } = await memory.cloneThread({
      sourceThreadId: threadId,
      resourceId: body.resourceId,
      title: `${sourceThread.title} · 修正分支`,
    });
    const cloned = await memory.recall({
      threadId: clone.id,
      resourceId: body.resourceId,
      perPage: false,
    });
    const clonedIds = (cloned.messages ?? []).map((message) => message.id);
    if (clonedIds.length > 0) await memory.deleteMessages(clonedIds);

    // The edited entry is deliberately not written into the clone here.
    // The renderer submits it as the clone's current input through the native
    // AI SDK Chat, exactly like an ordinary edit. Keeping it in this write
    // would make the new user message appear twice. Messages at and after
    // the anchor are also excluded so stale assistant replies cannot leak
    // into the corrected branch. When the history contains multiple
    // compaction windows, only the target entry's compactionId window is
    // used, matching the latest-compression/next-compression boundary.
    const foldedWindow = windowHistory.slice(0, entryIndex).flatMap((entry) => {
      if (
        (entry.role !== "user" && entry.role !== "assistant") ||
        typeof entry.text !== "string" ||
        !entry.createdAt
      ) {
        return [];
      }
      return [
        {
          id: memory.generateId(),
          role: entry.role as "user" | "assistant",
          type: "v2" as const,
          createdAt: new Date(entry.createdAt),
          threadId: clone.id,
          resourceId: body.resourceId,
          content: {
            format: 2 as const,
            parts: [{ type: "text" as const, text: entry.text }],
          },
        },
      ];
    });
    await memory.saveMessages({ messages: foldedWindow });
    const {
      compaction: _compaction,
      compactedAt: _compactedAt,
      contextUsage: _contextUsage,
      messageBranches: _messageBranches,
      ...cloneMetadata
    } = clone.metadata ?? {};
    const updatedClone = await memory.updateThread({
      id: clone.id,
      title: clone.title,
      metadata: {
        ...cloneMetadata,
        sourceCompactedThreadId: threadId,
        sourceCompactedMessageId: body.messageId,
      },
    });
    return c.json({ thread: updatedClone }, 201);
  },
});

// GET /work/threads/:threadId/clones — 分支谱系(克隆源/克隆链/直接分支)
export const threadClonesRoute = registerApiRoute("/work/threads/:threadId/clones", {
  method: "GET",
  handler: async (c) => {
    const threadId = c.req.param("threadId");
    const memory = await getWorkMemory();
    const thread = await memory.getThreadById({ threadId });
    const resourceId = c.req.query("resourceId");
    if (!resourceId || !thread || thread.resourceId !== resourceId) {
      return c.json({ error: "thread not found" }, 404);
    }
    const [source, clones, history] = await Promise.all([
      memory.getSourceThread(threadId),
      memory.listClones(threadId),
      memory.getCloneHistory(threadId),
    ]);
    return c.json({
      isClone: memory.isClone(thread),
      source,
      clones,
      history,
    });
  },
});
