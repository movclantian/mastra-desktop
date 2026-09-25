/** Desktop-only thread extensions. CRUD is registered by Mastra Server. */
import {
  cloneThreadRoute,
  decideThreadTransferRoute,
  generateThreadTitleRoute,
  searchThreadsRoute,
  summarizeThreadRoute,
  threadMessagesPageRoute,
  threadSourceRoute,
  threadTransferHistoryRoute,
  toggleMessageReactionRoute,
  transferThreadRoute,
} from "./threads";
export const threadRoutes = [
  generateThreadTitleRoute,
  toggleMessageReactionRoute,
  cloneThreadRoute,
  threadSourceRoute,
  threadMessagesPageRoute,
  summarizeThreadRoute,
  searchThreadsRoute,
  transferThreadRoute,
  decideThreadTransferRoute,
  threadTransferHistoryRoute,
];
export { getWorkMemory } from "./shared";
export type { ThreadMetadata } from "./types";
