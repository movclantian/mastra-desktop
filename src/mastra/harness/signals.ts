import {
  createNotificationInboxTool,
  InMemoryNotificationsStorage,
  type SendNotificationSignalInput,
} from "@mastra/core/notifications";
import { WebhookSignalProvider } from "@mastra/core/signals";
import { appStorage } from "../storage";

/**
 * 信号系统 (docs/en/docs/harness/signals.mdx, reference/signals/):
 * - workWebhookSignals: 外部 Webhook 信号接收通道
 * - notificationInboxTool: Agent 读取收件箱的工具
 */

export const workWebhookSignals = new WebhookSignalProvider({
  id: "mastra-work-webhooks",
  name: "Mastra Work Webhooks",
});

export const notificationsStorage = new InMemoryNotificationsStorage();

export const notificationInboxToolPromise = (async () => {
  const notificationsStore = await appStorage.getStore("notifications");
  if (!notificationsStore) {
    throw new Error("Notifications storage is not available");
  }
  return createNotificationInboxTool({ storage: notificationsStore });
})();

export const notificationInboxTool = createNotificationInboxTool({
  storage: notificationsStorage,
});

export type WorkNotificationInput = SendNotificationSignalInput | SendNotificationSignalInput[];

export {
  createNotificationInboxTool,
  InMemoryNotificationsStorage,
  type SendNotificationSignalInput,
  WebhookSignalProvider,
};
