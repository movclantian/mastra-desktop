/** Desktop thread lifecycle hooks around the built-in Memory API. */
import type { MastraDBMessage } from "@mastra/core/agent";
import { MASTRA_RESOURCE_ID_KEY } from "@mastra/core/request-context";
import { type ContextWithMastra, registerApiRoute } from "@mastra/core/server";
import { z } from "zod";
import { workBrowser } from "../../agents";
import { workError } from "../../errors";
import { workPollingSignals, workWebhookSignals } from "../../harness";
import { appStorage } from "../../storage";
import { deleteThreadWorkspace } from "../../workspace";
import { workbenchMessages } from "./messages";
import { getOwnedThread, getWorkMemoryForThread, normalizeChatHistoryMessages } from "./shared";

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
    if (workBrowser.hasThreadSession(threadId)) await workBrowser.closeThreadSession(threadId);
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
