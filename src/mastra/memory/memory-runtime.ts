/**
 * 记忆配置:设置面板「记忆」标签页写入数据库 app_config 表(key = "memory"),
 * 保存后实时生效(与业务数据同库)。
 * 字段对照 docs/en/reference/memory/memory-class.mdx 的 MemoryConfig 全量定义:
 * - lastMessages / readOnly                      → message-history.mdx
 * - semanticRecall{topK,messageRange,scope}      → semantic-recall.mdx
 *   messageRange 支持官方对象形态 {before, after}(每条命中前后各自附带条数)
 * - workingMemory{enabled,scope,template|schema} → working-memory.mdx
 *   schema 形态接受 Standard JSON Schema(Zod/Valibot/JSON Schema 均可,面板里
 *   直接编辑 JSON 文本),template 与 schema 互斥,分别对应 replace/merge 语义
 * - generateTitle                               → message-history.mdx
 * - observationalMemory(顶层 + observation/reflection 深层子项)
 *   → observational-memory.mdx:
 *   模型跟随当前请求，OM 固定使用官方推荐的 thread scope、temporalMarkers、
 *   retrieval{vector,scope};observation.instruction/threadTitle/manageWorkingMemory/
 *   observeAttachments/modelSettings.temperature；token 预算自动按当前模型派生。
 *   observation.extract(Extractor[])与 reflection.extract(Extractor[]) 可由设置面板配置；
 *   任意 schema/hook 仍保留为代码级扩展点,不允许普通 JSON 设置执行任意代码。
 */

import type { RequestContext } from "@mastra/core/request-context";
import { fastembed } from "@mastra/fastembed";
import { LibSQLVector } from "@mastra/libsql";
import { Extractor, Memory } from "@mastra/memory";
import { z } from "zod";
import { getModelTokenLimits, resolveAgentModel } from "../models/providers";
import {
  appStorage,
  getAppConfig,
  getStorageUrl,
  type RequestContextLike,
  setAppConfig,
  userIdFromContext,
} from "../storage/database";

const MEMORY_CONFIG_KEY = "memory";
// OM's main output is XML; only its subsequent structured extraction requests JSON.
// The same instruction is retained by the native observer/reflector extraction agents.
const OM_STRUCTURED_OUTPUT_INSTRUCTION =
  "When asked to extract structured data, return only the requested JSON object. For observation or reflection, keep the requested observation format.";

const omExtractorConfigSchema = z
  .object({
    /** 面板行 id(nanoid,与官方 slug 无关) */
    id: z.string().trim().min(1).max(80),
    /** 官方 Extractor name:人类可读,OM 自行 slug 化,同批内不可重名 */
    name: z.string().trim().max(120),
    /** 官方 Extractor instructions:抽取什么、何时更新 */
    instructions: z.string().trim().max(8_000),
    /** 挂到观察(observation)还是反思(reflection)阶段 */
    stage: z.enum(["observation", "reflection"]),
    /** 关闭后保留草稿但不注入 Memory */
    enabled: z.boolean(),
    /** 将上一次提取结果放回下一次提示，便于增量更新 */
    includePreviousExtraction: z.boolean().optional(),
    /** OM metadata 中的持久化路径；空字符串使用官方默认 extracted.<slug> */
    metadataKeyPath: z.string().trim().max(160).optional(),
  })
  .strict();

type OmExtractorUserConfig = z.infer<typeof omExtractorConfigSchema>;

export const memoryConfigSchema = z
  .object({
    /** options.lastMessages — OM 关闭时每次请求注入的最近消息数,默认 20 */
    lastMessages: z.number().int().min(1).max(500),
    /** options.readOnly — 只读记忆(不保存新消息,不注册 updateWorkingMemory 工具) */
    readOnly: z.boolean(),
    /** options.semanticRecall — 语义召回开关(需 vector + embedder) */
    semanticRecall: z.boolean(),
    /** options.semanticRecall.topK — 相似消息数,默认 4 */
    semanticRecallTopK: z.number().int().min(1).max(50),
    /** options.semanticRecall.messageRange.before — 每条命中消息向前附带条数 */
    semanticRecallMessageRangeBefore: z.number().int().min(0).max(50),
    /** options.semanticRecall.messageRange.after — 每条命中消息向后附带条数 */
    semanticRecallMessageRangeAfter: z.number().int().min(0).max(50),
    /** options.semanticRecall.scope — thread(线程内)/ resource(跨线程),默认 thread */
    semanticRecallScope: z.enum(["thread", "resource"]),
    /** options.semanticRecall.threshold — 相似度下限,0 = 使用向量库全部结果 */
    semanticRecallThreshold: z.number().min(0).max(1),
    /** options.semanticRecall.indexName — 向量索引名,空字符串使用官方默认 */
    semanticRecallIndexName: z.string().trim().max(128),
    /** options.workingMemory.enabled — 工作记忆开关 */
    workingMemory: z.boolean(),
    /** options.workingMemory.scope — resource(跨线程用户画像) / thread(线程内) */
    workingMemoryScope: z.enum(["resource", "thread"]),
    /**
     * 工作记忆形态:template(Markdown 模板,replace 语义)或
     * schema(Standard JSON Schema,merge 语义)。二者互斥(working-memory.mdx)。
     */
    workingMemoryFormat: z.enum(["template", "schema"]),
    /** options.workingMemory.template — Markdown 模板(定义工作记忆结构) */
    workingMemoryTemplate: z.string().max(100_000),
    /** options.workingMemory.schema — JSON Schema 文本(JSON 形态,format = schema 时生效) */
    workingMemorySchema: z.string().max(100_000),
    /** options.generateTitle — 自动为新线程生成标题 */
    generateTitle: z.boolean(),
    /** options.observationalMemory — 观察记忆(长上下文自动观察/反思) */
    observationalMemory: z.boolean(),
    /** options.observationalMemory.temporalMarkers — ≥10min 间隔插入时间标记 */
    omTemporalMarkers: z.boolean(),
    /** observation.instruction — 追加到 Observer 系统提示的自定义指令 */
    omObserverInstruction: z.string().max(100_000),
    /** reflection.instruction — 追加到 Reflector 系统提示的自定义指令 */
    omReflectionInstruction: z.string().max(100_000),
    /** observation.threadTitle — Observer 顺手维护线程标题(官方默认关) */
    omThreadTitle: z.boolean(),
    /** observation.manageWorkingMemory — 让 Observer 通过 OM 抽取管理工作记忆 */
    omManageWorkingMemory: z.boolean(),
    /** observation.observeAttachments — 附件转发给 Observer:on / off / auto(按模型多模态能力) */
    omObserveAttachments: z.enum(["auto", "on", "off"]),
    /** observation.modelSettings.temperature — Observer 温度(库默认 0.3) */
    omTemperature: z.number().min(0).max(2),
    /** 关闭 observation.bufferTokens(官方 false = 禁用全部异步缓冲) */
    omBufferEnabled: z.boolean(),
    /** options.observationalMemory.retrieval — 注册 recall 工具回查原始消息 */
    omRetrieval: z.boolean(),
    /** retrieval.vector — recall 同时启用语义检索(用 Memory 的 vector + embedder) */
    omRetrievalVector: z.boolean(),
    /** retrieval.scope — recall 的回查范围,官方默认 resource */
    omRetrievalScope: z.enum(["thread", "resource"]),
    /**
     * OM 自定义抽取器(observation.extract / reflection.extract,
     * observational-memory.mdx「Extractor API」)。schema 省略 = 内联字符串抽取器,
     * 由 Observer/Reflector 在主输出中直接产出,不额外发起结构化调用;
     * 抽取结果持久化在线程 OM metadata 的 om.extracted.<slug> 下。
     */
    omExtractors: z.array(omExtractorConfigSchema),
  })
  .strict();

export type MemoryUserConfig = z.infer<typeof memoryConfigSchema>;

const DEFAULT_WORKING_MEMORY_TEMPLATE = `# User Profile
- **Name**:
- **Location**:
- **Interests**:
- **Preferences**:
- **Long-term Goals**:
`;

/** schema 形态的默认示例(working-memory.mdx「Schema-Based Working Memory」) */
const DEFAULT_WORKING_MEMORY_SCHEMA = `{
  "type": "object",
  "properties": {
    "name": { "type": "string" },
    "location": { "type": "string" },
    "timezone": { "type": "string" },
    "preferences": {
      "type": "object",
      "properties": {
        "communicationStyle": { "type": "string" },
        "projectGoal": { "type": "string" },
        "deadlines": { "type": "array", "items": { "type": "string" } }
      }
    }
  }
}
`;

const DEFAULT_CONFIG: MemoryUserConfig = {
  // 短对话模式才使用 lastMessages;OM 开启时由 OM 自己管理原始消息窗口。
  lastMessages: 20,
  // 默认保留完整的对话写入链路,仅关闭时才会影响持久化。
  readOnly: false,
  // OM 已经提供长期记忆,默认关闭额外语义召回,避免两套召回叠加上下文。
  semanticRecall: false,
  // semanticRecallTopK:4 为官方默认值(memory-class.mdx: "Default topK is 4")。
  semanticRecallTopK: 4,
  // 命中消息各附带一条邻近消息,避免语义召回在 OM 之外重复扩大上下文。
  semanticRecallMessageRangeBefore: 1,
  semanticRecallMessageRangeAfter: 1,
  semanticRecallScope: "thread",
  semanticRecallThreshold: 0,
  semanticRecallIndexName: "",
  // 工作记忆适合保存小型稳定状态,默认开启。
  workingMemory: true,
  workingMemoryScope: "thread",
  workingMemoryFormat: "template",
  workingMemoryTemplate: DEFAULT_WORKING_MEMORY_TEMPLATE,
  workingMemorySchema: DEFAULT_WORKING_MEMORY_SCHEMA,
  // 标题是独立的异步调用,默认开启以便线程列表可读。
  generateTitle: true,
  // 长对话默认启用 OM；预算由当前请求模型的上下文容量决定。
  observationalMemory: true,
  // 长时间间隔的时间标记成本很低,默认开启以避免跨天对话失去时间感。
  omTemporalMarkers: true,
  omObserverInstruction: "",
  omReflectionInstruction: "",
  omThreadTitle: false,
  omManageWorkingMemory: false,
  omObserveAttachments: "auto",
  // omTemperature:0.3 为官方默认值(observational-memory.mdx: observation.modelSettings.temperature defaultValue='0.3')。
  omTemperature: 0.3,
  omBufferEnabled: true,
  omRetrieval: false,
  omRetrievalVector: false,
  omRetrievalScope: "resource",
  omExtractors: [
    {
      id: "om-extractor-default-profile",
      name: "User profile",
      instructions:
        "Extract stable facts about the user: name, role, timezone, communication preferences, recurring goals. Only include facts stated or clearly implied in this conversation window; never guess.",
      stage: "observation",
      enabled: true,
    },
    {
      id: "om-extractor-default-project",
      name: "Project facts",
      instructions:
        "Extract durable project context: what is being built, key file paths, chosen libraries, decisions already made, and constraints the user cares about. Skip transient task-list items.",
      stage: "observation",
      enabled: true,
    },
  ],
};

/** 读取记忆配置(app_config 表 key="memory";无记录或损坏时回落默认值) */
const memoryConfigByScope = new Map<string, MemoryUserConfig>();

function memoryScopeKey(resourceId?: string): string {
  return resourceId?.trim() || "__system__";
}

export async function getMemoryConfig(resourceId?: string): Promise<MemoryUserConfig> {
  const scope = memoryScopeKey(resourceId);
  const cached = memoryConfigByScope.get(scope);
  if (cached) return cached;
  const raw = await getAppConfig(MEMORY_CONFIG_KEY, resourceId);
  if (!raw) {
    memoryConfigByScope.set(scope, DEFAULT_CONFIG);
    return DEFAULT_CONFIG;
  }
  try {
    const next = normalizeMemoryConfig(JSON.parse(raw) as Partial<MemoryUserConfig>);
    memoryConfigByScope.set(scope, next);
    return next;
  } catch {
    memoryConfigByScope.set(scope, DEFAULT_CONFIG);
    return DEFAULT_CONFIG;
  }
}

/** 写入记忆配置并实时生效。嵌入固定使用本机 FastEmbed，不持久化模型或版本状态。 */
export async function saveMemoryConfig(next: MemoryUserConfig, resourceId?: string): Promise<void> {
  const normalized = normalizeMemoryConfig({ ...(await getMemoryConfig(resourceId)), ...next });
  await setAppConfig(MEMORY_CONFIG_KEY, JSON.stringify(normalized, null, 2), resourceId);
  memoryConfigByScope.set(memoryScopeKey(resourceId), normalized);
  const runtime = getMemoryRuntime(resourceId);
  for (const memory of runtime.memoryByBudget.values()) retiredMemories.add(memory);
  runtime.memoryByBudget.clear();
}

function normalizeMemoryConfig(input: Partial<MemoryUserConfig>): MemoryUserConfig {
  return memoryConfigSchema.strip().parse({ ...DEFAULT_CONFIG, ...input });
}

/** 解析 schema 文本为 JSON Schema 对象;非法 JSON 或非对象时返回 undefined */
function parseWorkingMemorySchema(text: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** 按阶段挑选抽取器并实例化;name 为空或重复的条目跳过(官方按 name 生成 slug,重名冲突) */
function instantiateExtractor(item: OmExtractorUserConfig): Extractor {
  const options = {
    name: item.name.trim(),
    instructions: item.instructions.trim(),
    ...(item.includePreviousExtraction ? { includePreviousExtraction: true } : {}),
    ...(item.metadataKeyPath?.trim() ? { metadataKeyPath: item.metadataKeyPath.trim() } : {}),
  };
  return new Extractor(options);
}

function dedupeExtractors(
  items: OmExtractorUserConfig[],
  stage: OmExtractorUserConfig["stage"],
): Extractor[] {
  const seen = new Set<string>();
  const extractors: Extractor[] = [];
  for (const item of items) {
    if (item.stage !== stage || item.enabled === false) continue;
    const name = item.name.trim();
    const instructions = item.instructions.trim();
    if (!name || !instructions || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    extractors.push(instantiateExtractor(item));
  }
  return extractors;
}

interface MemoryRuntime {
  memoryByBudget: Map<string, Memory>;
}

const memoryRuntimeByScope = new Map<string, MemoryRuntime>();
// A request can still hold an old instance and start work after settled() returns.
// Keep retired instances until shutdown; object count grows with config saves,
// while all configurations share one vector connection for the process lifetime.
const retiredMemories = new Set<Memory>();
let memoryVector: LibSQLVector | undefined;

function getMemoryRuntime(resourceId?: string): MemoryRuntime {
  const scope = memoryScopeKey(resourceId);
  let runtime = memoryRuntimeByScope.get(scope);
  if (!runtime) {
    runtime = { memoryByBudget: new Map() };
    memoryRuntimeByScope.set(scope, runtime);
  }
  return runtime;
}

interface MemoryBuildOverrides {
  memoryScope?: "thread" | "resource";
  budget: { messageTokens: number; observationTokens: number; maxOutputTokens: number };
}

/** Leave room for model output, system/tools and OM's default 1.2× buffering headroom. */
function memoryTokenBudget(limits: Awaited<ReturnType<typeof getModelTokenLimits>>) {
  // An unlisted model has no discoverable capacity; use a conservative 32K planning window.
  const context = limits?.context ?? 32_768;
  const outputReserve = Math.min(limits?.output ?? context / 4, context / 2);
  const input = Math.min(limits?.input ?? context, context - outputReserve);
  return {
    messageTokens: Math.max(1, Math.floor(input * 0.4)),
    observationTokens: Math.max(1, Math.floor(input * 0.2)),
    maxOutputTokens: Math.max(
      1,
      Math.floor(Math.min(limits?.output ?? 8_192, input * 0.1, 16_384)),
    ),
  };
}

/**
 * 当前 Memory 实例。Agent 以函数形式引用(memory: () => getMemory()),
 * 配置保存后无需重启即对后续请求生效。
 */
export async function getMemory(options?: {
  requestContext?: RequestContext;
  memoryScope?: "thread" | "resource";
}): Promise<Memory> {
  const resourceId = userIdFromContext(options?.requestContext as RequestContextLike);
  const config = await getMemoryConfig(resourceId);
  const runtime = getMemoryRuntime(resourceId);
  const budget = memoryTokenBudget(
    config.observationalMemory ? await getModelTokenLimits(options?.requestContext) : undefined,
  );
  // Share by capacity, not thread/model identity; two simultaneous models retain their own budgets.
  const key = JSON.stringify([options?.memoryScope ?? "default", budget]);
  let memory = runtime.memoryByBudget.get(key);
  if (!memory) {
    memory = buildMemory(config, { memoryScope: options?.memoryScope, budget });
    runtime.memoryByBudget.set(key, memory);
  }
  return memory;
}

/** Call only after the relevant runs return; includes every retired configuration. */
export async function settleAllMemory(): Promise<void> {
  const instances = new Set(retiredMemories);
  for (const runtime of memoryRuntimeByScope.values()) {
    for (const memory of runtime.memoryByBudget.values()) instances.add(memory);
  }
  await Promise.all([...instances].map((memory) => memory.settled()));
}

/** The shutdown owner stops producers and drains Memory before closing this shared handle. */
export async function closeMemoryVector(): Promise<void> {
  await memoryVector?.close();
}

function buildMemory(config: MemoryUserConfig, overrides: MemoryBuildOverrides): Memory {
  const semanticRecallScope = overrides.memoryScope ?? config.semanticRecallScope;
  const workingMemoryScope = overrides.memoryScope ?? config.workingMemoryScope;
  const { budget } = overrides;
  // 自定义抽取器(observational-memory.mdx「Extractor API」):schema 省略 =
  // 内联字符串抽取,Observer/Reflector 主输出顺带产出,无额外结构化调用。
  // 同批 name 去重(官方按 name 生成 slug,重名会在运行时报冲突)。
  const observationExtract = dedupeExtractors(config.omExtractors, "observation");
  const reflectionExtract = dedupeExtractors(config.omExtractors, "reflection");

  memoryVector ??= new LibSQLVector({ id: "mastra-vector", url: getStorageUrl() });
  return new Memory({
    storage: appStorage,
    // semantic-recall.mdx:LibSQLVector 与 LibSQLStore 共用同一数据库文件
    vector: memoryVector,
    embedder: fastembed.small,
    options: {
      // observational-memory.mdx:启用 OM 后由 OM 处理未观察消息窗口,
      // 不再同时注册 MessageHistory(lastMessages) 处理器,避免两套窗口策略叠加。
      // OM 关闭时才使用 message-history 的最近消息条数。
      lastMessages: config.observationalMemory ? false : config.lastMessages,
      ...(config.readOnly ? { readOnly: true } : {}),
      // semantic-recall.mdx:topK / messageRange(官方对象形态 {before, after})/ scope
      ...(config.semanticRecall
        ? {
            semanticRecall: {
              topK: config.semanticRecallTopK,
              messageRange: {
                before: config.semanticRecallMessageRangeBefore,
                after: config.semanticRecallMessageRangeAfter,
              },
              scope: semanticRecallScope,
              ...(config.semanticRecallThreshold > 0
                ? { threshold: config.semanticRecallThreshold }
                : {}),
              ...(config.semanticRecallIndexName
                ? { indexName: config.semanticRecallIndexName }
                : {}),
            },
          }
        : {}),
      // working-memory.mdx:template(replace 语义)与 schema(merge 语义)二选一;
      // schema 文本损坏时回落 template,服务不因此起不来。
      // useStateSignals:working memory 默认折进 system message,agent 每改一次就把整段
      // 前缀缓存打掉;改走 state signal 后它作为追加消息下发(带 cacheKey 去重与快照
      // 重注入),system prompt 保持稳定 —— 存储与工具形态不变,工具名变成 setWorkingMemory
      // (working-memory.mdx「Opt in to state signals」)。
      ...(config.workingMemory
        ? {
            workingMemory:
              config.workingMemoryFormat === "schema"
                ? (() => {
                    const schema = parseWorkingMemorySchema(config.workingMemorySchema);
                    return schema
                      ? {
                          enabled: true,
                          scope: workingMemoryScope,
                          schema,
                          useStateSignals: true,
                        }
                      : {
                          enabled: true,
                          scope: workingMemoryScope,
                          template: config.workingMemoryTemplate,
                          useStateSignals: true,
                        };
                  })()
                : {
                    enabled: true,
                    scope: workingMemoryScope,
                    template: config.workingMemoryTemplate,
                    useStateSignals: true,
                  },
          }
        : {}),
      // message-history.mdx:使用官方最小配置。标题模型和指令跟随 Agent,
      // 不在应用层重复实现标题提示或第二次调用模型。
      ...(config.generateTitle ? { generateTitle: true } : {}),
      // observational-memory.mdx:顶层 + observation/reflection 深层子项。
      // continuationHints(@mastra/memory 1.27)刻意关闭 <current-task> /
      // <suggested-response> 注入:本 Agent 自带控制流 —— TaskSignalProvider 的
      // task_* 工具 + Queue UI 承载任务状态,instructions 规定了 submit_plan /
      // ask_user 与引用格式纪律;记忆再注入这两段提示等于第二个控制器与其争控制权。
      ...(config.observationalMemory
        ? {
            observationalMemory: {
              model: resolveAgentModel,
              scope: "thread",
              // 压缩时机对齐前缀缓存的生命周期:'auto' 用供应商的 prompt cache TTL 作为
              // 空闲阈值,让"折叠旧消息"发生在缓存本来就已过期之后,而不是在缓存还热的时候
              // 把前缀砸掉。本 App 允许同线程中途换模型(见 agents/work-agent.ts 的动态 model),
              // 换模型时缓存必然失效 —— activateOnProviderChange 让压缩正好搭这趟车。
              activateAfterIdle: "auto" as const,
              activateOnProviderChange: true,
              ...(config.omTemporalMarkers ? { temporalMarkers: true } : {}),
              // retrieval:布尔之外的 { vector, scope } 形态(retrieval 默认 scope = resource)
              ...(config.omRetrieval
                ? {
                    retrieval: {
                      ...(config.omRetrievalVector ? { vector: true } : {}),
                      scope: config.omRetrievalScope,
                    },
                  }
                : {}),
              observation: {
                continuationHints: false,
                instruction: [OM_STRUCTURED_OUTPUT_INSTRUCTION, config.omObserverInstruction.trim()]
                  .filter(Boolean)
                  .join("\n\n"),
                ...(config.omThreadTitle ? { threadTitle: true } : {}),
                ...(config.omManageWorkingMemory ? { manageWorkingMemory: true } : {}),
                // 'auto' 字面量 = 按模型多模态能力自动决定;on/off → true/false
                observeAttachments:
                  config.omObserveAttachments === "auto"
                    ? ("auto" as const)
                    : config.omObserveAttachments === "on",
                messageTokens: budget.messageTokens,
                modelSettings: {
                  temperature: config.omTemperature,
                  maxOutputTokens: budget.maxOutputTokens,
                },
                // Official relative buffering scales with this instance's model budget.
                bufferTokens: config.omBufferEnabled ? 0.2 : false,
                ...(observationExtract.length > 0 ? { extract: observationExtract } : {}),
              },
              reflection: {
                continuationHints: false,
                instruction: [
                  OM_STRUCTURED_OUTPUT_INSTRUCTION,
                  config.omReflectionInstruction.trim(),
                ]
                  .filter(Boolean)
                  .join("\n\n"),
                observationTokens: budget.observationTokens,
                modelSettings: { maxOutputTokens: budget.maxOutputTokens },
                ...(reflectionExtract.length > 0 ? { extract: reflectionExtract } : {}),
              },
            },
          }
        : {}),
    },
  });
}
