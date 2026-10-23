import { useNavigate, useRouterState } from "@tanstack/react-router";
import { BoxesIcon, ChevronDownIcon, SettingsIcon } from "lucide-react";
import { useMemo, useState } from "react";
import {
  CapabilityBadges,
  formatModelContextWindow,
  getModelCapabilities,
  getModelContextWindow,
  getModelDisplayName,
  getModelKind,
  getReasoningEfforts,
} from "@/entities/workbench";
import { useCatalogQuery } from "@/entities/workbench/model/queries/config";
import { useSessionSettings } from "@/entities/workbench/model/use-session-settings";
import { useAuth } from "@/features/auth";
import { useTranslation } from "@/shared/i18n";
import { ModelSelectorLogo, ModelSelectorName } from "@/shared/ui/ai-elements/model-selector";
import { PromptInputButton } from "@/shared/ui/ai-elements/prompt-input";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/shared/ui/command";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/shared/ui/hover-card";
import { HyperText } from "@/shared/ui/hyper-text";
import { Popover, PopoverContent, PopoverTrigger } from "@/shared/ui/popover";
import { ScrollArea } from "@/shared/ui/scroll-area";

export function ChatModelSelector() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const { user } = useAuth();
  const navigate = useNavigate();
  const activeThreadId = useRouterState({
    select: (state) => (state.location.search as { thread?: string }).thread ?? null,
  });
  const catalogQuery = useCatalogQuery();
  const catalog = catalogQuery.data ?? [];
  const catalogStatus = catalogQuery.isPending
    ? "loading"
    : catalogQuery.isError
      ? "error"
      : "ready";
  const openSettings = (section?: string) => {
    void navigate({
      to: "/settings",
      search: (prev) => ({ ...prev, ...(section ? { section } : {}) }),
    });
  };
  const { providers, modelSelection, setModelSelection } = useSessionSettings(
    user?.id ?? "anonymous",
    activeThreadId,
  );

  const activeProviders = useMemo(
    () => providers.filter((provider) => !provider.disabled && provider.enabledModels.length > 0),
    [providers],
  );
  const modelOptionsByProvider = useMemo(
    () =>
      new Map(
        activeProviders.map((provider) => [
          provider.id,
          [...provider.enabledModels]
            .sort(
              (left, right) =>
                Number(
                  modelSelection?.providerId === provider.id && modelSelection.modelId === right.id,
                ) -
                Number(
                  modelSelection?.providerId === provider.id && modelSelection.modelId === left.id,
                ),
            )
            .map((model) => ({
              model,
              displayName: getModelDisplayName(model),
              caps: getModelCapabilities(provider, model.id, catalog),
              kind: getModelKind(provider, model.id, catalog),
              contextWindow: getModelContextWindow(provider, model.id, catalog),
            })),
        ]),
      ),
    [activeProviders, catalog, modelSelection],
  );
  const selectedProvider = providers.find((p) => p.id === modelSelection?.providerId);
  const selectedModel = selectedProvider?.enabledModels.find(
    (model) => model.id === modelSelection?.modelId,
  );
  const selectedModelName =
    selectedProvider && modelSelection
      ? getModelDisplayName(
          selectedModel ?? { id: modelSelection.modelId, name: modelSelection.modelName },
        )
      : undefined;

  const handleSelect = (providerId: string, modelId: string, modelName: string) => {
    const provider = providers.find((p) => p.id === providerId);
    if (!provider) return;
    setOpen(false);
    const caps = getModelCapabilities(provider, modelId, catalog);
    const efforts = getReasoningEfforts(provider);
    if (modelSelection?.providerId === providerId && modelSelection.modelId === modelId) return;
    setModelSelection({
      providerId,
      modelId,
      modelName: getModelDisplayName({ id: modelId, name: modelName }),
      // 支持推理的模型默认「中」档,否则关闭
      reasoningEffort: caps.reasoning
        ? efforts.includes("medium")
          ? "medium"
          : efforts[0]
        : "off",
    });
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      {/* min-w-0 允许模型标签在工具栏内收缩并截短 */}
      <PopoverTrigger
        render={
          <PromptInputButton
            aria-label={`${t("chat:models.selectModel")}${selectedModelName ? `: ${selectedModelName}` : ""}`}
            title={selectedModelName || t("chat:models.selectModel")}
            className="min-w-0 shrink"
            size="sm"
            variant="outline"
          />
        }
      >
        {selectedProvider && modelSelection ? (
          <>
            <ModelSelectorLogo provider={selectedProvider.registryId ?? "custom"} />
            <ModelSelectorName className="min-w-0 max-w-24 @max-[36rem]/prompt-footer:sr-only">
              {/* 换模型时逐字符解码收敛。key 绑定模型名:值一变就重挂载,
                  从而重新播放一次动画 —— 让"我切到哪个模型了"这件事有确认感 */}
              <HyperText
                key={selectedModelName}
                as="span"
                className="block truncate p-0 text-left font-normal text-sm tracking-normal"
                duration={520}
                startOnView
              >
                {selectedModelName}
              </HyperText>
            </ModelSelectorName>
          </>
        ) : (
          <>
            <BoxesIcon />
            <span className="min-w-0 truncate @max-[36rem]/prompt-footer:sr-only">
              {t("chat:models.selectModel")}
            </span>
          </>
        )}
        <ChevronDownIcon className="size-3.5 opacity-60" />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-max min-w-[min(16rem,calc(100vw-2rem))] max-w-[min(32rem,calc(100vw-2rem))] max-h-[var(--available-height)] min-h-0 gap-0 overflow-hidden p-0"
      >
        <Command
          className="h-auto min-h-0 flex-1 [&_[data-slot=command-input-wrapper]]:[contain:inline-size]"
          label={t("chat:models.selectModel")}
        >
          <CommandInput
            placeholder={t("chat:models.search")}
            aria-label={t("chat:models.search")}
          />
          <CommandList className="min-h-0">
            <CommandEmpty>{t("chat:models.noMatches")}</CommandEmpty>
            {activeProviders.map((provider) => (
              <CommandGroup key={provider.id} heading={provider.name}>
                {(modelOptionsByProvider.get(provider.id) ?? []).map(
                  ({ model, displayName, caps, kind, contextWindow }) => {
                    const isSelected =
                      modelSelection?.providerId === provider.id &&
                      modelSelection.modelId === model.id;
                    return (
                      <HoverCard key={model.id}>
                        <HoverCardTrigger
                          render={
                            <CommandItem
                              value={JSON.stringify([provider.id, model.id])}
                              keywords={[
                                provider.name,
                                provider.registryId ?? "",
                                model.id,
                                displayName,
                              ]}
                              data-checked={isSelected}
                              onSelect={() => handleSelect(provider.id, model.id, model.name)}
                              className="gap-2"
                            />
                          }
                        >
                          <ModelSelectorLogo
                            provider={provider.registryId ?? "custom"}
                            className="shrink-0"
                          />
                          <span className="min-w-0 flex-1 break-words font-medium">
                            {displayName}
                          </span>
                          {kind !== "language" ? (
                            <Badge variant="secondary" className="shrink-0 text-[10px]">
                              {t(`settings:providers.modelKinds.${kind}`)}
                            </Badge>
                          ) : null}
                        </HoverCardTrigger>
                        <HoverCardContent
                          side="right"
                          align="start"
                          className="w-72 max-w-[calc(100vw-2rem)]"
                        >
                          <ScrollArea className="max-h-64 min-w-0">
                            <div className="flex min-w-0 flex-col gap-2">
                              <span className="break-words font-medium">{displayName}</span>
                              {displayName.trim() !== model.id.trim() ? (
                                <span className="break-all text-xs text-muted-foreground">
                                  {model.id}
                                </span>
                              ) : null}
                              <div
                                className="flex flex-wrap items-center gap-1"
                                aria-label={t("chat:models.capabilities")}
                              >
                                {caps.reasoning ||
                                caps.vision ||
                                caps.audio ||
                                caps.tools ||
                                caps.structuredOutput ? (
                                  <CapabilityBadges caps={caps} />
                                ) : (
                                  <span className="text-xs text-muted-foreground">
                                    {t("chat:models.basicChat")}
                                  </span>
                                )}
                                {contextWindow ? (
                                  <span
                                    className="text-xs text-muted-foreground"
                                    title={`${t("chat:models.contextWindow")}: ${contextWindow.toLocaleString("en-US")} tokens`}
                                  >
                                    {t("chat:models.contextWindow")}:{" "}
                                    {formatModelContextWindow(contextWindow)}
                                  </span>
                                ) : (
                                  <Badge className="h-4 px-1 text-[10px]" variant="outline">
                                    {t(
                                      catalogStatus === "loading"
                                        ? "chat:models.catalogLoading"
                                        : catalogStatus === "error"
                                          ? "chat:models.catalogError"
                                          : "chat:models.catalogUnlisted",
                                    )}
                                  </Badge>
                                )}
                              </div>
                            </div>
                          </ScrollArea>
                        </HoverCardContent>
                      </HoverCard>
                    );
                  },
                )}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t p-2">
          <Button
            variant="ghost"
            size="xs"
            onClick={() => {
              setOpen(false);
              openSettings("providers");
            }}
          >
            <SettingsIcon />
            {t("chat:models.manageProviders")}
          </Button>
          {activeProviders.length === 0 ? (
            <span className="min-w-0 flex-1 break-words text-xs text-muted-foreground">
              {t("chat:models.noModels")}
            </span>
          ) : null}
          <Button variant="outline" size="xs" onClick={() => setOpen(false)}>
            {t("common:close")}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
