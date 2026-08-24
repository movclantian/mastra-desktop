/**
 * 线程克隆路由。
 * 官方 API:Memory.cloneThread()(docs/en/reference/memory/cloneThread.mdx)
 * 分支谱系:clone-utilities.mdx(isClone / getSourceThread / listClones / getCloneHistory)
 */
import { registerApiRoute } from "@mastra/core/server";
import { workError } from "../../errors";
import { getMemoryConfig } from "../../memory";
import { getOwnedThread, getWorkMemoryForThread } from "./shared";

type CloneRequestBody = {
  resourceId?: unknown;
  newThreadId?: unknown;
  title?: unknown;
  metadata?: unknown;
  options?: unknown;
};

type CloneOptions = {
  messageLimit?: number;
  messageFilter?: {
    startDate?: Date;
    endDate?: Date;
    messageIds?: string[];
  };
};

function parseCloneDate(value: unknown, name: string): Date | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" && !(value instanceof Date)) {
    throw workError("VALIDATION_FAILED", { text: `${name} must be a valid date` });
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw workError("VALIDATION_FAILED", { text: `${name} must be a valid date` });
  }
  return date;
}

function parseCloneOptions(value: unknown): CloneOptions | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw workError("VALIDATION_FAILED", { text: "options must be an object" });
  }
  const options = value as Record<string, unknown>;
  let messageLimit: number | undefined;
  if (options.messageLimit !== undefined) {
    if (
      typeof options.messageLimit !== "number" ||
      !Number.isInteger(options.messageLimit) ||
      options.messageLimit < 0
    ) {
      throw workError("VALIDATION_FAILED", {
        text: "options.messageLimit must be a non-negative integer",
      });
    }
    messageLimit = options.messageLimit;
  }

  let messageFilter: CloneOptions["messageFilter"];
  if (options.messageFilter !== undefined) {
    if (
      typeof options.messageFilter !== "object" ||
      options.messageFilter === null ||
      Array.isArray(options.messageFilter)
    ) {
      throw workError("VALIDATION_FAILED", { text: "options.messageFilter must be an object" });
    }
    const filter = options.messageFilter as Record<string, unknown>;
    const startDate = parseCloneDate(filter.startDate, "options.messageFilter.startDate");
    const endDate = parseCloneDate(filter.endDate, "options.messageFilter.endDate");
    if (startDate && endDate && startDate > endDate) {
      throw workError("VALIDATION_FAILED", {
        text: "options.messageFilter.startDate must be before endDate",
      });
    }
    let messageIds: string[] | undefined;
    if (filter.messageIds !== undefined) {
      if (
        !Array.isArray(filter.messageIds) ||
        filter.messageIds.some((messageId) => typeof messageId !== "string" || !messageId.trim())
      ) {
        throw workError("VALIDATION_FAILED", {
          text: "options.messageFilter.messageIds must be an array of non-empty strings",
        });
      }
      messageIds = filter.messageIds;
      if (new Set(messageIds).size !== messageIds.length) {
        throw workError("VALIDATION_FAILED", {
          text: "options.messageFilter.messageIds must not contain duplicates",
        });
      }
    }
    messageFilter = {
      ...(startDate ? { startDate } : {}),
      ...(endDate ? { endDate } : {}),
      ...(messageIds ? { messageIds } : {}),
    };
  }
  return {
    ...(messageLimit !== undefined ? { messageLimit } : {}),
    ...(messageFilter ? { messageFilter } : {}),
  };
}

// POST /work/threads/:threadId/clone — 克隆线程(全量或精确消息集合)
export const cloneThreadRoute = registerApiRoute("/work/threads/:threadId/clone", {
  method: "POST",
  handler: async (c) => {
    const threadId = c.req.param("threadId");
    const body = (await c.req.json().catch(() => ({}))) as CloneRequestBody;
    if (typeof body.resourceId !== "string" || !body.resourceId.trim()) {
      throw workError("VALIDATION_RESOURCE_ID_REQUIRED");
    }
    const resourceId = body.resourceId.trim();
    const memory = await getWorkMemoryForThread(c.get("requestContext"), threadId, resourceId);
    if (!(await getOwnedThread(memory, threadId, resourceId))) {
      throw workError("THREAD_NOT_FOUND");
    }
    // Clone the same settled Memory state used by the Agent run; otherwise an
    // in-flight OM buffer could be copied after the raw message snapshot.
    await memory.settled();
    if (body.newThreadId !== undefined) {
      if (typeof body.newThreadId !== "string" || !body.newThreadId.trim()) {
        throw workError("VALIDATION_FAILED", { text: "newThreadId must be a non-empty string" });
      }
      if (await memory.getThreadById({ threadId: body.newThreadId.trim() })) {
        throw workError("VALIDATION_FAILED", { text: "newThreadId already exists" });
      }
    }
    if (body.title !== undefined && typeof body.title !== "string") {
      throw workError("VALIDATION_FAILED", { text: "title must be a string" });
    }
    if (
      body.metadata !== undefined &&
      (typeof body.metadata !== "object" || body.metadata === null || Array.isArray(body.metadata))
    ) {
      throw workError("VALIDATION_FAILED", { text: "metadata must be an object" });
    }
    const options = parseCloneOptions(body.options);
    const requestedMessageIds = options?.messageFilter?.messageIds;
    if (requestedMessageIds) {
      const { messages } = await memory.recall({
        threadId,
        resourceId,
        perPage: false,
      });
      const ownedMessageIds = new Set((messages ?? []).map((message) => message.id));
      if (requestedMessageIds.some((messageId) => !ownedMessageIds.has(messageId))) {
        throw workError("MESSAGE_NOT_FOUND");
      }
    }
    const result = await memory.cloneThread({
      sourceThreadId: threadId,
      resourceId,
      ...(typeof body.newThreadId === "string" ? { newThreadId: body.newThreadId.trim() } : {}),
      ...(typeof body.title === "string" ? { title: body.title } : {}),
      ...(body.metadata && typeof body.metadata === "object"
        ? { metadata: body.metadata as Record<string, unknown> }
        : {}),
      ...(options ? { options } : {}),
    });
    await memory.settled();
    return c.json(result, 201);
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
      throw workError("VALIDATION_FAILED", { text: "resourceId, messageId and text are required" });
    }
    const memory = await getWorkMemoryForThread(c.get("requestContext"), threadId, body.resourceId);
    const sourceThread = await getOwnedThread(memory, threadId, body.resourceId);
    if (!sourceThread) throw workError("THREAD_NOT_FOUND");
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
      throw workError("MESSAGE_NOT_LATEST_COMPACTED");
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
    if (entryIndex < 0) throw workError("MESSAGE_NOT_FOUND");
    if (windowHistory[entryIndex]?.role !== "user") {
      throw workError("MESSAGE_EDIT_COMPACTED_ONLY");
    }

    const { thread: clone } = await memory.cloneThread({
      sourceThreadId: threadId,
      resourceId: body.resourceId,
      title: `${sourceThread.title} · 修正分支`,
    });
    await memory.settled();
    const cloned = await memory.recall({
      threadId: clone.id,
      resourceId: body.resourceId,
      perPage: false,
    });
    const clonedIds = (cloned.messages ?? []).map((message) => message.id);
    // Thread-scoped OM is cloned with remapped message IDs. Clear that clone
    // before deleting its raw messages; resource-scoped OM is shared by the
    // source and clone, so clearing it here would erase the user's source OM.
    try {
      if ((await getMemoryConfig()).omScope === "thread") {
        const cloneOm = await memory.omEngine;
        await cloneOm?.clear(clone.id, body.resourceId);
        if (memory.vector) {
          const vector = memory.vector;
          const observationIndexes = (await vector.listIndexes()).filter((indexName) =>
            indexName.startsWith("memory_observations"),
          );
          await Promise.all(
            observationIndexes.map((indexName) =>
              vector.deleteVectors({ indexName, filter: { thread_id: clone.id } }),
            ),
          );
        }
      }
      if (clonedIds.length > 0) {
        await memory.deleteMessages(clonedIds);
      }
    } catch (error) {
      await memory.deleteThread(clone.id).catch(() => undefined);
      throw error;
    }
    await memory.settled();

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
    await memory.settled();
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
    const resourceId = c.req.query("resourceId");
    if (!resourceId) throw workError("VALIDATION_RESOURCE_ID_REQUIRED");
    const memory = await getWorkMemoryForThread(c.get("requestContext"), threadId, resourceId);
    const thread = await memory.getThreadById({ threadId });
    if (!thread || thread.resourceId !== resourceId) {
      throw workError("THREAD_NOT_FOUND");
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
