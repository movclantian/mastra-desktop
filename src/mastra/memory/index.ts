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
 *   模型跟随当前请求、scope、temporalMarkers、
 *   retrieval{vector,scope};observation.instruction/threadTitle/manageWorkingMemory/
 *   observeAttachments/messageTokens/maxTokensPerBatch/modelSettings{temperature,
 *   maxOutputTokens}/bufferTokens;reflection.instruction/observationTokens。
 *   observation.extract(Extractor[])与 reflection.extract(Extractor[]) 可由设置面板配置；
 *   任意 schema/hook 仍保留为代码级扩展点,不允许普通 JSON 设置执行任意代码。
 */

import type { MastraModelConfig } from "@mastra/core/llm";
import type { RequestContext } from "@mastra/core/request-context";
import { fastembed } from "@mastra/fastembed";
import { type LibSQLStore, LibSQLVector } from "@mastra/libsql";
import { Extractor, Memory } from "@mastra/memory";
import { clampInt, clampNumber } from "../config/normalize";
import { REQUEST_MODEL_CONTEXT_KEY, resolveDefaultLanguageModel } from "../models";
import {
  appStorage,
  getAppConfig,
  getStorageUrl,
  type RequestContextLike,
  resourceIdFromContext,
  setAppConfig,
} from "../storage";

const MEMORY_CONFIG_KEY = "memory";
const DEFAULT_OM_MESSAGE_TOKENS = 16_000;

export interface MemoryUserConfig {
  /** options.lastMessages — OM 关闭时每次请求注入的最近消息数,默认 20 */
  lastMessages: number;
  /** options.readOnly — 只读记忆(不保存新消息,不注册 updateWorkingMemory 工具) */
  readOnly: boolean;
  /** options.semanticRecall — 语义召回开关(需 vector + embedder) */
  semanticRecall: boolean;
  /** options.semanticRecall.topK — 相似消息数,默认 4 */
  semanticRecallTopK: number;
  /** options.semanticRecall.messageRange.before — 每条命中消息向前附带条数 */
  semanticRecallMessageRangeBefore: number;
  /** options.semanticRecall.messageRange.after — 每条命中消息向后附带条数 */
  semanticRecallMessageRangeAfter: number;
  /** options.semanticRecall.scope — thread(线程内)/ resource(跨线程),默认 thread */
  semanticRecallScope: "thread" | "resource";
  /** options.semanticRecall.threshold — 相似度下限,0 = 使用向量库全部结果 */
  semanticRecallThreshold: number;
  /** options.semanticRecall.indexName — 向量索引名,空字符串使用官方默认 */
  semanticRecallIndexName: string;
  /** options.workingMemory.enabled — 工作记忆开关 */
  workingMemory: boolean;
  /** options.workingMemory.scope — resource(跨线程用户画像) / thread(线程内) */
  workingMemoryScope: "resource" | "thread";
  /**
   * 工作记忆形态:template(Markdown 模板,replace 语义)或
   * schema(Standard JSON Schema,merge 语义)。二者互斥(working-memory.mdx)。
   */
  workingMemoryFormat: "template" | "schema";
  /** options.workingMemory.template — Markdown 模板(定义工作记忆结构) */
  workingMemoryTemplate: string;
  /** options.workingMemory.schema — JSON Schema 文本(JSON 形态,format = schema 时生效) */
  workingMemorySchema: string;
  /** options.generateTitle — 自动为新线程生成标题 */
  generateTitle: boolean;
  /** options.observationalMemory — 观察记忆(长上下文自动观察/反思) */
  observationalMemory: boolean;
  /** options.observationalMemory.scope — thread / resource(跨线程共享) */
  omScope: "thread" | "resource";
  /** options.observationalMemory.temporalMarkers — ≥10min 间隔插入时间标记 */
  omTemporalMarkers: boolean;
  /** observation.instruction — 追加到 Observer 系统提示的自定义指令 */
  omObserverInstruction: string;
  /** reflection.instruction — 追加到 Reflector 系统提示的自定义指令 */
  omReflectionInstruction: string;
  /** observation.threadTitle — Observer 顺手维护线程标题(官方默认关) */
  omThreadTitle: boolean;
  /** observation.manageWorkingMemory — 让 Observer 通过 OM 抽取管理工作记忆 */
  omManageWorkingMemory: boolean;
  /** observation.observeAttachments — 附件转发给 Observer:on / off / auto(按模型多模态能力) */
  omObserveAttachments: "auto" | "on" | "off";
  /** observation.messageTokens — 触发观察的 token 阈值(默认 16K;设置页按模型派生) */
  omMessageTokens: number;
  /** observation.maxTokensPerBatch — resource 侧多线程批量观察的批大小(0 = 库默认 10000) */
  omMaxTokensPerBatch: number;
  /** observation.modelSettings.temperature — Observer 温度(库默认 0.3) */
  omTemperature: number;
  /** observation.modelSettings.maxOutputTokens — Observer 输出上限(0 = 库默认) */
  omMaxOutputTokens: number;
  /** observation.bufferTokens — 异步缓冲频率(<1 为 messageTokens 比例,≥1 为绝对值) */
  omBufferTokens: number;
  /** 关闭 observation.bufferTokens(官方 false = 禁用全部异步缓冲) */
  omBufferEnabled: boolean;
  /** reflection.observationTokens — 触发反思的观察 token 阈值(0 = 库默认 40000) */
  omObservationTokens: number;
  /** options.observationalMemory.retrieval — 注册 recall 工具回查原始消息 */
  omRetrieval: boolean;
  /** retrieval.vector — recall 同时启用语义检索(用 Memory 的 vector + embedder) */
  omRetrievalVector: boolean;
  /** retrieval.scope — recall 的回查范围,官方默认 resource */
  omRetrievalScope: "thread" | "resource";
  /**
   * OM 自定义抽取器(observation.extract / reflection.extract,
   * observational-memory.mdx「Extractor API」)。schema 省略 = 内联字符串抽取器,
   * 由 Observer/Reflector 在主输出中直接产出,不额外发起结构化调用;
   * 抽取结果持久化在线程 OM metadata 的 om.extracted.<slug> 下。
   */
  omExtractors: OmExtractorUserConfig[];
}

interface OmExtractorUserConfig {
  /** 面板行 id(nanoid,与官方 slug 无关) */
  id: string;
  /** 官方 Extractor name:人类可读,OM 自行 slug 化,同批内不可重名 */
  name: string;
  /** 官方 Extractor instructions:抽取什么、何时更新 */
  instructions: string;
  /** 挂到观察(observation)还是反思(reflection)阶段 */
  stage: "observation" | "reflection";
  /** 关闭后保留草稿但不注入 Memory */
  enabled: boolean;
  /** 将上一次提取结果放回下一次提示，便于增量更新 */
  includePreviousExtraction?: boolean;
  /** OM metadata 中的持久化路径；空字符串使用官方默认 extracted.<slug> */
  metadataKeyPath?: string;
}

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
  workingMemoryScope: "resource",
  workingMemoryFormat: "template",
  workingMemoryTemplate: DEFAULT_WORKING_MEMORY_TEMPLATE,
  workingMemorySchema: DEFAULT_WORKING_MEMORY_SCHEMA,
  // 标题是独立的异步调用,默认开启以便线程列表可读。
  generateTitle: true,
  // 长对话默认启用 OM;由设置页按当前模型写入 messageTokens。
  observationalMemory: true,
  omScope: "thread",
  // 长时间间隔的时间标记成本很低,默认开启以避免跨天对话失去时间感。
  omTemporalMarkers: true,
  omObserverInstruction: "",
  omReflectionInstruction: "",
  omThreadTitle: false,
  omManageWorkingMemory: false,
  omObserveAttachments: "auto",
  // 已知模型时由前端按最小模型窗口派生约 50%;未知模型先使用安全的 16K 回退。
  omMessageTokens: DEFAULT_OM_MESSAGE_TOKENS,
  omMaxTokensPerBatch: 0,
  // omTemperature:0.3 为官方默认值(observational-memory.mdx: observation.modelSettings.temperature defaultValue='0.3')。
  omTemperature: 0.3,
  omMaxOutputTokens: 0,
  // omBufferTokens:0.2 为官方默认值(observational-memory.mdx: bufferTokens defaultValue='0.2')。
  omBufferTokens: 0.2,
  omBufferEnabled: true,
  omObservationTokens: 0,
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

function currentConfig(resourceId?: string): MemoryUserConfig {
  return memoryConfigByScope.get(memoryScopeKey(resourceId)) ?? DEFAULT_CONFIG;
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
  const normalized = normalizeMemoryConfig({ ...currentConfig(resourceId), ...next });
  await setAppConfig(MEMORY_CONFIG_KEY, JSON.stringify(normalized, null, 2), resourceId);
  memoryConfigByScope.set(memoryScopeKey(resourceId), normalized);
  const runtime = getMemoryRuntime(resourceId);
  runtime.cachedMemory = null;
  runtime.memoryByScope.clear();
}

function normalizeExtractor(value: unknown, index: number): OmExtractorUserConfig | null {
  if (typeof value !== "object" || value === null) return null;
  const item = value as Partial<OmExtractorUserConfig>;
  const name = typeof item.name === "string" ? item.name.trim().slice(0, 120) : "";
  const instructions =
    typeof item.instructions === "string" ? item.instructions.trim().slice(0, 8_000) : "";
  const stage = item.stage === "reflection" ? "reflection" : "observation";
  if (!name || !instructions) return null;
  return {
    id: typeof item.id === "string" && item.id.trim() ? item.id.trim().slice(0, 80) : `om-${index}`,
    name,
    instructions,
    stage,
    enabled: item.enabled !== false,
    includePreviousExtraction: item.includePreviousExtraction === true,
    metadataKeyPath:
      typeof item.metadataKeyPath === "string" ? item.metadataKeyPath.trim().slice(0, 160) : "",
  };
}

/** 配置边界的唯一归一化入口,避免 HTTP JSON 直接破坏运行时类型。 */
function normalizeMemoryConfig(input: Partial<MemoryUserConfig>): MemoryUserConfig {
  const merged = { ...DEFAULT_CONFIG, ...input };
  const stored = Object.fromEntries(
    Object.entries(merged).filter(([key]) => key in DEFAULT_CONFIG),
  ) as unknown as MemoryUserConfig;
  const extractors = Array.isArray(input.omExtractors)
    ? input.omExtractors
        .map((item, index) => normalizeExtractor(item, index))
        .filter((item): item is OmExtractorUserConfig => Boolean(item))
    : DEFAULT_CONFIG.omExtractors;
  const unique = new Set<string>();
  return {
    ...DEFAULT_CONFIG,
    ...stored,
    lastMessages: clampInt(merged.lastMessages, DEFAULT_CONFIG.lastMessages, 1, 500),
    semanticRecallTopK: clampInt(merged.semanticRecallTopK, 4, 1, 50),
    semanticRecallMessageRangeBefore: clampInt(
      merged.semanticRecallMessageRangeBefore,
      DEFAULT_CONFIG.semanticRecallMessageRangeBefore,
      0,
      50,
    ),
    semanticRecallMessageRangeAfter: clampInt(
      merged.semanticRecallMessageRangeAfter,
      DEFAULT_CONFIG.semanticRecallMessageRangeAfter,
      0,
      50,
    ),
    semanticRecallScope: merged.semanticRecallScope === "resource" ? "resource" : "thread",
    semanticRecallThreshold: clampNumber(merged.semanticRecallThreshold, 0, 0, 1),
    semanticRecallIndexName:
      typeof merged.semanticRecallIndexName === "string"
        ? merged.semanticRecallIndexName.trim().slice(0, 128)
        : "",
    workingMemoryScope: merged.workingMemoryScope === "thread" ? "thread" : "resource",
    workingMemoryFormat: merged.workingMemoryFormat === "schema" ? "schema" : "template",
    omScope: merged.omScope === "resource" ? "resource" : "thread",
    omObserveAttachments:
      merged.omObserveAttachments === "on" || merged.omObserveAttachments === "off"
        ? merged.omObserveAttachments
        : "auto",
    // 页面派生值最多 250K;更大的值无法对常见模型提供可靠的窗口保护。
    omMessageTokens: clampInt(merged.omMessageTokens, DEFAULT_OM_MESSAGE_TOKENS, 0, 250_000),
    omMaxTokensPerBatch: clampInt(merged.omMaxTokensPerBatch, 0, 0, 2_000_000),
    omTemperature: clampNumber(merged.omTemperature, 0.3, 0, 2),
    omMaxOutputTokens: clampInt(merged.omMaxOutputTokens, 0, 0, 500_000),
    omBufferTokens: clampNumber(merged.omBufferTokens, 0.2, 0, 500_000),
    omObservationTokens: clampInt(merged.omObservationTokens, 0, 0, 2_000_000),
    omRetrievalScope: merged.omRetrievalScope === "thread" ? "thread" : "resource",
    omExtractors: extractors.filter((item) => {
      const key = `${item.stage}:${item.name.toLowerCase()}`;
      if (unique.has(key)) return false;
      unique.add(key);
      return true;
    }),
    workingMemory: merged.workingMemory === true,
    readOnly: merged.readOnly === true,
    semanticRecall: merged.semanticRecall === true,
    generateTitle: merged.generateTitle === true,
    observationalMemory: merged.observationalMemory === true,
    omTemporalMarkers: merged.omTemporalMarkers === true,
    omThreadTitle: merged.omThreadTitle === true,
    omManageWorkingMemory: merged.omManageWorkingMemory === true,
    omBufferEnabled: merged.omBufferEnabled !== false,
    omRetrieval: merged.omRetrieval === true,
    omRetrievalVector: merged.omRetrievalVector === true,
  };
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
  cachedMemory: Memory | null;
  memoryByScope: Map<string, Memory>;
}

const memoryRuntimeByScope = new Map<string, MemoryRuntime>();

function getMemoryRuntime(resourceId?: string): MemoryRuntime {
  const scope = memoryScopeKey(resourceId);
  let runtime = memoryRuntimeByScope.get(scope);
  if (!runtime) {
    runtime = { cachedMemory: null, memoryByScope: new Map() };
    memoryRuntimeByScope.set(scope, runtime);
  }
  return runtime;
}

interface MemoryBuildOverrides {
  memoryScope?: "thread" | "resource";
}

/**
 * 当前 Memory 实例。Agent 以函数形式引用(memory: () => getMemory()),
 * 配置保存后无需重启即对后续请求生效。
 */
export function getMemory(options?: {
  requestContext?: RequestContext;
  memoryScope?: "thread" | "resource";
}): Memory {
  const resourceId = resourceIdFromContext(options?.requestContext as RequestContextLike);
  const runtime = getMemoryRuntime(resourceId);
  if (options?.memoryScope) {
    const existing = runtime.memoryByScope.get(options.memoryScope);
    if (existing) return existing;
    const memory = buildMemory({ memoryScope: options.memoryScope }, resourceId);
    runtime.memoryByScope.set(options.memoryScope, memory);
    return memory;
  }
  if (!runtime.cachedMemory) runtime.cachedMemory = buildMemory({}, resourceId);
  return runtime.cachedMemory;
}

/** Wait for every cached Memory instance before process shutdown. */
export async function settleAllMemory(): Promise<void> {
  const instances = new Set<Memory>();
  for (const runtime of memoryRuntimeByScope.values()) {
    if (runtime.cachedMemory) instances.add(runtime.cachedMemory);
    for (const memory of runtime.memoryByScope.values()) instances.add(memory);
  }
  await Promise.allSettled([...instances].map((memory) => memory.settled()));
}

function buildMemory(overrides: MemoryBuildOverrides = {}, resourceId?: string): Memory {
  const config = currentConfig(resourceId);
  const semanticRecallScope = overrides.memoryScope ?? config.semanticRecallScope;
  const workingMemoryScope = overrides.memoryScope ?? config.workingMemoryScope;
  const observationalMemoryScope = overrides.memoryScope ?? config.omScope;
  // OM 永远跟随当前主请求模型,避免 Observer/Reflector 使用另一套模型配置。
  // 没有请求级模型的线程维护或后台任务使用当前资源的默认模型。
  const resolveCurrentRequestModel = async (
    requestContext: RequestContext,
  ): Promise<MastraModelConfig> => {
    const requestModel = requestContext.get(REQUEST_MODEL_CONTEXT_KEY) as
      | MastraModelConfig
      | undefined;
    const model = requestModel ?? (await resolveDefaultLanguageModel(resourceId));
    if (!model) {
      throw new Error("尚未配置可用的模型供应商,请先在「模型供应商」中选择模型");
    }
    return model;
  };

  // 自定义抽取器(observational-memory.mdx「Extractor API」):schema 省略 =
  // 内联字符串抽取,Observer/Reflector 主输出顺带产出,无额外结构化调用。
  // 同批 name 去重(官方按 name 生成 slug,重名会在运行时报冲突)。
  const observationExtract = dedupeExtractors(config.omExtractors, "observation");
  const reflectionExtract = dedupeExtractors(config.omExtractors, "reflection");

  return new Memory({
    storage: appStorage as LibSQLStore,
    // semantic-recall.mdx:LibSQLVector 与 LibSQLStore 共用同一数据库文件
    vector: new LibSQLVector({ id: "mastra-vector", url: getStorageUrl() }),
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
              model: ({ requestContext }) => resolveCurrentRequestModel(requestContext),
              scope: observationalMemoryScope,
              // 压缩时机对齐前缀缓存的生命周期:'auto' 用供应商的 prompt cache TTL 作为
              // 空闲阈值,让"折叠旧消息"发生在缓存本来就已过期之后,而不是在缓存还热的时候
              // 把前缀砸掉。本 App 允许同线程中途换模型(见 agents/index.ts 的动态 model),
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
                ...(config.omObserverInstruction.trim()
                  ? { instruction: config.omObserverInstruction.trim() }
                  : {}),
                ...(config.omThreadTitle ? { threadTitle: true } : {}),
                ...(config.omManageWorkingMemory ? { manageWorkingMemory: true } : {}),
                // 'auto' 字面量 = 按模型多模态能力自动决定;on/off → true/false
                observeAttachments:
                  config.omObserveAttachments === "auto"
                    ? ("auto" as const)
                    : config.omObserveAttachments === "on",
                ...(config.omMessageTokens > 0 ? { messageTokens: config.omMessageTokens } : {}),
                ...(config.omMaxTokensPerBatch > 0
                  ? { maxTokensPerBatch: config.omMaxTokensPerBatch }
                  : {}),
                modelSettings: {
                  temperature: config.omTemperature,
                  ...(config.omMaxOutputTokens > 0
                    ? { maxOutputTokens: config.omMaxOutputTokens }
                    : {}),
                },
                // 官方默认 0.2(messageTokens 的 20%);关闭时显式传 false
                ...(config.omBufferEnabled
                  ? { bufferTokens: config.omBufferTokens }
                  : { bufferTokens: false }),
                ...(observationExtract.length > 0 ? { extract: observationExtract } : {}),
              },
              reflection: {
                continuationHints: false,
                ...(config.omReflectionInstruction.trim()
                  ? { instruction: config.omReflectionInstruction.trim() }
                  : {}),
                ...(config.omObservationTokens > 0
                  ? { observationTokens: config.omObservationTokens }
                  : {}),
                ...(reflectionExtract.length > 0 ? { extract: reflectionExtract } : {}),
              },
            },
          }
        : {}),
    },
  });
}
