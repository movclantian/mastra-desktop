import { registerApiRoute } from "@mastra/core/server";
import { mastraWorkAgent, workWebhookSignals } from "../../agents";
import { getOwnedThread, getWorkMemory } from "./threads/shared";

export const webhookSubscribeRoute = registerApiRoute("/work/signals/webhook/subscriptions", {
  method: "POST",
  handler: async (c) => {
    const body = (await c.req.json()) as {
      resourceId?: string;
      threadId?: string;
      externalResourceId?: string;
      metadata?: Record<string, unknown>;
    };
    if (!body.resourceId || !body.threadId || !body.externalResourceId) {
      return c.json({ error: "resourceId, threadId and externalResourceId are required" }, 400);
    }
    if (!(await getOwnedThread(await getWorkMemory(), body.threadId, body.resourceId))) {
      return c.json({ error: "Thread not found" }, 404);
    }
    const subscription = workWebhookSignals.subscribeThread(
      { resourceId: body.resourceId, threadId: body.threadId },
      body.externalResourceId,
      body.metadata,
    );
    return c.json({ subscription }, 201 as 201);
  },
});

export const webhookUnsubscribeRoute = registerApiRoute("/work/signals/webhook/subscriptions", {
  method: "DELETE",
  handler: async (c) => {
    const body = (await c.req.json()) as {
      resourceId?: string;
      threadId?: string;
      externalResourceId?: string;
    };
    if (!body.resourceId || !body.threadId || !body.externalResourceId) {
      return c.json({ error: "resourceId, threadId and externalResourceId are required" }, 400);
    }
    if (!(await getOwnedThread(await getWorkMemory(), body.threadId, body.resourceId))) {
      return c.json({ error: "Thread not found" }, 404);
    }
    return c.json({
      removed: workWebhookSignals.unsubscribeThread(
        { resourceId: body.resourceId, threadId: body.threadId },
        body.externalResourceId,
      ),
    });
  },
});

export const webhookSignalRoute = registerApiRoute("/work/signals/webhook", {
  method: "POST",
  handler: async (c) => {
    const result = await workWebhookSignals.handleWebhook({
      body: await c.req.json(),
      headers: Object.fromEntries(c.req.raw.headers.entries()),
      params: {},
    });
    if (result.status === 204 || result.status === 205)
      return new Response(null, { status: result.status });
    return new Response(JSON.stringify(result.body ?? {}), {
      status: result.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  },
});

/**
 * Queue a follow-up for the current native chat run. The Agent signal runtime
 * drains it after the active turn; the current AI SDK UI stream remains the
 * sole owner of the visible response.
 */
export const queueMessageRoute = registerApiRoute("/work/threads/:threadId/queue", {
  method: "POST",
  handler: async (c) => {
    const threadId = c.req.param("threadId");
    const body = (await c.req.json()) as {
      resourceId?: string;
      content?: string;
      metadata?: Record<string, unknown>;
    };
    if (!body.resourceId || !body.content?.trim()) {
      return c.json({ error: "resourceId and content are required" }, 400);
    }
    const memory = await getWorkMemory();
    if (!(await getOwnedThread(memory, threadId, body.resourceId))) {
      return c.json({ error: "Thread not found" }, 404);
    }
    try {
      const accepted = mastraWorkAgent.queueMessage(
        { contents: body.content.trim(), ...(body.metadata ? { metadata: body.metadata } : {}) },
        {
          resourceId: body.resourceId,
          threadId,
          ifActive: { behavior: "deliver" },
          ifIdle: { behavior: "persist" },
        },
      );
      return c.json({ ok: true, accepted: await accepted.accepted });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "排队消息失败" }, 400);
    }
  },
});

/**
 * Deliver a follow-up immediately to the active Agent turn. This is distinct
 * from queueMessage: queueMessage waits for the current turn to become idle,
 * while sendMessage uses the runtime's active-run delivery path.
 */
export const sendMessageRoute = registerApiRoute("/work/threads/:threadId/send", {
  method: "POST",
  handler: async (c) => {
    const threadId = c.req.param("threadId");
    const body = (await c.req.json()) as {
      resourceId?: string;
      content?: string;
      metadata?: Record<string, unknown>;
    };
    if (!body.resourceId || !body.content?.trim()) {
      return c.json({ error: "resourceId and content are required" }, 400);
    }
    const memory = await getWorkMemory();
    if (!(await getOwnedThread(memory, threadId, body.resourceId))) {
      return c.json({ error: "Thread not found" }, 404);
    }
    try {
      const accepted = mastraWorkAgent.sendMessage(
        { contents: body.content.trim(), ...(body.metadata ? { metadata: body.metadata } : {}) },
        {
          resourceId: body.resourceId,
          threadId,
          ifActive: { behavior: "deliver" },
          ifIdle: { behavior: "wake" },
        },
      );
      return c.json({ ok: true, accepted: await accepted.accepted });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "立即发送失败" }, 400);
    }
  },
});

export const signalRoutes = [
  webhookSubscribeRoute,
  webhookUnsubscribeRoute,
  webhookSignalRoute,
  queueMessageRoute,
  sendMessageRoute,
];
