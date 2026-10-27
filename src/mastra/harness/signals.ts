/** Durable signal providers and desktop notifications. */
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  type SignalProviderTarget,
  type SignalSubscription,
  WebhookSignalProvider,
} from "@mastra/core/signals";
import { z } from "zod";
import type { ApplicationDomain, DesktopNotification } from "../../shared/window-contract";
import { getLibsqlClient } from "../storage/database";

export const desktopEvents = new EventEmitter();
export const scheduledDesktopNotifications = new Map<string, DesktopNotification[]>();

export function publishApplicationChange(resourceId: string, domain: ApplicationDomain) {
  desktopEvents.emit(`application:${resourceId}`, { resourceId, domain });
}

export function publishDesktopNotification(notification: DesktopNotification, afterRun?: string) {
  if (afterRun)
    scheduledDesktopNotifications.set(afterRun, [
      ...(scheduledDesktopNotifications.get(afterRun) ?? []),
      notification,
    ]);
  else desktopEvents.emit(notification.resourceId, notification);
}

// SignalProvider.__registerMastra only stores a Mastra reference; its registry is an in-memory
// Map (reference/signals/signal-provider.mdx). This table supplies restart persistence only.
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

class PersistentWebhookSignalProvider extends WebhookSignalProvider {
  private mutations: Promise<unknown> = Promise.resolve();

  // ponytail: one mutation queue per provider; partition by account only if write volume demands it.
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
      // Match native subscribe()'s metadata merge so a restart cannot erase retained fields.
      const current = this.getSubscriptionsForThread(target).find(
        (subscription) => subscription.externalResourceId === externalResourceId,
      );
      const nextMetadata = { ...current?.metadata, ...metadata };
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
          JSON.stringify(nextMetadata),
        ],
      });
      return super.subscribeThread(target, externalResourceId, nextMetadata);
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
    return {};
  }
}

type PollingSubscriptionMetadata = { url: string; headers?: Record<string, string> };

class PersistentPollingSignalProvider extends PersistentWebhookSignalProvider {
  readonly pollInterval = 30_000;
  private fingerprints = new Map<string, string>();
  private stopController = new AbortController();
  private pendingPolls = new Set<Promise<void>>();

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
      })
      .parse(metadata);
    return super.subscribePersistent(target, externalResourceId, parsed);
  }

  stop(): void {
    this.stopController.abort();
    this.fingerprints.clear();
    super.stop();
  }

  async poll(subscriptions: SignalSubscription[]): Promise<void> {
    if (this.stopController.signal.aborted) return;
    const active = new Set(subscriptions.map((subscription) => subscription.id));
    for (const id of this.fingerprints.keys()) {
      if (!active.has(id)) this.fingerprints.delete(id);
    }
    const pending = Promise.all(
      subscriptions.map(async (subscription) => {
        const metadata = subscription.metadata as Partial<PollingSubscriptionMetadata>;
        if (typeof metadata.url !== "string") return;
        try {
          const response = await fetch(metadata.url, {
            headers: metadata.headers,
            signal: AbortSignal.any([
              this.stopController.signal,
              AbortSignal.timeout(this.pollInterval),
            ]),
          });
          if (!response.ok) throw new Error(`Polling source returned ${response.status}`);
          const body = await response.text();
          if (this.stopController.signal.aborted) return;
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
          if (this.stopController.signal.aborted) return;
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
    ).then(() => undefined);
    this.pendingPolls.add(pending);
    try {
      await pending;
    } finally {
      this.pendingPolls.delete(pending);
    }
  }

  async settled(): Promise<void> {
    await Promise.all(this.pendingPolls);
  }
}

export const workWebhookSignals = new PersistentWebhookSignalProvider({
  id: "mastra-work-webhooks",
  name: "Mastra Work Webhooks",
  // Uses the default extractor: webhook payloads must provide resource or externalResourceId.
});
export const workPollingSignals = new PersistentPollingSignalProvider();
