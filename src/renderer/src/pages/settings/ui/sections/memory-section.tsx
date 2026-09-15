import * as React from "react";
import { toast } from "sonner";
import { Field, FieldContent, FieldDescription, FieldError, FieldTitle } from "@/shared/ui/field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/shared/ui/select";
import { Switch } from "@/shared/ui/switch";
import { Textarea } from "@/shared/ui/textarea";
import { fetchMemoryConfig, saveMemoryConfig } from "../../api/settings-api";
import {
  NumberRow,
  ScopeSelect,
  SelectRow,
  SettingCard,
  SettingRow,
  SliderRow,
  TextAreaRow,
} from "../controls";

const DEFAULT_OM_MESSAGE_TOKENS = 16_000;

// ---------------------------------------------------------------------------
// 记忆(暴露 Memory 可配置项,写入数据库 app_config 表,保存后实时生效)
// 字段与 src/mastra/memory/index.ts 的 MemoryUserConfig 一一对应。
// ---------------------------------------------------------------------------

/** 纯文本编辑字段:保存时静默,不弹撤回 toast(其余开关/滑块/下拉变化才弹) */
const MEMORY_TEXT_KEYS = new Set([
  "workingMemoryTemplate",
  "workingMemorySchema",
  "omObserverInstruction",
  "omReflectionInstruction",
]);

export interface MemoryDraft {
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
  observationalMemory: boolean;
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
  lastMessages: 20,
  readOnly: false,
  semanticRecall: false,
  semanticRecallTopK: 4,
  semanticRecallMessageRangeBefore: 1,
  semanticRecallMessageRangeAfter: 1,
  semanticRecallScope: "thread",
  workingMemory: true,
  workingMemoryScope: "resource",
  workingMemoryFormat: "template",
  workingMemoryTemplate:
    "# User Profile\n- **Name**:\n- **Location**:\n- **Interests**:\n- **Preferences**:\n- **Long-term Goals**:\n",
  workingMemorySchema:
    '{\n  "type": "object",\n  "properties": {\n    "name": { "type": "string" },\n    "location": { "type": "string" },\n    "timezone": { "type": "string" },\n    "preferences": {\n      "type": "object",\n      "properties": {\n        "communicationStyle": { "type": "string" },\n        "projectGoal": { "type": "string" },\n        "deadlines": { "type": "array", "items": { "type": "string" } }\n      }\n    }\n  }\n}\n',
  generateTitle: true,
  observationalMemory: true,
  omScope: "thread",
  omTemporalMarkers: true,
  omObserverInstruction: "",
  omReflectionInstruction: "",
  omThreadTitle: false,
  omManageWorkingMemory: false,
  omObserveAttachments: "auto",
  omMessageTokens: DEFAULT_OM_MESSAGE_TOKENS,
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
  const [draft, setDraft] = React.useState<MemoryDraft>(DEFAULT_MEMORY_DRAFT);
  const [extractorText, setExtractorText] = React.useState(() =>
    JSON.stringify(DEFAULT_MEMORY_DRAFT.omExtractors, null, 2),
  );
  const [loaded, setLoaded] = React.useState(false);

  const showAdvancedMemorySettings = true;

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
    fetchMemoryConfig<Partial<MemoryDraft>>()
      .then((config) => {
        const merged = { ...DEFAULT_MEMORY_DRAFT, ...config } as MemoryDraft;
        setDraft(merged);
        setExtractorText(JSON.stringify(merged.omExtractors, null, 2));
      })
      .catch(() => undefined)
      .finally(() => setLoaded(true));
  }, [loaded]);

  // 上次已保存的草稿快照:识别非文本字段变化并供撤回
  const prevSavedRef = React.useRef<MemoryDraft | null>(null);

  // 自动保存:800ms 防抖写入;非文本字段变化成功后弹 toast 供撤回,
  // 文本编辑(模板/Schema/指令)静默。messageTokens 按模型窗口自动重算,未知时回退 16K。
  React.useEffect(() => {
    if (!loaded) return;
    const timer = window.setTimeout(() => {
      void saveMemoryConfig({
        ...draft,
        omMessageTokens: draft.omMessageTokens,
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
  }, [draft, loaded]);

  return (
    <>
      <SettingCard
        title="消息历史"
        description={
          draft.observationalMemory
            ? "启用 OM 后由 Observational Memory 管理未观察消息窗口;此项只在关闭 OM 时生效。"
            : "每次请求注入上下文的最近消息条数与只读模式(message-history.mdx)。"
        }
      >
        {draft.observationalMemory ? (
          <SettingRow title="最近消息数" description="OM 会根据当前模型窗口自动管理上下文边界">
            <span className="shrink-0 text-sm font-medium text-muted-foreground">由 OM 管理</span>
          </SettingRow>
        ) : (
          <SliderRow
            description="每次请求注入的最近消息条数"
            max={200}
            min={1}
            step={1}
            title="最近消息数"
            value={draft.lastMessages}
            onChange={(v) => setDraft({ ...draft, lastMessages: v })}
          />
        )}
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

      <SettingCard title="语义召回" description="按语义相似度找回相关历史消息。">
        <p className="py-3 text-xs text-muted-foreground">
          使用本机 FastEmbed Small(384 维),无需 API Key。向量索引不随模型配置变化,也不需要手动重建。
        </p>
        <SettingRow title="启用语义召回" description="对话内容将写入向量库用于相似检索">
          <Switch
            checked={draft.semanticRecall}
            onCheckedChange={(v) => setDraft({ ...draft, semanticRecall: v })}
          />
        </SettingRow>
        {draft.semanticRecall && !showAdvancedMemorySettings ? (
          <p className="py-3 text-xs text-muted-foreground">
            已启用内置的保守召回策略；详细阈值由系统管理，以避免与观察记忆重复扩大上下文。
          </p>
        ) : null}
        {draft.semanticRecall && showAdvancedMemorySettings ? (
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
            <SettingRow
              title="检索范围(scope)"
              description="thread 仅当前线程;resource 跨全部线程检索"
            >
              <ScopeSelect
                onChange={(v) => setDraft({ ...draft, semanticRecallScope: v })}
                resourceLabel="resource(跨线程)"
                threadLabel="thread(线程内)"
                value={draft.semanticRecallScope}
              />
            </SettingRow>
          </>
        ) : null}
      </SettingCard>

      <SettingCard title="工作记忆" description="跨轮维护一份小型、稳定的用户与项目状态。">
        <SettingRow title="启用工作记忆" description="在系统上下文中维护一份可更新的画像">
          <Switch
            checked={draft.workingMemory}
            onCheckedChange={(v) => setDraft({ ...draft, workingMemory: v })}
          />
        </SettingRow>
        {draft.workingMemory && !showAdvancedMemorySettings ? (
          <p className="py-3 text-xs text-muted-foreground">
            使用内置的小型用户画像模板；结构和写入策略由系统管理。
          </p>
        ) : null}
        {draft.workingMemory && showAdvancedMemorySettings ? (
          <>
            <SettingRow
              title="记忆范围(scope)"
              description="resource 跨线程共享用户画像;thread 每线程独立"
            >
              <ScopeSelect
                onChange={(v) => setDraft({ ...draft, workingMemoryScope: v })}
                resourceLabel="resource(跨线程)"
                threadLabel="thread(线程内)"
                value={draft.workingMemoryScope}
              />
            </SettingRow>
            <SettingRow
              title="记忆形态(format)"
              description="template 每次整体重写(replace);schema 按 JSON 字段合并更新(merge)"
            >
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
            </SettingRow>
            {draft.workingMemoryFormat === "template" ? (
              <Field className="space-y-2 py-2">
                <FieldContent className="space-y-1">
                  <FieldTitle className="text-sm leading-none font-medium">
                    记忆模板(template)
                  </FieldTitle>
                  <FieldDescription className="text-xs text-muted-foreground">
                    Markdown 模板,定义工作记忆的结构(Agent 按此结构填写)
                  </FieldDescription>
                </FieldContent>
                <Textarea
                  className="min-h-32 font-mono text-xs"
                  onChange={(e) => setDraft({ ...draft, workingMemoryTemplate: e.target.value })}
                  rows={8}
                  value={draft.workingMemoryTemplate}
                />
              </Field>
            ) : (
              <Field className="space-y-2 py-2">
                <FieldContent className="space-y-1">
                  <FieldTitle className="text-sm leading-none font-medium">
                    记忆结构(schema)
                  </FieldTitle>
                  <FieldDescription className="text-xs text-muted-foreground">
                    Standard JSON Schema,定义工作记忆的字段(Agent 按字段合并更新)
                  </FieldDescription>
                </FieldContent>
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
                {!workingMemorySchemaValid ? (
                  <FieldError className="text-xs">
                    JSON 无效:保存后将回落 template 形态,请修正为合法的 JSON Schema 对象
                  </FieldError>
                ) : null}
              </Field>
            )}
          </>
        ) : null}
      </SettingCard>

      <SettingCard title="线程标题" description="由模型根据首轮对话自动为新线程命名。">
        <SettingRow title="自动生成线程标题" description="新建线程首轮对话后自动命名">
          <Switch
            checked={draft.generateTitle}
            onCheckedChange={(v) => setDraft({ ...draft, generateTitle: v })}
          />
        </SettingRow>
      </SettingCard>

      <SettingCard
        title="观察记忆"
        description="长对话中自动提取稳定事实，并在需要时压缩旧上下文。"
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
            <SettingRow
              description="Observer 与 Reflector 自动使用当前 promptInput 选择或请求的模型"
              title="记忆模型"
            >
              <span className="shrink-0 text-sm font-medium text-muted-foreground">
                跟随当前模型
              </span>
            </SettingRow>
            <NumberRow
              description="Observer 触发观察前保留的消息 token 数"
              max={250_000}
              min={0}
              onChange={(v) => setDraft({ ...draft, omMessageTokens: v })}
              suffix="token"
              title="消息阈值(messageTokens)"
              value={draft.omMessageTokens}
            />
            <SettingRow
              description="对话间隔 ≥10 分钟时插入时间标记,帮助模型感知时间跨度"
              title="时间标记(temporalMarkers)"
            >
              <Switch
                checked={draft.omTemporalMarkers}
                onCheckedChange={(v) => setDraft({ ...draft, omTemporalMarkers: v })}
              />
            </SettingRow>
            {showAdvancedMemorySettings ? (
              <>
                <SettingRow
                  description="Observer 与 Reflector 共享 thread 或跨线程资源记忆"
                  title="观察范围(scope)"
                >
                  <ScopeSelect
                    onChange={(v) => setDraft({ ...draft, omScope: v })}
                    resourceLabel="resource(跨线程)"
                    threadLabel="thread(当前线程)"
                    value={draft.omScope}
                  />
                </SettingRow>
                <SettingRow
                  description="Observer 顺手维护线程标题"
                  title="Observer 维护线程标题(threadTitle)"
                >
                  <Switch
                    checked={draft.omThreadTitle}
                    onCheckedChange={(v) => setDraft({ ...draft, omThreadTitle: v })}
                  />
                </SettingRow>
                <SettingRow
                  description="允许 Observer 直接管理工作记忆"
                  title="Observer 管理工作记忆(manageWorkingMemory)"
                >
                  <Switch
                    checked={draft.omManageWorkingMemory}
                    onCheckedChange={(v) => setDraft({ ...draft, omManageWorkingMemory: v })}
                  />
                </SettingRow>
                <SelectRow
                  description="按模型多模态能力自动决定是否观察附件"
                  onChange={(omObserveAttachments) => setDraft({ ...draft, omObserveAttachments })}
                  options={[
                    { value: "auto" as const, label: "auto(跟随模型)" },
                    { value: "on" as const, label: "on(启用)" },
                    { value: "off" as const, label: "off(关闭)" },
                  ]}
                  title="观察附件(observeAttachments)"
                  value={draft.omObserveAttachments}
                />
                <NumberRow
                  description="resource 范围批量观察的最大 token 数;0 使用默认"
                  max={2_000_000}
                  min={0}
                  onChange={(v) => setDraft({ ...draft, omMaxTokensPerBatch: v })}
                  suffix="token"
                  title="批量上限(maxTokensPerBatch)"
                  value={draft.omMaxTokensPerBatch}
                />
                <NumberRow
                  description="Observer 模型温度"
                  max={2}
                  min={0}
                  onChange={(v) => setDraft({ ...draft, omTemperature: v })}
                  title="Observer 温度(temperature)"
                  value={draft.omTemperature}
                />
                <NumberRow
                  description="Observer 单次输出上限;0 使用默认"
                  max={500_000}
                  min={0}
                  onChange={(v) => setDraft({ ...draft, omMaxOutputTokens: v })}
                  suffix="token"
                  title="Observer 输出(maxOutputTokens)"
                  value={draft.omMaxOutputTokens}
                />
                <NumberRow
                  description="异步观察缓冲频率;小于 1 表示 messageTokens 比例"
                  max={500_000}
                  min={0}
                  onChange={(v) => setDraft({ ...draft, omBufferTokens: v })}
                  title="缓冲频率(bufferTokens)"
                  value={draft.omBufferTokens}
                />
                <SettingRow description="关闭后不使用异步缓冲" title="启用异步缓冲(bufferEnabled)">
                  <Switch
                    checked={draft.omBufferEnabled}
                    onCheckedChange={(v) => setDraft({ ...draft, omBufferEnabled: v })}
                  />
                </SettingRow>
                <NumberRow
                  description="Reflector 触发反思的观察 token 数;0 使用默认"
                  max={2_000_000}
                  min={0}
                  onChange={(v) => setDraft({ ...draft, omObservationTokens: v })}
                  suffix="token"
                  title="反思阈值(observationTokens)"
                  value={draft.omObservationTokens}
                />
                <TextAreaRow
                  description="追加到 Observer 系统提示的指令"
                  onChange={(omObserverInstruction) =>
                    setDraft({ ...draft, omObserverInstruction })
                  }
                  rows={3}
                  title="Observer 指令(instruction)"
                  value={draft.omObserverInstruction}
                />
                <TextAreaRow
                  description="追加到 Reflector 系统提示的指令"
                  onChange={(omReflectionInstruction) =>
                    setDraft({ ...draft, omReflectionInstruction })
                  }
                  rows={3}
                  title="Reflector 指令(instruction)"
                  value={draft.omReflectionInstruction}
                />
                <Field className="space-y-2 py-3">
                  <FieldContent className="space-y-1">
                    <FieldTitle className="text-sm leading-none font-medium">
                      自定义抽取器(extract)
                    </FieldTitle>
                    <FieldDescription className="text-xs text-muted-foreground">
                      每个抽取器使用 name、instructions、stage、enabled 字段;保存为 JSON 数组
                    </FieldDescription>
                  </FieldContent>
                  <Textarea
                    className="min-h-32 font-mono text-xs"
                    onChange={(e) => {
                      setExtractorText(e.target.value);
                      try {
                        const value = JSON.parse(e.target.value) as unknown;
                        if (Array.isArray(value))
                          setDraft({ ...draft, omExtractors: value as OmExtractorDraft[] });
                      } catch {
                        // Keep the last valid draft while the user is typing.
                      }
                    }}
                    rows={8}
                    spellCheck={false}
                    value={extractorText}
                  />
                </Field>
                <SettingRow
                  description="为 Agent 注册 recall 工具,可回查观察背后的原始消息"
                  title="原始消息回查"
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
                      title="语义回查"
                    >
                      <Switch
                        checked={draft.omRetrievalVector}
                        onCheckedChange={(v) => setDraft({ ...draft, omRetrievalVector: v })}
                      />
                    </SettingRow>
                    <SettingRow
                      title="回查范围"
                      description="recall 工具检索原始消息的范围,默认跨线程"
                    >
                      <ScopeSelect
                        onChange={(v) => setDraft({ ...draft, omRetrievalScope: v })}
                        resourceLabel="跨线程"
                        threadLabel="当前线程"
                        value={draft.omRetrievalScope}
                      />
                    </SettingRow>
                  </>
                ) : null}
              </>
            ) : null}
          </>
        ) : null}
      </SettingCard>
    </>
  );
}
