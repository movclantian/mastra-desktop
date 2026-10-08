/** Desktop thread lifecycle hooks around the built-in Memory API. */
import type { MastraDBMessage } from "@mastra/core/agent";
import { MASTRA_RESOURCE_ID_KEY } from "@mastra/core/request-context";
import { type ContextWithMastra, registerApiRoute } from "@mastra/core/server";
import { TABLE_MESSAGES } from "@mastra/core/storage";
import { Extractor } from "@mastra/memory";
import { z } from "zod";
import { DEFAULT_AGENT_PROFILE_ID } from "../../../shared/agent-contract";
import { closeBrowserThreadSessions } from "../../agents/browser";
import { AGENT_PROFILE_CONTEXT_KEY, getAgentProfile } from "../../agents/custom";
import {
  createWorkMessageSignal,
  WORK_MESSAGE_OPTIONS_CONTEXT_KEY,
  workMessageMetadataSchema,
} from "../../agents/processors";
import { deleteTeamInvocations } from "../../agents/team-activity";
import { deleteTeamHandoffs } from "../../agents/team-handoff";
import { closeComputerConnections } from "../../connections/computer";
import { getMcpConfig } from "../../connections/mcp";
import { workError } from "../../errors";
import { workPollingSignals, workWebhookSignals } from "../../harness/signals";
import { resolveDefaultLanguageModel, resolveRequestModel } from "../../models/providers";
import { listPluginSkills } from "../../plugins/registry";
import {
  attachAssetReference,
  getLibraryAsset,
  getLibraryAssetId,
  releaseThreadAssets,
} from "../../rag/storage/assets";
import { appStorage, getLibsqlClient } from "../../storage/database";
import { listWorkspaceChanges } from "../../workspace/changes";
import { deleteThreadWorkspace } from "../../workspace/workspace-manager";
import { abortWorkbenchSession, observeSessionWork } from "../session";
import { prepareWorkbenchMessage } from "../session-context";
import { assertNoActiveTeamRun, startTeamWorkflow } from "../team-runs";
import { workbenchMessages } from "./messages";
import {
  deleteThreadMessages,
  getOwnedThread,
  getWorkMemory,
  normalizeChatHistoryMessages,
} from "./shared";

/** Editing rewrites stored history; ordinary messages use Controller.sendMessage. */
const rewriteThreadMessageRoute = registerApiRoute(
  "/work/threads/:threadId/messages/:messageId/rewrite",
  {
    method: "POST",
    handler: async (c) => {
      const body = z
        .discriminatedUnion("action", [
          z.object({
            action: z.literal("edit"),
            content: z.string(),
            options: z.record(z.string(), z.unknown()).optional(),
          }),
          z.object({
            action: z.literal("regenerate"),
            options: z.record(z.string(), z.unknown()).optional(),
          }),
        ])
        .parse(await c.req.json());
      const resourceId = c.get("requestContext").get(MASTRA_RESOURCE_ID_KEY) as string;
      const threadId = c.req.param("threadId");
      const messageId = c.req.param("messageId");
      const result = await prepareWorkbenchMessage(c, threadId, resourceId, body.options);
      await assertNoActiveTeamRun(resourceId, threadId);
      await abortWorkbenchSession(result.controllerSession);
      await result.memory.settled();
      const recalled = await result.memory.recall({ threadId, resourceId, perPage: false });
      const history = normalizeChatHistoryMessages(recalled.messages);
      const targetIndex = history.findIndex((message) => message.id === messageId);
      const target = history[targetIndex];
      if (!target || target.role !== (body.action === "edit" ? "user" : "assistant")) {
        throw workError("MESSAGE_NOT_FOUND");
      }
      const original =
        body.action === "edit"
          ? target
          : history.slice(0, targetIndex).findLast((message) => message.role === "user");
      if (!original) throw workError("MESSAGE_NOT_FOUND");
      const [message] = workbenchMessages([original]);
      const content =
        body.action === "edit"
          ? body.content
          : message.parts
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("\n");
      const files = message.parts.flatMap((part) =>
        part.type === "file"
          ? [{ url: part.url, mediaType: part.mediaType, filename: part.filename }]
          : [],
      );
      if (!content.trim() && files.length === 0) throw workError("SESSION_INPUT_REQUIRED");
      const metadata = message.metadata as
        | { skillNames?: string[]; fileReferences?: unknown[] }
        | undefined;
      await prepareWorkbenchMessage(c, threadId, resourceId, {
        ...body.options,
        skillNames: metadata?.skillNames ?? [],
        fileReferences: metadata?.fileReferences ?? [],
        files,
      });
      // A new native message gets a new ID, so remove the source user as well.
      const boundary = recalled.messages.findIndex((entry) => entry.id === original.id);
      await deleteThreadMessages(
        result.memory,
        threadId,
        resourceId,
        recalled.messages.slice(boundary).map((entry) => entry.id),
      );
      result.controllerSession.displayState.resetThread();
      const profile = await getAgentProfile(
        c.get("requestContext").get(AGENT_PROFILE_CONTEXT_KEY) as string,
        resourceId,
      );
      if (profile.workflow?.strategy === "workflow") return startTeamWorkflow(c, result, content);
      observeSessionWork(
        c,
        result.controllerSession,
        result.controllerSession.sendSignal(
          createWorkMessageSignal(
            content,
            workMessageMetadataSchema.parse(
              c.get("requestContext").get(WORK_MESSAGE_OPTIONS_CONTEXT_KEY),
            ),
          ),
          { requestContext: c.get("requestContext"), requireDelivery: true },
        ).accepted,
      );
      return c.json({ ok: true });
    },
  },
);

const searchThreadsRoute = registerApiRoute("/work/threads/search", {
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
      if (thread.metadata?.goalJudge === true) continue;
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
const generateThreadTitleRoute = registerApiRoute("/work/threads/:threadId/generate-title", {
  method: "POST",
  handler: async (c) => {
    const { resourceId } = z.object({ resourceId: z.string().min(1) }).parse(await c.req.json());
    const threadId = c.req.param("threadId");
    const memory = await getWorkMemory(c.get("requestContext"));
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
      .getAgentById(DEFAULT_AGENT_PROFILE_ID)
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
const toggleMessageReactionRoute = registerApiRoute(
  "/work/threads/:threadId/messages/:messageId/reactions",
  {
    method: "POST",
    handler: async (c) => {
      const { resourceId, emoji } = z
        .object({ resourceId: z.string().min(1), emoji: z.string().min(1).max(16) })
        .parse(await c.req.json());
      const threadId = c.req.param("threadId");
      const messageId = c.req.param("messageId");
      const memory = await getWorkMemory(c.get("requestContext"));
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

        const signal = mastra.getAgentById(DEFAULT_AGENT_PROFILE_ID).sendSignal(
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
const cloneThreadRoute = registerApiRoute("/work/threads/:threadId/clone", {
  method: "POST",
  handler: async (c) => {
    const { resourceId, upToMessageId } = z
      .object({
        resourceId: z.string().min(1),
        upToMessageId: z.string().min(1).optional(),
      })
      .parse(await c.req.json());
    const threadId = c.req.param("threadId");
    const memory = await getWorkMemory(c.get("requestContext"));
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
    const copied = await memory.recall({ threadId: clone.id, resourceId, perPage: false });
    for (const message of workbenchMessages(copied.messages)) {
      for (const part of message.parts) {
        const assetId = part.type === "file" ? getLibraryAssetId(part.url) : null;
        if (assetId && (await getLibraryAsset(resourceId, assetId)))
          await attachAssetReference(resourceId, assetId, undefined, clone.id);
      }
    }
    return c.json({ thread: clone });
  },
});

/** 分支来源(官方 isClone / getSourceThread):分支会话顶部「派生自 …」导航条的数据源 */
const threadSourceRoute = registerApiRoute("/work/threads/:threadId/source", {
  method: "GET",
  handler: async (c) => {
    const resourceId = z.string().min(1).parse(c.req.query("resourceId"));
    const threadId = c.req.param("threadId");
    const memory = await getWorkMemory(c.get("requestContext"));
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
const threadMessagesPageRoute = registerApiRoute("/work/threads/:threadId/messages/page", {
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
    const memory = await getWorkMemory(c.get("requestContext"));
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

/** Read persisted conversation facts and the working memory used by this thread. */
const threadContextRoute = registerApiRoute("/work/threads/:threadId/context", {
  method: "GET",
  handler: async (c) => {
    const resourceId = c.get("requestContext").get(MASTRA_RESOURCE_ID_KEY) as string;
    const threadId = c.req.param("threadId");
    const memory = await getWorkMemory(c.get("requestContext"));
    const thread = await getOwnedThread(memory, threadId, resourceId);
    if (!thread) throw workError("THREAD_NOT_FOUND");
    const memoryConfig = memory.getMergedThreadConfig().workingMemory;
    const [{ messages }, mcp, changes, workingMemory, workingMemoryTemplate] = await Promise.all([
      memory.recall({ threadId, resourceId, perPage: false }),
      getMcpConfig(resourceId),
      listWorkspaceChanges(threadId, resourceId),
      memory.getWorkingMemory({ threadId, resourceId }),
      memory.getWorkingMemoryTemplate({}),
    ]);
    type Item = {
      id: string;
      kind: "skill" | "mcp" | "web" | "file" | "artifact";
      label: string;
      url?: string;
      path?: string;
      mediaType?: string;
    };
    const items = new Map<string, Item>();
    const record = (value: unknown): Record<string, unknown> =>
      value && typeof value === "object" ? (value as Record<string, unknown>) : {};
    const add = (item: Item) => items.set(`${item.kind}:${item.id}`, item);
    const addFile = (raw: unknown) => {
      const file = record(raw);
      if (typeof file.url !== "string") return;
      let url: URL;
      try {
        url = new URL(file.url, c.req.url);
      } catch {
        return;
      }
      if (!/^\/work\/library\/assets\/[^/]+\/content$/.test(url.pathname)) return;
      // Rebuild the authenticated local URL: message metadata must not choose a preview host.
      const localUrl = `${url.pathname}?resourceId=${encodeURIComponent(resourceId)}`;
      add({
        id: url.pathname,
        kind: "file",
        label: String(file.filename ?? file.title ?? "文件"),
        url: localUrl,
        mediaType: String(file.mediaType ?? ""),
      });
    };
    let latestRequest = "";
    const pluginSkills = await listPluginSkills(resourceId);
    for (const message of workbenchMessages(messages)) {
      const metadata = record(message.metadata);
      if (message.role === "user") {
        latestRequest = message.parts
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n");
        for (const name of Array.isArray(metadata.skillNames) ? metadata.skillNames : []) {
          if (typeof name === "string")
            add({
              id: name,
              kind: "skill",
              label:
                pluginSkills.find((skill) => skill.id === name)?.displayName ?? "Skill unavailable",
            });
        }
        for (const source of Array.isArray(metadata.librarySources) ? metadata.librarySources : [])
          addFile(source);
        for (const file of Array.isArray(metadata.fileReferences) ? metadata.fileReferences : [])
          addFile(file);
      }
      for (const raw of message.parts) {
        const part = record(raw);
        if (part.type === "file") addFile(part);
        if (part.type === "data-library-sources" && Array.isArray(part.data))
          for (const source of part.data) addFile(source);
        if (typeof part.type !== "string") continue;
        const name =
          part.type === "dynamic-tool"
            ? String(part.toolName)
            : part.type.startsWith("tool-")
              ? part.type.slice(5)
              : "";
        if (!name || part.state !== "output-available") continue;
        const input = record(part.input);
        const output = record(part.output);
        const server = mcp.servers.find((server) => name.startsWith(`${server.id}_`));
        if (server) add({ id: server.id, kind: "mcp", label: server.name });
        const skillName =
          name === "skill" ? input.name : name === "skill_read" ? input.skillName : undefined;
        if (typeof skillName === "string") {
          const skill = pluginSkills.find((item) => item.name === skillName);
          add({
            id: skill?.id ?? skillName,
            kind: "skill",
            label: skill?.displayName ?? skillName,
          });
        }
        if (output.isError === true || output.success === false || output.ok === false) continue;
        if (
          /^(?:web_fetch|browser_(?:navigate|snapshot|screenshot)|firecrawl_scrape)$/.test(name)
        ) {
          const url = output.url ?? input.url;
          if (typeof url === "string" && /^https?:\/\//i.test(url))
            add({
              id: url,
              kind: "web",
              label: typeof output.title === "string" && output.title ? output.title : url,
              url,
            });
        }
        const archived = record(output.contentObject);
        if (name === "browser_screenshot" && typeof archived.workspacePath === "string") {
          add({
            id: archived.workspacePath,
            kind: "artifact",
            label: "screenshot.png",
            path: archived.workspacePath,
            mediaType: "image/png",
          });
        }
        const path = input.path ?? input.filePath ?? output.path;
        if (typeof path === "string" && /(?:write_file|edit_file|ast_edit|read_file)$/.test(name)) {
          const kind = /read_file/.test(name) ? "file" : "artifact";
          add({ id: path, kind, label: path.split(/[\\/]/).pop() || path, path });
        }
      }
    }
    // Filesystem hooks also record edits performed outside the top-level tool stream.
    for (const change of changes) {
      if (change.kind === "deleted") items.delete(`artifact:${change.path}`);
      else
        add({
          id: change.path,
          kind: "artifact",
          label: change.path.split(/[\\/]/).pop() || change.path,
          path: change.path,
          mediaType: change.after?.contentType,
        });
    }
    return c.json({
      threadId,
      title: thread.title,
      latestRequest,
      items: [...items.values()],
      workingMemory: {
        content: workingMemory,
        enabled: memoryConfig?.enabled === true,
        scope: memoryConfig?.scope ?? "resource",
        format: workingMemoryTemplate?.format ?? "markdown",
      },
    });
  },
});

const summarizeThreadRoute = registerApiRoute("/work/threads/:threadId/summarize", {
  method: "POST",
  handler: async (c) => {
    const { resourceId, model: rawModel } = z
      .object({ resourceId: z.string().min(1), model: z.unknown().optional() })
      .parse(await c.req.json());
    const threadId = c.req.param("threadId");
    const memory = await getWorkMemory(c.get("requestContext"));
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

// The desktop host owns draft creation across every renderer entry point.
// ponytail: process-local serialization; use a database lock if the app gains multiple hosts.
const draftCreations = new Map<string, Promise<void>>();

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
    const memory = await getWorkMemory(c.get("requestContext"));
    const threadIds = [...new Set(messages.map((message) => message.threadId))];
    for (const threadId of threadIds) {
      if (!threadId || !(await getOwnedThread(memory, threadId, resourceId)))
        throw workError("THREAD_NOT_FOUND");
      await assertNoActiveTeamRun(resourceId, threadId);
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
  const memory = await getWorkMemory(c.get("requestContext"));
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
    if (!threadId && c.req.method === "POST" && metadata?.draft === true) {
      const previous = draftCreations.get(resourceId) ?? Promise.resolve();
      const creation = previous
        .catch(() => undefined)
        .then(async () => {
          await memory.settled();
          const { threads } = await memory.listThreads({
            filter: { resourceId },
            perPage: false,
            orderBy: { field: "createdAt", direction: "DESC" },
          });
          const running = new Set(
            Object.values(c.get("mastra").listAgents()).flatMap((agent) =>
              agent
                .listActiveThreadRuns()
                .filter((run) => run.resourceId === resourceId)
                .map((run) => run.threadId),
            ),
          );
          const drafts = threads.filter(
            (candidate) =>
              candidate.metadata?.draft === true &&
              !candidate.metadata.archivedAt &&
              !running.has(candidate.id),
          );
          if (drafts.length) {
            const client = await getLibsqlClient();
            const history = await client.execute({
              sql: `SELECT DISTINCT thread_id FROM "${TABLE_MESSAGES}"
              WHERE "resourceId" = ? AND thread_id IN (${drafts.map(() => "?").join(",")})
                AND (role IN ('user', 'assistant') OR (role = 'signal' AND type = 'user'))`,
              args: [resourceId, ...drafts.map((draft) => draft.id)],
            });
            const used = new Set(history.rows.map((row) => row.thread_id));
            const draft = drafts.find((candidate) => !used.has(candidate.id));
            if (draft) {
              c.res = c.json(draft);
              return;
            }
          }
          await next();
          await memory.settled();
        });
      draftCreations.set(resourceId, creation);
      try {
        await creation;
      } finally {
        if (draftCreations.get(resourceId) === creation) draftCreations.delete(resourceId);
      }
      return;
    }
  }
  if (threadId && c.req.method === "DELETE") {
    await assertNoActiveTeamRun(resourceId, threadId);
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
    const schedules = c.get("mastra").schedules;
    const linkedSchedules = await schedules.list({ resourceId, threadId });
    await Promise.all(linkedSchedules.map((schedule) => schedules.delete(schedule.id)));
    await closeBrowserThreadSessions(resourceId, threadId);
    await closeComputerConnections(resourceId, threadId);
    await Promise.all([
      workWebhookSignals.removeThread({ threadId, resourceId }),
      workPollingSignals.removeThread({ threadId, resourceId }),
      deleteThreadWorkspace(threadId, thread.metadata, resourceId),
      releaseThreadAssets(resourceId, threadId),
      deleteTeamInvocations(resourceId, threadId),
      deleteTeamHandoffs(resourceId, threadId),
    ]);
  }
  if (!threadId && c.req.method === "GET") {
    const payload = (await c.res.clone().json()) as {
      threads: Array<{ id: string; metadata?: Record<string, unknown> }>;
    };
    // Keep native pagination: even a page containing only judge threads may have more pages.
    payload.threads = payload.threads.filter((thread) => thread.metadata?.goalJudge !== true);
    // Derive activity from persisted user turns, not settings writes to thread.updatedAt.
    // Aggregate timestamps in SQL so listing threads never loads message bodies into memory.
    const lastUserRequests = new Map<string, string>();
    if (payload.threads.length) {
      const client = await getLibsqlClient();
      const result = await client.execute({
        sql: `SELECT thread_id, strftime('%Y-%m-%dT%H:%M:%fZ', MAX("createdAt")) AS requested_at
              FROM "${TABLE_MESSAGES}"
              WHERE "resourceId" = ? AND thread_id IN (${payload.threads.map(() => "?").join(",")})
                AND (role = 'user' OR (role = 'signal' AND type = 'user'))
              GROUP BY thread_id`,
        args: [resourceId, ...payload.threads.map((thread) => thread.id)],
      });
      for (const row of result.rows) {
        if (typeof row.thread_id === "string" && typeof row.requested_at === "string") {
          lastUserRequests.set(row.thread_id, row.requested_at);
        }
      }
    }
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
        lastUserRequestAt: lastUserRequests.get(item.id) ?? null,
        metadata: {
          ...item.metadata,
          isWorking: active.has(item.id),
          activeRunId: active.get(item.id) ?? null,
        },
      })),
    });
  }
}

/** Desktop-only thread extensions. CRUD is registered by Mastra Server. */
export const threadRoutes = [
  rewriteThreadMessageRoute,
  generateThreadTitleRoute,
  toggleMessageReactionRoute,
  cloneThreadRoute,
  threadSourceRoute,
  threadMessagesPageRoute,
  summarizeThreadRoute,
  threadContextRoute,
  searchThreadsRoute,
];
