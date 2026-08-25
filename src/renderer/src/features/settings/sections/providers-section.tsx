import {
  BanIcon,
  ChevronDownIcon,
  ExternalLinkIcon,
  FlaskConicalIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  Trash2Icon,
} from "lucide-react";
import { nanoid } from "nanoid";
import * as React from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Dotm3x3_1 } from "@/components/ui/dotm-3x3-1";
import { DotmCircular4 } from "@/components/ui/dotm-circular-4";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  type EnabledModel,
  fetchProviderModels,
  formatModelContextWindow,
  GATEWAY_PROTOCOLS,
  type GatewayProtocol,
  getCachedProviderModels,
  getModelCapabilities,
  getModelContextWindow,
  getModelDisplayName,
  invalidateProviderModelsCache,
  normalizeGatewayUrl,
  type ProviderConfig,
  type RegistryProvider,
  testProviderModel,
  useRegistry,
} from "@/features/providers";
import { useWorkbench } from "@/features/workbench";
import { toastError } from "@/lib/errors";
import { CapabilityBadges } from "../components/controls";

// ---------------------------------------------------------------------------
// 模型供应商(BYOK)
// ---------------------------------------------------------------------------

export const CUSTOM_GATEWAY_VALUE = "__custom_gateway__";

/** 添加/编辑供应商:统一弹窗表单(editProvider 存在时为编辑模式) */
export function AddProviderDialog({
  registry,
  open,
  onOpenChange,
  editProvider,
}: {
  registry: RegistryProvider[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editProvider?: ProviderConfig | null;
}) {
  const { openBrowserUrl, providers, setProviders } = useWorkbench();
  // selection:内置供应商 registry id,或 CUSTOM_GATEWAY_VALUE
  const [selection, setSelection] = React.useState<string>(registry[0]?.id ?? CUSTOM_GATEWAY_VALUE);
  const [name, setName] = React.useState("");
  const [protocol, setProtocol] = React.useState<GatewayProtocol>("openai");
  const [baseUrl, setBaseUrl] = React.useState("");
  const [useResponses, setUseResponses] = React.useState(false);
  const [apiKey, setApiKey] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);

  const isCustom = selection === CUSTOM_GATEWAY_VALUE;
  const registryProvider = registry.find((p) => p.id === selection);

  // 打开时初始化表单(编辑模式灌入现有配置)
  React.useEffect(() => {
    if (!open) return;
    if (editProvider) {
      setSelection(editProvider.registryId ?? CUSTOM_GATEWAY_VALUE);
      setName(editProvider.name);
      setProtocol(editProvider.protocol ?? "openai");
      setBaseUrl(editProvider.baseUrl ?? "");
      setUseResponses(Boolean(editProvider.useResponses));
      setApiKey(editProvider.apiKey);
    } else {
      setSelection(registry[0]?.id ?? CUSTOM_GATEWAY_VALUE);
      setName("");
      setProtocol("openai");
      setBaseUrl("");
      setUseResponses(false);
      setApiKey("");
    }
  }, [open, editProvider, registry]);

  const handleSubmit = async () => {
    if (isCustom && !name.trim()) {
      toast.error("请填写供应商名称");
      return;
    }
    if (isCustom && !baseUrl.trim()) {
      toast.error("请填写网关 Base URL");
      return;
    }
    if (!apiKey.trim()) {
      toast.error("请填写 API Key");
      return;
    }

    // 编辑模式:更新既有配置(保留 id 与已启用模型);连接信息变了立即失效
    // 模型列表缓存,否则展开看到的仍是旧网关/旧 Key 拉到的列表
    if (editProvider) {
      const updated: ProviderConfig = {
        ...editProvider,
        apiKey: apiKey.trim(),
        ...(isCustom
          ? {
              name: name.trim(),
              protocol,
              baseUrl: normalizeGatewayUrl(baseUrl, protocol),
              useResponses: protocol === "openai" ? useResponses : false,
            }
          : { name: registryProvider?.name ?? editProvider.name }),
      };
      invalidateProviderModelsCache(editProvider.id);
      setProviders(providers.map((p) => (p.id === editProvider.id ? updated : p)));
      toast.success(`已更新 ${updated.name}`);
      onOpenChange(false);
      return;
    }

    const provider: ProviderConfig = {
      id: `provider-${nanoid(6)}`,
      name: isCustom ? name.trim() : (registryProvider?.name ?? selection),
      ...(isCustom
        ? {
            protocol,
            baseUrl: normalizeGatewayUrl(baseUrl, protocol),
            useResponses: protocol === "openai" ? useResponses : false,
          }
        : { registryId: selection }),
      apiKey: apiKey.trim(),
      enabledModels: [],
    };
    setProviders([...providers, provider]);
    setSubmitting(true);
    // 添加后立即拉取模型列表并缓存(内置供应商走 registry 缓存,零网络成本)
    try {
      const models = await fetchProviderModels(provider, registry);
      toast.success(`已添加 ${provider.name},共 ${models.length} 个可用模型`);
    } catch (error) {
      toast.warning(`供应商已添加,但模型列表拉取失败:${(error as Error).message}`);
    } finally {
      setSubmitting(false);
      onOpenChange(false);
    }
  };

  // select-demo.tsx 的 Select 用法(items 提供 value→label 映射)
  const providerItems = [
    { value: CUSTOM_GATEWAY_VALUE, label: "自定义网关 (Custom Gateway)" },
    ...registry.map((p) => ({ value: p.id, label: p.name })),
  ];
  const protocolItems = GATEWAY_PROTOCOLS.map((p) => ({
    value: p.value,
    label: p.label,
  }));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{editProvider ? "编辑供应商" : "添加供应商"}</DialogTitle>
          <DialogDescription>
            {editProvider
              ? "更新配置;Key 或网关地址变更后请重新拉取模型列表。"
              : "从 Mastra 内置供应商列表预选并填入你的 API Key;或选择自定义网关。"}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label>模型供应商</Label>
            <Select
              items={providerItems}
              value={selection}
              disabled={Boolean(editProvider)}
              onValueChange={(v) => setSelection(v ?? CUSTOM_GATEWAY_VALUE)}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {providerItems.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {isCustom ? (
            <>
              <div className="flex flex-col gap-2">
                <Label htmlFor="provider-name">供应商名称</Label>
                <Input
                  id="provider-name"
                  placeholder="例如:我的聚合网关"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label>网关协议</Label>
                <Select
                  items={protocolItems}
                  value={protocol}
                  onValueChange={(v) => setProtocol((v ?? "openai") as GatewayProtocol)}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {protocolItems.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {protocol === "anthropic"
                    ? "走 Anthropic 官方 Messages API({baseURL}/messages),API Key 环境变量名同内置供应商"
                    : protocol === "gemini"
                      ? "走 Google Gemini 原生 API({baseURL}/models/…:generateContent)"
                      : "走 OpenAI Chat Completions({baseURL}/chat/completions);勾选 Responses 则走 {baseURL}/responses"}
                </p>
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="gateway-url">Base URL</Label>
                <div className="flex items-center gap-3">
                  <Input
                    id="gateway-url"
                    className="flex-1"
                    placeholder="www.example.com/v1"
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                    // 失焦即归一化回显:裸域名在 openai 协议下自动补 /v1,
                    // 已带路径的端点原样保留,用户当场看到最终生效的 URL
                    onBlur={() => setBaseUrl((current) => normalizeGatewayUrl(current, protocol))}
                  />
                  {protocol === "openai" ? (
                    <label
                      htmlFor="use-responses"
                      className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground"
                    >
                      <Checkbox
                        id="use-responses"
                        checked={useResponses}
                        onCheckedChange={(v) => setUseResponses(Boolean(v))}
                      />
                      Responses
                    </label>
                  ) : null}
                </div>
                <p className="text-xs text-muted-foreground">
                  协议对应的 API 根地址(含版本段,如 …/v1),非具体 chat 端点
                </p>
              </div>
            </>
          ) : registryProvider?.docUrl ? (
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              onClick={() => openBrowserUrl(registryProvider.docUrl)}
            >
              <ExternalLinkIcon />
              供应商官网 / 获取 API Key
            </Button>
          ) : null}

          <div className="flex flex-col gap-2">
            <Label htmlFor="provider-key">API Key</Label>
            <Input
              id="provider-key"
              type="password"
              placeholder={registryProvider?.apiKeyEnvVar || "sk-..."}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !submitting) void handleSubmit();
              }}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button disabled={submitting} onClick={() => void handleSubmit()}>
            {submitting ? (
              <Dotm3x3_1 size={14} dotSize={2.2} colorPreset="solid-theme" />
            ) : (
              <PlusIcon />
            )}
            {editProvider ? "保存修改" : "添加供应商"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
export function ProviderItem({
  provider,
  registry,
  onEdit,
}: {
  provider: ProviderConfig;
  registry: RegistryProvider[];
  onEdit: () => void;
}) {
  const { providers, setProviders } = useWorkbench();
  const [expanded, setExpanded] = React.useState(false);
  const [models, setModels] = React.useState<EnabledModel[] | null>(
    getCachedProviderModels(provider.id),
  );
  const [loadingModels, setLoadingModels] = React.useState(false);
  const [refreshing, setRefreshing] = React.useState(false);

  // 连接身份(协议/端点/Key/Responses 开关)变化 = 缓存已失效(编辑保存时已清),
  // 重置本条已加载的列表,展开时重新拉取
  const connectionKey = `${provider.protocol ?? ""}|${provider.baseUrl ?? ""}|${provider.apiKey}|${provider.useResponses ?? false}`;
  const lastConnectionRef = React.useRef(connectionKey);
  React.useEffect(() => {
    if (lastConnectionRef.current === connectionKey) return;
    lastConnectionRef.current = connectionKey;
    setModels(getCachedProviderModels(provider.id));
  }, [connectionKey, provider.id]);

  const protocolLabel = GATEWAY_PROTOCOLS.find((p) => p.value === provider.protocol)?.label;

  const handleExpand = async () => {
    const next = !expanded;
    setExpanded(next);
    if (next && !models) {
      setLoadingModels(true);
      try {
        setModels(await fetchProviderModels(provider, registry));
      } catch (error) {
        toastError(error);
      } finally {
        setLoadingModels(false);
      }
    }
  };

  /**
   * 手动刷新(提升到本组件:models 状态的唯一数据源)。fetchProviderModels
   * 会重建会话内缓存;这里同步更新自身状态,收起再展开看到的才是新列表,
   * 并补回网关列表里没有的自定义模型 ID。
   */
  const refreshModels = async () => {
    setRefreshing(true);
    try {
      const fetched = await fetchProviderModels(provider, registry);
      const fetchedIds = new Set(fetched.map((model) => model.id));
      const customModels = provider.enabledModels.filter((model) => !fetchedIds.has(model.id));
      setModels([...fetched, ...customModels]);
    } catch (error) {
      toastError(error);
    } finally {
      setRefreshing(false);
    }
  };

  const removeProvider = () => {
    invalidateProviderModelsCache(provider.id);
    setProviders(providers.filter((p) => p.id !== provider.id));
  };

  const toggleDisabled = () => {
    setProviders(
      providers.map((p) => (p.id === provider.id ? { ...p, disabled: !p.disabled } : p)),
    );
  };

  return (
    <div className="w-full overflow-hidden rounded-xl border border-border bg-card shadow-xs transition-colors hover:border-border/80">
      <section className="w-full">
        {/* 头部:名称 + 操作(禁用 / 编辑 / 展开 / 删除) */}
        <div
          className={`flex items-center gap-2 px-4 py-3 ${provider.disabled ? "opacity-60" : ""}`}
        >
          <div className="min-w-0 flex-1">
            <p className="flex flex-wrap items-center gap-2 break-words text-sm font-medium">
              {provider.name}
              {provider.disabled ? <Badge variant="secondary">已禁用</Badge> : null}
            </p>
            <p
              className="break-all text-xs text-muted-foreground"
              title={
                provider.registryId
                  ? `内置 · ${provider.registryId}`
                  : `${protocolLabel}${provider.useResponses ? " · Responses" : ""} · ${provider.baseUrl}`
              }
            >
              {provider.registryId
                ? `内置 · ${provider.registryId}`
                : `${protocolLabel}${provider.useResponses ? " · Responses" : ""} · ${provider.baseUrl}`}
            </p>
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={toggleDisabled}
              aria-label={provider.disabled ? "启用供应商" : "禁用供应商"}
            >
              <BanIcon />
            </Button>
            <Button variant="ghost" size="icon-sm" onClick={onEdit} aria-label="编辑">
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

        {/* 模型列表:搜索过滤 + 无结果时可添加自定义模型 ID + 每行连接测试 */}
        <Collapsible open={expanded}>
          <CollapsibleContent>
            <div className="border-t border-border/60 bg-muted/20">
              {loadingModels ? (
                <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
                  {/* 雷达点阵 = 正在向远端拉取,与本地保存态的螺旋点阵区分 */}
                  <DotmCircular4 size={16} dotSize={1.8} colorPreset="solid-theme" />
                  正在拉取模型列表...
                </div>
              ) : models ? (
                <ModelListSection
                  models={models}
                  onRefresh={() => void refreshModels()}
                  provider={provider}
                  refreshing={refreshing}
                />
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
    </div>
  );
}

/** 模型列表区块:模糊搜索 / 无结果添加自定义 ID / 每行连接测试 / 手动刷新 */
export function ModelListSection({
  provider,
  models: initialModels,
  onRefresh,
  refreshing,
}: {
  provider: ProviderConfig;
  models: EnabledModel[];
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const { providers, setProviders, catalog } = useWorkbench();
  const [models, setModels] = React.useState(initialModels);
  const [query, setQuery] = React.useState("");
  const [testingId, setTestingId] = React.useState<string | null>(null);

  // 自定义模型只保存在 provider.enabledModels 中,重新拉取网关模型后要补回列表。
  const initialModelIds = React.useMemo(
    () => new Set(initialModels.map((model) => model.id)),
    [initialModels],
  );
  // 父组件(ProviderItem)刷新后传入新列表,同步覆盖本地状态;
  // 不同步的话收起再展开会用旧 prop 重新初始化,又回到旧内容
  React.useEffect(() => {
    setModels(initialModels);
  }, [initialModels]);
  React.useEffect(() => {
    setModels((current) => {
      const currentIds = new Set(current.map((model) => model.id));
      const persistedCustomModels = provider.enabledModels.filter(
        (model) => !currentIds.has(model.id),
      );
      return persistedCustomModels.length > 0 ? [...current, ...persistedCustomModels] : current;
    });
  }, [provider.enabledModels]);

  const normalizedQuery = query.trim().toLowerCase();
  const filtered = normalizedQuery
    ? models.filter(
        (m) =>
          m.id.toLowerCase().includes(normalizedQuery) ||
          m.name.toLowerCase().includes(normalizedQuery),
      )
    : models;
  const enabledIds = new Set(provider.enabledModels.map((model) => model.id));
  const orderedModels = [...filtered].sort(
    (a, b) => Number(enabledIds.has(b.id)) - Number(enabledIds.has(a.id)),
  );
  const canAddCustom = normalizedQuery.length > 0 && filtered.length === 0;

  const patchProvider = (patch: Partial<ProviderConfig>) => {
    setProviders(providers.map((p) => (p.id === provider.id ? { ...p, ...patch } : p)));
  };

  const addCustomModel = () => {
    const id = query.trim();
    if (!id || !canAddCustom) return;
    const customModel = { id, name: id };
    setModels((prev) => (prev.some((model) => model.id === id) ? prev : [...prev, customModel]));
    patchProvider({ enabledModels: [...provider.enabledModels, { id, name: id }] });
    setQuery("");
    toast.success(`已添加自定义模型 ${id}`);
  };

  const runTest = async (modelId: string) => {
    setTestingId(modelId);
    const startedAt = performance.now();
    try {
      const result = await testProviderModel(provider, modelId);
      const elapsed = Math.round(performance.now() - startedAt);
      if (result.ok) {
        toast.success(`${modelId} 连接成功(${elapsed}ms):${result.reply ?? ""}`);
      } else {
        toast.error(`${modelId} 测试失败:${result.error ?? "未知错误"}`);
      }
    } finally {
      setTestingId(null);
    }
  };

  return (
    <div>
      <div className="flex items-center gap-2 bg-muted/30 px-4 py-2">
        <div className="relative min-w-0 flex-1">
          <SearchIcon className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="h-8 pl-8 text-sm"
            placeholder="搜索模型(id 或名称,支持模糊)..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <Button
          className="size-8 shrink-0 text-muted-foreground"
          disabled={refreshing}
          onClick={onRefresh}
          size="icon"
          title={refreshing ? "正在拉取…" : "重新拉取模型列表"}
          variant="ghost"
        >
          <RefreshCwIcon className={refreshing ? "size-3.5 animate-spin" : "size-3.5"} />
        </Button>
      </div>
      <ScrollArea className="h-64">
        <div className="divide-y">
          {orderedModels.map((model) => {
            const enabled = enabledIds.has(model.id);
            const isCustomModel = !initialModelIds.has(model.id);
            const caps = getModelCapabilities(provider, model.id, catalog);
            const contextWindow = getModelContextWindow(provider, model.id, catalog);
            // 内置供应商的 name === id,只渲染一行避免重复
            const displayName = getModelDisplayName(model);
            return (
              <div key={model.id} className="flex items-center gap-3 px-4 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="break-words text-sm" title={displayName}>
                    {displayName}
                  </p>
                  <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                    <CapabilityBadges caps={caps} />
                    {contextWindow ? (
                      <Badge
                        variant="secondary"
                        className="text-[10px]"
                        title={`${contextWindow.toLocaleString("en-US")} tokens`}
                      >
                        上下文 {formatModelContextWindow(contextWindow)}
                      </Badge>
                    ) : null}
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  disabled={testingId !== null}
                  onClick={() => void runTest(model.id)}
                  aria-label={`测试 ${model.id}`}
                >
                  {testingId === model.id ? (
                    <DotmCircular4 size={15} dotSize={1.7} colorPreset="solid-theme" />
                  ) : (
                    <FlaskConicalIcon />
                  )}
                </Button>
                <Switch
                  checked={enabled}
                  onCheckedChange={(nextEnabled) => {
                    const enabledModels = nextEnabled
                      ? provider.enabledModels.some((m) => m.id === model.id)
                        ? provider.enabledModels
                        : [...provider.enabledModels, model]
                      : provider.enabledModels.filter((m) => m.id !== model.id);
                    patchProvider({ enabledModels });
                    if (!nextEnabled && isCustomModel) {
                      setModels((current) => current.filter((item) => item.id !== model.id));
                    }
                  }}
                  aria-label={`启用 ${displayName}`}
                />
              </div>
            );
          })}
          {filtered.length === 0 && !canAddCustom ? (
            <p className="px-4 py-6 text-center text-sm text-muted-foreground">没有匹配的模型</p>
          ) : null}
        </div>
      </ScrollArea>
      {canAddCustom ? (
        <div className="bg-muted/20 px-4 py-2">
          <Button variant="outline" size="sm" className="w-full" onClick={addCustomModel}>
            <PlusIcon />
            添加自定义模型 "{query.trim()}"
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export function ProvidersSection() {
  const { providers } = useWorkbench();
  const registry = useRegistry();
  const [addOpen, setAddOpen] = React.useState(false);
  const [editingProvider, setEditingProvider] = React.useState<ProviderConfig | null>(null);

  return (
    <div className="flex min-w-0 flex-col gap-4 p-4">
      <div className="flex items-center justify-between gap-4">
        <p className="text-sm text-muted-foreground">
          预选 Mastra 内置供应商填入你的 Key,或接入自定义网关。
        </p>
        <Button size="sm" onClick={() => setAddOpen(true)}>
          <PlusIcon className="size-3.5 mr-1" />
          添加供应商
        </Button>
      </div>

      <AddProviderDialog registry={registry} open={addOpen} onOpenChange={setAddOpen} />
      <AddProviderDialog
        registry={registry}
        open={Boolean(editingProvider)}
        onOpenChange={(open) => {
          if (!open) setEditingProvider(null);
        }}
        editProvider={editingProvider}
      />

      <div className="flex min-w-0 flex-col gap-3">
        {providers.length === 0 ? (
          <p className="w-full rounded-xl border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
            还没有供应商,点击「添加」开始。
          </p>
        ) : (
          providers.map((provider) => (
            <ProviderItem
              key={provider.id}
              provider={provider}
              registry={registry}
              onEdit={() => setEditingProvider(provider)}
            />
          ))
        )}
      </div>
    </div>
  );
}
