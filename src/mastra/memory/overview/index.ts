import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ModelRouterEmbeddingModel } from "@mastra/core/llm";
import { type LibSQLStore, LibSQLVector } from "@mastra/libsql";
import { Memory } from "@mastra/memory";
import { appStorage, getStorageUrl } from "../../storage";

/**
 * 记忆配置文件:设置面板「记忆」标签页写入 memory-config.json,重启后生效。
 * 参考 docs/en/docs/memory/overview.mdx 的 Memory 构造与 options 字段。
 */
const MEMORY_CONFIG_FILE = join(process.cwd(), "memory-config.json");

export interface MemoryUserConfig {
  /** options.lastMessages — 每次请求注入的最近消息数,默认 20 */
  lastMessages: number;
  /** options.semanticRecall — 语义召回开关 */
  semanticRecall: boolean;
  /** options.semanticRecall.topK */
  semanticRecallTopK: number;
  /** options.workingMemory.enabled — 工作记忆开关 */
  workingMemory: boolean;
  /** options.workingMemory.scope — resource(跨线程) / thread(线程内) */
  workingMemoryScope: "resource" | "thread";
}

const DEFAULT_CONFIG: MemoryUserConfig = {
  lastMessages: 20,
  semanticRecall: false,
  semanticRecallTopK: 3,
  workingMemory: false,
  workingMemoryScope: "resource",
};

export function getMemoryConfig(): MemoryUserConfig {
  if (existsSync(MEMORY_CONFIG_FILE)) {
    try {
      return {
        ...DEFAULT_CONFIG,
        ...JSON.parse(readFileSync(MEMORY_CONFIG_FILE, "utf-8")),
      } as MemoryUserConfig;
    } catch {
      return DEFAULT_CONFIG;
    }
  }
  return DEFAULT_CONFIG;
}

// 参考 docs/en/docs/memory/overview.mdx + working-memory.mdx + semantic-recall.mdx
const config = getMemoryConfig();

export const appMemory = new Memory({
  storage: appStorage as LibSQLStore,
  // semantic-recall.mdx:LibSQLVector 与 LibSQLStore 共用同一数据库文件
  vector: new LibSQLVector({
    id: "mastra-vector",
    url: getStorageUrl(),
  }),
  embedder: new ModelRouterEmbeddingModel("openai/text-embedding-3-small"),
  options: {
    lastMessages: config.lastMessages,
    // semantic-recall.mdx:semanticRecall 配置(topK / messageRange)
    ...(config.semanticRecall
      ? { semanticRecall: { topK: config.semanticRecallTopK, messageRange: 2 } }
      : {}),
    // working-memory.mdx:workingMemory 配置(enabled / scope / template)
    ...(config.workingMemory
      ? {
          workingMemory: {
            enabled: true,
            scope: config.workingMemoryScope,
            template: `# User Profile
- **Name**:
- **Location**:
- **Interests**:
- **Preferences**:
- **Long-term Goals**:
`,
          },
        }
      : {}),
  },
});
