import { FolderOpenIcon, PlusIcon, XIcon } from "lucide-react";
import { nanoid } from "nanoid";
import * as React from "react";
import { toast } from "sonner";
import { useTranslation } from "@/shared/i18n";
import { Button } from "@/shared/ui/button";
import { Dotm3x3_1 } from "@/shared/ui/dotm-3x3-1";
import { Field, FieldContent, FieldDescription, FieldTitle } from "@/shared/ui/field";
import { Input } from "@/shared/ui/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/shared/ui/input-group";
import { Switch } from "@/shared/ui/switch";
import { fetchWorkspaceSettings, saveWorkspaceSettings } from "../../api/settings-api";
import {
  AdvancedSection,
  ConfirmDialog,
  NumberRow,
  SettingCard,
  SettingGrid,
  SettingRow,
  SliderRow,
} from "../controls";

export interface WorkspaceDraft {
  threadsRoot: string;
  readOnly: boolean;
  allowedPaths: string[];
  sandboxEnabled: boolean;
  sandboxTimeoutMs: number;
  sandboxEnv: Record<string, string>;
  bm25: boolean;
  bm25K1: number;
  bm25B: number;
  lsp: boolean;
  lspDiagnosticTimeoutMs: number;
  lspInitTimeoutMs: number;
  lspMaxOpenClients: number;
  lspDisableServers: string[];
  lspBinaryOverrides: Record<string, string>;
  lspSearchPaths: string[];
  tools: {
    requireReadBeforeWrite?: boolean;
    maxOutputTokens?: number;
    writeLockTimeoutMs?: number;
    [key: string]: unknown;
  };
  skillsPaths: string[];
  autoIndexPaths: string[];
}

export const DEFAULT_WORKSPACE_DRAFT: WorkspaceDraft = {
  threadsRoot: "",
  readOnly: false,
  allowedPaths: [],
  sandboxEnabled: true,
  sandboxTimeoutMs: 30_000,
  sandboxEnv: {},
  bm25: true,
  bm25K1: 1.5,
  bm25B: 0.75,
  lsp: false,
  lspDiagnosticTimeoutMs: 5_000,
  lspInitTimeoutMs: 15_000,
  lspMaxOpenClients: 8,
  lspDisableServers: [],
  lspBinaryOverrides: {},
  lspSearchPaths: [],
  tools: { requireReadBeforeWrite: true, maxOutputTokens: 3_000, writeLockTimeoutMs: 30_000 },
  skillsPaths: ["skills"],
  autoIndexPaths: [],
};

const WORKSPACE_TOOL_IDS = [
  "mastra_workspace_read_file",
  "mastra_workspace_write_file",
  "mastra_workspace_edit_file",
  "mastra_workspace_execute_command",
  "mastra_workspace_search",
] as const;

/** 目录选择字段:路径展示 + 系统目录选择器按钮(路径一律通过选择器写入) */
export function DirectoryPickerField({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  const [picking, setPicking] = React.useState(false);
  const pick = async () => {
    setPicking(true);
    try {
      const dir = await window.api?.filesystem.pickDirectory?.();
      if (dir) onChange(dir);
    } finally {
      setPicking(false);
    }
  };
  return (
    <InputGroup>
      <InputGroupInput
        readOnly
        className="font-mono text-xs"
        placeholder={t("settings:workspace.selectDirPlaceholder")}
        value={value}
      />
      <InputGroupAddon align="inline-end">
        <InputGroupButton
          variant="secondary"
          size="xs"
          disabled={picking}
          onClick={() => void pick()}
        >
          {picking ? (
            <Dotm3x3_1 size={14} dotSize={2.2} colorPreset="solid-theme" />
          ) : (
            <FolderOpenIcon />
          )}
          {t("settings:workspace.selectDir")}
        </InputGroupButton>
      </InputGroupAddon>
    </InputGroup>
  );
}

/** 列表字段头部:标题+描述在左,"添加"按钮在右(一行,空列表不额外占行) */
function ListFieldHeader({
  title,
  description,
  onAdd,
  addLabel,
  picking = false,
}: {
  title: string;
  description: string;
  onAdd: () => void;
  addLabel?: string;
  picking?: boolean;
}) {
  const { t } = useTranslation();
  const label = addLabel ?? t("settings:workspace.add");
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="space-y-0.5">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <Button
        className="shrink-0"
        disabled={picking}
        onClick={onAdd}
        size="xs"
        type="button"
        variant="outline"
      >
        {picking ? (
          <Dotm3x3_1 colorPreset="solid-theme" dotSize={2} size={12} />
        ) : (
          <PlusIcon className="size-3.5" />
        )}
        {label}
      </Button>
    </div>
  );
}

/** 绝对目录列表:每项经系统目录选择器加入,可删除(allowedPaths) */
function AllowedPathsList({
  title,
  description,
  value,
  onChange,
}: {
  title: string;
  description: string;
  value: string[];
  onChange: (value: string[]) => void;
}) {
  const { t } = useTranslation();
  const [picking, setPicking] = React.useState(false);
  const addDirectory = async () => {
    setPicking(true);
    try {
      const dir = await window.api?.filesystem.pickDirectory?.();
      if (dir && !value.includes(dir)) {
        onChange([...value, dir]);
      }
    } finally {
      setPicking(false);
    }
  };

  return (
    <div className="space-y-2">
      <ListFieldHeader
        addLabel={t("settings:workspace.addDir")}
        description={description}
        onAdd={() => void addDirectory()}
        picking={picking}
        title={title}
      />
      {value.length > 0 ? (
        <div className="space-y-1.5 pt-1">
          {value.map((item, index) => (
            <div key={item} className="flex items-center gap-2">
              <Input className="font-mono text-xs" readOnly value={item} />
              <Button
                aria-label={t("settings:workspace.deleteDir")}
                className="shrink-0"
                onClick={() => onChange(value.filter((_, i) => i !== index))}
                size="icon-xs"
                type="button"
                variant="ghost"
              >
                <XIcon className="size-3.5" />
              </Button>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

interface KeyedRow {
  id: string;
  value: string;
}

/**
 * 相对路径列表:相对工作区根目录,支持 glob(skillsPaths / autoIndexPaths)。
 * 行 id 与 value 等长保持稳定(编辑路径不重挂行、不丢焦点;
 * 外部整组替换(加载配置)导致长度变化时重生成)。
 */
function RelativePathList({
  title,
  description,
  placeholder,
  value,
  onChange,
  pickDirectories = false,
}: {
  title: string;
  description: string;
  placeholder?: string;
  value: string[];
  onChange: (value: string[]) => void;
  pickDirectories?: boolean;
}) {
  const { t } = useTranslation();
  const [rows, setRows] = React.useState<KeyedRow[]>(() =>
    value.map((v) => ({ id: nanoid(), value: v })),
  );

  React.useEffect(() => {
    setRows((prev) => {
      if (prev.length === value.length && prev.every((row, i) => row.value === value[i])) {
        return prev;
      }
      return value.map((v) => ({ id: nanoid(), value: v }));
    });
  }, [value]);

  const updateAt = (index: number, nextValue: string) => {
    const nextRows = rows.map((r, i) => (i === index ? { ...r, value: nextValue } : r));
    setRows(nextRows);
    onChange(nextRows.map((r) => r.value));
  };

  const removeAt = (index: number) => {
    const nextRows = rows.filter((_, i) => i !== index);
    setRows(nextRows);
    onChange(nextRows.map((r) => r.value));
  };

  const [picking, setPicking] = React.useState(false);
  const addRow = async () => {
    if (pickDirectories) {
      setPicking(true);
      try {
        const directory = await window.api?.filesystem.pickDirectory?.();
        if (directory && !rows.some((row) => row.value === directory)) {
          const nextRows = [...rows, { id: nanoid(), value: directory }];
          setRows(nextRows);
          onChange(nextRows.map((row) => row.value));
        }
      } finally {
        setPicking(false);
      }
      return;
    }
    const nextRows = [...rows, { id: nanoid(), value: "" }];
    setRows(nextRows);
    onChange(nextRows.map((r) => r.value));
  };

  return (
    <div className="space-y-2">
      <ListFieldHeader
        addLabel={pickDirectories ? t("settings:workspace.selectDir") : undefined}
        description={description}
        onAdd={() => void addRow()}
        picking={picking}
        title={title}
      />
      {rows.length > 0 ? (
        <div className="space-y-1.5 pt-1">
          {rows.map((row, index) => (
            <div key={row.id} className="flex items-center gap-2">
              <Input
                className="font-mono text-xs"
                onChange={(e) => updateAt(index, e.target.value)}
                placeholder={placeholder}
                readOnly={pickDirectories}
                value={row.value}
              />
              <Button
                aria-label={t("settings:workspace.deletePath")}
                className="shrink-0"
                onClick={() => removeAt(index)}
                size="icon-xs"
                type="button"
                variant="ghost"
              >
                <XIcon className="size-3.5" />
              </Button>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

interface KeyedEntry {
  id: string;
  key: string;
  val: string;
}

/**
 * 沙箱环境变量键值对编辑(sandboxEnv;PATH 默认保留,无需手填)。
 * 行 id 与 entries 等长保持稳定(重命名变量不重挂行、不丢焦点)。
 */
function EnvMapField({
  title,
  description,
  value,
  onChange,
}: {
  title: string;
  description: string;
  value: Record<string, string>;
  onChange: (value: Record<string, string>) => void;
}) {
  const { t } = useTranslation();
  const [rows, setRows] = React.useState<KeyedEntry[]>(() =>
    Object.entries(value).map(([k, v]) => ({ id: nanoid(), key: k, val: v })),
  );

  React.useEffect(() => {
    const entries = Object.entries(value);
    setRows((prev) => {
      if (
        prev.length === entries.length &&
        prev.every((row, i) => row.key === entries[i][0] && row.val === entries[i][1])
      ) {
        return prev;
      }
      return entries.map(([k, v]) => ({ id: nanoid(), key: k, val: v }));
    });
  }, [value]);

  const commit = (nextRows: KeyedEntry[]) => {
    setRows(nextRows);
    onChange(Object.fromEntries(nextRows.map((r) => [r.key, r.val])));
  };

  const updateAt = (index: number, patch: Partial<KeyedEntry>) => {
    commit(rows.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  };

  const removeAt = (index: number) => {
    commit(rows.filter((_, i) => i !== index));
  };

  const addRow = () => {
    commit([...rows, { id: nanoid(), key: "", val: "" }]);
  };
  const quickEntries = [
    ["LANG", "en_US.UTF-8"],
    ["NODE_ENV", "development"],
    ["NO_COLOR", "1"],
  ] as const;

  return (
    <div className="space-y-2">
      <ListFieldHeader description={description} onAdd={addRow} title={title} />
      <div className="flex flex-wrap gap-1.5">
        {quickEntries
          .filter(([key]) => !rows.some((row) => row.key === key))
          .map(([key, val]) => (
            <Button
              key={key}
              type="button"
              size="xs"
              variant="ghost"
              onClick={() => commit([...rows, { id: nanoid(), key, val }])}
            >
              <PlusIcon />
              {key}
            </Button>
          ))}
      </div>
      {rows.length > 0 ? (
        <div className="space-y-1.5 pt-1">
          {rows.map((row, index) => (
            <div key={row.id} className="flex items-center gap-2">
              <Input
                aria-label={t("settings:workspace.varName")}
                className="w-40 font-mono text-xs"
                onChange={(e) => updateAt(index, { key: e.target.value })}
                placeholder={t("settings:workspace.variableNamePlaceholder")}
                value={row.key}
              />
              <Input
                aria-label={t("settings:workspace.varValue")}
                className="min-w-0 flex-1 font-mono text-xs"
                onChange={(e) => updateAt(index, { val: e.target.value })}
                placeholder={t("settings:workspace.variableValuePlaceholder")}
                value={row.val}
              />
              <Button
                aria-label={t("settings:workspace.deleteVar")}
                className="shrink-0"
                onClick={() => removeAt(index)}
                size="icon-xs"
                type="button"
                variant="ghost"
              >
                <XIcon className="size-3.5" />
              </Button>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * 结构性变化(开关/选择器/目录选择/列表增删)→ 返回可读名对应的字段 key;
 * 纯文本编辑(路径内容/变量值输入)返回 null,保存时静默不弹 toast。
 */
function structuralChangeKey(before: WorkspaceDraft, after: WorkspaceDraft): string | null {
  if (before.threadsRoot !== after.threadsRoot) return "threadsRoot";
  if (before.readOnly !== after.readOnly) return "readOnly";
  if (before.allowedPaths.length !== after.allowedPaths.length) return "allowedPaths";
  if (before.sandboxEnabled !== after.sandboxEnabled) return "sandboxEnabled";
  if (before.sandboxTimeoutMs !== after.sandboxTimeoutMs) return "sandboxTimeoutMs";
  if (Object.keys(before.sandboxEnv).length !== Object.keys(after.sandboxEnv).length)
    return "sandboxEnv";
  if (before.bm25 !== after.bm25) return "bm25";
  if (before.bm25K1 !== after.bm25K1 || before.bm25B !== after.bm25B) return "bm25Params";
  if (before.autoIndexPaths.length !== after.autoIndexPaths.length) return "autoIndexPaths";
  if (before.skillsPaths.length !== after.skillsPaths.length) return "skillsPaths";
  if (before.lsp !== after.lsp) return "lsp";
  if (before.lspMaxOpenClients !== after.lspMaxOpenClients) return "lspMaxOpenClients";
  if (before.tools !== after.tools) return "tools";
  return null;
}

export function WorkspaceSection() {
  const { t } = useTranslation();
  const [draft, setDraft] = React.useState<WorkspaceDraft>(DEFAULT_WORKSPACE_DRAFT);
  const [loaded, setLoaded] = React.useState(false);

  React.useEffect(() => {
    if (loaded) return;
    fetchWorkspaceSettings<Partial<WorkspaceDraft>>()
      .then((config) => {
        setDraft((prev) => ({ ...prev, ...config }));
      })
      .catch(() => undefined)
      .finally(() => setLoaded(true));
  }, [loaded]);

  // 上次已保存的草稿快照:识别结构性变化并供撤回
  const prevSavedRef = React.useRef<WorkspaceDraft | null>(null);

  // 自动保存:800ms 防抖写入;结构性变化成功后弹 toast 供撤回,
  // 纯文本编辑静默。空路径/空变量名过滤后再提交。
  React.useEffect(() => {
    if (!loaded) return;
    const timer = window.setTimeout(() => {
      void saveWorkspaceSettings({
        ...draft,
        sandboxEnv: Object.fromEntries(Object.entries(draft.sandboxEnv).filter(([k]) => k.trim())),
        skillsPaths: draft.skillsPaths.map((p) => p.trim()).filter(Boolean),
        autoIndexPaths: draft.autoIndexPaths.map((p) => p.trim()).filter(Boolean),
      })
        .then(() => {
          const before = prevSavedRef.current;
          prevSavedRef.current = draft;
          const key = before ? structuralChangeKey(before, draft) : null;
          if (before && key) {
            const label = t(`settings:workspace.fields.${key}`);
            toast.success(t("settings:workspace.updatedToast", { label }), {
              action: {
                label: t("settings:workspace.undo"),
                onClick: () => {
                  // 预置快照:随后的自动保存视为无变化,不再弹 toast
                  prevSavedRef.current = before;
                  setDraft(before);
                },
              },
            });
          }
        })
        .catch(() => toast.error(t("settings:workspace.autoSaveFailed")));
    }, 800);
    return () => window.clearTimeout(timer);
  }, [draft, loaded, t]);

  const patch = (next: Partial<WorkspaceDraft>) => setDraft({ ...draft, ...next });
  const restore = (...keys: Array<keyof WorkspaceDraft>) =>
    setDraft((current) => ({
      ...current,
      ...Object.fromEntries(keys.map((key) => [key, DEFAULT_WORKSPACE_DRAFT[key]])),
    }));
  const resetLabel = t("common:restoreDefaults");

  return (
    <>
      <SettingCard
        title={t("settings:workspace.fsTitle")}
        description={t("settings:workspace.fsDesc")}
        onReset={() => restore("threadsRoot", "readOnly", "allowedPaths")}
        resetLabel={resetLabel}
      >
        <Field className="space-y-2 py-4">
          <FieldContent className="space-y-1">
            <FieldTitle className="text-sm leading-none font-medium">
              {t("settings:workspace.threadsRootTitle")}
            </FieldTitle>
            <FieldDescription className="text-xs text-muted-foreground">
              {t("settings:workspace.threadsRootDesc")}
            </FieldDescription>
          </FieldContent>
          <DirectoryPickerField
            onChange={(threadsRoot) => patch({ threadsRoot })}
            value={draft.threadsRoot}
          />
        </Field>
        <SettingRow
          description={t("settings:workspace.readOnlyDesc")}
          title={t("settings:workspace.readOnlyTitle")}
        >
          {draft.readOnly ? (
            <Switch checked onCheckedChange={(readOnly) => patch({ readOnly })} />
          ) : (
            <ConfirmDialog
              cancelLabel={t("common:cancel")}
              confirmLabel={t("settings:workspace.confirmReadOnlyAction")}
              description={t("settings:workspace.confirmReadOnlyDesc")}
              onConfirm={() => patch({ readOnly: true })}
              title={t("settings:workspace.confirmReadOnlyTitle")}
              trigger={
                <Switch checked={false} aria-label={t("settings:workspace.readOnlyTitle")} />
              }
            />
          )}
        </SettingRow>
        <AllowedPathsList
          description={t("settings:workspace.allowedPathsDesc")}
          onChange={(allowedPaths) => patch({ allowedPaths })}
          title={t("settings:workspace.allowedPathsTitle")}
          value={draft.allowedPaths}
        />
      </SettingCard>

      <SettingCard
        title={t("settings:workspace.sandboxTitle")}
        description={t("settings:workspace.sandboxDesc")}
        onReset={() => restore("sandboxEnabled", "sandboxTimeoutMs", "sandboxEnv")}
        resetLabel={resetLabel}
      >
        <SettingRow
          description={t("settings:workspace.sandboxEnableDesc")}
          title={t("settings:workspace.sandboxEnableTitle")}
        >
          <Switch
            checked={draft.sandboxEnabled}
            onCheckedChange={(v) => patch({ sandboxEnabled: v })}
          />
        </SettingRow>
        {draft.sandboxEnabled ? (
          <>
            <SliderRow
              description={t("settings:workspace.commandTimeoutDesc")}
              max={300}
              min={5}
              presets={[
                { label: t("settings:workspace.timeoutShort"), value: 15 },
                { label: t("settings:workspace.timeoutBalanced"), value: 30 },
                { label: t("settings:workspace.timeoutLong"), value: 120 },
              ]}
              step={5}
              suffix={t("settings:workspace.secondsUnit")}
              title={t("settings:workspace.commandTimeoutTitle")}
              value={draft.sandboxTimeoutMs / 1000}
              onChange={(v) => patch({ sandboxTimeoutMs: v * 1000 })}
            />
            <EnvMapField
              description={t("settings:workspace.envDesc")}
              onChange={(sandboxEnv) => patch({ sandboxEnv })}
              title={t("settings:workspace.envTitle")}
              value={draft.sandboxEnv}
            />
          </>
        ) : null}
      </SettingCard>

      <SettingCard
        title={t("settings:workspace.searchTitle")}
        description={t("settings:workspace.searchDesc")}
        onReset={() =>
          restore(
            "bm25",
            "bm25K1",
            "bm25B",
            "autoIndexPaths",
            "lsp",
            "lspDiagnosticTimeoutMs",
            "lspInitTimeoutMs",
            "lspMaxOpenClients",
            "lspDisableServers",
            "lspBinaryOverrides",
            "lspSearchPaths",
          )
        }
        resetLabel={resetLabel}
      >
        <SettingRow
          description={t("settings:workspace.bm25Desc")}
          title={t("settings:workspace.bm25Title")}
        >
          <Switch checked={draft.bm25} onCheckedChange={(v) => patch({ bm25: v })} />
        </SettingRow>
        {draft.bm25 ? (
          <AdvancedSection
            title={t("settings:workspace.advancedTitle")}
            description={t("settings:workspace.searchAdvancedDesc")}
          >
            <RelativePathList
              description={t("settings:workspace.autoIndexPathsDesc")}
              onChange={(autoIndexPaths) => patch({ autoIndexPaths })}
              placeholder={t("settings:workspace.autoIndexPathsPlaceholder")}
              title={t("settings:workspace.autoIndexPathsTitle")}
              value={draft.autoIndexPaths}
            />
            <NumberRow
              description={t("settings:workspace.bm25K1Desc")}
              hint={t("settings:workspace.bm25K1Hint")}
              min={0.1}
              max={5}
              step={0.1}
              title={t("settings:workspace.bm25K1Title")}
              value={draft.bm25K1}
              onChange={(bm25K1) => patch({ bm25K1 })}
            />
            <NumberRow
              description={t("settings:workspace.bm25BDesc")}
              hint={t("settings:workspace.bm25BHint")}
              min={0}
              max={1}
              step={0.05}
              title={t("settings:workspace.bm25BTitle")}
              value={draft.bm25B}
              onChange={(bm25B) => patch({ bm25B })}
            />
          </AdvancedSection>
        ) : null}
        <SettingRow
          description={t("settings:workspace.lspDesc")}
          title={t("settings:workspace.lspTitle")}
        >
          <Switch checked={draft.lsp} onCheckedChange={(v) => patch({ lsp: v })} />
        </SettingRow>
        {draft.lsp ? (
          <AdvancedSection
            title={t("settings:workspace.advancedTitle")}
            description={t("settings:workspace.codeAdvancedDesc")}
          >
            <NumberRow
              description={t("settings:workspace.lspDiagTimeoutDesc")}
              hint={t("settings:workspace.lspDiagTimeoutHint")}
              min={100}
              suffix={t("settings:workspace.millisecondsUnit")}
              title={t("settings:workspace.lspDiagTimeoutTitle")}
              value={draft.lspDiagnosticTimeoutMs}
              onChange={(lspDiagnosticTimeoutMs) => patch({ lspDiagnosticTimeoutMs })}
            />
            <NumberRow
              description={t("settings:workspace.lspInitTimeoutDesc")}
              hint={t("settings:workspace.lspInitTimeoutHint")}
              min={500}
              suffix={t("settings:workspace.millisecondsUnit")}
              title={t("settings:workspace.lspInitTimeoutTitle")}
              value={draft.lspInitTimeoutMs}
              onChange={(lspInitTimeoutMs) => patch({ lspInitTimeoutMs })}
            />
            <NumberRow
              description={t("settings:workspace.lspClientLimitDesc")}
              hint={t("settings:workspace.lspClientLimitHint")}
              min={1}
              title={t("settings:workspace.lspClientLimitTitle")}
              value={draft.lspMaxOpenClients}
              onChange={(lspMaxOpenClients) => patch({ lspMaxOpenClients })}
            />
            <RelativePathList
              title={t("settings:workspace.lspSearchPathsTitle")}
              description={t("settings:workspace.lspSearchPathsDesc")}
              value={draft.lspSearchPaths}
              onChange={(lspSearchPaths) => patch({ lspSearchPaths })}
              placeholder={t("settings:workspace.lspSearchPathsPlaceholder")}
            />
            <RelativePathList
              title={t("settings:workspace.lspDisableServersTitle")}
              description={t("settings:workspace.lspDisableServersDesc")}
              value={draft.lspDisableServers}
              onChange={(lspDisableServers) => patch({ lspDisableServers })}
              placeholder={t("settings:workspace.disabledServicePlaceholder")}
            />
            <EnvMapField
              title={t("settings:workspace.lspBinaryOverridesTitle")}
              description={t("settings:workspace.lspBinaryOverridesDesc")}
              value={draft.lspBinaryOverrides}
              onChange={(lspBinaryOverrides) => patch({ lspBinaryOverrides })}
            />
          </AdvancedSection>
        ) : null}
      </SettingCard>

      <SettingCard
        title={t("settings:workspace.toolsTitle")}
        description={t("settings:workspace.toolsDesc")}
        onReset={() => restore("tools")}
        resetLabel={resetLabel}
      >
        <SettingRow
          title={t("settings:workspace.requireReadBeforeWriteTitle")}
          description={t("settings:workspace.requireReadBeforeWriteDesc")}
        >
          <Switch
            checked={draft.tools.requireReadBeforeWrite !== false}
            onCheckedChange={(requireReadBeforeWrite) =>
              patch({ tools: { ...draft.tools, requireReadBeforeWrite } })
            }
          />
        </SettingRow>
        <div className="space-y-2 rounded-lg bg-muted/20 p-3">
          <div className="space-y-1">
            <p className="text-sm font-medium">{t("settings:workspace.toolApprovalTitle")}</p>
            <p className="text-xs text-muted-foreground">
              {t("settings:workspace.toolApprovalDesc")}
            </p>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {WORKSPACE_TOOL_IDS.map((toolName) => {
              const rule =
                (draft.tools[toolName] as
                  | { enabled?: boolean; requireApproval?: boolean }
                  | undefined) ?? {};
              const updateRule = (next: { enabled?: boolean; requireApproval?: boolean }) =>
                patch({ tools: { ...draft.tools, [toolName]: { ...rule, ...next } } });
              return (
                <div
                  key={toolName}
                  className="flex min-w-0 items-center justify-between gap-3 rounded-md border p-2"
                >
                  <span className="min-w-0 break-words text-sm" title={toolName}>
                    {t(`settings:workspace.tools.${toolName}`)}
                  </span>
                  <div className="flex shrink-0 items-center gap-2">
                    <span className="flex items-center gap-1 text-xs text-muted-foreground">
                      {t("settings:workspace.toolEnable")}
                      <Switch
                        checked={rule.enabled !== false}
                        onCheckedChange={(enabled) => updateRule({ enabled })}
                      />
                    </span>
                    <span className="flex items-center gap-1 text-xs text-muted-foreground">
                      {t("settings:workspace.toolApprove")}
                      <Switch
                        checked={rule.requireApproval === true}
                        onCheckedChange={(requireApproval) => updateRule({ requireApproval })}
                      />
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
        <AdvancedSection
          title={t("settings:workspace.advancedTitle")}
          description={t("settings:workspace.toolsAdvancedDesc")}
        >
          <SettingGrid>
            <NumberRow
              title={t("settings:workspace.maxOutputTokensTitle")}
              description={t("settings:workspace.maxOutputTokensDesc")}
              hint={t("settings:workspace.maxOutputTokensHint")}
              min={1}
              suffix={t("settings:workspace.tokenUnit")}
              value={draft.tools.maxOutputTokens ?? 3_000}
              onChange={(maxOutputTokens) => patch({ tools: { ...draft.tools, maxOutputTokens } })}
            />
            <NumberRow
              title={t("settings:workspace.writeLockTimeoutTitle")}
              description={t("settings:workspace.writeLockTimeoutDesc")}
              hint={t("settings:workspace.writeLockTimeoutHint")}
              min={1_000}
              suffix={t("settings:workspace.millisecondsUnit")}
              value={draft.tools.writeLockTimeoutMs ?? 30_000}
              onChange={(writeLockTimeoutMs) =>
                patch({ tools: { ...draft.tools, writeLockTimeoutMs } })
              }
            />
          </SettingGrid>
        </AdvancedSection>
      </SettingCard>

      <SettingCard
        title={t("settings:workspace.skillsTitle")}
        description={t("settings:workspace.skillsDesc")}
        onReset={() => restore("skillsPaths")}
        resetLabel={resetLabel}
      >
        <RelativePathList
          description={t("settings:workspace.skillsPathsDesc")}
          onChange={(skillsPaths) => patch({ skillsPaths })}
          pickDirectories
          placeholder={t("settings:workspace.skillsPathsPlaceholder")}
          title={t("settings:workspace.skillsPathsTitle")}
          value={draft.skillsPaths}
        />
      </SettingCard>
    </>
  );
}
