import { registerApiRoute } from "@mastra/core/server";
import { workWebhookSignals } from "../../harness";
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

export const signalRoutes = [webhookSubscribeRoute, webhookUnsubscribeRoute, webhookSignalRoute];
