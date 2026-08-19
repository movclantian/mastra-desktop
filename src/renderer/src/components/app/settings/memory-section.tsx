import { PlusIcon, Trash2Icon } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  formatModelContextWindow,
  getModelContextWindow,
  MASTRA_SERVER_URL,
} from "@/lib/providers";
import { useWorkbench } from "@/lib/workbench";
import {
  currentModelRouterString,
  FOLLOW_CURRENT_MODEL,
  ModelSelectDropdown,
  ScopeSelect,
  SettingCard,
  SettingRow,
  SliderRow,
} from "./shared";

// ---------------------------------------------------------------------------
// 记忆(暴露 Memory 可配置项,写入数据库 app_config 表,保存后实时生效)
// 字段与 src/mastra/memory/index.ts 的 MemoryUserConfig 一一对应。
// ---------------------------------------------------------------------------

/** 纯文本编辑字段:保存时静默,不弹撤回 toast(其余开关/滑块/下拉变化才弹) */
const MEMORY_TEXT_KEYS = new Set([
  "workingMemoryTemplate",
  "workingMemorySchema",
  "generateTitleInstructions",
  "omObserverInstruction",
  "omReflectionInstruction",
]);

export interface MemoryDraft {
  embeddingModel: string;
  lastMessages: number;
  readOnly: boolean;
  semanticRecall: boolean;
  semanticRecallTopK: number;
  semanticRecallMessageRangeBefore: number;
  semanticRecallMessageRangeAfter: number;
  semanticRecallScope: "thread" | "resource";
  workingMemory: boolean;
  workingMemoryScope: "resource" | "thread";
  workingMemoryFormat: "template" | "schema";
  workingMemoryTemplate: string;
  workingMemorySchema: string;
  generateTitle: boolean;
  generateTitleModel: string;
  generateTitleInstructions: string;
  observationalMemory: boolean;
  omModel: string;
  omObserverModel: string;
  omReflectionModel: string;
  omScope: "thread" | "resource";
  omTemporalMarkers: boolean;
  omObserverInstruction: string;
  omReflectionInstruction: string;
  omThreadTitle: boolean;
  omManageWorkingMemory: boolean;
  omObserveAttachments: "auto" | "on" | "off";
  omMessageTokens: number;
  omMaxTokensPerBatch: number;
  omTemperature: number;
  omMaxOutputTokens: number;
  omBufferTokens: number;
  omBufferEnabled: boolean;
  omObservationTokens: number;
  omRetrieval: boolean;
  omRetrievalVector: boolean;
  omRetrievalScope: "thread" | "resource";
  omExtractors: OmExtractorDraft[];
}

/** OM 自定义抽取器(官方 Extractor API,schema 省略 = 内联字符串抽取) */
export interface OmExtractorDraft {
  id: string;
  name: string;
  instructions: string;
  stage: "observation" | "reflection";
  enabled: boolean;
  includePreviousExtraction?: boolean;
  metadataKeyPath?: string;
}

export const DEFAULT_MEMORY_DRAFT: MemoryDraft = {
  embeddingModel: "small",
  lastMessages: 20,
  readOnly: false,
  semanticRecall: false,
  semanticRecallTopK: 4,
  semanticRecallMessageRangeBefore: 2,
  semanticRecallMessageRangeAfter: 2,
  semanticRecallScope: "thread",
  workingMemory: true,
  workingMemoryScope: "resource",
  workingMemoryFormat: "template",
  workingMemoryTemplate:
    "# User Profile\n- **Name**:\n- **Location**:\n- **Interests**:\n- **Preferences**:\n- **Long-term Goals**:\n",
  workingMemorySchema:
    '{\n  "type": "object",\n  "properties": {\n    "name": { "type": "string" },\n    "location": { "type": "string" },\n    "timezone": { "type": "string" },\n    "preferences": {\n      "type": "object",\n      "properties": {\n        "communicationStyle": { "type": "string" },\n        "projectGoal": { "type": "string" },\n        "deadlines": { "type": "array", "items": { "type": "string" } }\n      }\n    }\n  }\n}\n',
  generateTitle: true,
  generateTitleModel: FOLLOW_CURRENT_MODEL,
  generateTitleInstructions: "",
  observationalMemory: true,
  omModel: FOLLOW_CURRENT_MODEL,
  omObserverModel: FOLLOW_CURRENT_MODEL,
  omReflectionModel: FOLLOW_CURRENT_MODEL,
  omScope: "thread",
  omTemporalMarkers: false,
  omObserverInstruction: "",
  omReflectionInstruction: "",
  omThreadTitle: false,
  omManageWorkingMemory: false,
  omObserveAttachments: "auto",
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

export function MemorySection() {
  const { providers, catalog, modelSelection, activeThreadId, user } = useWorkbench();
  const [draft, setDraft] = React.useState<MemoryDraft>(DEFAULT_MEMORY_DRAFT);
  const [loaded, setLoaded] = React.useState(false);
  const [threadOmDraft, setThreadOmDraft] = React.useState({
    messageTokens: 0,
    maxTokensPerBatch: 0,
    observationTokens: 0,
    bufferTokens: 0.2,
  });
  const [threadOmLoaded, setThreadOmLoaded] = React.useState(false);

  // messageTokens 派生:Observer/Reflector 所用(或跟随的)模型上下文窗口 × 25%,
  // 夹在 8K~250K —— 窗口越大触发阈值越高,在撑爆上下文前完成压缩。
  const omEffectiveModel =
    draft.omObserverModel !== FOLLOW_CURRENT_MODEL
      ? draft.omObserverModel
      : draft.omReflectionModel !== FOLLOW_CURRENT_MODEL
        ? draft.omReflectionModel
        : draft.omModel !== FOLLOW_CURRENT_MODEL
          ? draft.omModel
          : currentModelRouterString(providers, modelSelection);
  const derivedMessageTokens = React.useMemo(() => {
    const idx = omEffectiveModel.indexOf("/");
    if (idx <= 0) return 0;
    const provider = providers.find(
      (p) => (p.registryId ?? p.id) === omEffectiveModel.slice(0, idx),
    );
    if (!provider) return 0;
    const window = getModelContextWindow(provider, omEffectiveModel.slice(idx + 1), catalog);
    if (!window) return 0;
    return Math.min(250_000, Math.max(8_000, Math.round(window * 0.25)));
  }, [omEffectiveModel, providers, catalog]);

  // schema 形态实时校验:非法 JSON / 非对象时后端会回落 template,这里给即时提示
  const workingMemorySchemaValid = React.useMemo(() => {
    if (draft.workingMemoryFormat !== "schema") return true;
    try {
      const parsed = JSON.parse(draft.workingMemorySchema) as unknown;
      return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
    } catch {
      return false;
    }
  }, [draft.workingMemoryFormat, draft.workingMemorySchema]);

  React.useEffect(() => {
    if (loaded) return;
    fetch(`${MASTRA_SERVER_URL}/work/memory`)
      .then((r) => (r.ok ? r.json() : null))
      .then((config) => {
        if (config) {
          setDraft((prev) => {
            const merged = { ...prev, ...config } as MemoryDraft;
            // 空模型串(跟随当前模型)映射为下拉的哨兵值
            merged.omModel = merged.omModel || FOLLOW_CURRENT_MODEL;
            merged.omObserverModel = merged.omObserverModel || FOLLOW_CURRENT_MODEL;
            merged.omReflectionModel = merged.omReflectionModel || FOLLOW_CURRENT_MODEL;
            merged.generateTitleModel = merged.generateTitleModel || FOLLOW_CURRENT_MODEL;
            return merged;
          });
        }
      })
      .catch(() => undefined)
      .finally(() => setLoaded(true));
  }, [loaded]);

  React.useEffect(() => {
    if (!activeThreadId) {
      setThreadOmLoaded(false);
      return;
    }
    setThreadOmLoaded(false);
    fetch(
      `${MASTRA_SERVER_URL}/work/threads/${activeThreadId}/observational-memory-config?resourceId=${encodeURIComponent(user.id)}`,
    )
      .then((response) => (response.ok ? response.json() : null))
      .then((payload: { config?: Record<string, unknown> } | null) => {
        const config = payload?.config;
        if (!config) return;
        setThreadOmDraft((current) => ({
          ...current,
          ...Object.fromEntries(
            Object.entries(config).filter(([, value]) => typeof value === "number"),
          ),
        }));
      })
      .catch(() => undefined)
      .finally(() => setThreadOmLoaded(true));
  }, [activeThreadId, user.id]);

  const saveThreadOmConfig = async () => {
    if (!activeThreadId) return;
    const response = await fetch(
      `${MASTRA_SERVER_URL}/work/threads/${activeThreadId}/observational-memory-config`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resourceId: user.id, config: threadOmDraft }),
      },
    );
    if (response.ok) toast.success("当前线程的观察记忆覆盖已保存");
    else toast.error("当前线程的观察记忆覆盖保存失败");
  };

  // 上次已保存的草稿快照:识别非文本字段变化并供撤回
  const prevSavedRef = React.useRef<MemoryDraft | null>(null);

  // 自动保存:800ms 防抖写入;非文本字段变化成功后弹 toast 供撤回,
  // 文本编辑(模板/Schema/指令)静默。messageTokens 为派生值,随模型选择自动重算写入。
  React.useEffect(() => {
    if (!loaded) return;
    const timer = window.setTimeout(() => {
      void fetch(`${MASTRA_SERVER_URL}/work/memory`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...draft,
          omModel: draft.omModel === FOLLOW_CURRENT_MODEL ? "" : draft.omModel,
          omObserverModel:
            draft.omObserverModel === FOLLOW_CURRENT_MODEL ? "" : draft.omObserverModel,
          omReflectionModel:
            draft.omReflectionModel === FOLLOW_CURRENT_MODEL ? "" : draft.omReflectionModel,
          generateTitleModel:
            draft.generateTitleModel === FOLLOW_CURRENT_MODEL ? "" : draft.generateTitleModel,
          omMessageTokens: derivedMessageTokens,
        }),
      })
        .then(() => {
          const before = prevSavedRef.current;
          prevSavedRef.current = draft;
          const changed =
            before !== null &&
            (Object.keys(before) as Array<keyof MemoryDraft>).some(
              (key) => !MEMORY_TEXT_KEYS.has(key) && !Object.is(before[key], draft[key]),
            );
          if (before !== null && changed) {
            toast.success("记忆配置已更新", {
              action: {
                label: "撤回",
                onClick: () => {
                  // 预置快照:随后的自动保存视为无变化,不再弹 toast
                  prevSavedRef.current = before;
                  setDraft(before);
                },
              },
            });
          }
        })
        .catch(() => toast.error("记忆配置自动保存失败,请确认 Mastra 服务已启动"));
    }, 800);
    return () => window.clearTimeout(timer);
  }, [draft, loaded, derivedMessageTokens]);

  return (
    <>
      <SettingCard
        title="消息历史(lastMessages)"
        description="每次请求注入上下文的最近消息条数与只读模式(message-history.mdx)。"
      >
        <SliderRow
          description="每次请求注入的最近消息条数"
          max={200}
          min={1}
          step={1}
          title="最近消息数"
          value={draft.lastMessages}
          onChange={(v) => setDraft({ ...draft, lastMessages: v })}
        />
        <SettingRow
          description="只读记忆:不保存新消息,不注册 updateWorkingMemory 工具"
          title="只读模式(readOnly)"
        >
          <Switch
            checked={draft.readOnly}
            onCheckedChange={(v) => setDraft({ ...draft, readOnly: v })}
          />
        </SettingRow>
      </SettingCard>

      <SettingCard
        title="语义召回(semanticRecall)"
        description="按语义相似度召回历史消息,需向量存储与 embedder(semantic-recall.mdx)。"
      >
        <div className="space-y-2 py-3">
          <div className="space-y-1">
            <p className="text-sm leading-none font-medium">记忆嵌入模型(embedder)</p>
            <p className="text-xs text-muted-foreground">
              默认使用本机 FastEmbed，不需要 API Key；也可以选择已在模型供应商中启用的 embedding
              模型。
            </p>
          </div>
          <Select
            value={draft.embeddingModel}
            onValueChange={(value) => value && setDraft({ ...draft, embeddingModel: value })}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="small">本机 FastEmbed Small · 384 维</SelectItem>
              <SelectItem value="base">本机 FastEmbed Base · 768 维</SelectItem>
              {providers.flatMap((provider) =>
                provider.enabledModels
                  .filter((model) => Boolean(model.embedding))
                  .map((model) => {
                    const value = `${provider.registryId ?? provider.id}/${model.id}`;
                    return (
                      <SelectItem key={value} value={value}>
                        {provider.name} / {model.name}
                      </SelectItem>
                    );
                  }),
              )}
            </SelectContent>
          </Select>
        </div>
        <SettingRow title="启用语义召回" description="对话内容将写入向量库用于相似检索">
          <Switch
            checked={draft.semanticRecall}
            onCheckedChange={(v) => setDraft({ ...draft, semanticRecall: v })}
          />
        </SettingRow>
        {draft.semanticRecall ? (
          <>
            <SliderRow
              description="topK:每次召回的相似消息条数"
              max={20}
              min={1}
              step={1}
              title="召回条数(topK)"
              value={draft.semanticRecallTopK}
              onChange={(v) => setDraft({ ...draft, semanticRecallTopK: v })}
            />
            <SliderRow
              description="messageRange.before:每条命中消息向前附带的上下文条数"
              max={10}
              min={0}
              step={1}
              title="向前附带(before)"
              value={draft.semanticRecallMessageRangeBefore}
              onChange={(v) => setDraft({ ...draft, semanticRecallMessageRangeBefore: v })}
            />
            <SliderRow
              description="messageRange.after:每条命中消息向后附带的上下文条数"
              max={10}
              min={0}
              step={1}
              title="向后附带(after)"
              value={draft.semanticRecallMessageRangeAfter}
              onChange={(v) => setDraft({ ...draft, semanticRecallMessageRangeAfter: v })}
            />
            <div className="flex items-center justify-between gap-4 py-4">
              <div className="min-w-0 space-y-1">
                <p className="text-sm leading-none font-medium">检索范围(scope)</p>
                <p className="text-xs text-muted-foreground">
                  thread 仅当前线程;resource 跨全部线程检索
                </p>
              </div>
              <ScopeSelect
                onChange={(v) => setDraft({ ...draft, semanticRecallScope: v })}
                resourceLabel="resource(跨线程)"
                threadLabel="thread(线程内)"
                value={draft.semanticRecallScope}
              />
            </div>
          </>
        ) : null}
      </SettingCard>

      <SettingCard
        title="工作记忆(workingMemory)"
        description="跨轮维护的结构化用户画像,由 Agent 通过工具自动更新(working-memory.mdx)。"
      >
        <SettingRow title="启用工作记忆" description="在系统上下文中维护一份可更新的画像">
          <Switch
            checked={draft.workingMemory}
            onCheckedChange={(v) => setDraft({ ...draft, workingMemory: v })}
          />
        </SettingRow>
        {draft.workingMemory ? (
          <>
            <div className="flex items-center justify-between gap-4 py-4">
              <div className="min-w-0 space-y-1">
                <p className="text-sm leading-none font-medium">记忆范围(scope)</p>
                <p className="text-xs text-muted-foreground">
                  resource 跨线程共享用户画像;thread 每线程独立
                </p>
              </div>
              <ScopeSelect
                onChange={(v) => setDraft({ ...draft, workingMemoryScope: v })}
                resourceLabel="resource(跨线程)"
                threadLabel="thread(线程内)"
                value={draft.workingMemoryScope}
              />
            </div>
            <div className="flex items-center justify-between gap-4 py-4">
              <div className="min-w-0 space-y-1">
                <p className="text-sm leading-none font-medium">记忆形态(format)</p>
                <p className="text-xs text-muted-foreground">
                  template 每次整体重写(replace);schema 按 JSON 字段合并更新(merge)
                </p>
              </div>
              <Select
                onValueChange={(v) =>
                  v !== null &&
                  setDraft({ ...draft, workingMemoryFormat: v as "template" | "schema" })
                }
                value={draft.workingMemoryFormat}
              >
                <SelectTrigger className="w-40 shrink-0">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="template">template(Markdown)</SelectItem>
                  <SelectItem value="schema">schema(JSON Schema)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {draft.workingMemoryFormat === "template" ? (
              <div className="space-y-2 py-2">
                <div className="space-y-1">
                  <p className="text-sm leading-none font-medium">记忆模板(template)</p>
                  <p className="text-xs text-muted-foreground">
                    Markdown 模板,定义工作记忆的结构(Agent 按此结构填写)
                  </p>
                </div>
                <Textarea
                  className="min-h-32 font-mono text-xs"
                  onChange={(e) => setDraft({ ...draft, workingMemoryTemplate: e.target.value })}
                  rows={8}
                  value={draft.workingMemoryTemplate}
                />
              </div>
            ) : (
              <div className="space-y-2 py-2">
                <div className="space-y-1">
                  <p className="text-sm leading-none font-medium">记忆结构(schema)</p>
                  <p className="text-xs text-muted-foreground">
                    Standard JSON Schema,定义工作记忆的字段(Agent 按字段合并更新)
                  </p>
                </div>
                <Textarea
                  className={`min-h-32 font-mono text-xs ${
                    workingMemorySchemaValid
                      ? ""
                      : "border-destructive focus-visible:ring-destructive"
                  }`}
                  onChange={(e) => setDraft({ ...draft, workingMemorySchema: e.target.value })}
                  rows={12}
                  value={draft.workingMemorySchema}
                />
                {workingMemorySchemaValid ? null : (
                  <p className="text-xs text-destructive">
                    JSON 无效:保存后将回落 template 形态,请修正为合法的 JSON Schema 对象
                  </p>
                )}
              </div>
            )}
          </>
        ) : null}
      </SettingCard>

      <SettingCard
        title="线程标题(generateTitle)"
        description="由模型根据首轮对话自动为新线程命名(message-history.mdx)。"
      >
        <SettingRow title="自动生成线程标题" description="新建线程首轮对话后自动命名">
          <Switch
            checked={draft.generateTitle}
            onCheckedChange={(v) => setDraft({ ...draft, generateTitle: v })}
          />
        </SettingRow>
        {draft.generateTitle ? (
          <>
            <div className="space-y-2 py-2">
              <div className="space-y-1">
                <p className="text-sm leading-none font-medium">标题生成模型</p>
                <p className="text-xs text-muted-foreground">
                  默认跟随当前模型;显式选择时密钥取自服务端环境变量
                </p>
              </div>
              <ModelSelectDropdown
                allowFollow
                onChange={(v) => setDraft({ ...draft, generateTitleModel: v })}
                providers={providers}
                value={draft.generateTitleModel}
              />
            </div>
            <div className="space-y-2 py-2">
              <div className="space-y-1">
                <p className="text-sm leading-none font-medium">附加指令(instructions)</p>
                <p className="text-xs text-muted-foreground">自定义标题风格,留空使用默认</p>
              </div>
              <Input
                onChange={(e) => setDraft({ ...draft, generateTitleInstructions: e.target.value })}
                placeholder="例如:生成不超过 6 个字的中文标题"
                value={draft.generateTitleInstructions}
              />
            </div>
          </>
        ) : null}
      </SettingCard>

      <SettingCard
        title="观察记忆(observationalMemory)"
        description="长对话中自动观察/反思提取要点,超阈值后压缩上下文(observational-memory.mdx)。"
      >
        <SettingRow
          description="由 Observer/Reflector 代理后台提取用户偏好与事实"
          title="启用观察记忆"
        >
          <Switch
            checked={draft.observationalMemory}
            onCheckedChange={(v) => setDraft({ ...draft, observationalMemory: v })}
          />
        </SettingRow>
        {draft.observationalMemory ? (
          <>
            <div className="space-y-2 py-2">
              <div className="space-y-1">
                <p className="text-sm leading-none font-medium">共用模型(model)</p>
                <p className="text-xs text-muted-foreground">
                  Observer/Reflector 共用;下方任一专属模型设置后此项被忽略
                </p>
              </div>
              <ModelSelectDropdown
                allowFollow
                onChange={(v) => setDraft({ ...draft, omModel: v })}
                providers={providers}
                value={draft.omModel}
              />
            </div>
            <div className="space-y-2 py-2">
              <div className="space-y-1">
                <p className="text-sm leading-none font-medium">
                  Observer 专属模型(observation.model)
                </p>
                <p className="text-xs text-muted-foreground">
                  负责从对话中提取观察;设置后与 Reflector 各自独立
                </p>
              </div>
              <ModelSelectDropdown
                allowFollow
                onChange={(v) => setDraft({ ...draft, omObserverModel: v })}
                providers={providers}
                value={draft.omObserverModel}
              />
            </div>
            <div className="space-y-2 py-2">
              <div className="space-y-1">
                <p className="text-sm leading-none font-medium">
                  Reflector 专属模型(reflection.model)
                </p>
                <p className="text-xs text-muted-foreground">负责总结归纳既有观察</p>
              </div>
              <ModelSelectDropdown
                allowFollow
                onChange={(v) => setDraft({ ...draft, omReflectionModel: v })}
                providers={providers}
                value={draft.omReflectionModel}
              />
            </div>
            <div className="flex items-center justify-between gap-4 py-4">
              <div className="min-w-0 space-y-1">
                <p className="text-sm leading-none font-medium">观察范围(scope)</p>
                <p className="text-xs text-muted-foreground">
                  thread 每线程独立观察;resource 跨线程共享(实验性)
                </p>
              </div>
              <ScopeSelect
                onChange={(v) => setDraft({ ...draft, omScope: v })}
                resourceLabel="resource(跨线程)"
                threadLabel="thread(线程内)"
                value={draft.omScope}
              />
            </div>
            <div className="flex items-center justify-between gap-4 py-4">
              <div className="min-w-0 space-y-1">
                <p className="text-sm leading-none font-medium">观察触发阈值(messageTokens)</p>
                <p className="text-xs text-muted-foreground">
                  按模型上下文窗口自动计算(25%),窗口越大阈值越高,无需手动配置
                </p>
              </div>
              <span className="shrink-0 text-sm font-medium tabular-nums">
                {derivedMessageTokens > 0
                  ? formatModelContextWindow(derivedMessageTokens)
                  : "库默认"}
              </span>
            </div>
            <SettingRow
              description="对话间隔 ≥10 分钟时插入时间标记,帮助模型感知时间跨度"
              title="时间标记(temporalMarkers)"
            >
              <Switch
                checked={draft.omTemporalMarkers}
                onCheckedChange={(v) => setDraft({ ...draft, omTemporalMarkers: v })}
              />
            </SettingRow>
            <SettingRow
              description="为 Agent 注册 recall 工具,可回查观察背后的原始消息"
              title="原始消息回查(retrieval)"
            >
              <Switch
                checked={draft.omRetrieval}
                onCheckedChange={(v) => setDraft({ ...draft, omRetrieval: v })}
              />
            </SettingRow>
            {draft.omRetrieval ? (
              <>
                <SettingRow
                  description="recall 工具同时启用语义检索(复用记忆的向量库与 embedder)"
                  title="语义回查(retrieval.vector)"
                >
                  <Switch
                    checked={draft.omRetrievalVector}
                    onCheckedChange={(v) => setDraft({ ...draft, omRetrievalVector: v })}
                  />
                </SettingRow>
                <div className="flex items-center justify-between gap-4 py-4">
                  <div className="min-w-0 space-y-1">
                    <p className="text-sm leading-none font-medium">回查范围(retrieval.scope)</p>
                    <p className="text-xs text-muted-foreground">
                      recall 工具检索原始消息的范围,官方默认 resource
                    </p>
                  </div>
                  <ScopeSelect
                    onChange={(v) => setDraft({ ...draft, omRetrievalScope: v })}
                    resourceLabel="resource(跨线程)"
                    threadLabel="thread(线程内)"
                    value={draft.omRetrievalScope}
                  />
                </div>
              </>
            ) : null}
          </>
        ) : null}
      </SettingCard>

      {draft.observationalMemory ? (
        <SettingCard
          title="观察记忆高级(observation / reflection)"
          description="Observer/Reflector 的深层子项:指令、标题、附件、批量与缓冲参数(observational-memory.mdx)。"
        >
          <SettingRow
            description="Observer 顺手维护线程标题,替代独立的 generateTitle 调用(官方默认关)"
            title="维护线程标题(observation.threadTitle)"
          >
            <Switch
              checked={draft.omThreadTitle}
              onCheckedChange={(v) => setDraft({ ...draft, omThreadTitle: v })}
            />
          </SettingRow>
          <SettingRow
            description="让 Observer 从观察中抽取内容更新工作记忆(需启用工作记忆)"
            title="管理工作记忆(observation.manageWorkingMemory)"
          >
            <Switch
              checked={draft.omManageWorkingMemory}
              onCheckedChange={(v) => setDraft({ ...draft, omManageWorkingMemory: v })}
            />
          </SettingRow>
          <div className="flex items-center justify-between gap-4 py-4">
            <div className="min-w-0 space-y-1">
              <p className="text-sm leading-none font-medium">
                附件观察(observation.observeAttachments)
              </p>
              <p className="text-xs text-muted-foreground">
                附件是否转发给 Observer:auto 按模型多模态能力自动决定
              </p>
            </div>
            <Select
              onValueChange={(v) =>
                v !== null &&
                setDraft({ ...draft, omObserveAttachments: v as "auto" | "on" | "off" })
              }
              value={draft.omObserveAttachments}
            >
              <SelectTrigger className="w-32 shrink-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">auto(自动)</SelectItem>
                <SelectItem value="on">on(开启)</SelectItem>
                <SelectItem value="off">off(关闭)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2 py-2">
            <div className="space-y-1">
              <p className="text-sm leading-none font-medium">
                Observer 指令(observation.instruction)
              </p>
              <p className="text-xs text-muted-foreground">
                追加到 Observer 系统提示的自定义指令,留空使用默认
              </p>
            </div>
            <Textarea
              className="min-h-20 text-xs"
              onChange={(e) => setDraft({ ...draft, omObserverInstruction: e.target.value })}
              placeholder="例如:重点观察用户的技术栈偏好与项目背景"
              rows={3}
              value={draft.omObserverInstruction}
            />
          </div>
          <div className="space-y-2 py-2">
            <div className="space-y-1">
              <p className="text-sm leading-none font-medium">
                Reflector 指令(reflection.instruction)
              </p>
              <p className="text-xs text-muted-foreground">
                追加到 Reflector 系统提示的自定义指令,留空使用默认
              </p>
            </div>
            <Textarea
              className="min-h-20 text-xs"
              onChange={(e) => setDraft({ ...draft, omReflectionInstruction: e.target.value })}
              placeholder="例如:归纳时保留可量化的偏好,丢弃一次性闲聊"
              rows={3}
              value={draft.omReflectionInstruction}
            />
          </div>
          <SliderRow
            description="Observer 温度,越低越稳定(库默认 0.3)"
            max={1}
            min={0}
            step={0.1}
            title="Observer 温度(modelSettings.temperature)"
            value={draft.omTemperature}
            onChange={(v) => setDraft({ ...draft, omTemperature: Math.round(v * 10) / 10 })}
          />
          <SettingRow
            description="resource 侧多线程批量观察的批大小,0 = 库默认 10000"
            title="批量观察上限(observation.maxTokensPerBatch)"
          >
            <Input
              className="w-32"
              min={0}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  omMaxTokensPerBatch: Math.max(0, Number(e.target.value) || 0),
                })
              }
              step={1000}
              type="number"
              value={draft.omMaxTokensPerBatch}
            />
          </SettingRow>
          <SettingRow
            description="Observer 单次输出 token 上限,0 = 库默认"
            title="Observer 输出上限(modelSettings.maxOutputTokens)"
          >
            <Input
              className="w-32"
              min={0}
              onChange={(e) =>
                setDraft({ ...draft, omMaxOutputTokens: Math.max(0, Number(e.target.value) || 0) })
              }
              step={1000}
              type="number"
              value={draft.omMaxOutputTokens}
            />
          </SettingRow>
          <SettingRow
            description="关闭后禁用全部异步缓冲,观察同步完成(官方默认开启)"
            title="异步缓冲(observation.bufferTokens)"
          >
            <Switch
              checked={draft.omBufferEnabled}
              onCheckedChange={(v) => setDraft({ ...draft, omBufferEnabled: v })}
            />
          </SettingRow>
          {draft.omBufferEnabled ? (
            <SettingRow
              description="<1 为 messageTokens 的比例(默认 0.2);≥1 为绝对 token 数"
              title="缓冲阈值(bufferTokens 数值)"
            >
              <Input
                className="w-32"
                min={0}
                onChange={(e) =>
                  setDraft({ ...draft, omBufferTokens: Math.max(0, Number(e.target.value) || 0) })
                }
                step={0.05}
                type="number"
                value={draft.omBufferTokens}
              />
            </SettingRow>
          ) : null}
          <SettingRow
            description="累积观察达到该 token 数后触发反思,0 = 库默认 40000"
            title="反思触发阈值(reflection.observationTokens)"
          >
            <Input
              className="w-32"
              min={0}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  omObservationTokens: Math.max(0, Number(e.target.value) || 0),
                })
              }
              step={1000}
              type="number"
              value={draft.omObservationTokens}
            />
          </SettingRow>
          <div className="space-y-3 border-t pt-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 space-y-1">
                <p className="text-sm leading-none font-medium">自定义抽取器(Extractors)</p>
                <p className="text-xs text-muted-foreground">
                  在 Observer 或 Reflector 阶段提取稳定事实。这里只开放声明式指令，不执行任意代码。
                </p>
              </div>
              <Button
                size="sm"
                variant="outline"
                className="shrink-0"
                onClick={() =>
                  setDraft({
                    ...draft,
                    omExtractors: [
                      ...draft.omExtractors,
                      {
                        id: `om-${Date.now()}`,
                        name: "New extractor",
                        instructions:
                          "Describe the durable facts to extract and when to update them.",
                        stage: "observation",
                        enabled: true,
                        includePreviousExtraction: false,
                        metadataKeyPath: "",
                      },
                    ],
                  })
                }
              >
                <PlusIcon />
                添加抽取器
              </Button>
            </div>
            <div className="space-y-3">
              {draft.omExtractors.map((extractor, index) => (
                <div key={extractor.id} className="space-y-2 rounded-lg border p-3">
                  <div className="flex items-center gap-2">
                    <Input
                      className="min-w-0 flex-1"
                      value={extractor.name}
                      placeholder="名称"
                      onChange={(event) => {
                        const omExtractors = draft.omExtractors.map((item, itemIndex) =>
                          itemIndex === index ? { ...item, name: event.target.value } : item,
                        );
                        setDraft({ ...draft, omExtractors });
                      }}
                    />
                    <Select
                      value={extractor.stage}
                      onValueChange={(value) => {
                        if (value !== "observation" && value !== "reflection") return;
                        setDraft({
                          ...draft,
                          omExtractors: draft.omExtractors.map((item, itemIndex) =>
                            itemIndex === index ? { ...item, stage: value } : item,
                          ),
                        });
                      }}
                    >
                      <SelectTrigger className="w-36 shrink-0">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="observation">Observer</SelectItem>
                        <SelectItem value="reflection">Reflector</SelectItem>
                      </SelectContent>
                    </Select>
                    <Switch
                      checked={extractor.enabled}
                      aria-label="启用抽取器"
                      onCheckedChange={(enabled) =>
                        setDraft({
                          ...draft,
                          omExtractors: draft.omExtractors.map((item, itemIndex) =>
                            itemIndex === index ? { ...item, enabled } : item,
                          ),
                        })
                      }
                    />
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label="删除抽取器"
                      onClick={() =>
                        setDraft({
                          ...draft,
                          omExtractors: draft.omExtractors.filter(
                            (_, itemIndex) => itemIndex !== index,
                          ),
                        })
                      }
                    >
                      <Trash2Icon />
                    </Button>
                  </div>
                  <Textarea
                    className="min-h-20 text-xs"
                    rows={3}
                    value={extractor.instructions}
                    placeholder="说明需要抽取的稳定事实"
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        omExtractors: draft.omExtractors.map((item, itemIndex) =>
                          itemIndex === index
                            ? { ...item, instructions: event.target.value }
                            : item,
                        ),
                      })
                    }
                  />
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <SettingRow
                      title="带入上次结果(includePreviousExtraction)"
                      description="允许抽取器根据已有 metadata 做增量更新"
                    >
                      <Switch
                        checked={extractor.includePreviousExtraction === true}
                        onCheckedChange={(includePreviousExtraction) =>
                          setDraft({
                            ...draft,
                            omExtractors: draft.omExtractors.map((item, itemIndex) =>
                              itemIndex === index ? { ...item, includePreviousExtraction } : item,
                            ),
                          })
                        }
                      />
                    </SettingRow>
                    <div className="space-y-1">
                      <p className="text-sm font-medium">metadataKeyPath</p>
                      <Input
                        value={extractor.metadataKeyPath ?? ""}
                        placeholder="默认 extracted.&lt;slug&gt;"
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            omExtractors: draft.omExtractors.map((item, itemIndex) =>
                              itemIndex === index
                                ? { ...item, metadataKeyPath: event.target.value }
                                : item,
                            ),
                          })
                        }
                      />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </SettingCard>
      ) : null}
      {activeThreadId && threadOmLoaded ? (
        <SettingCard
          title="当前线程覆盖(updateObservationalMemoryConfig)"
          description="只影响当前线程后续的观察/反思阈值，不改变全局记忆设置。"
        >
          <SettingRow title="观察触发阈值(messageTokens)" description="0 表示跟随全局配置">
            <Input
              className="w-32"
              min={0}
              type="number"
              value={threadOmDraft.messageTokens}
              onChange={(event) =>
                setThreadOmDraft({
                  ...threadOmDraft,
                  messageTokens: Math.max(0, Number(event.target.value) || 0),
                })
              }
            />
          </SettingRow>
          <SettingRow title="批量观察上限(maxTokensPerBatch)" description="0 表示跟随全局配置">
            <Input
              className="w-32"
              min={0}
              type="number"
              value={threadOmDraft.maxTokensPerBatch}
              onChange={(event) =>
                setThreadOmDraft({
                  ...threadOmDraft,
                  maxTokensPerBatch: Math.max(0, Number(event.target.value) || 0),
                })
              }
            />
          </SettingRow>
          <SettingRow title="反思触发阈值(observationTokens)" description="0 表示跟随全局配置">
            <Input
              className="w-32"
              min={0}
              type="number"
              value={threadOmDraft.observationTokens}
              onChange={(event) =>
                setThreadOmDraft({
                  ...threadOmDraft,
                  observationTokens: Math.max(0, Number(event.target.value) || 0),
                })
              }
            />
          </SettingRow>
          <SettingRow title="缓冲阈值(bufferTokens)" description="0 表示跟随全局配置">
            <Input
              className="w-32"
              min={0}
              type="number"
              step={0.05}
              value={threadOmDraft.bufferTokens}
              onChange={(event) =>
                setThreadOmDraft({
                  ...threadOmDraft,
                  bufferTokens: Math.max(0, Number(event.target.value) || 0),
                })
              }
            />
          </SettingRow>
          <Button className="w-full" onClick={() => void saveThreadOmConfig()}>
            保存当前线程覆盖
          </Button>
        </SettingCard>
      ) : null}
    </>
  );
}
