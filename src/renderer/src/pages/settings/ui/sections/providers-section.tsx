import { useQueryClient } from "@tanstack/react-query";
import {
  ExternalLinkIcon,
  FlaskConicalIcon,
  KeyRoundIcon,
  PanelLeftIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  ServerIcon,
  Trash2Icon,
} from "lucide-react";
import { nanoid } from "nanoid";
import * as React from "react";
import { toast } from "sonner";
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
  qk,
  type RegistryProvider,
  saveProviderConfig,
  testProviderModel,
  useCatalogQuery,
  useOpenBrowserUrl,
  useProviderConfigQuery,
  useRegistry,
} from "@/entities/workbench";
import { useTranslation } from "@/shared/i18n";
import { cn, toastError } from "@/shared/lib";
import { ModelSelectorLogo } from "@/shared/ui/ai-elements/model-selector";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { Checkbox } from "@/shared/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { DotmCircular4 } from "@/shared/ui/dotm-circular-4";
import { Input } from "@/shared/ui/input";
import { Label } from "@/shared/ui/label";
import { PanelHeader } from "@/shared/ui/panel";
import { ScrollArea } from "@/shared/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/shared/ui/select";
import { Separator } from "@/shared/ui/separator";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/shared/ui/sidebar";
import { Switch } from "@/shared/ui/switch";
import { providerCredentialPurpose } from "../../../../../../shared/credential-contract";
import { CapabilityBadges } from "../controls";

// ---------------------------------------------------------------------------
// 模型供应商(BYOK):三列布局,水平分割线统一对齐(所有列 header h-12)
// - 第一列(设置菜单由 settings-page 提供):供应商列表,参考资料库二级侧栏的
//   手写 aside 嵌套模式(relative 布局不逃逸),可折叠为 48px 图标列,
//   顶部搜索检索,已配置置顶 + 状态角标(收起展开均显示状态且填 Key 后转绿)
// - 右侧详情:未配置 → 简介卡 +「添加 API Key」;已配置 → 模型管理
// - 连接配置(填 Key / 自定义网关 / 编辑连接)统一走弹窗,不直接平铺
// ---------------------------------------------------------------------------

type Selection = { kind: "provider"; id: string } | { kind: "registry"; id: string };

type ConnectionDialogMode = { kind: "gateway" } | { kind: "edit"; provider: ProviderConfig };

function useProviderEditor() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const configQuery = useProviderConfigQuery();
  const providers = configQuery.data?.providers ?? [];
  const setProviders = React.useCallback(
    (updater: ProviderConfig[] | ((current: ProviderConfig[]) => ProviderConfig[])) => {
      const current = queryClient.getQueryData<ReturnType<typeof useProviderConfigQuery>["data"]>(
        qk.providerConfig(),
      );
      const prev = current?.providers ?? [];
      const next = typeof updater === "function" ? updater(prev) : updater;
      queryClient.setQueryData(qk.providerConfig(), (_prev: typeof current) => ({
        providers: next,
        modelSelection: current?.modelSelection ?? null,
      }));
      void saveProviderConfig({ providers: next }).catch(() =>
        toast.error(t("settings:providers.saveFailed")),
      );
    },
    [queryClient, t],
  );
  const saveProviders = React.useCallback(
    async (next: ProviderConfig[]) => {
      await saveProviderConfig({ providers: next });
      queryClient.setQueryData(
        qk.providerConfig(),
        (current: ReturnType<typeof useProviderConfigQuery>["data"]) => ({
          providers: next,
          modelSelection: current?.modelSelection ?? null,
        }),
      );
    },
    [queryClient],
  );
  const openBrowserUrl = useOpenBrowserUrl();
  return { providers, setProviders, saveProviders, openBrowserUrl };
}

/** 供应商 logo:与模型选择器同源,直接取 models.dev/logos/{id}.svg */
function ProviderLogo({ provider, className }: { provider: string; className?: string }) {
  return <ModelSelectorLogo provider={provider} className={cn("size-4.5", className)} />;
}

function StatusDot({
  configured,
  disabled,
  className,
}: {
  configured: boolean;
  disabled?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  return (
    <span
      title={
        configured
          ? disabled
            ? t("settings:providers.disabledStatus")
            : t("settings:providers.enabledStatus")
          : t("common:empty")
      }
      className={cn(
        "size-2 shrink-0 rounded-full transition-colors",
        configured
          ? disabled
            ? "bg-muted-foreground/50 ring-2 ring-sidebar"
            : "bg-emerald-500 dark:bg-emerald-400 ring-2 ring-sidebar"
          : "bg-muted-foreground/30 ring-2 ring-sidebar",
        className,
      )}
    />
  );
}

// ---------------------------------------------------------------------------
// 主组件
// ---------------------------------------------------------------------------

export function ProvidersSection() {
  const { providers } = useProviderEditor();
  const registry = useRegistry();
  const [selected, setSelected] = React.useState<Selection | null>(null);
  const [dialogMode, setDialogMode] = React.useState<ConnectionDialogMode | null>(null);
  const [listOpen, setListOpen] = React.useState(true);
  const toggleList = () => setListOpen((open) => !open);

  // 已配置项被删除后清除选中;无选中时默认聚焦第一个已配置供应商
  const selectedProviderGone =
    selected?.kind === "provider" && !providers.some((p) => p.id === selected.id);
  React.useEffect(() => {
    if (selectedProviderGone) setSelected(null);
  }, [selectedProviderGone]);
  const effectiveSelected = selectedProviderGone ? null : selected;
  React.useEffect(() => {
    if (!effectiveSelected && providers.length > 0) {
      setSelected({ kind: "provider", id: providers[0].id });
    }
  }, [effectiveSelected, providers]);

  const configuredRegistryIds = new Set(
    providers.map((p) => p.registryId).filter((id): id is string => Boolean(id)),
  );
  const unconfigured = registry.filter((r) => !configuredRegistryIds.has(r.id));

  const selectedRegistryProvider =
    effectiveSelected?.kind === "registry"
      ? registry.find((r) => r.id === effectiveSelected.id)
      : undefined;

  return (
    // 资料库同款嵌套模式:手写 aside + 右侧主区,不依赖外层 SidebarProvider
    <div className="flex size-full min-h-0 min-w-0 overflow-hidden">
      <ProviderListSidebar
        providers={providers}
        unconfigured={unconfigured}
        selected={effectiveSelected}
        onSelect={setSelected}
        onAddGateway={() => setDialogMode({ kind: "gateway" })}
        open={listOpen}
        onToggle={toggleList}
      />

      <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
        {effectiveSelected?.kind === "provider" ? (
          <ProviderDetail
            key={effectiveSelected.id}
            providerId={effectiveSelected.id}
            registry={registry}
            onEditConnection={(provider) => setDialogMode({ kind: "edit", provider })}
            listOpen={listOpen}
            onToggleList={toggleList}
          />
        ) : selectedRegistryProvider ? (
          <RegistryIntro
            key={selectedRegistryProvider.id}
            registryProvider={selectedRegistryProvider}
            registry={registry}
            listOpen={listOpen}
            onToggleList={toggleList}
            onAdded={(id) => setSelected({ kind: "provider", id })}
          />
        ) : (
          <EmptyDetail listOpen={listOpen} onToggleList={toggleList} />
        )}
      </main>

      <ProviderConnectionDialog
        mode={dialogMode}
        registry={registry}
        onOpenChange={(open) => {
          if (!open) setDialogMode(null);
        }}
        onSaved={(providerId) => {
          setDialogMode(null);
          setSelected({ kind: "provider", id: providerId });
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// 供应商列表列:资料库同款手写 aside(relative 不逃逸),折叠为 48px 图标列
// ---------------------------------------------------------------------------

function ProviderListSidebar({
  providers,
  unconfigured,
  selected,
  onSelect,
  onAddGateway,
  open,
  onToggle,
}: {
  providers: ProviderConfig[];
  unconfigured: RegistryProvider[];
  selected: Selection | null;
  onSelect: (selection: Selection) => void;
  onAddGateway: () => void;
  open: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const [search, setSearch] = React.useState("");

  const q = search.trim().toLowerCase();
  const filteredProviders = q
    ? providers.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          p.registryId?.toLowerCase().includes(q) ||
          p.baseUrl?.toLowerCase().includes(q),
      )
    : providers;

  const filteredUnconfigured = q
    ? unconfigured.filter((r) => r.name.toLowerCase().includes(q) || r.id.toLowerCase().includes(q))
    : unconfigured;

  const renderItem = (
    key: string,
    logoId: string,
    name: string,
    isActive: boolean,
    configured: boolean,
    disabled: boolean | undefined,
    onSelectItem: () => void,
  ) => (
    <SidebarMenuItem key={key}>
      <SidebarMenuButton
        isActive={isActive}
        onClick={onSelectItem}
        tooltip={name}
        className="h-9 gap-2.5 px-2"
      >
        <div className="relative flex shrink-0 items-center justify-center">
          <ProviderLogo provider={logoId} />
          <StatusDot
            configured={configured}
            disabled={disabled}
            className="absolute -bottom-0.5 -right-0.5"
          />
        </div>
        <span className="min-w-0 flex-1 truncate group-data-[collapsible=icon]/sidebar:hidden">
          {name}
        </span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );

  return (
    // 资料库二级侧栏同款结构:data-state/data-collapsible 驱动折叠,
    // 纯 relative 布局,绝对不逃逸出当前容器,transition-[width] 驱动原生平滑滑入滑出
    <aside
      data-state={open ? "expanded" : "collapsed"}
      data-collapsible={open ? "" : "icon"}
      data-slot="sidebar"
      data-sidebar="sidebar"
      className={cn(
        "group/sidebar group relative flex h-full min-h-0 shrink-0 flex-col overflow-hidden border-r border-border bg-sidebar transition-[width] duration-200 ease-linear",
        open ? "w-60" : "w-12",
      )}
    >
      <div className="flex h-full w-full min-h-0 shrink-0 flex-col">
        {/* 顶栏 h-12 与其余两列 header 对齐:检索框 + 添加自定义网关; 水平分割线统一 border-border */}
        <div className="flex h-12 shrink-0 items-center gap-1 border-b border-border px-2 py-1.5">
          {open ? (
            <>
              <div className="relative min-w-0 flex-1">
                <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={t("settings:providers.searchPlaceholder")}
                  className="h-8 bg-transparent pl-8 pr-2 text-xs shadow-none"
                />
              </div>
              <Button
                variant="ghost"
                size="icon-sm"
                className="shrink-0"
                title={t("settings:providers.addGateway")}
                aria-label={t("settings:providers.addGateway")}
                onClick={onAddGateway}
              >
                <PlusIcon />
              </Button>
            </>
          ) : (
            <Button
              variant="ghost"
              size="icon-sm"
              className="mx-auto"
              title={t("settings:providers.expandList")}
              aria-label={t("settings:providers.expandList")}
              onClick={onToggle}
            >
              <SearchIcon />
            </Button>
          )}
        </div>

        <ScrollArea className="min-h-0 flex-1 p-1.5 group-data-[collapsible=icon]/sidebar:p-1">
          {filteredProviders.length === 0 && filteredUnconfigured.length === 0 ? (
            <div className="py-6 text-center text-xs text-muted-foreground group-data-[collapsible=icon]/sidebar:hidden">
              {t("settings:providers.noMatching")}
            </div>
          ) : null}

          {filteredProviders.length > 0 ? (
            <div className="mb-2">
              <div className="px-2 pt-1.5 pb-1 text-[10px] font-medium tracking-wide text-muted-foreground group-data-[collapsible=icon]/sidebar:hidden">
                {t("settings:providers.configured")}
              </div>
              <SidebarMenu>
                {filteredProviders.map((provider) =>
                  renderItem(
                    provider.id,
                    provider.registryId ?? "custom",
                    provider.name,
                    selected?.kind === "provider" && selected.id === provider.id,
                    true,
                    provider.disabled,
                    () => onSelect({ kind: "provider", id: provider.id }),
                  ),
                )}
              </SidebarMenu>
            </div>
          ) : null}

          {filteredUnconfigured.length > 0 ? (
            <div>
              <div className="px-2 pt-2 pb-1 text-[10px] font-medium tracking-wide text-muted-foreground group-data-[collapsible=icon]/sidebar:hidden">
                {t("settings:providers.allProviders")}
              </div>
              <SidebarMenu>
                {filteredUnconfigured.map((r) =>
                  renderItem(
                    r.id,
                    r.id,
                    r.name,
                    selected?.kind === "registry" && selected.id === r.id,
                    false,
                    undefined,
                    () => onSelect({ kind: "registry", id: r.id }),
                  ),
                )}
              </SidebarMenu>
            </div>
          ) : null}
        </ScrollArea>
      </div>
    </aside>
  );
}

function EmptyDetail({ listOpen, onToggleList }: { listOpen: boolean; onToggleList: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex size-full flex-col">
      <PanelHeader className="px-4">
        <Button
          size="icon-sm"
          variant="ghost"
          className="-ml-1"
          title={
            listOpen ? t("settings:providers.collapseList") : t("settings:providers.expandList")
          }
          aria-label={
            listOpen ? t("settings:providers.collapseList") : t("settings:providers.expandList")
          }
          onClick={onToggleList}
        >
          <PanelLeftIcon />
        </Button>
      </PanelHeader>
      <div className="flex size-full flex-1 items-center justify-center p-8">
        <div className="flex max-w-md flex-col items-center gap-2 text-center">
          <ServerIcon className="size-8 text-muted-foreground/50" />
          <p className="text-sm text-muted-foreground">{t("settings:providers.selectToStart")}</p>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 未配置的内置供应商:简介 + 内联 API Key 输入框(不弹窗,填完直接保存)
// ---------------------------------------------------------------------------

function RegistryIntro({
  registryProvider,
  registry,
  listOpen,
  onToggleList,
  onAdded,
}: {
  registryProvider: RegistryProvider;
  registry: RegistryProvider[];
  listOpen: boolean;
  onToggleList: () => void;
  onAdded: (providerId: string) => void;
}) {
  const { t } = useTranslation();
  const { providers, saveProviders, openBrowserUrl } = useProviderEditor();
  const [apiKey, setApiKey] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);

  const handleSubmit = async () => {
    if (!apiKey.trim()) {
      toast.error(t("settings:providers.pleaseEnterKey"));
      return;
    }
    setSubmitting(true);
    const id = `provider-${nanoid(6)}`;
    try {
      const credential = await window.api.credentials.put({
        purpose: providerCredentialPurpose(id),
        value: apiKey.trim(),
      });
      const provider: ProviderConfig = {
        id,
        name: registryProvider.name,
        registryId: registryProvider.id,
        ...credential,
        enabledModels: [],
      };
      // 新配置的供应商排列到顶部
      await saveProviders([provider, ...providers]);
      try {
        const models = await fetchProviderModels(provider, registry);
        toast.success(
          t("settings:providers.addedSuccess", {
            name: provider.name,
            count: models.length,
          }),
        );
      } catch (error) {
        toast.warning(
          t("settings:providers.addedFetchError", {
            error: (error as Error).message,
          }),
        );
      }
      onAdded(provider.id);
    } catch (error) {
      toastError(error, t("settings:providers.saveFailed"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <PanelHeader className="px-4">
        <Button
          size="icon-sm"
          variant="ghost"
          className="-ml-1"
          title={
            listOpen ? t("settings:providers.collapseList") : t("settings:providers.expandList")
          }
          aria-label={
            listOpen ? t("settings:providers.collapseList") : t("settings:providers.expandList")
          }
          onClick={onToggleList}
        >
          <PanelLeftIcon />
        </Button>
        <Separator orientation="vertical" className="mx-1 h-4" />
        <div className="min-w-0 flex-1">
          <p className="flex min-w-0 items-center gap-2 text-sm font-medium">
            <ProviderLogo provider={registryProvider.id} />
            <span className="truncate">{registryProvider.name}</span>
            <Badge variant="outline" className="shrink-0 text-[10px]">
              {t("settings:providers.builtin")}
            </Badge>
          </p>
          <p className="truncate text-xs text-muted-foreground" title={registryProvider.id}>
            {registryProvider.id}
          </p>
        </div>
        {registryProvider.docUrl ? (
          <Button
            variant="ghost"
            size="icon-sm"
            title={t("settings:providers.docLink")}
            aria-label={t("settings:providers.docLink")}
            onClick={() => openBrowserUrl(registryProvider.docUrl)}
          >
            <ExternalLinkIcon />
          </Button>
        ) : null}
      </PanelHeader>
      <div className="flex min-h-0 flex-1 items-center justify-center p-8">
        <div className="flex w-full max-w-xs flex-col items-center gap-3 text-center">
          <ProviderLogo provider={registryProvider.id} className="size-10" />
          <p className="text-sm font-medium">{registryProvider.name}</p>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {t("settings:providers.introDesc")}
          </p>
          <div className="flex w-full flex-col gap-1.5">
            <Input
              type="password"
              placeholder={registryProvider.apiKeyEnvVar}
              value={apiKey}
              disabled={submitting}
              onChange={(e) => setApiKey(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !submitting) void handleSubmit();
              }}
            />
            <Button
              size="sm"
              className="w-full"
              disabled={submitting || !apiKey.trim()}
              onClick={() => void handleSubmit()}
            >
              {submitting ? (
                <DotmCircular4 size={15} dotSize={1.7} colorPreset="solid-theme" />
              ) : (
                <KeyRoundIcon />
              )}
              {submitting
                ? t("settings:providers.verifying")
                : t("settings:providers.saveAndEnable")}
            </Button>
          </div>
          {registryProvider.docUrl ? (
            <Button
              variant="ghost"
              size="sm"
              className="w-full text-xs text-muted-foreground"
              onClick={() => openBrowserUrl(registryProvider.docUrl)}
            >
              <ExternalLinkIcon />
              {t("settings:providers.getApiKey")}
            </Button>
          ) : null}
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// 连接配置弹窗:创建自定义网关 / 编辑已配置供应商(首次填 Key 在详情面板内联完成)
// ---------------------------------------------------------------------------

function ProviderConnectionDialog({
  mode,
  registry,
  onOpenChange,
  onSaved,
}: {
  mode: ConnectionDialogMode | null;
  registry: RegistryProvider[];
  onOpenChange: (open: boolean) => void;
  onSaved: (providerId: string) => void;
}) {
  const { t } = useTranslation();
  const { providers, saveProviders } = useProviderEditor();
  const [name, setName] = React.useState("");
  const [apiKey, setApiKey] = React.useState("");
  const [protocol, setProtocol] = React.useState<GatewayProtocol>("openai");
  const [baseUrl, setBaseUrl] = React.useState("");
  const [useResponses, setUseResponses] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);

  const showGatewayFields =
    mode?.kind === "gateway" || (mode?.kind === "edit" && !mode.provider.registryId);

  // 打开/切换目标时重置表单
  React.useEffect(() => {
    if (!mode) return;
    setSubmitting(false);
    if (mode.kind === "edit") {
      setName(mode.provider.name);
      setApiKey("");
      setProtocol(mode.provider.protocol ?? "openai");
      setBaseUrl(mode.provider.baseUrl ?? "");
      setUseResponses(Boolean(mode.provider.useResponses));
    } else {
      setName("");
      setApiKey("");
      setProtocol("openai");
      setBaseUrl("");
      setUseResponses(false);
    }
  }, [mode]);

  const title =
    mode?.kind === "gateway"
      ? t("settings:providers.addCustomGatewayTitle")
      : t("settings:providers.connectionConfig");
  const description =
    mode?.kind === "gateway"
      ? t("settings:providers.gatewayProtocolsHint")
      : t("settings:providers.editConnectionDesc");

  const handleSubmit = async () => {
    if (!mode) return;
    if (mode.kind === "gateway" && !apiKey.trim()) {
      toast.error(t("settings:providers.pleaseEnterKey"));
      return;
    }
    if (showGatewayFields && !name.trim()) {
      toast.error(t("settings:providers.pleaseEnterName"));
      return;
    }
    if (showGatewayFields && !baseUrl.trim()) {
      toast.error(t("settings:providers.pleaseEnterUrl"));
      return;
    }
    setSubmitting(true);
    try {
      if (mode.kind === "edit") {
        const credential = apiKey.trim()
          ? await window.api.credentials.put({
              purpose: providerCredentialPurpose(mode.provider.id),
              value: apiKey.trim(),
            })
          : {
              credentialRef: mode.provider.credentialRef,
              credentialHint: mode.provider.credentialHint,
              hasCredential: true as const,
            };
        const updated: ProviderConfig = showGatewayFields
          ? {
              ...mode.provider,
              ...credential,
              name: name.trim(),
              protocol,
              baseUrl: normalizeGatewayUrl(baseUrl, protocol),
              useResponses: protocol === "openai" ? useResponses : false,
            }
          : { ...mode.provider, ...credential };
        // 连接信息变了立即失效模型列表缓存,详情面板检测到变化后自动重拉
        invalidateProviderModelsCache(updated.id);
        await saveProviders(providers.map((p) => (p.id === updated.id ? updated : p)));
        toast.success(
          t("settings:providers.updatedSuccess", {
            name: updated.name,
          }),
        );
        onOpenChange(false);
        return;
      }
      const id = `provider-${nanoid(6)}`;
      const credential = await window.api.credentials.put({
        purpose: providerCredentialPurpose(id),
        value: apiKey.trim(),
      });
      const provider: ProviderConfig = {
        id,
        name: name.trim(),
        protocol,
        baseUrl: normalizeGatewayUrl(baseUrl, protocol),
        useResponses: protocol === "openai" ? useResponses : false,
        ...credential,
        enabledModels: [],
      };
      // 新配置的供应商排列到顶部
      await saveProviders([provider, ...providers]);
      try {
        const models = await fetchProviderModels(provider, registry);
        toast.success(
          t("settings:providers.addedSuccess", {
            name: provider.name,
            count: models.length,
          }),
        );
      } catch (error) {
        toast.warning(
          t("settings:providers.addedFetchError", {
            error: (error as Error).message,
          }),
        );
      }
      onSaved(provider.id);
    } catch (error) {
      toastError(error, t("settings:providers.saveFailed"));
    } finally {
      setSubmitting(false);
    }
  };

  const protocolItems = GATEWAY_PROTOCOLS.map((p) => ({ value: p.value, label: p.label }));

  return (
    <Dialog open={mode !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          {showGatewayFields ? (
            <>
              <div className="flex flex-col gap-2">
                <Label htmlFor="connection-name">{t("settings:providers.providerName")}</Label>
                <Input
                  id="connection-name"
                  placeholder={t("settings:providers.providerNamePlaceholder")}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label>{t("settings:providers.gatewayProtocol")}</Label>
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
                    ? t("settings:providers.anthropicProtocolHint")
                    : protocol === "gemini"
                      ? t("settings:providers.geminiProtocolHint")
                      : t("settings:providers.openaiProtocolHint")}
                </p>
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="connection-url">{t("settings:providers.baseUrl")}</Label>
                <div className="flex items-center gap-3">
                  <Input
                    id="connection-url"
                    className="flex-1"
                    placeholder={t("settings:providers.serviceAddressPlaceholder")}
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                    // 失焦即归一化回显:裸域名在 openai 协议下自动补 /v1
                    onBlur={() => setBaseUrl((current) => normalizeGatewayUrl(current, protocol))}
                  />
                  {protocol === "openai" ? (
                    <label
                      htmlFor="connection-use-responses"
                      className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground"
                    >
                      <Checkbox
                        id="connection-use-responses"
                        checked={useResponses}
                        onCheckedChange={(v) => setUseResponses(Boolean(v))}
                      />
                      {t("settings:providers.useResponses")}
                    </label>
                  ) : null}
                </div>
              </div>
            </>
          ) : null}
          <div className="flex flex-col gap-2">
            <Label htmlFor="connection-key">{t("settings:providers.apiKey")}</Label>
            <Input
              id="connection-key"
              type="password"
              placeholder={
                mode?.kind === "edit"
                  ? t("settings:providers.credentialConfigured", {
                      hint: mode.provider.credentialHint,
                    })
                  : t("settings:providers.accessKeyPlaceholder")
              }
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
            {t("common:cancel")}
          </Button>
          <Button disabled={submitting} onClick={() => void handleSubmit()}>
            {submitting ? (
              <DotmCircular4 size={15} dotSize={1.7} colorPreset="solid-theme" />
            ) : mode?.kind === "edit" ? (
              t("common:save")
            ) : (
              t("settings:providers.addGateway")
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// 已配置供应商:panel-header 承载名称与操作,body 只管模型管理
// ---------------------------------------------------------------------------

function ProviderDetail({
  providerId,
  registry,
  onEditConnection,
  listOpen,
  onToggleList,
}: {
  providerId: string;
  registry: RegistryProvider[];
  onEditConnection: (provider: ProviderConfig) => void;
  listOpen: boolean;
  onToggleList: () => void;
}) {
  const { t } = useTranslation();
  const { providers, setProviders, openBrowserUrl } = useProviderEditor();
  const provider = providers.find((p) => p.id === providerId);
  const [models, setModels] = React.useState<EnabledModel[] | null>(
    provider ? getCachedProviderModels(provider.id) : null,
  );
  const [loadingModels, setLoadingModels] = React.useState(false);
  const [refreshing, setRefreshing] = React.useState(false);

  const registryProvider = provider?.registryId
    ? registry.find((r) => r.id === provider.registryId)
    : undefined;
  const protocolLabel = GATEWAY_PROTOCOLS.find((p) => p.value === provider?.protocol)?.label;

  // 连接身份(协议/端点/Key/Responses)变化 = 缓存已失效(保存时已清),自动重拉;
  // 有缓存(含网关列表快照)则直接复用
  const connectionKey = provider
    ? `${provider.protocol ?? ""}|${provider.baseUrl ?? ""}|${provider.credentialRef}|${provider.useResponses ?? false}`
    : "";
  React.useEffect(() => {
    if (!provider) return;
    if (provider.registryId && registry.length === 0) return;
    const cached = getCachedProviderModels(provider.id);
    if (cached) {
      setModels(cached);
      return;
    }
    let active = true;
    setLoadingModels(true);
    fetchProviderModels(provider, registry)
      .then((fetched) => {
        if (active) setModels(fetched);
      })
      .catch((error: unknown) => {
        if (active) toastError(error);
      })
      .finally(() => {
        if (active) setLoadingModels(false);
      });
    return () => {
      active = false;
    };
    // registry 异步加载完成后引用变化 → 重拉(命中会话内缓存则零成本)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionKey, registry]);

  if (!provider) return null;

  /** 手动刷新 / 保存连接信息后重建模型列表(fetchProviderModels 会重建会话内缓存),
   * 并补回网关列表里没有的自定义模型 ID。target 允许用尚未写回 state 的新配置。 */
  const refreshModels = async (target: ProviderConfig = provider) => {
    setRefreshing(true);
    try {
      const fetched = await fetchProviderModels(target, registry);
      const fetchedIds = new Set(fetched.map((model) => model.id));
      const customModels = target.enabledModels.filter((model) => !fetchedIds.has(model.id));
      setModels([...fetched, ...customModels]);
    } catch (error) {
      toastError(error);
    } finally {
      setRefreshing(false);
    }
  };

  const toggleDisabled = () => {
    setProviders(
      providers.map((p) => (p.id === provider.id ? { ...p, disabled: !p.disabled } : p)),
    );
  };

  const removeProvider = () => {
    invalidateProviderModelsCache(provider.id);
    setProviders(providers.filter((p) => p.id !== provider.id));
  };

  return (
    <>
      {/* 名称与全部操作(官网/刷新模型/连接配置/启停/删除)都在顶栏 */}
      <PanelHeader className="px-4">
        <Button
          size="icon-sm"
          variant="ghost"
          className="-ml-1"
          title={
            listOpen ? t("settings:providers.collapseList") : t("settings:providers.expandList")
          }
          aria-label={
            listOpen ? t("settings:providers.collapseList") : t("settings:providers.expandList")
          }
          onClick={onToggleList}
        >
          <PanelLeftIcon />
        </Button>
        <Separator orientation="vertical" className="mx-1 h-4" />
        <div className="min-w-0 flex-1">
          <p className="flex min-w-0 flex-wrap items-center gap-2 text-sm font-medium">
            <ProviderLogo provider={provider.registryId ?? "custom"} />
            <span className="truncate">{provider.name}</span>
            {provider.disabled ? (
              <Badge variant="secondary" className="shrink-0">
                {t("settings:providers.disabledStatus")}
              </Badge>
            ) : null}
          </p>
          <p
            className="truncate text-xs text-muted-foreground"
            title={
              provider.registryId
                ? `${t("settings:providers.builtin")} · ${provider.registryId}`
                : `${protocolLabel}${provider.useResponses ? " · Responses" : ""} · ${provider.baseUrl}`
            }
          >
            {provider.registryId
              ? `${t("settings:providers.builtin")} · ${provider.registryId}`
              : `${protocolLabel}${provider.useResponses ? " · Responses" : ""} · ${provider.baseUrl}`}
          </p>
        </div>
        {registryProvider?.docUrl ? (
          <Button
            variant="ghost"
            size="icon-sm"
            title={t("settings:providers.docLink")}
            aria-label={t("settings:providers.docLink")}
            onClick={() => openBrowserUrl(registryProvider.docUrl)}
          >
            <ExternalLinkIcon />
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => onEditConnection(provider)}
          aria-label={t("settings:providers.connectionConfig")}
          title={t("settings:providers.connectionConfig")}
        >
          <KeyRoundIcon />
        </Button>
        <Switch
          checked={!provider.disabled}
          onCheckedChange={toggleDisabled}
          aria-label={
            provider.disabled
              ? t("settings:providers.enableProvider")
              : t("settings:providers.disableProvider")
          }
        />
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={removeProvider}
          aria-label={t("settings:providers.deleteProvider")}
          title={t("settings:providers.deleteProvider")}
        >
          <Trash2Icon />
        </Button>
      </PanelHeader>

      {/* 模型列表直接铺满,不再套卡片 */}
      {loadingModels ? (
        <div className="flex min-h-0 flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
          <DotmCircular4 size={16} dotSize={1.8} colorPreset="solid-theme" />
          {t("settings:providers.fetchingModels")}
        </div>
      ) : models ? (
        <ModelListSection
          provider={provider}
          models={models}
          onRefresh={() => void refreshModels()}
          refreshing={refreshing}
        />
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <Button variant="outline" size="sm" onClick={() => void refreshModels()}>
            <RefreshCwIcon />
            {t("settings:providers.fetchModels")}
          </Button>
        </div>
      )}
    </>
  );
}

/** 模型列表区块:模糊搜索 / 无结果添加自定义 ID / 每行连接测试 / 刷新按钮在搜索行右侧 */
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
  const { t } = useTranslation();
  const { providers, setProviders } = useProviderEditor();
  const catalog = useCatalogQuery().data ?? [];
  const [models, setModels] = React.useState(initialModels);
  const [query, setQuery] = React.useState("");
  const [testingId, setTestingId] = React.useState<string | null>(null);

  // 自定义模型只保存在 provider.enabledModels 中,重新拉取网关模型后要补回列表。
  const initialModelIds = React.useMemo(
    () => new Set(initialModels.map((model) => model.id)),
    [initialModels],
  );
  // 父组件刷新后传入新列表,同步覆盖本地状态;
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
    toast.success(t("settings:providers.customModelAdded", { id }));
  };

  const runTest = async (modelId: string) => {
    setTestingId(modelId);
    const startedAt = performance.now();
    try {
      const result = await testProviderModel(provider, modelId);
      const elapsed = Math.round(performance.now() - startedAt);
      if (result.ok) {
        toast.success(
          t("settings:providers.testSuccess", {
            id: modelId,
            ms: elapsed,
            reply: result.reply ?? "",
          }),
        );
      } else {
        toast.error(
          t("settings:providers.testFailed", {
            id: modelId,
            error: result.error ?? t("common:unknown"),
          }),
        );
      }
    } finally {
      setTestingId(null);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 模型检索行:Input 拉满整行,刷新按钮在布局右侧(不在 Input 内) */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2">
        <Input
          className="h-8 min-w-0 flex-1 text-sm"
          placeholder={t("settings:providers.searchModels")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <Button
          variant="ghost"
          size="icon-sm"
          className="shrink-0"
          disabled={refreshing}
          onClick={onRefresh}
          title={
            refreshing ? t("settings:providers.refreshing") : t("settings:providers.refreshModels")
          }
          aria-label={t("settings:providers.refreshModels")}
        >
          <RefreshCwIcon className={refreshing ? "size-3.5 animate-spin" : "size-3.5"} />
        </Button>
      </div>
      <ScrollArea className="min-h-0 flex-1">
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
                        {t("settings:providers.context", {
                          size: formatModelContextWindow(contextWindow),
                        })}
                      </Badge>
                    ) : null}
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  disabled={testingId !== null}
                  onClick={() => void runTest(model.id)}
                  aria-label={`${t("settings:providers.testModel")} ${model.id}`}
                  title={`${t("settings:providers.testModel")} ${model.id}`}
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
                  aria-label={`${t("settings:providers.enableModel")} ${displayName}`}
                />
              </div>
            );
          })}
          {filtered.length === 0 && !canAddCustom ? (
            <p className="px-4 py-6 text-center text-sm text-muted-foreground">
              {t("settings:providers.noMatchingModels")}
            </p>
          ) : null}
        </div>
        {canAddCustom ? (
          <div className="p-3">
            <Button variant="outline" size="sm" className="w-full" onClick={addCustomModel}>
              <PlusIcon />
              {t("settings:providers.addCustomModel", {
                id: query.trim(),
              })}
            </Button>
          </div>
        ) : null}
      </ScrollArea>
    </div>
  );
}
