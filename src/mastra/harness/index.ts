/**
 * Harness 运行时执行套件 (docs/en/docs/harness/):
 * - session: WorkSessionHost 与 WorkSession (docs/en/docs/harness/sessions.mdx)
 * - signals: WebhookSignalProvider 与 NotificationInbox (docs/en/docs/harness/signals.mdx)
 */

export {
  isTerminalAgentChunk,
  SESSION_SCOPE_DEFAULT,
  type WorkDisplayState,
  type WorkSession,
  type WorkSessionGrants,
  WorkSessionHost,
  type WorkSessionState,
  workSessionHost,
  workSessionStateSchema,
} from "./session";
export {
  createNotificationInboxTool,
  InMemoryNotificationsStorage,
  notificationInboxTool,
  notificationsStorage,
  type SendNotificationSignalInput,
  WebhookSignalProvider,
  type WorkNotificationInput,
  workWebhookSignals,
} from "./signals";
