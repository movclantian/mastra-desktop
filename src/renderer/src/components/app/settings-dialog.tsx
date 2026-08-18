import {
  BrainIcon,
  ChevronDownIcon,
  DatabaseIcon,
  EyeIcon,
  EyeOffIcon,
  FolderOpenIcon,
  HardDriveDownloadIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  ServerIcon,
  Trash2Icon,
} from "lucide-react";
import { nanoid } from "nanoid";
import * as React from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from "@/components/ui/sidebar";
import { Slider } from "@/components/ui/slider";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import {
  type EnabledModel,
  fetchProviderModels,
  getCachedProviderModels,
  getModelCapabilities,
  MASTRA_SERVER_URL,
  PROVIDER_PRESETS,
  type ProviderConfig,
  type ProviderType,
} from "@/lib/providers";
import { useWorkbench } from "@/lib/workbench";

// 布局照搬 .vscode/1.txt(shadcn 官方 Settings Dialog):
// Dialog 内嵌 SidebarProvider + Sidebar(collapsible="none") 左侧导航,
// 右侧 main = Breadcrumb header + 滚动内容区。

// ---------------------------------------------------------------------------
// 通用设置行:左侧标题+描述,右侧控件(shadcn 设置页典型样式)
// ---------------------------------------------------------------------------

function SettingRow({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-4">
      <div className="min-w-0 space-y-1">
        <p className="text-sm leading-none font-medium">{title}</p>
        {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
      </div>
      {children ? <div className="flex shrink-0 items-center gap-2">{children}</div> : null}
    </div>
  );
}

/** 独立设置卡片:rounded-lg border + 分隔线层次 */
function SettingCard({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="max-w-2xl rounded-xl border">
      <header className="border-b px-4 py-3">
        <p className="text-sm font-medium">{title}</p>
        {description ? <p className="mt-1 text-xs text-muted-foreground">{description}</p> : null}
      </header>
      <div className="divide-y px-4">{children}</div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// 模型供应商(BYOK)
// ---------------------------------------------------------------------------

function AddProviderForm({ onDone }: { onDone: () => void }) {
  const { providers, setProviders } = useWorkbench();
  const [name, setName] = React.useState("");
  const [type, setType] = React.useState<ProviderType>("openai-compatible");
  const preset = PROVIDER_PRESETS.find((p) => p.type === type);
  const [url, setUrl] = React.useState(preset?.urls[0] ?? "");
  const [apiKey, setApiKey] = React.useState("");

  const handleTypeChange = (next: string) => {
    setType(next as ProviderType);
    const nextPreset = PROVIDER_PRESETS.find((p) => p.type === next);
    setUrl(nextPreset?.urls[0] ?? "");
  };

  const handleSubmit = () => {
    if (!name.trim() || !url.trim() || !apiKey.trim()) {
      toast.error("请完整填写供应商名称、接口地址和 API Key");
      return;
    }
    const provider: ProviderConfig = {
      id: `provider-${nanoid(6)}`,
      name: name.trim(),
      type,
      url: url.trim(),
      apiKey: apiKey.trim(),
      enabledModels: [],
    };
    setProviders([...providers, provider]);
    setName("");
    setApiKey("");
    onDone();
  };

  return (
    <section className="max-w-2xl rounded-xl border">
      <header className="border-b px-4 py-3">
        <p className="text-sm font-medium">添加供应商</p>
        <p className="mt-1 text-xs text-muted-foreground">
          选择接口类型,填入你的 API Key 即可启用 BYOK。
        </p>
      </header>
      <div className="grid gap-4 px-4 py-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="provider-name">供应商名称</Label>
          <Input
            id="provider-name"
            placeholder="例如:我的 OpenAI"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label>供应商接口</Label>
          <NativeSelect
            className="w-full"
            value={type}
            onChange={(e) => handleTypeChange(e.target.value)}
          >
            {PROVIDER_PRESETS.map((p) => (
              <NativeSelectOption key={p.type} value={p.type}>
                {p.label}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        <div className="space-y-2">
          <Label htmlFor="provider-url">接口地址</Label>
          <NativeSelect className="w-full" value={url} onChange={(e) => setUrl(e.target.value)}>
            {[...(preset?.urls ?? []), url]
              .filter((u, i, arr) => arr.indexOf(u) === i)
              .map((u) => (
                <NativeSelectOption key={u} value={u}>
                  {u}
                </NativeSelectOption>
              ))}
          </NativeSelect>
        </div>
        <div className="space-y-2">
          <Label htmlFor="provider-key">API Key</Label>
          <Input
            id="provider-key"
            type="password"
            placeholder="sk-..."
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
        </div>
      </div>
      <footer className="flex justify-end border-t px-4 py-3">
        <Button size="sm" onClick={handleSubmit}>
          <PlusIcon />
          添加供应商
        </Button>
      </footer>
    </section>
  );
}

function CapabilityBadges({ provider, modelId }: { provider: ProviderConfig; modelId: string }) {
  const { catalog } = useWorkbench();
  const caps = getModelCapabilities(provider.type, modelId, catalog);
  return (
    <div className="flex flex-wrap gap-1">
      {caps.reasoning ? <Badge variant="secondary">推理</Badge> : null}
      {caps.vision ? <Badge variant="secondary">视觉</Badge> : null}
      {caps.audio ? <Badge variant="secondary">音频</Badge> : null}
      {caps.tools ? <Badge variant="secondary">工具</Badge> : null}
    </div>
  );
}

function ProviderItem({
  provider,
  editing,
  onEditToggle,
}: {
  provider: ProviderConfig;
  editing: boolean;
  onEditToggle: () => void;
}) {
  const { providers, setProviders } = useWorkbench();
  const [expanded, setExpanded] = React.useState(false);
  const [models, setModels] = React.useState<EnabledModel[] | null>(
    getCachedProviderModels(provider.id),
  );
  const [loadingModels, setLoadingModels] = React.useState(false);
  const [showKey, setShowKey] = React.useState(false);
  const [draft, setDraft] = React.useState(provider);

  const handleExpand = async () => {
    const next = !expanded;
    setExpanded(next);
    if (next && !models) {
      setLoadingModels(true);
      try {
        setModels(await fetchProviderModels(provider));
        toast.success(`已缓存 ${provider.name} 的模型列表`);
      } catch (error) {
        toast.error((error as Error).message);
      } finally {
        setLoadingModels(false);
      }
    }
  };

  const toggleModel = (model: EnabledModel) => {
    const exists = provider.enabledModels.some((m) => m.id === model.id);
    const enabledModels = exists
      ? provider.enabledModels.filter((m) => m.id !== model.id)
      : [...provider.enabledModels, model];
    setProviders(providers.map((p) => (p.id === provider.id ? { ...p, enabledModels } : p)));
  };

  const saveEdit = () => {
    setProviders(providers.map((p) => (p.id === provider.id ? draft : p)));
    onEditToggle();
  };

  const removeProvider = () => {
    setProviders(providers.filter((p) => p.id !== provider.id));
  };

  return (
    <section className="max-w-2xl overflow-hidden rounded-xl border">
      {/* 头部:名称 + 操作 */}
      <div className="flex items-center gap-2 px-4 py-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{provider.name}</p>
          <p className="truncate text-xs text-muted-foreground">
            {PROVIDER_PRESETS.find((p) => p.type === provider.type)?.label} · {provider.url}
          </p>
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon-sm" onClick={onEditToggle} aria-label="编辑">
            <PencilIcon />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => void handleExpand()}
            aria-label="展开模型列表"
          >
            <ChevronDownIcon
              className={expanded ? "rotate-180 transition-transform" : "transition-transform"}
            />
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={removeProvider} aria-label="删除供应商">
            <Trash2Icon />
          </Button>
        </div>
      </div>

      {/* 编辑态 */}
      {editing ? (
        <div className="grid gap-4 border-t px-4 py-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label>供应商名称</Label>
            <Input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </div>
          <div className="space-y-2">
            <Label>接口地址</Label>
            <Input
              value={draft.url}
              onChange={(e) => setDraft({ ...draft, url: e.target.value })}
            />
          </div>
          <div className="space-y-2 sm:col-span-2">
            <Label>API Key</Label>
            <div className="flex gap-2">
              <Input
                type={showKey ? "text" : "password"}
                value={draft.apiKey}
                onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })}
              />
              <Button
                variant="outline"
                size="icon"
                onClick={() => setShowKey(!showKey)}
                aria-label="显示/隐藏 Key"
              >
                {showKey ? <EyeOffIcon /> : <EyeIcon />}
              </Button>
            </div>
          </div>
          <div className="flex gap-2 sm:col-span-2">
            <Button size="sm" onClick={saveEdit}>
              保存
            </Button>
            <Button size="sm" variant="outline" onClick={onEditToggle}>
              取消
            </Button>
          </div>
        </div>
      ) : null}

      {/* 模型列表 */}
      <Collapsible open={expanded}>
        <CollapsibleContent>
          <div className="border-t">
            {loadingModels ? (
              <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
                <Spinner className="size-4" />
                正在拉取模型列表...
              </div>
            ) : models ? (
              <div className="max-h-64 divide-y overflow-y-auto">
                {models.map((model) => {
                  const enabled = provider.enabledModels.some((m) => m.id === model.id);
                  return (
                    <div key={model.id} className="flex items-center gap-3 px-4 py-2.5">
                      <Switch
                        checked={enabled}
                        onCheckedChange={() => toggleModel(model)}
                        aria-label={`启用 ${model.name}`}
                      />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm">{model.name}</p>
                        <p className="truncate font-mono text-xs text-muted-foreground">
                          {model.id}
                        </p>
                      </div>
                      <CapabilityBadges provider={provider} modelId={model.id} />
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="flex items-center justify-center py-4">
                <Button variant="outline" size="sm" onClick={() => void handleExpand()}>
                  <RefreshCwIcon />
                  拉取模型列表
                </Button>
              </div>
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </section>
  );
}

function ProvidersSection() {
  const { providers } = useWorkbench();
  const [showAdd, setShowAdd] = React.useState(false);
  const [editingId, setEditingId] = React.useState<string | null>(null);

  return (
    <>
      <div className="flex items-center justify-between pr-4">
        <p className="text-sm text-muted-foreground">
          填写你自己的 API Key,模型列表自动从供应商接口拉取并缓存。
        </p>
        <Button
          size="sm"
          variant={showAdd ? "ghost" : "default"}
          onClick={() => setShowAdd(!showAdd)}
        >
          <PlusIcon />
          添加
        </Button>
      </div>

      {showAdd ? <AddProviderForm onDone={() => setShowAdd(false)} /> : null}

      {providers.length === 0 && !showAdd ? (
        <p className="max-w-2xl rounded-xl border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
          还没有供应商,点击「添加」开始。
        </p>
      ) : (
        providers.map((provider) => (
          <ProviderItem
            key={provider.id}
            provider={provider}
            editing={editingId === provider.id}
            onEditToggle={() => setEditingId(editingId === provider.id ? null : provider.id)}
          />
        ))
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// 记忆(暴露 Memory 可配置项,写入 memory-config.json,重启生效)
// ---------------------------------------------------------------------------

interface MemoryDraft {
  lastMessages: number;
  semanticRecall: boolean;
  semanticRecallTopK: number;
  workingMemory: boolean;
  workingMemoryScope: "resource" | "thread";
}

function MemorySection() {
  const [draft, setDraft] = React.useState<MemoryDraft>({
    lastMessages: 20,
    semanticRecall: false,
    semanticRecallTopK: 3,
    workingMemory: false,
    workingMemoryScope: "resource",
  });
  const [saving, setSaving] = React.useState(false);
  const [loaded, setLoaded] = React.useState(false);

  React.useEffect(() => {
    if (loaded) return;
    fetch(`${MASTRA_SERVER_URL}/api/work/memory`)
      .then((r) => (r.ok ? r.json() : null))
      .then((config) => {
        if (config) setDraft((prev) => ({ ...prev, ...config }) as MemoryDraft);
      })
      .catch(() => undefined)
      .finally(() => setLoaded(true));
  }, [loaded]);

  const save = async () => {
    setSaving(true);
    try {
      const response = await fetch(`${MASTRA_SERVER_URL}/api/work/memory`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
      if (!response.ok) throw new Error(String(response.status));
      toast.success("记忆配置已保存,重启 Mastra 服务后生效");
    } catch {
      toast.error("保存失败,请确认 Mastra 服务已启动");
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <SettingCard
        title="消息历史"
        description="对应 Mastra Memory 的 lastMessages / semanticRecall 配置。"
      >
        <div className="py-4">
          <div className="flex items-center justify-between">
            <div className="space-y-1">
              <p className="text-sm font-medium">最近消息数(lastMessages)</p>
              <p className="text-xs text-muted-foreground">每次请求注入的最近消息条数</p>
            </div>
            <span className="w-10 text-right text-sm font-medium tabular-nums">
              {draft.lastMessages}
            </span>
          </div>
          <Slider
            className="mt-4"
            value={[draft.lastMessages]}
            min={5}
            max={100}
            step={5}
            onValueChange={(value) =>
              setDraft({
                ...draft,
                lastMessages: Array.isArray(value) ? value[0] : value,
              })
            }
          />
        </div>
        <div>
          <SettingRow title="语义召回(semanticRecall)" description="按语义相似度召回历史消息">
            <Switch
              checked={draft.semanticRecall}
              onCheckedChange={(v) => setDraft({ ...draft, semanticRecall: v })}
            />
          </SettingRow>
          {draft.semanticRecall ? (
            <div className="pb-4">
              <div className="flex items-center justify-between">
                <p className="text-sm text-muted-foreground">召回条数(topK)</p>
                <span className="text-sm font-medium tabular-nums">{draft.semanticRecallTopK}</span>
              </div>
              <Slider
                className="mt-3"
                value={[draft.semanticRecallTopK]}
                min={1}
                max={10}
                step={1}
                onValueChange={(value) =>
                  setDraft({
                    ...draft,
                    semanticRecallTopK: Array.isArray(value) ? value[0] : value,
                  })
                }
              />
            </div>
          ) : null}
        </div>
      </SettingCard>

      <SettingCard
        title="工作记忆(workingMemory)"
        description="跨轮维护的用户画像记忆,对应 workingMemory 配置。"
      >
        <SettingRow title="启用工作记忆" description="跨轮维护的用户画像记忆">
          <Switch
            checked={draft.workingMemory}
            onCheckedChange={(v) => setDraft({ ...draft, workingMemory: v })}
          />
        </SettingRow>
        {draft.workingMemory ? (
          <div className="flex items-center justify-between gap-4 py-4">
            <p className="text-sm text-muted-foreground">记忆范围(scope)</p>
            <NativeSelect
              className="w-56"
              value={draft.workingMemoryScope}
              onChange={(e) =>
                setDraft({ ...draft, workingMemoryScope: e.target.value as "resource" | "thread" })
              }
            >
              <NativeSelectOption value="resource">resource(跨线程,用户级)</NativeSelectOption>
              <NativeSelectOption value="thread">thread(线程内)</NativeSelectOption>
            </NativeSelect>
          </div>
        ) : null}
      </SettingCard>

      <div className="flex justify-end">
        <Button size="sm" disabled={saving} onClick={() => void save()}>
          {saving ? <Spinner className="size-4" /> : <BrainIcon />}
          保存记忆配置
        </Button>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// 存储(目录展示 / 打开目录 / 更改位置 / 一键重置)
// ---------------------------------------------------------------------------

function StorageSection() {
  const [info, setInfo] = React.useState<{ url: string; directory: string } | null>(null);
  const [newDirectory, setNewDirectory] = React.useState("");
  const [resetConfirm, setResetConfirm] = React.useState(false);

  const loadInfo = React.useCallback(() => {
    fetch(`${MASTRA_SERVER_URL}/api/work/storage`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data) {
          setInfo(data);
          setNewDirectory(data.directory);
        }
      })
      .catch(() => undefined);
  }, []);

  React.useEffect(() => {
    loadInfo();
  }, [loadInfo]);

  const openDirectory = () => {
    if (info) void window.api.openDirectory(info.directory);
  };

  const changeLocation = async () => {
    if (!newDirectory.trim()) return;
    const response = await fetch(`${MASTRA_SERVER_URL}/api/work/storage/location`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ directory: newDirectory.trim() }),
    });
    if (response.ok) {
      toast.success("存储位置已更新,重启 Mastra 服务后生效");
      loadInfo();
    } else {
      toast.error("更新失败,请确认 Mastra 服务已启动");
    }
  };

  const resetApp = () => {
    void window.api.resetAppData();
  };

  return (
    <>
      <SettingCard
        title="存储目录"
        description="LibSQL(threads/记忆)+ DuckDB(observability)复合存储。"
      >
        <div className="space-y-3 py-4">
          <div className="flex items-center gap-2">
            <DatabaseIcon className="size-4 shrink-0 text-muted-foreground" />
            <p className="break-all font-mono text-xs text-muted-foreground">
              {info?.directory ?? "正在读取..."}
            </p>
          </div>
          {info?.url ? (
            <p className="break-all pl-6 font-mono text-xs text-muted-foreground">{info.url}</p>
          ) : null}
          <Button variant="outline" size="sm" onClick={openDirectory} disabled={!info}>
            <FolderOpenIcon />
            打开存储目录
          </Button>
        </div>
      </SettingCard>

      <SettingCard
        title="更改存储位置"
        description="输入新目录绝对路径,保存后重启 Mastra 服务即完成存储迁移。"
      >
        <div className="space-y-3 py-4">
          <div className="flex items-center gap-2">
            <HardDriveDownloadIcon className="size-4 shrink-0 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">迁移目标目录</p>
          </div>
          <Input
            placeholder="D:\mastra-data"
            value={newDirectory}
            onChange={(e) => setNewDirectory(e.target.value)}
          />
          <Button size="sm" onClick={() => void changeLocation()}>
            保存新位置
          </Button>
        </div>
      </SettingCard>

      <SettingCard title="危险区" description="重置将清空全部本地数据且不可恢复。">
        <div className="space-y-3 py-4">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <p className="text-sm font-medium text-destructive">重置软件数据</p>
              <p className="text-xs text-muted-foreground">
                清空全部本地数据(线程、供应商配置、存储文件),应用将自动重启。
              </p>
            </div>
            {!resetConfirm ? (
              <Button variant="destructive" size="sm" onClick={() => setResetConfirm(true)}>
                <Trash2Icon />
                一键重置
              </Button>
            ) : (
              <div className="flex shrink-0 gap-2">
                <Button variant="destructive" size="sm" onClick={resetApp}>
                  确认重置并重启
                </Button>
                <Button variant="outline" size="sm" onClick={() => setResetConfirm(false)}>
                  取消
                </Button>
              </div>
            )}
          </div>
        </div>
      </SettingCard>
    </>
  );
}

// ---------------------------------------------------------------------------
// 设置弹窗:照搬 .vscode/1.txt 官方布局
// ---------------------------------------------------------------------------

const SECTIONS = [
  { id: "providers", label: "模型供应商", icon: ServerIcon },
  { id: "memory", label: "记忆", icon: BrainIcon },
  { id: "storage", label: "存储", icon: DatabaseIcon },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

export function SettingsDialog() {
  const { settingsOpen, setSettingsOpen } = useWorkbench();
  const [section, setSection] = React.useState<SectionId>("providers");
  const current = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0];

  return (
    <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
      <DialogContent className="overflow-hidden p-0 md:max-h-[500px] md:max-w-[700px] lg:max-w-[800px]">
        <DialogTitle className="sr-only">设置</DialogTitle>
        <DialogDescription className="sr-only">自定义 MastraWork 设置。</DialogDescription>
        <SidebarProvider className="items-start">
          <Sidebar collapsible="none" className="hidden md:flex">
            <SidebarContent>
              <SidebarGroup>
                <SidebarGroupContent>
                  <SidebarMenu>
                    {SECTIONS.map((s) => (
                      <SidebarMenuItem key={s.id}>
                        <SidebarMenuButton
                          isActive={section === s.id}
                          onClick={() => setSection(s.id)}
                        >
                          <s.icon />
                          <span>{s.label}</span>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    ))}
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            </SidebarContent>
          </Sidebar>
          <main className="flex h-[480px] flex-1 flex-col overflow-hidden">
            <header className="flex h-16 shrink-0 items-center gap-2 transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-12">
              <div className="flex items-center gap-2 px-4">
                <Breadcrumb>
                  <BreadcrumbList>
                    <BreadcrumbItem className="hidden md:block">
                      <BreadcrumbPage>设置</BreadcrumbPage>
                    </BreadcrumbItem>
                    <BreadcrumbSeparator className="hidden md:block" />
                    <BreadcrumbItem>
                      <BreadcrumbPage>{current.label}</BreadcrumbPage>
                    </BreadcrumbItem>
                  </BreadcrumbList>
                </Breadcrumb>
              </div>
            </header>
            <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-4 pt-0">
              {section === "providers" ? <ProvidersSection /> : null}
              {section === "memory" ? <MemorySection /> : null}
              {section === "storage" ? <StorageSection /> : null}
            </div>
          </main>
        </SidebarProvider>
      </DialogContent>
    </Dialog>
  );
}
