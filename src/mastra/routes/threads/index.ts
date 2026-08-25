/**
 * 线程会话路由汇总(按子模块拆分):
 * - threads.ts         线程 CRUD
 * - messages.ts        消息历史 + 删除
 * - compact.ts         真压缩(summarize)
 *
 * 写法参考 docs/en/docs/server/custom-api-routes.mdx(registerApiRoute)。
 * 注意:Mastra 保留 /api 前缀给内置路由,自定义路由统一使用 /work/*。
 */
import { summarizeThreadRoute } from "./compact";
import { inlineCompletionRoute, inlineEditRoute } from "./inline-edit";
import { deleteMessagesRoute, threadMessagesRoute } from "./messages";
import {
  observationalMemoryConfigRoute,
  updateObservationalMemoryConfigRoute,
} from "./observational-memory";
import {
  createThreadRoute,
  deleteThreadRoute,
  listThreadsRoute,
  updateThreadRoute,
} from "./threads";
import { generateThreadTitleRoute } from "./title";

export const threadRoutes = [
  listThreadsRoute,
  createThreadRoute,
  updateThreadRoute,
  deleteThreadRoute,
  threadMessagesRoute,
  deleteMessagesRoute,
  observationalMemoryConfigRoute,
  updateObservationalMemoryConfigRoute,
  summarizeThreadRoute,
  generateThreadTitleRoute,
  inlineEditRoute,
  inlineCompletionRoute,
];

export { getWorkMemory } from "./shared";
export type { ThreadMetadata } from "./types";
