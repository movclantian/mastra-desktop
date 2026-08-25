/**
 * 消息历史路由:分页拉取与批量删除。
 * 官方文档:docs/en/docs/memory/message-history.mdx;
 * resourceId 租户隔离见 docs/en/docs/memory/multi-user-threads.mdx。
 */
import { toAISdkMessages } from "@mastra/ai-sdk/ui";
import { registerApiRoute } from "@mastra/core/server";
import { errorText, workError } from "../../errors";
import { removeObservationalMemoryReferences } from "./compact";
import { getOwnedThread, getWorkMemoryForThread, normalizeChatHistoryMessages } from "./shared";

const LIBRARY_SEARCH_TOOL_NAMES = new Set(["library_vector_search", "library_graph_search"]);

function parseRecallPage(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const page = Number(value);
  if (!Number.isInteger(page) || page < 0) {
    throw workError("VALIDATION_FAILED", { text: "page must be a non-negative integer" });
  }
  return page;
}

function parseRecallPerPage(value: string | undefined): number | false | undefined {
  if (value === undefined) return undefined;
  if (value === "false") return false;
  const perPage = Number(value);
  if (!Number.isInteger(perPage) || perPage < 1 || perPage > 500) {
    throw workError("VALIDATION_FAILED", { text: "perPage must be 1..500 or false" });
  }
  return perPage;
}

function parseRecallDate(value: string | undefined, name: string): Date | undefined {
  if (value === undefined) return undefined;
  if (!value) {
    throw workError("VALIDATION_FAILED", { text: `${name} must be a valid date` });
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw workError("VALIDATION_FAILED", { text: `${name} must be a valid date` });
  }
  return date;
}

type RecallMetadataValue = string | number | boolean | null;
type RecallMetadataFilter = Record<string, RecallMetadataValue>;

function parseRecallMetadataObject(value: unknown): RecallMetadataFilter {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("metadata must be an object");
  }
  const result: RecallMetadataFilter = {};
  for (const [key, item] of Object.entries(value)) {
    if (
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ||
      key.length > 128 ||
      key === "__proto__" ||
      key === "prototype" ||
      key === "constructor" ||
      (typeof item !== "string" &&
        typeof item !== "number" &&
        typeof item !== "boolean" &&
        item !== null) ||
      (typeof item === "number" && !Number.isFinite(item))
    ) {
      throw new Error("metadata must contain only valid scalar values");
    }
    result[key] = item;
  }
  return result;
}

function parseRecallFilter(value: string | undefined) {
  if (value === undefined) return undefined;
  if (!value.trim()) {
    throw workError("VALIDATION_FAILED", { text: "filter must be a valid recall filter object" });
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error();
    }
    const input = parsed as Record<string, unknown>;
    const dateRangeValue = input.dateRange;
    let dateRange:
      | {
          start?: Date;
          end?: Date;
          startExclusive?: boolean;
          endExclusive?: boolean;
        }
      | undefined;
    if (dateRangeValue !== undefined) {
      if (
        typeof dateRangeValue !== "object" ||
        dateRangeValue === null ||
        Array.isArray(dateRangeValue)
      ) {
        throw new Error();
      }
      const range = dateRangeValue as Record<string, unknown>;
      if (
        (range.start !== undefined && typeof range.start !== "string") ||
        (range.end !== undefined && typeof range.end !== "string")
      ) {
        throw new Error();
      }
      const start = parseRecallDate(range.start as string | undefined, "filter.dateRange.start");
      const end = parseRecallDate(range.end as string | undefined, "filter.dateRange.end");
      if (start && end && start > end) throw new Error();
      if (
        (range.startExclusive !== undefined && typeof range.startExclusive !== "boolean") ||
        (range.endExclusive !== undefined && typeof range.endExclusive !== "boolean")
      ) {
        throw new Error();
      }
      dateRange = {
        ...(start ? { start } : {}),
        ...(end ? { end } : {}),
        ...(range.startExclusive === true ? { startExclusive: true } : {}),
        ...(range.endExclusive === true ? { endExclusive: true } : {}),
      };
    }
    const metadata =
      input.metadata === undefined ? undefined : parseRecallMetadataObject(input.metadata);
    return {
      ...(dateRange ? { dateRange } : {}),
      ...(metadata ? { metadata } : {}),
    };
  } catch {
    throw workError("VALIDATION_FAILED", { text: "filter must be a valid recall filter object" });
  }
}

function parseRecallOrderBy(value: string | undefined) {
  if (value === undefined) return undefined;
  if (!value.trim()) {
    throw workError("VALIDATION_FAILED", { text: "orderBy must be a valid JSON object" });
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
    const input = parsed as Record<string, unknown>;
    if (input.field !== "createdAt") throw new Error();
    if (input.direction !== undefined && input.direction !== "ASC" && input.direction !== "DESC") {
      throw new Error();
    }
    return {
      field: "createdAt" as const,
      ...(input.direction ? { direction: input.direction as "ASC" | "DESC" } : {}),
    };
  } catch {
    throw workError("VALIDATION_FAILED", {
      text: 'orderBy must be a JSON object with field "createdAt" and direction ASC or DESC',
    });
  }
}

function parseRecallInclude(value: string | undefined) {
  if (value === undefined) return undefined;
  if (!value.trim()) {
    throw workError("VALIDATION_FAILED", {
      text: "include must be a JSON array of message references",
    });
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) throw new Error();
    return parsed.map((item) => {
      if (typeof item !== "object" || item === null) {
        throw new Error();
      }
      const candidate = item as Record<string, unknown>;
      if (typeof candidate.id !== "string" || !candidate.id.trim()) throw new Error();
      if (
        candidate.threadId !== undefined &&
        (typeof candidate.threadId !== "string" || !candidate.threadId.trim())
      ) {
        throw new Error();
      }
      for (const key of ["withPreviousMessages", "withNextMessages"] as const) {
        const count = candidate[key];
        if (count !== undefined && (!Number.isInteger(count) || Number(count) < 0)) {
          throw new Error();
        }
      }
      return {
        id: candidate.id,
        ...(typeof candidate.threadId === "string" ? { threadId: candidate.threadId } : {}),
        ...(Number.isInteger(candidate.withPreviousMessages) &&
        Number(candidate.withPreviousMessages) >= 0
          ? { withPreviousMessages: Number(candidate.withPreviousMessages) }
          : {}),
        ...(Number.isInteger(candidate.withNextMessages) && Number(candidate.withNextMessages) >= 0
          ? { withNextMessages: Number(candidate.withNextMessages) }
          : {}),
      };
    });
  } catch {
    throw workError("VALIDATION_FAILED", {
      text: "include must be a JSON array of message references",
    });
  }
}

function getLibraryToolName(part: Record<string, unknown>): string | undefined {
  if (part.type === "dynamic-tool") {
    return typeof part.toolName === "string" ? part.toolName : undefined;
  }
  if (typeof part.type !== "string" || !part.type.startsWith("tool-")) return undefined;
  return part.type.slice("tool-".length);
}

function appendLibrarySourceParts<Message extends { id?: string; role: string; parts: unknown[] }>(
  messages: Message[],
): Message[] {
  return messages.map((message) => {
    if (message.role !== "assistant") return message;
    if (
      message.parts.some(
        (part) =>
          typeof part === "object" &&
          part !== null &&
          (part as { type?: unknown }).type === "data-library-sources",
      )
    ) {
      return message;
    }

    const sources = new Map<string, Record<string, unknown>>();
    for (const rawPart of message.parts) {
      if (typeof rawPart !== "object" || rawPart === null) continue;
      const part = rawPart as Record<string, unknown>;
      const toolName = getLibraryToolName(part);
      if (!toolName || !LIBRARY_SEARCH_TOOL_NAMES.has(toolName)) continue;
      const output = part.output;
      if (typeof output !== "object" || output === null) continue;
      const results = (output as { results?: unknown }).results;
      if (!Array.isArray(results)) continue;

      for (const rawResult of results) {
        if (typeof rawResult !== "object" || rawResult === null) continue;
        const result = rawResult as Record<string, unknown>;
        const assetId = typeof result.assetId === "string" ? result.assetId : "";
        const url = typeof result.url === "string" ? result.url : "";
        if (!assetId || !url) continue;
        try {
          const parsed = new URL(url);
          if (!parsed.pathname.startsWith("/work/library/assets/")) continue;
        } catch {
          continue;
        }
        const id =
          typeof result.citationId === "string" && result.citationId
            ? result.citationId
            : `library-${assetId}`;
        sources.set(id, {
          id,
          assetId,
          filename:
            typeof result.filename === "string" && result.filename ? result.filename : "资料库文件",
          url,
          snippet: typeof result.text === "string" ? result.text.slice(0, 280) : "",
          score:
            typeof result.score === "number" && Number.isFinite(result.score) ? result.score : 0,
        });
      }
    }
    if (sources.size === 0) return message;
    return {
      ...message,
      parts: [
        ...message.parts,
        {
          type: "data-library-sources",
          id: `${message.id ?? "assistant"}:library-sources`,
          data: [...sources.values()],
        },
      ],
    };
  });
}

/**
 * toAISdkMessages(v7) 在转换 DB 的 ModelMessage file part({mimeType,data,filename})
 * 时会丢 filename —— UI part 只剩 {url,mediaType}。这里按 URL 匹配把落库的
 * filename 补回去,否则前端气泡只能显示「未命名附件」。
 */
function restoreFileFilenames(
  uiMessages: ReturnType<typeof toAISdkMessages>,
  rawMessages: Array<{ id?: string; role: string; content?: unknown }>,
): ReturnType<typeof toAISdkMessages> {
  const filenamesByMessage = rawMessages.map((raw) => {
    const map = new Map<string, string>();
    const parts =
      raw.content && typeof raw.content === "object"
        ? ((raw.content as { parts?: unknown[] }).parts ?? [])
        : [];
    for (const part of parts) {
      if (part && typeof part === "object" && (part as { type?: unknown }).type === "file") {
        const { data, filename } = part as { data?: unknown; filename?: unknown };
        if (typeof data === "string" && typeof filename === "string") {
          map.set(data, filename);
        }
      }
    }
    return map;
  });

  return uiMessages.map((message, index) => {
    const map = filenamesByMessage[index];
    if (!map || map.size === 0) return message;
    let patched = false;
    const parts = message.parts.map((part) => {
      if (part.type !== "file" || part.filename) return part;
      const filename = map.get(part.url);
      if (!filename) return part;
      patched = true;
      return { ...part, filename };
    });
    return patched ? { ...message, parts } : message;
  });
}

/**
 * 消息路由:历史拉取、删除、跨线程搜索。
 * 官方 API 参考 docs/en/reference/memory/{recall,deleteMessages}.mdx。
 */

// GET /work/threads/:threadId/messages — 拉取线程消息历史(recall)
export const threadMessagesRoute = registerApiRoute("/work/threads/:threadId/messages", {
  method: "GET",
  handler: async (c) => {
    const threadId = c.req.param("threadId");
    const resourceId = c.req.query("resourceId");
    if (!resourceId) throw workError("VALIDATION_RESOURCE_ID_REQUIRED");
    const memory = await getWorkMemoryForThread(c.get("requestContext"), threadId, resourceId);
    const thread = await getOwnedThread(memory, threadId, resourceId);
    if (!thread) {
      throw workError("THREAD_NOT_FOUND");
    }
    const page = parseRecallPage(c.req.query("page"));
    const perPage = parseRecallPerPage(c.req.query("perPage"));
    const filter = parseRecallFilter(c.req.query("filter"));
    const include = parseRecallInclude(c.req.query("include"));
    const orderBy = parseRecallOrderBy(c.req.query("orderBy"));
    const recalled = await memory.recall({
      threadId,
      resourceId,
      ...(page !== undefined ? { page } : {}),
      ...(perPage !== undefined ? { perPage } : { perPage: false }),
      ...(include ? { include } : {}),
      ...(filter ? { filter } : {}),
      ...(orderBy ? { orderBy } : {}),
      ...(c.req.query("vectorSearchString")
        ? { vectorSearchString: c.req.query("vectorSearchString") }
        : {}),
    });
    const { messages } = recalled;
    // Task signals stay out of chat history; session user signals are restored
    // to normal user turns by the shared history normalizer.
    const chatMessages = normalizeChatHistoryMessages(messages ?? []);
    // 消息格式和 reasoning/tool/approval 状态全部由 Mastra 官方 v7 converter
    // 负责。这里不保留任何旧数据修复或兼容路径。
    const ui_messages = appendLibrarySourceParts(
      restoreFileFilenames(
        toAISdkMessages(chatMessages, { version: "v7" }),
        chatMessages as Array<{ id?: string; role: string; content?: unknown }>,
      ),
    );
    return c.json({
      total: recalled.total,
      page: recalled.page,
      perPage: recalled.perPage,
      hasMore: recalled.hasMore,
      messages: ui_messages,
    });
  },
});

// DELETE /work/threads/:threadId/messages — 删除指定消息
// 官方 API:Memory.deleteMessages()(docs/en/reference/memory/deleteMessages.mdx)
export const deleteMessagesRoute = registerApiRoute("/work/threads/:threadId/messages", {
  method: "DELETE",
  handler: async (c) => {
    const threadId = c.req.param("threadId");
    const body = (await c.req.json()) as { resourceId?: string; messageIds?: string[] };
    if (!body.resourceId) throw workError("VALIDATION_RESOURCE_ID_REQUIRED");
    if (!body.messageIds?.length) {
      throw workError("VALIDATION_FAILED", { text: "messageIds is required" });
    }
    const memory = await getWorkMemoryForThread(c.get("requestContext"), threadId, body.resourceId);
    if (!(await getOwnedThread(memory, threadId, body.resourceId))) {
      throw workError("THREAD_NOT_FOUND");
    }
    const { messages } = await memory.recall({
      threadId,
      resourceId: body.resourceId,
      perPage: false,
    });
    const ownedMessageIds = new Set((messages ?? []).map((message) => message.id));
    if (body.messageIds.some((messageId) => !ownedMessageIds.has(messageId))) {
      throw workError("MESSAGE_NOT_FOUND");
    }
    // Join OM buffering/reflection and vector cleanup before mutating the raw
    // message set. Compaction performs the additional reference rewrite first.
    await memory.settled();
    let restoreObservations: (() => Promise<void>) | undefined;
    try {
      restoreObservations = await removeObservationalMemoryReferences(
        memory,
        threadId,
        body.resourceId,
        body.messageIds,
      );
    } catch (error) {
      throw workError("VALIDATION_FAILED", {
        text: errorText(error, "OM references cannot be safely deleted"),
      });
    }
    try {
      await memory.deleteMessages(body.messageIds);
    } catch (error) {
      await restoreObservations?.();
      throw error;
    }
    await memory.settled();
    return c.json({ ok: true, threadId, deleted: body.messageIds.length });
  },
});
