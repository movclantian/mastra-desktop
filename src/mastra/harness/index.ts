/**
 * Harness 运行时执行套件 (docs/en/docs/harness/):
 * - session: WorkSessionHost 与 WorkSession (agent-controller.mdx)
 * - signals: 持久化 Webhook/PollingSignalProvider 与 NotificationInbox (signals.mdx)
 */

export { setDefaultWorkAgent } from "./registry";
export {
  isTerminalAgentChunk,
  SESSION_SCOPE_DEFAULT,
  type WorkSession,
  workSessionHost,
} from "./session";
export {
  getNotificationInboxTool,
  PersistentPollingSignalProvider,
  PersistentWebhookSignalProvider,
  type WorkNotificationInput,
  workPollingSignals,
  workWebhookSignals,
} from "./signals";
