/** Durable webhook/polling signal providers and the notification inbox tool. */
import { createHash } from "node:crypto";
import {
  createNotificationInboxTool,
  type SendNotificationSignalInput,
} from "@mastra/core/notifications";
import {
  SignalProvider,
  type SignalProviderTarget,
  type SignalSubscription,
  WebhookSignalProvider,
} from "@mastra/core/signals";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { appStorage, getAppConfig, setAppConfig } from "../storage";
import { WORKSPACE_RESOURCE_ID_CONTEXT_KEY, WORKSPACE_THREAD_ID_CONTEXT_KEY } from "../workspace";

const SIGNAL_REGISTRY_SCOPE = "__mastra_signal_registry__";
const WEBHOOK_SUBSCRIPTIONS_KEY = "signals:webhook:subscriptions";
const POLLING_SUBSCRIPTIONS_KEY = "signals:polling:subscriptions";

type PersistedSubscription = {
  id: string;
  providerId: string;
  threadId: string;
  resourceId: string;
  externalResourceId: string;
  subscribedAt: string;
  metadata: Record<string, unknown>;
};

const subscriptionWrites = new Map<string, Promise<unknown>>();

async function readSubscriptions(key: string): Promise<PersistedSubscription[]> {
  const raw = await getAppConfig(key, SIGNAL_REGISTRY_SCOPE);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is PersistedSubscription => {
      if (!item || typeof item !== "object") return false;
      const value = item as Record<string, unknown>;
      return (
        typeof value.id === "string" &&
        typeof value.providerId === "string" &&
        typeof value.threadId === "string" &&
        typeof value.resourceId === "string" &&
        typeof value.externalResourceId === "string" &&
        typeof value.subscribedAt === "string" &&
        typeof value.metadata === "object" &&
        value.metadata !== null &&
        !Array.isArray(value.metadata)
      );
    });
  } catch {
    return [];
  }
}

async function mutateSubscriptions(
  key: string,
  update: (subscriptions: PersistedSubscription[]) => PersistedSubscription[],
): Promise<PersistedSubscription[]> {
  const previous = subscriptionWrites.get(key) ?? Promise.resolve();
  const next = previous.then(async () => {
    const subscriptions = await readSubscriptions(key);
    const updated = update(subscriptions);
    await setAppConfig(key, JSON.stringify(updated), SIGNAL_REGISTRY_SCOPE);
    return updated;
  });
  subscriptionWrites.set(key, next);
  try {
    return await next;
  } finally {
    if (subscriptionWrites.get(key) === next) subscriptionWrites.delete(key);
  }
}

function toPersisted(subscription: SignalSubscription): PersistedSubscription {
  return {
    id: subscription.id,
    providerId: subscription.providerId,
    threadId: subscription.threadId,
    resourceId: subscription.resourceId,
    externalResourceId: subscription.externalResourceId,
    subscribedAt: subscription.subscribedAt.toISOString(),
    metadata: subscription.metadata,
  };
}

function fromPersisted(subscription: PersistedSubscription): SignalSubscription {
  return { ...subscription, subscribedAt: new Date(subscription.subscribedAt) };
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
  async hydrate(): Promise<void> {
    const subscriptions = await readSubscriptions(WEBHOOK_SUBSCRIPTIONS_KEY);
    for (const subscription of subscriptions) {
      super.subscribeThread(
        { threadId: subscription.threadId, resourceId: subscription.resourceId },
        subscription.externalResourceId,
        subscription.metadata,
      );
    }
  }

  async start(): Promise<void> {
    await this.hydrate();
    await super.start?.();
  }

  async subscribePersistent(
    target: SignalProviderTarget,
    externalResourceId: string,
    metadata?: Record<string, unknown>,
  ) {
    const subscription = super.subscribeThread(target, externalResourceId, metadata);
    await mutateSubscriptions(WEBHOOK_SUBSCRIPTIONS_KEY, (subscriptions) => [
      ...subscriptions.filter(
        (item) =>
          item.providerId !== this.id ||
          item.threadId !== target.threadId ||
          item.resourceId !== target.resourceId ||
          item.externalResourceId !== externalResourceId,
      ),
      toPersisted(subscription),
    ]);
    return subscription;
  }

  async unsubscribePersistent(
    target: SignalProviderTarget,
    externalResourceId: string,
  ): Promise<boolean> {
    const removed = super.unsubscribeThread(target, externalResourceId);
    await mutateSubscriptions(WEBHOOK_SUBSCRIPTIONS_KEY, (subscriptions) =>
      subscriptions.filter(
        (item) =>
          item.providerId !== this.id ||
          item.threadId !== target.threadId ||
          item.resourceId !== target.resourceId ||
          item.externalResourceId !== externalResourceId,
      ),
    );
    return removed;
  }

  async listPersistent(resourceId: string): Promise<SignalSubscription[]> {
    return (await readSubscriptions(WEBHOOK_SUBSCRIPTIONS_KEY))
      .filter((item) => item.providerId === this.id && item.resourceId === resourceId)
      .map(fromPersisted);
  }

  async handleWebhookPersistent(request: Parameters<WebhookSignalProvider["handleWebhook"]>[0]) {
    return this.handleWebhook(request);
  }

  getTools() {
    return signalTools;
  }
}

type PollingSubscriptionMetadata = { url: string; headers?: Record<string, string> };

export class PersistentPollingSignalProvider extends SignalProvider<"mastra-polling-signals"> {
  readonly id = "mastra-polling-signals" as const;
  readonly name = "Mastra Polling Signals";
  readonly pollInterval = 30_000;
  private fingerprints = new Map<string, string>();

  async hydrate(): Promise<void> {
    const subscriptions = await readSubscriptions(POLLING_SUBSCRIPTIONS_KEY);
    for (const subscription of subscriptions) {
      super.subscribe(
        { threadId: subscription.threadId, resourceId: subscription.resourceId },
        subscription.externalResourceId,
        subscription.metadata,
      );
    }
  }

  async start(): Promise<void> {
    await this.hydrate();
    await super.start?.();
  }

  async subscribePersistent(
    target: SignalProviderTarget,
    externalResourceId: string,
    metadata: PollingSubscriptionMetadata,
  ): Promise<SignalSubscription> {
    const url = new URL(metadata.url);
    if (!/^https?:$/.test(url.protocol)) throw new Error("Polling source must use HTTP or HTTPS");
    const subscription = super.subscribe(target, externalResourceId, metadata);
    await mutateSubscriptions(POLLING_SUBSCRIPTIONS_KEY, (subscriptions) => [
      ...subscriptions.filter(
        (item) =>
          item.providerId !== this.id ||
          item.threadId !== target.threadId ||
          item.resourceId !== target.resourceId ||
          item.externalResourceId !== externalResourceId,
      ),
      toPersisted(subscription),
    ]);
    return subscription;
  }

  async unsubscribePersistent(
    target: SignalProviderTarget,
    externalResourceId: string,
  ): Promise<boolean> {
    const removed = super.unsubscribe(target, externalResourceId);
    await mutateSubscriptions(POLLING_SUBSCRIPTIONS_KEY, (subscriptions) =>
      subscriptions.filter(
        (item) =>
          item.providerId !== this.id ||
          item.threadId !== target.threadId ||
          item.resourceId !== target.resourceId ||
          item.externalResourceId !== externalResourceId,
      ),
    );
    return removed;
  }

  async listPersistent(resourceId: string): Promise<SignalSubscription[]> {
    return (await readSubscriptions(POLLING_SUBSCRIPTIONS_KEY))
      .filter((item) => item.providerId === this.id && item.resourceId === resourceId)
      .map(fromPersisted);
  }

  async poll(subscriptions: SignalSubscription[]): Promise<void> {
    await Promise.all(
      subscriptions.map(async (subscription) => {
        const metadata = subscription.metadata as Partial<PollingSubscriptionMetadata>;
        if (typeof metadata.url !== "string") return;
        try {
          const response = await fetch(metadata.url, { headers: metadata.headers });
          if (!response.ok) throw new Error(`Polling source returned ${response.status}`);
          const body = await response.text();
          const fingerprint = createHash("sha256").update(body).digest("hex");
          const key = `${subscription.resourceId}:${subscription.threadId}:${subscription.externalResourceId}`;
          const previous = this.fingerprints.get(key);
          this.fingerprints.set(key, fingerprint);
          if (!previous || previous === fingerprint) return;
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
