import { PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { nanoid } from "nanoid";
import * as React from "react";
import { toast } from "sonner";
import { useTranslation } from "@/shared/i18n";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "@/shared/ui/drawer";
import { Field, FieldContent, FieldDescription, FieldError, FieldTitle } from "@/shared/ui/field";
import { Input } from "@/shared/ui/input";
import { ScrollArea } from "@/shared/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/shared/ui/select";
import { Switch } from "@/shared/ui/switch";
import { Textarea } from "@/shared/ui/textarea";
import { fetchMemoryConfig, saveMemoryConfig } from "../../api/settings-api";
import {
  AdvancedSection,
  ConfirmDialog,
  NumberRow,
  ScopeSelect,
  SelectRow,
  SettingCard,
  SettingRow,
  SliderRow,
  TextAreaRow,
} from "../controls";

const DEFAULT_OM_MESSAGE_TOKENS = 16_000;
const PROFILE_TEMPLATE =
  "# User Profile\n- **Name**:\n- **Location**:\n- **Interests**:\n- **Preferences**:\n- **Long-term Goals**:\n";
const PROJECT_TEMPLATE =
  "# Project Context\n- **Goal**:\n- **Constraints**:\n- **Decisions**:\n- **Current Focus**:\n- **Next Steps**:\n";

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
  semanticRecallThreshold: number;
  semanticRecallIndexName: string;
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
  semanticRecallThreshold: 0,
  semanticRecallIndexName: "",
  workingMemory: true,
  workingMemoryScope: "resource",
  workingMemoryFormat: "template",
  workingMemoryTemplate: PROFILE_TEMPLATE,
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

function TemplateEditor({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const { t } = useTranslation();
  const profileTemplate = `# ${t("settings:memory.templateHeadingProfile")}\n- **${t("settings:memory.templateFields.name")}**:\n- **${t("settings:memory.templateFields.location")}**:\n- **${t("settings:memory.templateFields.interests")}**:\n- **${t("settings:memory.templateFields.preferences")}**:\n- **${t("settings:memory.templateFields.goals")}**:\n`;
  const projectTemplate = `# ${t("settings:memory.templateHeadingProject")}\n- **${t("settings:memory.templateFields.projectGoal")}**:\n- **${t("settings:memory.templateFields.constraints")}**:\n- **${t("settings:memory.templateFields.decisions")}**:\n- **${t("settings:memory.templateFields.currentFocus")}**:\n- **${t("settings:memory.templateFields.nextSteps")}**:\n`;
  const displayedValue =
    value === PROFILE_TEMPLATE
      ? profileTemplate
      : value === PROJECT_TEMPLATE
        ? projectTemplate
        : value;
  const preset =
    value === PROFILE_TEMPLATE || value === profileTemplate
      ? "profile"
      : value === PROJECT_TEMPLATE || value === projectTemplate
        ? "project"
        : "custom";
  const fields = ["name", "preferences", "goals", "constraints"] as const;

  return (
    <Field className="min-w-0 py-3">
      <FieldContent>
        <FieldTitle>{t("settings:memory.templateTitle")}</FieldTitle>
        <FieldDescription className="text-xs">{t("settings:memory.templateDesc")}</FieldDescription>
      </FieldContent>
      <Select
        value={preset}
        onValueChange={(next) => {
          if (next === "profile") onChange(profileTemplate);
          if (next === "project") onChange(projectTemplate);
        }}
      >
        <SelectTrigger className="w-full sm:w-64">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="profile">{t("settings:memory.templatePresetProfile")}</SelectItem>
          <SelectItem value="project">{t("settings:memory.templatePresetProject")}</SelectItem>
          <SelectItem value="custom">{t("settings:memory.templatePresetCustom")}</SelectItem>
        </SelectContent>
      </Select>
      <div className="flex min-w-0 flex-wrap gap-1.5">
        {fields.map((field) => (
          <Button
            key={field}
            type="button"
            size="xs"
            variant="outline"
            onClick={() =>
              onChange(
                `${displayedValue.trimEnd()}\n- **${t(`settings:memory.templateFields.${field}`)}**:\n`,
              )
            }
          >
            <PlusIcon />
            {t(`settings:memory.templateFields.${field}`)}
          </Button>
        ))}
      </div>
      <div className="grid min-w-0 gap-3 lg:grid-cols-2">
        <Textarea
          className="min-h-48 min-w-0 resize-y font-mono text-xs"
          onChange={(event) => onChange(event.target.value)}
          value={displayedValue}
        />
        <div className="min-h-48 min-w-0 overflow-auto rounded-lg border bg-muted/30 p-3">
          <p className="mb-2 text-xs font-medium text-muted-foreground">
            {t("settings:memory.templatePreview")}
          </p>
          <pre className="whitespace-pre-wrap break-words font-sans text-sm">{displayedValue}</pre>
        </div>
      </div>
    </Field>
  );
}

interface SchemaField {
  name: string;
  definition: Record<string, unknown>;
}

function parseSchema(value: string): { root: Record<string, unknown>; fields: SchemaField[] } {
  try {
    const root = JSON.parse(value) as Record<string, unknown>;
    const properties =
      root && typeof root === "object" && !Array.isArray(root) && root.properties
        ? (root.properties as Record<string, unknown>)
        : {};
    return {
      root,
      fields: Object.entries(properties).map(([name, definition]) => ({
        name,
        definition:
          definition && typeof definition === "object" && !Array.isArray(definition)
            ? (definition as Record<string, unknown>)
            : { type: "string" },
      })),
    };
  } catch {
    return { root: {}, fields: [] };
  }
}

function SchemaEditor({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const { t } = useTranslation();
  const { root, fields } = React.useMemo(() => parseSchema(value), [value]);
  const rowIds = React.useMemo(() => fields.map(() => nanoid()), [fields.length]);
  const commit = (nextFields: SchemaField[]) => {
    const properties = Object.fromEntries(
      nextFields
        .filter((field) => field.name.trim())
        .map((field) => [field.name.trim(), field.definition]),
    );
    onChange(JSON.stringify({ ...root, type: "object", properties }, null, 2));
  };

  return (
    <Field className="min-w-0 py-3">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
        <FieldContent className="min-w-0">
          <FieldTitle>{t("settings:memory.schemaTitle")}</FieldTitle>
          <FieldDescription className="text-xs">{t("settings:memory.schemaDesc")}</FieldDescription>
        </FieldContent>
        <Button
          type="button"
          size="xs"
          variant="outline"
          onClick={() => commit([...fields, { name: "", definition: { type: "string" } }])}
        >
          <PlusIcon />
          {t("settings:memory.addSchemaField")}
        </Button>
      </div>
      <div className="space-y-2">
        {fields.length ? (
          fields.map((field, index) => (
            <div
              key={rowIds[index]}
              className="grid min-w-0 gap-2 rounded-lg border bg-muted/20 p-2 sm:grid-cols-[minmax(0,1fr)_10rem_auto]"
            >
              <Input
                aria-label={t("settings:memory.schemaFieldName")}
                placeholder={t("settings:memory.schemaFieldName")}
                value={field.name}
                onChange={(event) =>
                  commit(
                    fields.map((item, itemIndex) =>
                      itemIndex === index ? { ...item, name: event.target.value } : item,
                    ),
                  )
                }
              />
              <Select
                value={String(field.definition.type ?? "string")}
                onValueChange={(type) =>
                  type &&
                  commit(
                    fields.map((item, itemIndex) =>
                      itemIndex === index
                        ? { ...item, definition: { ...item.definition, type } }
                        : item,
                    ),
                  )
                }
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(["string", "number", "boolean", "array", "object"] as const).map((type) => (
                    <SelectItem key={type} value={type}>
                      {t(`settings:memory.schemaTypes.${type}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                aria-label={t("settings:memory.deleteSchemaField")}
                onClick={() => commit(fields.filter((_, itemIndex) => itemIndex !== index))}
              >
                <Trash2Icon />
              </Button>
            </div>
          ))
        ) : (
          <p className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
            {t("settings:memory.noSchemaFields")}
          </p>
        )}
      </div>
    </Field>
  );
}

function ExtractorCardList({
  value,
  onChange,
}: {
  value: OmExtractorDraft[];
  onChange: (value: OmExtractorDraft[]) => void;
}) {
  const { t } = useTranslation();
  const [editingIndex, setEditingIndex] = React.useState<number | null>(null);
  const [editor, setEditor] = React.useState<OmExtractorDraft | null>(null);
  const duplicate = editor
    ? value.some(
        (item, index) =>
          index !== editingIndex &&
          item.stage === editor.stage &&
          item.name.trim().toLowerCase() === editor.name.trim().toLowerCase(),
      )
    : false;
  const valid = Boolean(editor?.name.trim() && editor.instructions.trim() && !duplicate);
  const localizeDefault = (item: OmExtractorDraft): OmExtractorDraft => {
    if (item.id === "om-extractor-default-profile") {
      return {
        ...item,
        name: t("settings:memory.defaultUserProfileName"),
        instructions: t("settings:memory.defaultUserProfileInstructions"),
      };
    }
    if (item.id === "om-extractor-default-project") {
      return {
        ...item,
        name: t("settings:memory.defaultProjectFactsName"),
        instructions: t("settings:memory.defaultProjectFactsInstructions"),
      };
    }
    return item;
  };
  const openEditor = (index: number | null) => {
    setEditingIndex(index);
    setEditor(
      index === null
        ? {
            id: `extractor-${nanoid(8)}`,
            name: "",
            instructions: "",
            stage: "observation",
            enabled: true,
          }
        : localizeDefault(value[index]),
    );
  };
  const closeEditor = () => {
    setEditingIndex(null);
    setEditor(null);
  };
  const saveEditor = () => {
    if (!editor || !valid) return;
    onChange(
      editingIndex === null
        ? [...value, editor]
        : value.map((item, index) => (index === editingIndex ? editor : item)),
    );
    closeEditor();
  };

  return (
    <Field className="min-w-0 py-3">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
        <FieldContent className="min-w-0">
          <FieldTitle>{t("settings:memory.extractorsTitle")}</FieldTitle>
          <FieldDescription className="text-xs">
            {t("settings:memory.extractorsDesc")}
          </FieldDescription>
        </FieldContent>
        <Button type="button" size="xs" variant="outline" onClick={() => openEditor(null)}>
          <PlusIcon />
          {t("settings:memory.addExtractor")}
        </Button>
      </div>
      <div className="grid min-w-0 gap-2 sm:grid-cols-2">
        {value.map((item, index) => {
          const displayItem = localizeDefault(item);
          return (
            <article key={item.id} className="min-w-0 rounded-lg border bg-muted/20 p-3">
              <div className="flex min-w-0 items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                    <p className="break-words text-sm font-medium">{displayItem.name}</p>
                    <Badge variant={item.enabled ? "secondary" : "outline"}>
                      {item.enabled ? t("common:enabled") : t("common:disabled")}
                    </Badge>
                  </div>
                  <p className="mt-1 line-clamp-3 break-words text-xs text-muted-foreground">
                    {displayItem.instructions}
                  </p>
                  <p className="mt-2 text-[11px] text-muted-foreground">
                    {item.stage === "observation"
                      ? t("settings:memory.extractorStageConversation")
                      : t("settings:memory.extractorStageSummary")}
                  </p>
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    aria-label={t("common:edit")}
                    onClick={() => openEditor(index)}
                  >
                    <PencilIcon />
                  </Button>
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    aria-label={t("common:delete")}
                    onClick={() => onChange(value.filter((_, itemIndex) => itemIndex !== index))}
                  >
                    <Trash2Icon />
                  </Button>
                </div>
              </div>
            </article>
          );
        })}
      </div>
      <Drawer
        open={editor !== null}
        onOpenChange={(open) => {
          if (!open) closeEditor();
        }}
        swipeDirection="right"
      >
        <DrawerContent>
          <DrawerHeader>
            <DrawerTitle>
              {editingIndex === null
                ? t("settings:memory.addExtractor")
                : t("settings:memory.editExtractor")}
            </DrawerTitle>
            <DrawerDescription>{t("settings:memory.extractorEditorDesc")}</DrawerDescription>
          </DrawerHeader>
          {editor ? (
            <ScrollArea className="min-h-0 flex-1 px-4">
              <div className="space-y-4 py-4">
                <Field data-invalid={!editor.name.trim() || duplicate}>
                  <FieldTitle>{t("settings:memory.extractorName")}</FieldTitle>
                  <Input
                    value={editor.name}
                    onChange={(event) => setEditor({ ...editor, name: event.target.value })}
                  />
                  {duplicate ? (
                    <FieldError>{t("settings:memory.extractorNameDuplicate")}</FieldError>
                  ) : null}
                </Field>
                <Field data-invalid={!editor.instructions.trim()}>
                  <FieldTitle>{t("settings:memory.extractorInstructions")}</FieldTitle>
                  <FieldDescription className="text-xs">
                    {t("settings:memory.extractorInstructionsDesc")}
                  </FieldDescription>
                  <Textarea
                    className="min-h-36 resize-y"
                    value={editor.instructions}
                    onChange={(event) => setEditor({ ...editor, instructions: event.target.value })}
                  />
                </Field>
                <Field>
                  <FieldTitle>{t("settings:memory.extractorStage")}</FieldTitle>
                  <Select
                    value={editor.stage}
                    onValueChange={(stage) =>
                      stage && setEditor({ ...editor, stage: stage as OmExtractorDraft["stage"] })
                    }
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="observation">
                        {t("settings:memory.extractorStageConversation")}
                      </SelectItem>
                      <SelectItem value="reflection">
                        {t("settings:memory.extractorStageSummary")}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                <SettingRow title={t("settings:memory.extractorEnabled")}>
                  <Switch
                    checked={editor.enabled}
                    onCheckedChange={(enabled) => setEditor({ ...editor, enabled })}
                  />
                </SettingRow>
                <SettingRow
                  title={t("settings:memory.extractorUsePrevious")}
                  description={t("settings:memory.extractorUsePreviousDesc")}
                >
                  <Switch
                    checked={editor.includePreviousExtraction === true}
                    onCheckedChange={(includePreviousExtraction) =>
                      setEditor({ ...editor, includePreviousExtraction })
                    }
                  />
                </SettingRow>
                <Field>
                  <FieldTitle>{t("settings:memory.extractorMetadataPath")}</FieldTitle>
                  <FieldDescription className="text-xs">
                    {t("settings:memory.extractorMetadataPathDesc")}
                  </FieldDescription>
                  <Input
                    value={editor.metadataKeyPath ?? ""}
                    onChange={(event) =>
                      setEditor({ ...editor, metadataKeyPath: event.target.value })
                    }
                    placeholder={t("settings:memory.recommendedPlaceholder")}
                  />
                </Field>
              </div>
            </ScrollArea>
          ) : null}
          <DrawerFooter className="flex-row justify-end border-t pt-3">
            <DrawerClose render={<Button type="button" variant="outline" />}>
              {t("common:cancel")}
            </DrawerClose>
            <Button type="button" disabled={!valid} onClick={saveEditor}>
              {t("common:save")}
            </Button>
          </DrawerFooter>
        </DrawerContent>
      </Drawer>
    </Field>
  );
}

export function MemorySection() {
  const { t } = useTranslation();
  const [draft, setDraft] = React.useState<MemoryDraft>(DEFAULT_MEMORY_DRAFT);
  const [loaded, setLoaded] = React.useState(false);

  React.useEffect(() => {
    if (loaded) return;
    fetchMemoryConfig<Partial<MemoryDraft>>()
      .then((config) => {
        const merged = { ...DEFAULT_MEMORY_DRAFT, ...config } as MemoryDraft;
        setDraft(merged);
      })
      .catch(() => undefined)
      .finally(() => setLoaded(true));
  }, [loaded]);

  // 上次已保存的草稿快照:识别非文本字段变化并供撤回
  const prevSavedRef = React.useRef<MemoryDraft | null>(null);

  // 自动保存:800ms 防抖写入;非文本字段变化成功后弹 toast 供撤回,
  // 文本编辑(模板/Schema/指令)静默。JSON 草稿非法时暂停,避免写入旧值或触发后端回退。
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
            toast.success(t("settings:memory.configUpdated"), {
              action: {
                label: t("settings:memory.undo"),
                onClick: () => {
                  // 预置快照:随后的自动保存视为无变化,不再弹 toast
                  prevSavedRef.current = before;
                  setDraft(before);
                },
              },
            });
          }
        })
        .catch(() => toast.error(t("settings:memory.autoSaveFailed")));
    }, 800);
    return () => window.clearTimeout(timer);
  }, [draft, loaded, t]);

  const restore = (...keys: Array<keyof MemoryDraft>) =>
    setDraft((current) => ({
      ...current,
      ...Object.fromEntries(keys.map((key) => [key, DEFAULT_MEMORY_DRAFT[key]])),
    }));
  const resetLabel = t("common:restoreDefaults");

  return (
    <>
      <SettingCard
        title={t("settings:memory.messageHistoryTitle")}
        onReset={() => restore("lastMessages", "readOnly")}
        resetLabel={resetLabel}
        description={
          draft.observationalMemory
            ? t("settings:memory.messageHistoryDescOm")
            : t("settings:memory.messageHistoryDescNonOm")
        }
      >
        {!draft.observationalMemory ? (
          <SliderRow
            description={t("settings:memory.recentMessagesDesc")}
            max={200}
            min={1}
            step={1}
            title={t("settings:memory.recentMessagesTitle")}
            value={draft.lastMessages}
            onChange={(v) => setDraft({ ...draft, lastMessages: v })}
          />
        ) : null}
        <SettingRow
          description={t("settings:memory.readOnlyDesc")}
          title={t("settings:memory.readOnlyTitle")}
        >
          {draft.readOnly ? (
            <Switch checked onCheckedChange={(readOnly) => setDraft({ ...draft, readOnly })} />
          ) : (
            <ConfirmDialog
              cancelLabel={t("common:cancel")}
              confirmLabel={t("settings:memory.confirmReadOnlyAction")}
              description={t("settings:memory.confirmReadOnlyDesc")}
              onConfirm={() => setDraft({ ...draft, readOnly: true })}
              title={t("settings:memory.confirmReadOnlyTitle")}
              trigger={<Switch checked={false} aria-label={t("settings:memory.readOnlyTitle")} />}
            />
          )}
        </SettingRow>
      </SettingCard>

      <SettingCard
        title={t("settings:memory.semanticRecallTitle")}
        description={t("settings:memory.semanticRecallDesc")}
        onReset={() =>
          restore(
            "semanticRecall",
            "semanticRecallTopK",
            "semanticRecallMessageRangeBefore",
            "semanticRecallMessageRangeAfter",
            "semanticRecallScope",
            "semanticRecallThreshold",
            "semanticRecallIndexName",
          )
        }
        resetLabel={resetLabel}
      >
        <p className="py-3 text-xs text-muted-foreground">
          {t("settings:memory.semanticRecallFastEmbedHint")}
        </p>
        <SettingRow
          title={t("settings:memory.enableSemanticRecall")}
          description={t("settings:memory.enableSemanticRecallDesc")}
        >
          <Switch
            checked={draft.semanticRecall}
            onCheckedChange={(v) => setDraft({ ...draft, semanticRecall: v })}
          />
        </SettingRow>
        {draft.semanticRecall ? (
          <AdvancedSection
            title={t("settings:memory.advancedTitle")}
            description={t("settings:memory.semanticAdvancedDesc")}
          >
            <SliderRow
              description={t("settings:memory.topKDesc")}
              max={20}
              min={1}
              step={1}
              title={t("settings:memory.topKTitle")}
              value={draft.semanticRecallTopK}
              onChange={(v) => setDraft({ ...draft, semanticRecallTopK: v })}
            />
            <SliderRow
              description={t("settings:memory.beforeRangeDesc")}
              max={10}
              min={0}
              step={1}
              title={t("settings:memory.beforeRangeTitle")}
              value={draft.semanticRecallMessageRangeBefore}
              onChange={(v) => setDraft({ ...draft, semanticRecallMessageRangeBefore: v })}
            />
            <SliderRow
              description={t("settings:memory.afterRangeDesc")}
              max={10}
              min={0}
              step={1}
              title={t("settings:memory.afterRangeTitle")}
              value={draft.semanticRecallMessageRangeAfter}
              onChange={(v) => setDraft({ ...draft, semanticRecallMessageRangeAfter: v })}
            />
            <SettingRow
              title={t("settings:memory.scopeTitle")}
              description={t("settings:memory.scopeDesc")}
            >
              <ScopeSelect
                onChange={(v) => setDraft({ ...draft, semanticRecallScope: v })}
                resourceLabel={t("settings:memory.scopeResource")}
                threadLabel={t("settings:memory.scopeThread")}
                value={draft.semanticRecallScope}
              />
            </SettingRow>
            <SliderRow
              description={t("settings:memory.thresholdDesc")}
              max={1}
              min={0}
              onChange={(v) =>
                setDraft({ ...draft, semanticRecallThreshold: Math.round(v * 100) / 100 })
              }
              step={0.05}
              title={t("settings:memory.thresholdTitle")}
              value={draft.semanticRecallThreshold}
            />
            <TextAreaRow
              description={t("settings:memory.indexNameDesc")}
              onChange={(semanticRecallIndexName) =>
                setDraft({ ...draft, semanticRecallIndexName })
              }
              rows={1}
              title={t("settings:memory.indexNameTitle")}
              value={draft.semanticRecallIndexName}
            />
          </AdvancedSection>
        ) : null}
      </SettingCard>

      <SettingCard
        title={t("settings:memory.workingMemoryTitle")}
        description={t("settings:memory.workingMemoryDesc")}
        onReset={() =>
          restore(
            "workingMemory",
            "workingMemoryScope",
            "workingMemoryFormat",
            "workingMemoryTemplate",
            "workingMemorySchema",
          )
        }
        resetLabel={resetLabel}
      >
        <SettingRow
          title={t("settings:memory.enableWorkingMemory")}
          description={t("settings:memory.enableWorkingMemoryDesc")}
        >
          <Switch
            checked={draft.workingMemory}
            onCheckedChange={(v) => setDraft({ ...draft, workingMemory: v })}
          />
        </SettingRow>
        {draft.workingMemory ? (
          <AdvancedSection
            title={t("settings:memory.advancedTitle")}
            description={t("settings:memory.workingMemoryAdvancedDesc")}
          >
            <SettingRow
              title={t("settings:memory.wmScopeTitle")}
              description={t("settings:memory.wmScopeDesc")}
            >
              <ScopeSelect
                onChange={(v) => setDraft({ ...draft, workingMemoryScope: v })}
                resourceLabel={t("settings:memory.scopeResource")}
                threadLabel={t("settings:memory.scopeThread")}
                value={draft.workingMemoryScope}
              />
            </SettingRow>
            <SettingRow
              title={t("settings:memory.wmFormatTitle")}
              description={t("settings:memory.wmFormatDesc")}
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
                  <SelectItem value="template">{t("settings:memory.wmFormatTemplate")}</SelectItem>
                  <SelectItem value="schema">{t("settings:memory.wmFormatSchema")}</SelectItem>
                </SelectContent>
              </Select>
            </SettingRow>
            {draft.workingMemoryFormat === "template" ? (
              <TemplateEditor
                value={draft.workingMemoryTemplate}
                onChange={(workingMemoryTemplate) => setDraft({ ...draft, workingMemoryTemplate })}
              />
            ) : (
              <SchemaEditor
                value={draft.workingMemorySchema}
                onChange={(workingMemorySchema) => setDraft({ ...draft, workingMemorySchema })}
              />
            )}
          </AdvancedSection>
        ) : null}
      </SettingCard>

      <SettingCard
        title={t("settings:memory.threadTitleCard")}
        description={t("settings:memory.threadTitleCardDesc")}
        onReset={() => restore("generateTitle")}
        resetLabel={resetLabel}
      >
        <SettingRow
          title={t("settings:memory.autoTitle")}
          description={t("settings:memory.autoTitleDesc")}
        >
          <Switch
            checked={draft.generateTitle}
            onCheckedChange={(v) => setDraft({ ...draft, generateTitle: v })}
          />
        </SettingRow>
      </SettingCard>

      <SettingCard
        title={t("settings:memory.omTitle")}
        description={t("settings:memory.omDesc")}
        onReset={() =>
          restore(
            "observationalMemory",
            "omScope",
            "omTemporalMarkers",
            "omObserverInstruction",
            "omReflectionInstruction",
            "omThreadTitle",
            "omManageWorkingMemory",
            "omObserveAttachments",
            "omMessageTokens",
            "omMaxTokensPerBatch",
            "omTemperature",
            "omMaxOutputTokens",
            "omBufferTokens",
            "omBufferEnabled",
            "omObservationTokens",
            "omRetrieval",
            "omRetrievalVector",
            "omRetrievalScope",
            "omExtractors",
          )
        }
        resetLabel={resetLabel}
      >
        <SettingRow
          description={t("settings:memory.enableOmDesc")}
          title={t("settings:memory.enableOm")}
        >
          <Switch
            checked={draft.observationalMemory}
            onCheckedChange={(v) => setDraft({ ...draft, observationalMemory: v })}
          />
        </SettingRow>
        {draft.observationalMemory ? (
          <>
            <SettingRow
              description={t("settings:memory.modelDesc")}
              title={t("settings:memory.modelTitle")}
            >
              <span className="shrink-0 text-sm font-medium text-muted-foreground">
                {t("settings:memory.followCurrentModel")}
              </span>
            </SettingRow>
            <NumberRow
              description={t("settings:memory.messageTokensDesc")}
              max={250_000}
              min={1_000}
              onChange={(v) => setDraft({ ...draft, omMessageTokens: v })}
              suffix={t("settings:memory.tokenUnit")}
              hint={t("settings:memory.messageTokensHint")}
              title={t("settings:memory.messageTokensTitle")}
              value={draft.omMessageTokens}
            />
            <SettingRow
              description={t("settings:memory.temporalMarkersDesc")}
              title={t("settings:memory.temporalMarkersTitle")}
            >
              <Switch
                checked={draft.omTemporalMarkers}
                onCheckedChange={(v) => setDraft({ ...draft, omTemporalMarkers: v })}
              />
            </SettingRow>
            <AdvancedSection
              title={t("settings:memory.advancedTitle")}
              description={t("settings:memory.observationAdvancedDesc")}
            >
              <SettingRow
                description={t("settings:memory.omScopeDesc")}
                title={t("settings:memory.omScopeTitle")}
              >
                <ScopeSelect
                  onChange={(v) => setDraft({ ...draft, omScope: v })}
                  resourceLabel={t("settings:memory.scopeResource")}
                  threadLabel={t("settings:memory.omScopeCurrentThread")}
                  value={draft.omScope}
                />
              </SettingRow>
              <SettingRow
                description={t("settings:memory.omThreadTitleDesc")}
                title={t("settings:memory.omThreadTitleTitle")}
              >
                <Switch
                  checked={draft.omThreadTitle}
                  onCheckedChange={(v) => setDraft({ ...draft, omThreadTitle: v })}
                />
              </SettingRow>
              <SettingRow
                description={t("settings:memory.manageWmDesc")}
                title={t("settings:memory.manageWmTitle")}
              >
                <Switch
                  checked={draft.omManageWorkingMemory}
                  onCheckedChange={(v) => setDraft({ ...draft, omManageWorkingMemory: v })}
                />
              </SettingRow>
              <SelectRow
                description={t("settings:memory.observeAttachmentsDesc")}
                onChange={(omObserveAttachments) => setDraft({ ...draft, omObserveAttachments })}
                options={[
                  { value: "auto" as const, label: t("settings:memory.observeAttachmentsAuto") },
                  { value: "on" as const, label: t("settings:memory.observeAttachmentsOn") },
                  { value: "off" as const, label: t("settings:memory.observeAttachmentsOff") },
                ]}
                title={t("settings:memory.observeAttachmentsTitle")}
                value={draft.omObserveAttachments}
              />
              <NumberRow
                description={t("settings:memory.maxTokensPerBatchDesc")}
                max={2_000_000}
                min={0}
                onChange={(v) => setDraft({ ...draft, omMaxTokensPerBatch: v })}
                emptyValue={0}
                placeholder={t("settings:memory.recommendedPlaceholder")}
                suffix={t("settings:memory.tokenUnit")}
                hint={t("settings:memory.maxTokensPerBatchHint")}
                title={t("settings:memory.maxTokensPerBatchTitle")}
                value={draft.omMaxTokensPerBatch}
              />
              <NumberRow
                description={t("settings:memory.temperatureDesc")}
                max={2}
                min={0}
                onChange={(v) => setDraft({ ...draft, omTemperature: v })}
                hint={t("settings:memory.temperatureHint")}
                step={0.1}
                title={t("settings:memory.temperatureTitle")}
                value={draft.omTemperature}
              />
              <NumberRow
                description={t("settings:memory.maxOutputTokensDesc")}
                max={500_000}
                min={0}
                onChange={(v) => setDraft({ ...draft, omMaxOutputTokens: v })}
                emptyValue={0}
                placeholder={t("settings:memory.recommendedPlaceholder")}
                suffix={t("settings:memory.tokenUnit")}
                hint={t("settings:memory.maxOutputTokensHint")}
                title={t("settings:memory.maxOutputTokensTitle")}
                value={draft.omMaxOutputTokens}
              />
              <NumberRow
                description={t("settings:memory.bufferTokensDesc")}
                max={500_000}
                min={0}
                onChange={(v) => setDraft({ ...draft, omBufferTokens: v })}
                hint={t("settings:memory.bufferTokensHint")}
                step={0.1}
                title={t("settings:memory.bufferTokensTitle")}
                value={draft.omBufferTokens}
              />
              <SettingRow
                description={t("settings:memory.bufferEnabledDesc")}
                title={t("settings:memory.bufferEnabledTitle")}
              >
                <Switch
                  checked={draft.omBufferEnabled}
                  onCheckedChange={(v) => setDraft({ ...draft, omBufferEnabled: v })}
                />
              </SettingRow>
              <NumberRow
                description={t("settings:memory.observationTokensDesc")}
                max={2_000_000}
                min={0}
                onChange={(v) => setDraft({ ...draft, omObservationTokens: v })}
                emptyValue={0}
                placeholder={t("settings:memory.recommendedPlaceholder")}
                suffix={t("settings:memory.tokenUnit")}
                hint={t("settings:memory.observationTokensHint")}
                title={t("settings:memory.observationTokensTitle")}
                value={draft.omObservationTokens}
              />
              <TextAreaRow
                description={t("settings:memory.observerInstructionDesc")}
                onChange={(omObserverInstruction) => setDraft({ ...draft, omObserverInstruction })}
                rows={3}
                title={t("settings:memory.observerInstructionTitle")}
                value={draft.omObserverInstruction}
              />
              <TextAreaRow
                description={t("settings:memory.reflectorInstructionDesc")}
                onChange={(omReflectionInstruction) =>
                  setDraft({ ...draft, omReflectionInstruction })
                }
                rows={3}
                title={t("settings:memory.reflectorInstructionTitle")}
                value={draft.omReflectionInstruction}
              />
              <ExtractorCardList
                value={draft.omExtractors}
                onChange={(omExtractors) => setDraft({ ...draft, omExtractors })}
              />
              <SettingRow
                description={t("settings:memory.recallDesc")}
                title={t("settings:memory.recallTitle")}
              >
                <Switch
                  checked={draft.omRetrieval}
                  onCheckedChange={(v) => setDraft({ ...draft, omRetrieval: v })}
                />
              </SettingRow>
              {draft.omRetrieval ? (
                <>
                  <SettingRow
                    description={t("settings:memory.recallSemanticDesc")}
                    title={t("settings:memory.recallSemanticTitle")}
                  >
                    <Switch
                      checked={draft.omRetrievalVector}
                      onCheckedChange={(v) => setDraft({ ...draft, omRetrievalVector: v })}
                    />
                  </SettingRow>
                  <SettingRow
                    title={t("settings:memory.recallScopeTitle")}
                    description={t("settings:memory.recallScopeDesc")}
                  >
                    <ScopeSelect
                      onChange={(v) => setDraft({ ...draft, omRetrievalScope: v })}
                      resourceLabel={t("settings:memory.recallScopeResource")}
                      threadLabel={t("settings:memory.recallScopeThread")}
                      value={draft.omRetrievalScope}
                    />
                  </SettingRow>
                </>
              ) : null}
            </AdvancedSection>
          </>
        ) : null}
      </SettingCard>
    </>
  );
}
