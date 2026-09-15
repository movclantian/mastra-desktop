/**
 * Webhook 信号路由(/work/signals/*):持久化线程订阅管理与外部事件接收入口。
 * 官方文档:docs/en/docs/harness/signals.mdx「Use HTTP routes」、
 * docs/en/reference/signals/webhook-signal-provider.mdx。
 */
import { registerApiRoute } from "@mastra/core/server";
import { workError } from "../errors";
import { workWebhookSignals } from "../harness";
import { getOwnedThread, getWorkMemoryForThread } from "./threads/shared";

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
      throw workError("VALIDATION_FAILED", {
        text: "resourceId, threadId and externalResourceId are required",
      });
    }
    if (
      !(await getOwnedThread(
        await getWorkMemoryForThread(c.get("requestContext"), body.threadId, body.resourceId),
        body.threadId,
        body.resourceId,
      ))
    ) {
      throw workError("THREAD_NOT_FOUND");
    }
    const subscription = await workWebhookSignals.subscribePersistent(
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
      throw workError("VALIDATION_FAILED", {
        text: "resourceId, threadId and externalResourceId are required",
      });
    }
    if (
      !(await getOwnedThread(
        await getWorkMemoryForThread(c.get("requestContext"), body.threadId, body.resourceId),
        body.threadId,
        body.resourceId,
      ))
    ) {
      throw workError("THREAD_NOT_FOUND");
    }
    return c.json({
      removed: await workWebhookSignals.unsubscribePersistent(
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
