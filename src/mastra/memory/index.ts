import type { RequestContext } from "@mastra/core/request-context";
import { fastembed } from "@mastra/fastembed";
import { type LibSQLStore, LibSQLVector } from "@mastra/libsql";
import { Extractor, Memory } from "@mastra/memory";
import {
  resolveConfiguredEmbeddingModelForUse,
  resolveDefaultModelId,
  WORKBENCH_GATEWAY_ID,
} from "../models";
import { appStorage, getAppConfig, getStorageUrl, setAppConfig } from "../storage";

/**
 * 记忆配置:设置面板「记忆」标签页写入数据库 app_config 表(key = "memory"),
 * 保存后实时生效(与业务数据同库,不再落 JSON 文件)。
 * 字段对照 docs/en/reference/memory/memory-class.mdx 的 MemoryConfig 全量定义:
 * - lastMessages / readOnly                      → message-history.mdx
 * - semanticRecall{topK,messageRange,scope}      → semantic-recall.mdx
 *   messageRange 支持官方对象形态 {before, after}(每条命中前后各自附带条数)
 * - workingMemory{enabled,scope,template|schema} → working-memory.mdx
 *   schema 形态接受 Standard JSON Schema(Zod/Valibot/JSON Schema 均可,面板里
 *   直接编辑 JSON 文本),template 与 schema 互斥,分别对应 replace/merge 语义
 * - generateTitle{model,instructions}            → message-history.mdx
 * - observationalMemory(顶层 + observation/reflection 深层子项)
 *   → observational-memory.mdx:
 *   顶层 model|observation.model/reflection.model(互斥)、scope、temporalMarkers、
 *   retrieval{vector,scope};observation.instruction/threadTitle/manageWorkingMemory/
 *   observeAttachments/messageTokens/maxTokensPerBatch/modelSettings{temperature,
 *   maxOutputTokens}/bufferTokens;reflection.instruction/observationTokens。
 *   observation.extract(Extractor[])与 reflection.extract(Extractor[]) 可由设置面板配置；
 *   任意 schema/hook 仍保留为代码级扩展点,不允许普通 JSON 设置执行任意代码。
 */
const MEMORY_CONFIG_KEY = "memory";

export interface MemoryUserConfig {
  /** 语义召回与 OM 共用的嵌入模型:默认使用本机 FastEmbed,也可选择供应商模型 */
  embeddingModel: string;
  /** options.lastMessages — 每次请求注入的最近消息数,默认 10 */
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
  /** options.generateTitle.model — 标题生成模型(路由字符串) */
  generateTitleModel: string;
  /** options.generateTitle.instructions — 标题生成附加指令 */
  generateTitleInstructions: string;
  /** options.observationalMemory — 观察记忆(长上下文自动观察/反思) */
  observationalMemory: boolean;
  /** 顶层 model(Observer/Reflector 共用);与子模型二选一,子模型设置时忽略 */
  omModel: string;
  /** observation.model — Observer 专属模型(与顶层 model 互斥) */
  omObserverModel: string;
  /** reflection.model — Reflector 专属模型(与顶层 model 互斥) */
  omReflectionModel: string;
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
  /** observation.messageTokens — 触发观察的 token 阈值(0 = 库默认 30000) */
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

export interface OmExtractorUserConfig {
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

export const DEFAULT_WORKING_MEMORY_TEMPLATE = `# User Profile
- **Name**:
- **Location**:
- **Interests**:
- **Preferences**:
- **Long-term Goals**:
`;

/** schema 形态的默认示例(working-memory.mdx「Schema-Based Working Memory」) */
export const DEFAULT_WORKING_MEMORY_SCHEMA = `{
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
  embeddingModel: "small",
  lastMessages: 20,
  readOnly: false,
  semanticRecall: false,
  semanticRecallTopK: 4,
  // 官方对象形态 {before, after};沿用此前单数 2 的行为
  semanticRecallMessageRangeBefore: 2,
  semanticRecallMessageRangeAfter: 2,
  semanticRecallScope: "thread",
  workingMemory: true,
  workingMemoryScope: "resource",
  workingMemoryFormat: "template",
  workingMemoryTemplate: DEFAULT_WORKING_MEMORY_TEMPLATE,
  workingMemorySchema: DEFAULT_WORKING_MEMORY_SCHEMA,
  generateTitle: true,
  // 空串 = 跟随当前模型(不显式指定,由库默认解析;前端下拉默认预填当前模型)
  generateTitleModel: "",
  generateTitleInstructions: "",
  observationalMemory: true,
  omModel: "",
  omObserverModel: "",
  omReflectionModel: "",
  omScope: "thread",
  omTemporalMarkers: false,
  omObserverInstruction: "",
  omReflectionInstruction: "",
  omThreadTitle: false,
  omManageWorkingMemory: false,
  omObserveAttachments: "auto",
  // 0 = 不显式指定,由前端按模型上下文窗口自动派生后写入(25%,8K~250K)
  omMessageTokens: 0,
  omMaxTokensPerBatch: 0,
  omTemperature: 0.3,
  omMaxOutputTokens: 0,
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

const configuredEmbeddingModel = {
  specificationVersion: "v2" as const,
  modelId: "mastra-work/embedding",
  provider: "mastra-work",
  maxEmbeddingsPerCall: 2048,
  supportsParallelCalls: true,
  async doEmbed(args: {
    values: string[];
    abortSignal?: AbortSignal;
    headers?: Record<string, string>;
  }) {
    const selected = await resolveConfiguredEmbeddingModelForUse(config.embeddingModel);
    if (!selected) {
      throw new Error(`记忆嵌入模型 ${config.embeddingModel} 未配置或不可用`);
    }
    return selected.doEmbed(args);
  },
};

/** 读取记忆配置(app_config 表 key="memory";无记录或损坏时回落默认值) */
export async function getMemoryConfig(): Promise<MemoryUserConfig> {
  const raw = await getAppConfig(MEMORY_CONFIG_KEY);
  if (!raw) return DEFAULT_CONFIG;
  try {
    return normalizeMemoryConfig(JSON.parse(raw) as Partial<MemoryUserConfig>);
  } catch {
    return DEFAULT_CONFIG;
  }
}

/** 写入记忆配置并实时生效:替换运行时配置、置空实例缓存(下次使用时按新配置重建) */
export async function saveMemoryConfig(next: MemoryUserConfig): Promise<void> {
  const normalized = normalizeMemoryConfig(next);
  await setAppConfig(MEMORY_CONFIG_KEY, JSON.stringify(normalized, null, 2));
  config = normalized;
  cachedMemory = null;
  memoryByOmModels.clear();
}

function finite(value: unknown, fallback: number, min = 0, max = Number.POSITIVE_INFINITY): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
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
export function normalizeMemoryConfig(input: Partial<MemoryUserConfig>): MemoryUserConfig {
  const merged = { ...DEFAULT_CONFIG, ...input };
  const extractors = Array.isArray(input.omExtractors)
    ? input.omExtractors
        .map((item, index) => normalizeExtractor(item, index))
        .filter((item): item is OmExtractorUserConfig => Boolean(item))
    : DEFAULT_CONFIG.omExtractors;
  const unique = new Set<string>();
  return {
    ...DEFAULT_CONFIG,
    ...merged,
    embeddingModel:
      typeof merged.embeddingModel === "string" &&
      (merged.embeddingModel === "small" ||
        merged.embeddingModel === "base" ||
        /^[^/\s]+\/[^/\s]+$/.test(merged.embeddingModel))
        ? merged.embeddingModel
        : DEFAULT_CONFIG.embeddingModel,
    lastMessages: Math.round(finite(merged.lastMessages, DEFAULT_CONFIG.lastMessages, 1, 500)),
    semanticRecallTopK: Math.round(finite(merged.semanticRecallTopK, 4, 1, 50)),
    semanticRecallMessageRangeBefore: Math.round(
      finite(merged.semanticRecallMessageRangeBefore, 2, 0, 50),
    ),
    semanticRecallMessageRangeAfter: Math.round(
      finite(merged.semanticRecallMessageRangeAfter, 2, 0, 50),
    ),
    semanticRecallScope: merged.semanticRecallScope === "resource" ? "resource" : "thread",
    workingMemoryScope: merged.workingMemoryScope === "thread" ? "thread" : "resource",
    workingMemoryFormat: merged.workingMemoryFormat === "schema" ? "schema" : "template",
    omScope: merged.omScope === "resource" ? "resource" : "thread",
    omObserveAttachments:
      merged.omObserveAttachments === "on" || merged.omObserveAttachments === "off"
        ? merged.omObserveAttachments
        : "auto",
    omMessageTokens: Math.round(finite(merged.omMessageTokens, 0, 0, 2_000_000)),
    omMaxTokensPerBatch: Math.round(finite(merged.omMaxTokensPerBatch, 0, 0, 2_000_000)),
    omTemperature: finite(merged.omTemperature, 0.3, 0, 2),
    omMaxOutputTokens: Math.round(finite(merged.omMaxOutputTokens, 0, 0, 500_000)),
    omBufferTokens: finite(merged.omBufferTokens, 0.2, 0, 500_000),
    omObservationTokens: Math.round(finite(merged.omObservationTokens, 0, 0, 2_000_000)),
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

/**
 * Extractors used by one-shot/manual summarization. OM attaches extractors to
 * separate observer/reflection stages, while summarizeThread accepts one flat
 * list; preserve configuration order and remove duplicate names globally.
 */
export function getConfiguredMemoryExtractors(): Extractor[] {
  const seen = new Set<string>();
  const extractors: Extractor[] = [];
  for (const item of config.omExtractors) {
    if (item.enabled === false) continue;
    const name = item.name.trim();
    const instructions = item.instructions.trim();
    const key = name.toLowerCase();
    if (!name || !instructions || seen.has(key)) continue;
    seen.add(key);
    extractors.push(instantiateExtractor(item));
  }
  return extractors;
}

// 运行时配置为模块级可变状态:顶层 await 在服务启动时从数据库读取
// (输出为 ESM,.mastra/output/index.mjs,顶层 await 合法);保存配置时原地替换。
let config = await getMemoryConfig();

// Memory 实例按配置缓存:saveMemoryConfig 置空后,下一次 getMemory() 按新配置重建
let cachedMemory: Memory | null = null;
const memoryByOmModels = new Map<string, Memory>();

export const OM_MODELS_CONTEXT_KEY = "mastra-work:om-models";

export interface OmModelSelection {
  observerModelId?: string;
  reflectorModelId?: string;
}

/**
 * 当前 Memory 实例。Agent 以函数形式引用(memory: () => getMemory()),
 * 配置保存后无需重启即对后续请求生效。
 */
export function getMemory(options?: { requestContext?: RequestContext }): Memory {
  const selection = options?.requestContext?.get(OM_MODELS_CONTEXT_KEY) as
    | OmModelSelection
    | undefined;
  const observerModelId = selection?.observerModelId?.trim() || undefined;
  const reflectorModelId = selection?.reflectorModelId?.trim() || undefined;
  if (observerModelId || reflectorModelId) {
    const key = JSON.stringify([observerModelId ?? null, reflectorModelId ?? null]);
    const existing = memoryByOmModels.get(key);
    if (existing) return existing;
    const memory = buildMemory({ observerModelId, reflectorModelId });
    memoryByOmModels.set(key, memory);
    return memory;
  }
  if (!cachedMemory) cachedMemory = buildMemory();
  return cachedMemory;
}

function workbenchModelId(modelId: string): `${string}/${string}` {
  return (
    modelId.startsWith(`${WORKBENCH_GATEWAY_ID}/`) ? modelId : `${WORKBENCH_GATEWAY_ID}/${modelId}`
  ) as `${string}/${string}`;
}

function buildMemory(overrides: OmModelSelection = {}): Memory {
  // 官方约束:顶层 model 与 observation.model/reflection.model 互斥 ——
  // 任一子模型配置时只传子模型,否则传顶层(或全部省略 = 跟随当前模型)。
  const omObserverModel = overrides.observerModelId?.trim() || config.omObserverModel.trim();
  const omReflectionModel = overrides.reflectorModelId?.trim() || config.omReflectionModel.trim();
  const omTopModel = omObserverModel || omReflectionModel ? undefined : config.omModel.trim();
  // OM 的配置对象不能省略 model:Mastra 会把「未配置」静默解析为
  // google/gemini-2.5-flash,这会让用户明明选择了自定义网关却在后台观察任务里
  // 触发 Google 的环境变量检查。空配置必须动态跟随工作台当前模型,并在没有模型
  // 时给出明确的配置错误;实际路由 id 由 WorkbenchGateway 在 Mastra 实例上解析。
  const omFollowCurrentModel = async () => {
    const modelId = await resolveDefaultModelId();
    if (!modelId) {
      throw new Error("尚未配置可用的模型供应商,请先在「模型供应商」中选择模型");
    }
    return modelId;
  };

  // 自定义抽取器(observational-memory.mdx「Extractor API」):schema 省略 =
  // 内联字符串抽取,Observer/Reflector 主输出顺带产出,无额外结构化调用。
  // 同批 name 去重(官方按 name 生成 slug,重名会在运行时报冲突)。
  const observationExtract = dedupeExtractors(config.omExtractors, "observation");
  const reflectionExtract = dedupeExtractors(config.omExtractors, "reflection");

  return new Memory({
    storage: appStorage as LibSQLStore,
    // semantic-recall.mdx:LibSQLVector 与 LibSQLStore 共用同一数据库文件
    vector: new LibSQLVector({
      id: "mastra-vector",
      url: getStorageUrl(),
    }),
    embedder:
      config.embeddingModel === "base"
        ? fastembed.baseV2
        : config.embeddingModel === "small"
          ? fastembed.smallV2
          : configuredEmbeddingModel,
    options: {
      // message-history.mdx:lastMessages 注入最近 N 条;readOnly 只读
      lastMessages: config.lastMessages,
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
              scope: config.semanticRecallScope,
            },
          }
        : {}),
      // working-memory.mdx:template(replace 语义)与 schema(merge 语义)二选一;
      // schema 文本损坏时回落 template,服务不因此起不来
      ...(config.workingMemory
        ? {
            workingMemory:
              config.workingMemoryFormat === "schema"
                ? (() => {
                    const schema = parseWorkingMemorySchema(config.workingMemorySchema);
                    return schema
                      ? { enabled: true, scope: config.workingMemoryScope, schema }
                      : {
                          enabled: true,
                          scope: config.workingMemoryScope,
                          template: config.workingMemoryTemplate,
                        };
                  })()
                : {
                    enabled: true,
                    scope: config.workingMemoryScope,
                    template: config.workingMemoryTemplate,
                  },
          }
        : {}),
      // message-history.mdx:generateTitle 布尔或 { model, instructions }。
      // 模型空串 = 跟随当前模型:传 true 由库默认解析,不锁定具体模型。
      ...(config.generateTitle
        ? config.generateTitleModel
          ? {
              generateTitle: {
                model: config.generateTitleModel,
                ...(config.generateTitleInstructions
                  ? { instructions: config.generateTitleInstructions }
                  : {}),
              },
            }
          : { generateTitle: true }
        : {}),
      // observational-memory.mdx:顶层 + observation/reflection 深层子项。
      // continuationHints(@mastra/memory 1.27)刻意关闭 <current-task> /
      // <suggested-response> 注入:本 Agent 自带控制流 —— TaskSignalProvider 的
      // task_* 工具 + Queue UI 承载任务状态,instructions 规定了 submit_plan /
      // ask_user 与引用格式纪律;记忆再注入这两段提示等于第二个控制器与其争控制权。
      ...(config.observationalMemory
        ? {
            observationalMemory: {
              ...(omObserverModel || omReflectionModel
                ? {}
                : { model: omTopModel ? workbenchModelId(omTopModel) : omFollowCurrentModel }),
              scope: config.omScope,
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
                ...(omObserverModel ? { model: workbenchModelId(omObserverModel) } : {}),
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
                ...(omReflectionModel ? { model: workbenchModelId(omReflectionModel) } : {}),
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
