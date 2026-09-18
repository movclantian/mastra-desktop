/** Desktop-only thread extensions. CRUD is registered by Mastra Server. */
import {
  cloneThreadRoute,
  generateThreadTitleRoute,
  searchThreadsRoute,
  summarizeThreadRoute,
  threadMessagesPageRoute,
  threadSourceRoute,
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
];
export { getWorkMemory } from "./shared";
export type { ThreadMetadata } from "./types";
