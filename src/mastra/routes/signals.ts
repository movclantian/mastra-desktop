/**
 * Webhook 信号路由(/work/signals/*):持久化线程订阅管理与外部事件接收入口。
 * 官方文档:docs/en/docs/harness/signals.mdx「Use HTTP routes」、
 * docs/en/reference/signals/webhook-signal-provider.mdx。
 */

import { MASTRA_RESOURCE_ID_KEY } from "@mastra/core/request-context";
import { registerApiRoute } from "@mastra/core/server";
import { createRoute } from "@mastra/server/server-adapter";
import { z } from "zod";
import { workError, workValidationError } from "../errors";
import { workWebhookSignals } from "../harness/signals";
import { getOwnedThread, getWorkMemory } from "./threads/shared";

const webhookSubscriptionSchema = z
  .object({
    threadId: z.string().trim().min(1).max(256),
    externalResourceId: z.string().trim().min(1).max(256),
  })
  .strict();

const webhookSubscribeRoute = createRoute({
  path: "/work/signals/webhook/subscriptions",
  method: "POST",
  responseType: "datastream-response",
  queryParamSchema: z.object({}).strict(),
  bodySchema: webhookSubscriptionSchema.extend({
    metadata: z.record(z.string(), z.unknown()).optional(),
  }),
  onValidationError: workValidationError,
  handler: async ({ threadId, externalResourceId, metadata, requestContext }) => {
    const resourceId = requestContext.get(MASTRA_RESOURCE_ID_KEY);
    if (typeof resourceId !== "string" || !resourceId.trim()) throw workError("AUTH_REQUIRED");
    if (!(await getOwnedThread(await getWorkMemory(requestContext), threadId, resourceId))) {
      throw workError("THREAD_NOT_FOUND");
    }
    const subscription = await workWebhookSignals.subscribePersistent(
      { resourceId, threadId },
      externalResourceId,
      metadata,
    );
    return Response.json({ subscription }, { status: 201 });
  },
});

const webhookUnsubscribeRoute = createRoute({
  path: "/work/signals/webhook/subscriptions",
  method: "DELETE",
  responseType: "json",
  queryParamSchema: z.object({}).strict(),
  bodySchema: webhookSubscriptionSchema,
  onValidationError: workValidationError,
  handler: async ({ threadId, externalResourceId, requestContext }) => {
    const resourceId = requestContext.get(MASTRA_RESOURCE_ID_KEY);
    if (typeof resourceId !== "string" || !resourceId.trim()) throw workError("AUTH_REQUIRED");
    if (!(await getOwnedThread(await getWorkMemory(requestContext), threadId, resourceId))) {
      throw workError("THREAD_NOT_FOUND");
    }
    return {
      removed: await workWebhookSignals.unsubscribePersistent(
        { resourceId, threadId },
        externalResourceId,
      ),
    };
  },
});

const webhookSignalRoute = registerApiRoute("/work/signals/webhook", {
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
