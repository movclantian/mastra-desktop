/** Durable webhook/polling signal providers and the notification inbox tool. */
import { createHash } from "node:crypto";
import {
  createNotificationInboxTool,
  type SendNotificationSignalInput,
} from "@mastra/core/notifications";
import {
  type SignalProviderTarget,
  type SignalSubscription,
  WebhookSignalProvider,
} from "@mastra/core/signals";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { appStorage, getLibsqlClient } from "../storage";
import { WORKSPACE_RESOURCE_ID_CONTEXT_KEY, WORKSPACE_THREAD_ID_CONTEXT_KEY } from "../workspace";

// The database owns durable subscriptions; the official registry handles delivery.
let subscriptionsReady: Promise<void> | undefined;
async function subscriptionStore() {
  const client = await getLibsqlClient();
  subscriptionsReady ??= client
    .execute(`CREATE TABLE IF NOT EXISTS signal_subscriptions (
    provider_id TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    external_resource_id TEXT NOT NULL,
    metadata TEXT NOT NULL,
    PRIMARY KEY (provider_id, resource_id, thread_id, external_resource_id)
  )`)
    .then(() => undefined);
  await subscriptionsReady;
  return client;
}

function publicSubscription(subscription: SignalSubscription): SignalSubscription {
  const metadata = subscription.metadata as { url?: unknown; headers?: unknown };
  return {
    ...subscription,
    metadata: {
      ...(typeof metadata.url === "string" ? { url: metadata.url } : {}),
      ...(metadata.headers &&
      typeof metadata.headers === "object" &&
      !Array.isArray(metadata.headers)
        ? { headerKeys: Object.keys(metadata.headers as Record<string, unknown>) }
        : {}),
    },
  };
}

export class PersistentWebhookSignalProvider extends WebhookSignalProvider {
  private mutations: Promise<unknown> = Promise.resolve();

  // Serialize DB + registry changes together. A failed write must not poison later writes.
  private update<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.mutations.then(operation);
    this.mutations = next.catch(() => undefined);
    return next;
  }

  async start(): Promise<void> {
    await this.update(async () => {
      const result = await (await subscriptionStore()).execute({
        sql: "SELECT resource_id, thread_id, external_resource_id, metadata FROM signal_subscriptions WHERE provider_id = ?",
        args: [this.id],
      });
      for (const row of result.rows) {
        super.subscribeThread(
          { resourceId: String(row.resource_id), threadId: String(row.thread_id) },
          String(row.external_resource_id),
          z.record(z.string(), z.unknown()).parse(JSON.parse(String(row.metadata))),
        );
      }
    });
  }

  async subscribePersistent(
    target: SignalProviderTarget,
    externalResourceId: string,
    metadata: Record<string, unknown> = {},
  ): Promise<SignalSubscription> {
    return this.update(async () => {
      await (await subscriptionStore()).execute({
        sql: `INSERT INTO signal_subscriptions
          (provider_id, resource_id, thread_id, external_resource_id, metadata)
          VALUES (?, ?, ?, ?, ?) ON CONFLICT(provider_id, resource_id, thread_id, external_resource_id)
          DO UPDATE SET metadata = excluded.metadata`,
        args: [
          this.id,
          target.resourceId,
          target.threadId,
          externalResourceId,
          JSON.stringify(metadata),
        ],
      });
      return super.subscribeThread(target, externalResourceId, metadata);
    });
  }

  async unsubscribePersistent(
    target: SignalProviderTarget,
    externalResourceId: string,
  ): Promise<boolean> {
    return this.update(async () => {
      const result = await (await subscriptionStore()).execute({
        sql: "DELETE FROM signal_subscriptions WHERE provider_id = ? AND resource_id = ? AND thread_id = ? AND external_resource_id = ?",
        args: [this.id, target.resourceId, target.threadId, externalResourceId],
      });
      super.unsubscribeThread(target, externalResourceId);
      return result.rowsAffected > 0;
    });
  }

  async removeThread(target: SignalProviderTarget): Promise<void> {
    await this.update(async () => {
      await (await subscriptionStore()).execute({
        sql: "DELETE FROM signal_subscriptions WHERE provider_id = ? AND resource_id = ? AND thread_id = ?",
        args: [this.id, target.resourceId, target.threadId],
      });
      this.unsubscribeAll(target);
    });
  }

  async listPersistent(resourceId: string): Promise<SignalSubscription[]> {
    await this.mutations;
    return this.getSubscriptions().filter((item) => item.resourceId === resourceId);
  }

  getTools() {
    return signalTools;
  }
}

type PollingSubscriptionMetadata = { url: string; headers?: Record<string, string> };

export class PersistentPollingSignalProvider extends PersistentWebhookSignalProvider {
  readonly pollInterval = 30_000;
  private fingerprints = new Map<string, string>();

  constructor() {
    super({ id: "mastra-polling-signals", name: "Mastra Polling Signals" });
  }

  async subscribePersistent(
    target: SignalProviderTarget,
    externalResourceId: string,
    metadata: Record<string, unknown> = {},
  ) {
    const parsed = z
      .object({
        url: z.url({ protocol: /^https?$/ }),
        headers: z.record(z.string(), z.string()).optional(),
      })
      .parse(metadata);
    return super.subscribePersistent(target, externalResourceId, parsed);
  }

  stop(): void {
    this.fingerprints.clear();
    super.stop();
  }

  async poll(subscriptions: SignalSubscription[]): Promise<void> {
    const active = new Set(subscriptions.map((subscription) => subscription.id));
    for (const id of this.fingerprints.keys()) {
      if (!active.has(id)) this.fingerprints.delete(id);
    }
    await Promise.all(
      subscriptions.map(async (subscription) => {
        const metadata = subscription.metadata as Partial<PollingSubscriptionMetadata>;
        if (typeof metadata.url !== "string") return;
        try {
          const response = await fetch(metadata.url, {
            headers: metadata.headers,
            signal: AbortSignal.timeout(this.pollInterval),
          });
          if (!response.ok) throw new Error(`Polling source returned ${response.status}`);
          const body = await response.text();
          const fingerprint = createHash("sha256").update(body).digest("hex");
          const key = subscription.id;
          const previous = this.fingerprints.get(key);
          if (!previous) {
            this.fingerprints.set(key, fingerprint);
            return;
          }
          if (previous === fingerprint) return;
          await this.notify(
            {
              source: "polling",
              kind: "resource-changed",
              priority: "medium",
              summary: `Polling source ${subscription.externalResourceId} changed.`,
              payload: { externalResourceId: subscription.externalResourceId, body },
              dedupeKey: `polling:${subscription.externalResourceId}:${fingerprint}`,
            },
            { threadId: subscription.threadId, resourceId: subscription.resourceId },
          );
          this.fingerprints.set(key, fingerprint);
        } catch (error) {
          await this.notify(
            {
              source: "polling",
              kind: "poll-error",
              priority: "low",
              summary: `Polling source ${subscription.externalResourceId} failed.`,
              payload: { error: error instanceof Error ? error.message : String(error) },
              dedupeKey: `polling:error:${subscription.externalResourceId}`,
            },
            { threadId: subscription.threadId, resourceId: subscription.resourceId },
          ).catch(() => undefined);
        }
      }),
    );
  }
}

export const workWebhookSignals = new PersistentWebhookSignalProvider({
  id: "mastra-work-webhooks",
  name: "Mastra Work Webhooks",
  // Uses the default extractor: webhook payloads must provide resource or externalResourceId.
});
export const workPollingSignals = new PersistentPollingSignalProvider();

function signalTarget(context: {
  requestContext?: { get(key: string): unknown };
}): SignalProviderTarget {
  const resourceId = context.requestContext?.get(WORKSPACE_RESOURCE_ID_CONTEXT_KEY);
  const threadId = context.requestContext?.get(WORKSPACE_THREAD_ID_CONTEXT_KEY);
  if (typeof resourceId !== "string" || typeof threadId !== "string")
    throw new Error("Signal subscriptions require an active thread and resource");
  return { resourceId, threadId };
}

const signalTools = {
  signal_subscribe: createTool({
    id: "signal_subscribe",
    description: "Subscribe the current Agent thread to a webhook or polling signal source.",
    inputSchema: z.object({
      provider: z.enum(["webhook", "polling"]).default("webhook"),
      externalResourceId: z.string().min(1),
      pollUrl: z.string().url().optional(),
      headers: z.record(z.string(), z.string()).optional(),
    }),
    execute: async ({ provider, externalResourceId, pollUrl, headers }, context) => {
      const target = signalTarget(context);
      if (provider === "polling") {
        if (!pollUrl) throw new Error("pollUrl is required for polling subscriptions");
        return {
          subscription: publicSubscription(
            await workPollingSignals.subscribePersistent(target, externalResourceId, {
              url: pollUrl,
              headers,
            }),
          ),
        };
      }
      return {
        subscription: publicSubscription(
          await workWebhookSignals.subscribePersistent(target, externalResourceId),
        ),
      };
    },
  }),
  signal_unsubscribe: createTool({
    id: "signal_unsubscribe",
    description: "Remove a webhook or polling signal subscription from the current thread.",
    inputSchema: z.object({
      provider: z.enum(["webhook", "polling"]).default("webhook"),
      externalResourceId: z.string().min(1),
    }),
    execute: async ({ provider, externalResourceId }, context) => {
      const target = signalTarget(context);
      return {
        removed:
          provider === "polling"
            ? await workPollingSignals.unsubscribePersistent(target, externalResourceId)
            : await workWebhookSignals.unsubscribePersistent(target, externalResourceId),
      };
    },
  }),
  signal_list_subscriptions: createTool({
    id: "signal_list_subscriptions",
    description: "List signal subscriptions for the current Agent resource.",
    inputSchema: z.object({ provider: z.enum(["webhook", "polling"]).default("webhook") }),
    execute: async ({ provider }, context) => {
      const { resourceId } = signalTarget(context);
      return {
        subscriptions:
          provider === "polling"
            ? (await workPollingSignals.listPersistent(resourceId)).map(publicSubscription)
            : (await workWebhookSignals.listPersistent(resourceId)).map(publicSubscription),
      };
    },
  }),
};

let notificationInboxToolPromise:
  | Promise<ReturnType<typeof createNotificationInboxTool>>
  | undefined;
export function getNotificationInboxTool(): Promise<
  ReturnType<typeof createNotificationInboxTool>
> {
  notificationInboxToolPromise ??= appStorage.getStore("notifications").then((storage) => {
    if (!storage) throw new Error("Notifications storage is not configured");
    return createNotificationInboxTool({ storage });
  });
  return notificationInboxToolPromise;
}

export type WorkNotificationInput = SendNotificationSignalInput | SendNotificationSignalInput[];
