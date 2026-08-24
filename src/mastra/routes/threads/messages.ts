/**
 * 消息历史路由:分页拉取、批量删除与跨线程搜索。
 * 官方文档:docs/en/docs/memory/message-history.mdx;
 * resourceId 租户隔离见 docs/en/docs/memory/multi-user-threads.mdx。
 */
import { toAISdkMessages } from "@mastra/ai-sdk/ui";
import { registerApiRoute } from "@mastra/core/server";
import type { UIMessage } from "ai";
import { workError } from "../../errors";
import { readMessageBranches, snapshot } from "./branches";
import { removeObservationalMemoryReferences } from "./compact";
import {
  getOwnedThread,
  getWorkMemory,
  getWorkMemoryForThread,
  normalizeChatHistoryMessages,
} from "./shared";
import type {
  MessageBranchRecord,
  MessageBranchVersion,
  PersistedUIMessage,
  ThreadMetadata,
} from "./types";

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

function projectBranchMessages(
  messages: ReturnType<typeof toAISdkMessages>,
  branches: Record<string, MessageBranchRecord>,
) {
  if (Object.keys(branches).length === 0) return messages;
  const branchByMessageId = new Map<string, MessageBranchRecord>();
  for (const branch of Object.values(branches)) {
    for (const item of branch.versions) {
      const messageId = item.message?.id;
      if (messageId) branchByMessageId.set(messageId, branch);
    }
  }

  // 每行先决定 保留/快照替换/隐藏:
  // - 行 id 与当前版本相同(用户编辑复用 id) → 原位换成当前版本快照;
  // - 不同(助手重试/编辑产生的新行) → 隐藏,避免新旧两行同时显示。
  // 第二步:当前版本的物理行已被删除(编辑时旧尾巴从 Memory 清掉了)的分支,
  // 把当前版本快照插回最后一个隐藏行的位置 —— 否则切回旧版本时该条消息
  // 会整行消失,而不是在原位显示旧内容。
  const rows: (typeof messages)[] = [];
  const selectedRowSeen = new Set<string>();
  const lastHiddenRowByRoot = new Map<string, number>();
  messages.forEach((message, index) => {
    const branch = branchByMessageId.get(message.id);
    if (!branch) {
      rows[index] = [message];
      return;
    }
    const selected = branch.versions.find((item) => item.id === branch.currentVersionId);
    if (!selected?.message) {
      rows[index] = [message];
      return;
    }
    // User turns are timeline anchors. They must never disappear merely
    // because an assistant branch has a different physical row after reload.
    // Edits reuse the user message id in the normal path; the role fallback
    // also handles older branch metadata whose converted ids no longer match
    // the recalled row exactly.
    if (message.role === "user" && selected.role === "user") {
      if (!selectedRowSeen.has(branch.rootId)) {
        selectedRowSeen.add(branch.rootId);
        rows[index] = [selected.message as typeof message];
      } else {
        rows[index] = [message];
      }
      return;
    }
    if (selected.message.id === message.id) {
      selectedRowSeen.add(branch.rootId);
      rows[index] = [selected.message as typeof message];
    } else {
      lastHiddenRowByRoot.set(branch.rootId, index);
      rows[index] = [];
    }
  });
  // 第二步:当前版本的物理行已被删除(编辑/切换时旧时间线从 Memory 清掉了)
  // 的分支,把 [当前版本快照 + 子树 tail] 整条插回 —— 分支作用于该节点之后
  // 的全部消息,不只是这一对。助手分支的插入位置 = 其配对用户版本(父锚点)
  // 所在行之后;找不到锚点(旧数据无配对)时退回最后一个隐藏行的位置。
  for (const branch of Object.values(branches)) {
    if (selectedRowSeen.has(branch.rootId)) continue;
    const selected = branch.versions.find((item) => item.id === branch.currentVersionId);
    if (!selected?.message) continue;
    const injected = [selected.message, ...(selected.tail ?? [])] as (typeof messages)[number][];
    const anchorId = findVersionById(branches, selected.pairVersionId)?.message?.id;
    let anchorIndex = -1;
    if (anchorId) {
      anchorIndex = rows.findIndex((rowMessages) => rowMessages.some((m) => m.id === anchorId));
    }
    if (anchorIndex < 0) anchorIndex = lastHiddenRowByRoot.get(branch.rootId) ?? -1;
    if (anchorIndex >= 0) {
      rows[anchorIndex] = [...rows[anchorIndex], ...injected];
    } else {
      rows.push(injected);
    }
  }
  return rows.flat();
}

function findVersionById(
  branches: Record<string, MessageBranchRecord>,
  versionId: string | undefined,
): MessageBranchVersion | undefined {
  if (!versionId) return undefined;
  for (const branch of Object.values(branches)) {
    const found = branch.versions.find((item) => item.id === versionId);
    if (found) return found;
  }
  return undefined;
}

function branchPayload(branches: Record<string, MessageBranchRecord>) {
  // tail 是服务端子树快照,客户端切换器用不到,剥掉减小载荷
  return Object.fromEntries(
    Object.entries(branches).map(([rootId, branch]) => [
      rootId,
      {
        ...branch,
        versions: branch.versions.map(({ tail: _tail, ...version }) => version),
      },
    ]),
  );
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
    const branches = readMessageBranches((thread.metadata ?? {}) as ThreadMetadata);
    return c.json({
      total: recalled.total,
      page: recalled.page,
      perPage: recalled.perPage,
      hasMore: recalled.hasMore,
      messages: projectBranchMessages(ui_messages, branches),
      branches: branchPayload(branches),
    });
  },
});

// PATCH /work/threads/:threadId/branches/:rootId — persist the selected branch.
// 分支作用于整条时间线而非单对消息:切走 = 把当前版本行之后的下游消息快照进
// 旧版本的 tail 并从 Memory 删除(隔离);切回 = GET 投影把 [当前版本 + tail]
// 插回显示,下一次发消息时随请求物理落库。
export const updateMessageBranchRoute = registerApiRoute(
  "/work/threads/:threadId/branches/:rootId",
  {
    method: "PATCH",
    handler: async (c) => {
      const threadId = c.req.param("threadId");
      const rootId = c.req.param("rootId");
      const body = (await c.req.json()) as { resourceId?: string; currentVersionId?: string };
      if (!body.resourceId || !body.currentVersionId) {
        throw workError("VALIDATION_FAILED", {
          text: "resourceId and currentVersionId are required",
        });
      }
      const memory = await getWorkMemoryForThread(
        c.get("requestContext"),
        threadId,
        body.resourceId,
      );
      const thread = await getOwnedThread(memory, threadId, body.resourceId);
      if (!thread) throw workError("THREAD_NOT_FOUND");
      const metadata = (thread.metadata ?? {}) as ThreadMetadata;
      const branches = readMessageBranches(metadata);
      const branch = branches[rootId];
      const incoming = branch?.versions.find((item) => item.id === body.currentVersionId);
      if (!branch || !incoming?.message) {
        throw workError("MESSAGE_NOT_FOUND");
      }

      let rows: UIMessage[] = [];
      try {
        const recalled = await memory.recall({
          threadId,
          resourceId: body.resourceId,
          perPage: false,
        });
        rows = toAISdkMessages(recalled.messages ?? [], { version: "v7" }) as UIMessage[];
        const branchRowIds = new Set(
          branch.versions
            .map((item) => item.message?.id)
            .filter((id): id is string => typeof id === "string"),
        );
        const position = rows.findIndex((message) => branchRowIds.has(message.id));
        if (position >= 0) {
          const tailRows = rows.slice(position + 1);
          if (tailRows.length > 0) {
            const tailIds = tailRows
              .map((message) => message.id)
              .filter((id): id is string => typeof id === "string");
            await memory.settled();
            let restoreObservations: (() => Promise<void>) | undefined;
            try {
              restoreObservations = await removeObservationalMemoryReferences(
                memory,
                threadId,
                body.resourceId,
                tailIds,
              );
              await memory.deleteMessages(tailIds);
            } catch (error) {
              await restoreObservations?.();
              throw workError("VALIDATION_FAILED", {
                text:
                  error instanceof Error ? error.message : "OM references cannot be safely deleted",
              });
            }
            await memory.settled();
          }
          // 尾巴归属旧时间线的助手版本:助手分支直接归当前旧版本;用户分支
          // 的尾巴首行就是旧助手回复(由配对版本的 message 快照负责),其余
          // 下游归"配对的那个助手版本"的 tail
          const outgoing = branch.versions.find((item) => item.id === branch.currentVersionId);
          const tailOwner =
            incoming.role === "assistant"
              ? outgoing
              : findVersionById(branches, outgoing?.pairVersionId);
          if (tailOwner?.message) {
            const ownerRowIndex = tailRows.findIndex(
              (message) => message.id === tailOwner.message?.id,
            );
            const subordinateStart = ownerRowIndex >= 0 ? ownerRowIndex + 1 : 1;
            const subordinate = tailRows
              .slice(subordinateStart)
              .map((message) => snapshot(message))
              .filter((item): item is PersistedUIMessage => !!item);
            if (subordinate.length > 0) tailOwner.tail = subordinate;
          }
        }
      } catch {
        // 截断失败不阻断选择持久化:退化为旧行为(仅切换当前版本标记)
      }

      branches[rootId] = { ...branch, currentVersionId: incoming.id };
      // Context 用量与当前分支时间线联动:投影出切换后的消息列表,取最后
      // 一条助手消息的 usage 写回线程元数据 contextUsage —— 它是前端刷新/
      // 重启后的用量回退源,不写回会一直停留在旧时间线的数值上
      let branchContextUsage: unknown;
      try {
        const projected = projectBranchMessages(rows, branches);
        const lastAssistant = [...projected]
          .reverse()
          .find((message) => message.role === "assistant");
        branchContextUsage = (lastAssistant?.metadata as { usage?: unknown } | undefined)?.usage;
      } catch {
        // 投影失败不影响分支切换本身
      }
      await memory.updateThread({
        id: threadId,
        title: thread.title,
        metadata: {
          ...metadata,
          messageBranches: branches,
          ...(branchContextUsage ? { contextUsage: branchContextUsage } : {}),
        },
      });
      return c.json({ ok: true, rootId, currentVersionId: incoming.id });
    },
  },
);

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
        text: error instanceof Error ? error.message : "OM references cannot be safely deleted",
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

// GET /work/memory/search?q=&resourceId= — 跨线程检索线程消息
// 官方 API:Memory.recall() 的 vectorSearchString(docs/en/reference/memory/recall.mdx)。
// 语义召回(embedder/vector 可用)优先;失败或未启用时回退全量拉取 + 文本包含匹配。
export const searchMessagesRoute = registerApiRoute("/work/memory/search", {
  method: "GET",
  handler: async (c) => {
    const q = c.req.query("q")?.trim();
    const resourceId = c.req.query("resourceId");
    if (!q || !resourceId) {
      throw workError("VALIDATION_FAILED", { text: "q and resourceId are required" });
    }
    const memory = await getWorkMemory(c.get("requestContext"));
    const { threads } = await memory.listThreads({
      filter: { resourceId },
      perPage: false,
    });

    type SearchHit = {
      threadId: string;
      threadTitle: string;
      messageId: string;
      role: string;
      text: string;
      createdAt: string;
      semantic: boolean;
    };
    const hits: SearchHit[] = [];
    const lower = q.toLowerCase();

    for (const thread of threads) {
      // 1) 官方语义召回路径
      try {
        const { messages } = await memory.recall({
          threadId: thread.id,
          resourceId,
          vectorSearchString: q,
          perPage: 10,
        });
        for (const m of messages ?? []) {
          const text = (m.content.parts ?? [])
            .map((p) => (p.type === "text" ? p.text : ""))
            .filter(Boolean)
            .join(" ");
          if (text) {
            hits.push({
              threadId: thread.id,
              threadTitle: thread.title ?? thread.id,
              messageId: m.id,
              role: m.role,
              text,
              createdAt: m.createdAt.toISOString(),
              semantic: true,
            });
          }
        }
      } catch {
        // embedder/vector 不可用:走文本回退
      }

      // 2) 文本回退(语义不可用或未命中):全量拉取 + 包含匹配
      if (!hits.some((h) => h.threadId === thread.id)) {
        const { messages } = await memory.recall({ threadId: thread.id, perPage: false });
        for (const m of messages ?? []) {
          const text = (m.content.parts ?? [])
            .map((p) => (p.type === "text" ? p.text : ""))
            .filter(Boolean)
            .join(" ");
          if (text?.toLowerCase().includes(lower)) {
            hits.push({
              threadId: thread.id,
              threadTitle: thread.title ?? thread.id,
              messageId: m.id,
              role: m.role,
              text,
              createdAt: m.createdAt.toISOString(),
              semantic: false,
            });
          }
        }
      }
    }

    return c.json({ hits });
  },
});
