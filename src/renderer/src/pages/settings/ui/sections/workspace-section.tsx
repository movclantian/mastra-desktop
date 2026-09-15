import { FolderOpenIcon, PlusIcon, XIcon } from "lucide-react";
import { nanoid } from "nanoid";
import * as React from "react";
import { toast } from "sonner";
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
import { SettingCard, SettingRow, SliderRow } from "../controls";

// ---------------------------------------------------------------------------
// 工作区(文件系统 + 沙箱 + 搜索 + LSP + Skills,写入数据库 app_config 表,保存后实时生效)
// 参数语义对照 docs/en/reference/workspace/*.mdx 与 docs/en/docs/sandbox/*.mdx。
// ---------------------------------------------------------------------------

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

const WORKSPACE_TOOL_OPTIONS = [
  ["mastra_workspace_read_file", "读取文件"],
  ["mastra_workspace_write_file", "写入文件"],
  ["mastra_workspace_edit_file", "编辑文件"],
  ["mastra_workspace_execute_command", "执行命令"],
  ["mastra_workspace_search", "工作区搜索"],
] as const;

/** 目录选择字段:路径展示 + 系统目录选择器按钮(路径一律通过选择器写入) */
export function DirectoryPickerField({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
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
        placeholder="点击右侧按钮选择目录"
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
          选择目录
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
  addLabel = "添加",
  picking = false,
}: {
  title: string;
  description: string;
  onAdd: () => void;
  addLabel?: string;
  picking?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <FieldContent className="min-w-0 space-y-1">
        <FieldTitle className="text-sm leading-none font-medium">{title}</FieldTitle>
        <FieldDescription className="text-xs text-muted-foreground">{description}</FieldDescription>
      </FieldContent>
      <Button variant="outline" size="sm" className="shrink-0" disabled={picking} onClick={onAdd}>
        {picking ? <Dotm3x3_1 size={14} dotSize={2.2} colorPreset="solid-theme" /> : <PlusIcon />}
        {addLabel}
      </Button>
    </div>
  );
}

/** 绝对目录列表:每项经系统目录选择器加入,可删除(allowedPaths) */
export function DirectoryList({
  title,
  description,
  value,
  onChange,
}: {
  title: string;
  description: string;
  value: string[];
  onChange: (paths: string[]) => void;
}) {
  const [picking, setPicking] = React.useState(false);
  const add = async () => {
    setPicking(true);
    try {
      const dir = await window.api?.filesystem.pickDirectory?.();
      if (dir && !value.includes(dir)) onChange([...value, dir]);
    } finally {
      setPicking(false);
    }
  };
  return (
    <div>
      <ListFieldHeader
        description={description}
        addLabel="添加目录"
        picking={picking}
        title={title}
        onAdd={() => void add()}
      />
      {value.length > 0 ? (
        <div className="space-y-2 pb-2">
          {value.map((dir) => (
            <InputGroup key={dir}>
              <InputGroupInput readOnly className="font-mono text-xs" value={dir} />
              <InputGroupAddon align="inline-end">
                <InputGroupButton
                  size="icon-xs"
                  variant="ghost"
                  aria-label="删除目录"
                  onClick={() => onChange(value.filter((p) => p !== dir))}
                >
                  <XIcon />
                </InputGroupButton>
              </InputGroupAddon>
            </InputGroup>
          ))}
        </div>
      ) : null}
    </div>
  );
}
/**
 * 相对路径列表:相对工作区根目录,支持 glob(skillsPaths / autoIndexPaths)。
 * 行 id 与 value 等长保持稳定(编辑路径不重挂行、不丢焦点;
 * 外部整组替换(加载配置)导致长度变化时重生成)。
 */
export function RelativePathList({
  title,
  description,
  value,
  onChange,
  placeholder,
}: {
  title: string;
  description: string;
  value: string[];
  onChange: (paths: string[]) => void;
  placeholder: string;
}) {
  const idRef = React.useRef<string[]>([]);
  if (idRef.current.length !== value.length) {
    idRef.current = value.map(() => nanoid(4));
  }
  const rows = value.map((path, i) => ({ id: idRef.current[i], path }));

  const update = (id: string, next: string) =>
    onChange(value.map((p, i) => (idRef.current[i] === id ? next : p)));

  const remove = (id: string) => {
    const index = idRef.current.indexOf(id);
    if (index < 0) return;
    idRef.current = idRef.current.filter((x) => x !== id);
    onChange(value.filter((_, i) => i !== index));
  };

  const add = () => {
    idRef.current = [...idRef.current, nanoid(4)];
    onChange([...value, ""]);
  };

  return (
    <div>
      <ListFieldHeader description={description} title={title} onAdd={add} />
      {rows.length > 0 ? (
        <div className="space-y-2 pb-2">
          {rows.map(({ id, path }) => (
            <InputGroup key={id}>
              <InputGroupInput
                className="font-mono text-xs"
                placeholder={placeholder}
                value={path}
                onChange={(e) => update(id, e.target.value)}
              />
              <InputGroupAddon align="inline-end">
                <InputGroupButton
                  size="icon-xs"
                  variant="ghost"
                  aria-label="删除路径"
                  onClick={() => remove(id)}
                >
                  <XIcon />
                </InputGroupButton>
              </InputGroupAddon>
            </InputGroup>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * 沙箱环境变量键值对编辑(sandboxEnv;PATH 默认保留,无需手填)。
 * 行 id 与 entries 等长保持稳定(重命名变量不重挂行、不丢焦点)。
 */
export function EnvEntryList({
  title,
  description,
  value,
  onChange,
}: {
  title: string;
  description: string;
  value: Record<string, string>;
  onChange: (env: Record<string, string>) => void;
}) {
  const entries = Object.entries(value);
  const idRef = React.useRef<string[]>([]);
  if (idRef.current.length !== entries.length) {
    idRef.current = entries.map(() => nanoid(4));
  }
  const rows = entries.map(([k, v], i) => ({ id: idRef.current[i], envKey: k, envVal: v }));

  const rebuild = (nextRows: typeof rows) =>
    onChange(Object.fromEntries(nextRows.map((r) => [r.envKey, r.envVal])));

  const update = (id: string, patch: { envKey?: string; envVal?: string }) =>
    rebuild(rows.map((r) => (r.id === id ? { ...r, ...patch, id } : r)));

  const remove = (id: string) => {
    const nextRows = rows.filter((r) => r.id !== id);
    idRef.current = idRef.current.filter((x) => x !== id);
    rebuild(nextRows);
  };

  const add = () => {
    idRef.current = [...idRef.current, nanoid(4)];
    onChange({ ...value, "": "" });
  };

  return (
    <div>
      <ListFieldHeader description={description} title={title} onAdd={add} />
      {rows.length > 0 ? (
        <div className="space-y-2 pb-2">
          {rows.map(({ id, envKey, envVal }) => (
            <div key={id} className="flex items-center gap-2">
              <Input
                className="w-40 shrink-0 font-mono text-xs"
                aria-label="变量名"
                placeholder="KEY"
                value={envKey}
                onChange={(e) => update(id, { envKey: e.target.value })}
              />
              <InputGroup className="min-w-0 flex-1">
                <InputGroupInput
                  className="font-mono text-xs"
                  aria-label="变量值"
                  placeholder="VALUE"
                  value={envVal}
                  onChange={(e) => update(id, { envVal: e.target.value })}
                />
                <InputGroupAddon align="inline-end">
                  <InputGroupButton
                    size="icon-xs"
                    variant="ghost"
                    aria-label="删除变量"
                    onClick={() => remove(id)}
                  >
                    <XIcon />
                  </InputGroupButton>
                </InputGroupAddon>
              </InputGroup>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * 结构性变化(开关/选择器/目录选择/列表增删)→ 返回可读名;
 * 纯文本编辑(路径内容/变量值输入)返回 null,保存时静默不弹 toast。
 */
function structuralChangeLabel(before: WorkspaceDraft, after: WorkspaceDraft): string | null {
  if (before.threadsRoot !== after.threadsRoot) return "线程根目录";
  if (before.readOnly !== after.readOnly) return "只读模式";
  if (before.allowedPaths.length !== after.allowedPaths.length) return "额外目录";
  if (before.sandboxEnabled !== after.sandboxEnabled) return "沙箱开关";
  if (before.sandboxTimeoutMs !== after.sandboxTimeoutMs) return "命令超时";
  if (Object.keys(before.sandboxEnv).length !== Object.keys(after.sandboxEnv).length)
    return "环境变量";
  if (before.bm25 !== after.bm25) return "BM25 搜索";
  if (before.bm25K1 !== after.bm25K1 || before.bm25B !== after.bm25B) return "BM25 参数";
  if (before.autoIndexPaths.length !== after.autoIndexPaths.length) return "自动索引路径";
  if (before.skillsPaths.length !== after.skillsPaths.length) return "技能目录";
  if (before.lsp !== after.lsp) return "LSP 检查";
  if (before.lspMaxOpenClients !== after.lspMaxOpenClients) return "LSP 客户端上限";
  if (before.tools !== after.tools) return "Workspace 工具策略";
  return null;
}

export function WorkspaceSection() {
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
          const label = before ? structuralChangeLabel(before, draft) : null;
          if (before && label) {
            toast.success(`${label}已更新`, {
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
        .catch(() => toast.error("工作区配置自动保存失败,请确认 Mastra 服务已启动"));
    }, 800);
    return () => window.clearTimeout(timer);
  }, [draft, loaded]);

  const patch = (next: Partial<WorkspaceDraft>) => setDraft({ ...draft, ...next });

  return (
    <>
      <SettingCard
        title="文件系统(LocalFilesystem)"
        description="工作区始终开启。每条线程会话绑定一个工作目录:promptInput 选定(显式)或回落线程根目录(隐式);Agent 在会话绑定目录内读写文件,路径越界由容器策略阻止(local-filesystem.mdx)。"
      >
        <Field className="space-y-2 py-4">
          <FieldContent className="space-y-1">
            <FieldTitle className="text-sm leading-none font-medium">
              线程工作区根目录(threadsRoot)
            </FieldTitle>
            <FieldDescription className="text-xs text-muted-foreground">
              未显式选定目录的线程在首条消息时自动绑定到 &lt;根目录&gt;/&lt;threadId&gt;/ (仅 Agent
              工作目录);显式选定的本地目录不受此影响
            </FieldDescription>
          </FieldContent>
          <DirectoryPickerField
            onChange={(threadsRoot) => patch({ threadsRoot })}
            value={draft.threadsRoot}
          />
        </Field>
        <SettingRow
          description="禁止写入/编辑/删除/建目录,仅保留读取与列表"
          title="只读模式(readOnly)"
        >
          <Switch checked={draft.readOnly} onCheckedChange={(v) => patch({ readOnly: v })} />
        </SettingRow>
        <DirectoryList
          description="根目录之外允许访问的目录,通过目录选择器添加"
          onChange={(allowedPaths) => patch({ allowedPaths })}
          title="额外可访问目录(allowedPaths)"
          value={draft.allowedPaths}
        />
      </SettingCard>

      <SettingCard
        title="沙箱(LocalSandbox)"
        description="execute_command 等命令执行工具,以会话绑定目录为工作目录(local-sandbox.mdx)。"
      >
        <SettingRow description="关闭后 Agent 无法执行任何 shell 命令" title="启用沙箱命令执行">
          <Switch
            checked={draft.sandboxEnabled}
            onCheckedChange={(v) => patch({ sandboxEnabled: v })}
          />
        </SettingRow>
        {draft.sandboxEnabled ? (
          <>
            <SliderRow
              description="命令执行超时时间(秒)"
              max={300}
              min={5}
              step={5}
              title="命令超时(timeout)"
              value={draft.sandboxTimeoutMs / 1000}
              onChange={(v) => patch({ sandboxTimeoutMs: v * 1000 })}
            />
            <EnvEntryList
              description="仅注入此处声明的变量(默认仅 PATH),不继承宿主环境,避免泄漏密钥"
              onChange={(sandboxEnv) => patch({ sandboxEnv })}
              title="环境变量(env)"
              value={draft.sandboxEnv}
            />
          </>
        ) : null}
      </SettingCard>

      <SettingCard
        title="搜索与代码检查"
        description="BM25 关键词搜索与 LSP 语义检查;Skills 内容亦会被索引(search.mdx / lsp.mdx)。"
      >
        <SettingRow
          description="为 Agent 提供 search / index 工具,关键词检索工作区与技能内容"
          title="BM25 关键词搜索(bm25)"
        >
          <Switch checked={draft.bm25} onCheckedChange={(v) => patch({ bm25: v })} />
        </SettingRow>
        {draft.bm25 ? (
          <RelativePathList
            description="启动时自动索引的路径或 glob(相对根目录),例如 docs 或 **/*.md"
            onChange={(autoIndexPaths) => patch({ autoIndexPaths })}
            placeholder="docs"
            title="自动索引路径(autoIndexPaths)"
            value={draft.autoIndexPaths}
          />
        ) : null}
        {draft.bm25 ? (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <SettingRow description="词频饱和参数,默认 1.5" title="BM25 k1">
              <Input
                className="w-28"
                min={0.1}
                max={5}
                step={0.1}
                type="number"
                value={draft.bm25K1}
                onChange={(event) => patch({ bm25K1: Number(event.target.value) || 1.5 })}
              />
            </SettingRow>
            <SettingRow description="文档长度归一化,默认 0.75" title="BM25 b">
              <Input
                className="w-28"
                min={0}
                max={1}
                step={0.05}
                type="number"
                value={draft.bm25B}
                onChange={(event) => patch({ bm25B: Number(event.target.value) || 0.75 })}
              />
            </SettingRow>
          </div>
        ) : null}
        <SettingRow
          description="语言服务器语义检查(诊断/定义跳转),需本机已安装对应语言服务器"
          title="LSP 代码检查(lsp)"
        >
          <Switch checked={draft.lsp} onCheckedChange={(v) => patch({ lsp: v })} />
        </SettingRow>
        {draft.lsp ? (
          <>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <SettingRow description="编辑后等待诊断的毫秒数" title="诊断超时">
                <Input
                  className="w-28"
                  min={100}
                  type="number"
                  value={draft.lspDiagnosticTimeoutMs}
                  onChange={(event) =>
                    patch({ lspDiagnosticTimeoutMs: Number(event.target.value) || 5_000 })
                  }
                />
              </SettingRow>
              <SettingRow description="语言服务器启动等待时间" title="初始化超时">
                <Input
                  className="w-28"
                  min={500}
                  type="number"
                  value={draft.lspInitTimeoutMs}
                  onChange={(event) =>
                    patch({ lspInitTimeoutMs: Number(event.target.value) || 15_000 })
                  }
                />
              </SettingRow>
              <SettingRow description="限制同时保留的语言服务器客户端数" title="客户端上限">
                <Input
                  className="w-20"
                  min={1}
                  type="number"
                  value={draft.lspMaxOpenClients}
                  onChange={(event) =>
                    patch({ lspMaxOpenClients: Number(event.target.value) || 8 })
                  }
                />
              </SettingRow>
            </div>
            <RelativePathList
              title="LSP 搜索路径(searchPaths)"
              description="额外搜索语言服务器二进制与 Node 模块的目录"
              value={draft.lspSearchPaths}
              onChange={(lspSearchPaths) => patch({ lspSearchPaths })}
              placeholder="例如 node_modules"
            />
            <RelativePathList
              title="禁用语言服务器(disableServers)"
              description="输入服务器 ID,例如 eslint 或 typescript"
              value={draft.lspDisableServers}
              onChange={(lspDisableServers) => patch({ lspDisableServers })}
              placeholder="typescript"
            />
            <EnvEntryList
              title="语言服务器二进制覆盖(binaryOverrides)"
              description="按服务器 ID 指定可执行文件路径，例如 typescript-language-server → C:\\tools\\typescript-language-server.cmd"
              value={draft.lspBinaryOverrides}
              onChange={(lspBinaryOverrides) => patch({ lspBinaryOverrides })}
            />
          </>
        ) : null}
      </SettingCard>

      <SettingCard
        title="Workspace 工具策略"
        description="直接传给 Mastra WorkspaceToolsConfig,控制写前读取、输出长度和写锁。"
      >
        <SettingRow
          title="写入前必须读取(requireReadBeforeWrite)"
          description="防止 Agent 未查看现有内容就覆盖文件"
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
            <p className="text-sm font-medium">工具启用与审批(per-tool)</p>
            <p className="text-xs text-muted-foreground">
              关闭后该 Workspace 工具不会注入 Agent；审批开关只控制工具自身的 approval 请求。
            </p>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {WORKSPACE_TOOL_OPTIONS.map(([toolName, label]) => {
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
                    {label}
                  </span>
                  <div className="flex shrink-0 items-center gap-2">
                    <span className="flex items-center gap-1 text-xs text-muted-foreground">
                      启用
                      <Switch
                        checked={rule.enabled !== false}
                        onCheckedChange={(enabled) => updateRule({ enabled })}
                      />
                    </span>
                    <span className="flex items-center gap-1 text-xs text-muted-foreground">
                      审批
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
        <SettingRow
          title="默认工具输出上限(maxOutputTokens)"
          description="仅用于内置后台进程读取工具；前台命令 stdout/stderr 会完整归档"
        >
          <Input
            className="w-32"
            min={1}
            type="number"
            value={draft.tools.maxOutputTokens ?? 3_000}
            onChange={(event) =>
              patch({
                tools: { ...draft.tools, maxOutputTokens: Number(event.target.value) || 3_000 },
              })
            }
          />
        </SettingRow>
        <SettingRow
          title="写锁超时(writeLockTimeoutMs)"
          description="单次写入持有文件锁的最长毫秒数"
        >
          <Input
            className="w-32"
            min={1_000}
            type="number"
            value={draft.tools.writeLockTimeoutMs ?? 30_000}
            onChange={(event) =>
              patch({
                tools: { ...draft.tools, writeLockTimeoutMs: Number(event.target.value) || 30_000 },
              })
            }
          />
        </SettingRow>
      </SettingCard>

      <SettingCard
        title="Skills"
        description="SKILL.md 技能目录(skills.mdx):Agent 可按需加载技能指令与配套文件。"
      >
        <RelativePathList
          description="相对工作区根目录,支持 glob(如 **/skills);含 SKILL.md 的文件夹即一个技能"
          onChange={(skillsPaths) => patch({ skillsPaths })}
          placeholder="skills"
          title="技能目录(skillsPaths)"
          value={draft.skillsPaths}
        />
      </SettingCard>
    </>
  );
}
