/** Desktop-only thread extensions. CRUD is registered by Mastra Server. */
import { generateThreadTitleRoute } from "./threads";
export const threadRoutes = [generateThreadTitleRoute];
export { getWorkMemory } from "./shared";
export type { ThreadMetadata } from "./types";
