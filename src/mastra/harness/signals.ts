/**
 * 信号系统。
 * 官方文档:docs/en/docs/harness/signals.mdx(State / Notification signals)、
 * docs/en/reference/signals/webhook-signal-provider.mdx、create-notification-inbox-tool.mdx。
 * - workWebhookSignals: 外部 Webhook 信号接收通道
 * - notificationInboxTool: Agent 读取收件箱的工具(内存存储,重启即清)
 */
import {
  createNotificationInboxTool,
  InMemoryNotificationsStorage,
  type SendNotificationSignalInput,
} from "@mastra/core/notifications";
import { WebhookSignalProvider } from "@mastra/core/signals";

export const workWebhookSignals = new WebhookSignalProvider({
  id: "mastra-work-webhooks",
  name: "Mastra Work Webhooks",
});

export const notificationInboxTool = createNotificationInboxTool({
  storage: new InMemoryNotificationsStorage(),
});

export type WorkNotificationInput = SendNotificationSignalInput | SendNotificationSignalInput[];
