import { useNavigate, useRouterState } from "@tanstack/react-router";
import { BoxesIcon, BrainIcon, CheckIcon, ChevronDownIcon, SettingsIcon } from "lucide-react";
import {
  CapabilityBadges,
  formatModelContextWindow,
  getModelCapabilities,
  getModelContextWindow,
  getModelDisplayName,
  getReasoningEfforts,
  REASONING_EFFORT_LABELS,
  type ReasoningEffort,
} from "@/entities/workbench";
import { useCatalogQuery } from "@/entities/workbench/model/queries/config";
import { useSessionSettings } from "@/entities/workbench/model/use-session-settings";
import { useAuth } from "@/features/auth";
import { useTranslation } from "@/shared/i18n";
import { ModelSelectorLogo, ModelSelectorName } from "@/shared/ui/ai-elements/model-selector";
import { PromptInputButton } from "@/shared/ui/ai-elements/prompt-input";
import { Badge } from "@/shared/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";
import { HyperText } from "@/shared/ui/hyper-text";

// ---------------------------------------------------------------------------
// 模型选择器:官方 DropdownMenu 菜单形态 + 官方 ai-elements Logo/Name
// 结构:供应商分组 → 模型行(hover 展开二级菜单:能力 + 使用) →
//       思考等级三级子菜单(RadioGroup,仅 reasoning 模型)
// ---------------------------------------------------------------------------

export function ChatModelSelector() {
  const { t } = useTranslation();
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

  const activeProviders = providers.filter((p) => !p.disabled && p.enabledModels.length > 0);
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
    const caps = getModelCapabilities(provider, modelId, catalog);
    const efforts = getReasoningEfforts(provider);
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

  const handleEffortChange = (
    provider: (typeof providers)[number],
    modelId: string,
    modelName: string,
    effort: string,
  ) => {
    // 调整思考等级隐含选中该模型
    setModelSelection({
      providerId: provider.id,
      modelId,
      modelName: getModelDisplayName({ id: modelId, name: modelName }),
      reasoningEffort: effort as ReasoningEffort,
    });
  };

  return (
    <DropdownMenu>
      {/* min-w-0:见 approval-selector 同处注释,解开 min-content 定宽标签才能截短 */}
      <DropdownMenuTrigger
        render={<PromptInputButton aria-label={t("chat:models.selectModel")} className="min-w-0" />}
      >
        {selectedProvider && modelSelection ? (
          <>
            <ModelSelectorLogo provider={selectedProvider.registryId ?? "custom"} />
            {/* 与审批(max-w-24)/检索(max-w-28)/模式(max-w-20)三个选择器同规:
                标签给一个上限再 truncate。基类已有 truncate,但按钮按内容定宽,
                没有上限时超长模型名会独自把整排工具栏顶宽。 */}
            <ModelSelectorName className="max-w-28">
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
            <span>{t("chat:models.selectModel")}</span>
          </>
        )}
        <ChevronDownIcon className="size-3.5 opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-max max-w-[min(90vw,32rem)]">
        {activeProviders.length === 0 ? (
          <DropdownMenuItem
            onClick={() => {
              openSettings("providers");
            }}
          >
            <SettingsIcon />
            {t("chat:models.noModels")}
          </DropdownMenuItem>
        ) : (
          activeProviders.map((provider, groupIndex) => (
            <DropdownMenuGroup key={provider.id}>
              <DropdownMenuLabel className="flex items-center gap-1.5">
                <ModelSelectorLogo provider={provider.registryId ?? "custom"} />
                {provider.name}
              </DropdownMenuLabel>
              {[...provider.enabledModels]
                .sort(
                  (left, right) =>
                    Number(
                      modelSelection?.providerId === provider.id &&
                        modelSelection?.modelId === right.id,
                    ) -
                    Number(
                      modelSelection?.providerId === provider.id &&
                        modelSelection?.modelId === left.id,
                    ),
                )
                .map((model) => {
                  const caps = getModelCapabilities(provider, model.id, catalog);
                  const contextWindow = getModelContextWindow(provider, model.id, catalog);
                  const isSelected =
                    modelSelection?.providerId === provider.id &&
                    modelSelection?.modelId === model.id;
                  const currentEffort =
                    isSelected && modelSelection?.reasoningEffort !== "off"
                      ? modelSelection?.reasoningEffort
                      : undefined;
                  return (
                    <DropdownMenuSub key={model.id}>
                      {/* 模型行:点击直接选中;hover/展开按钮打开二级菜单(官方 SubTrigger 自带右侧箭头) */}
                      <DropdownMenuSubTrigger
                        className="pr-1 [&>svg:last-child]:ml-0"
                        onClick={() => handleSelect(provider.id, model.id, model.name)}
                      >
                        <ModelSelectorName className="max-w-[min(62vw,24rem)] whitespace-normal break-all">
                          {getModelDisplayName(model)}
                        </ModelSelectorName>
                        <span className="ml-auto flex shrink-0 items-center gap-1.5">
                          {contextWindow ? (
                            <span
                              className="truncate text-[10px] text-muted-foreground"
                              title={`${contextWindow.toLocaleString("en-US")} tokens`}
                            >
                              {formatModelContextWindow(contextWindow)}
                            </span>
                          ) : (
                            <Badge
                              className="h-4 px-1.5 text-[10px]"
                              variant={catalogStatus === "loading" ? "secondary" : "outline"}
                            >
                              {catalogStatus === "loading"
                                ? t("chat:models.catalogLoading")
                                : catalogStatus === "error"
                                  ? t("chat:models.catalogError")
                                  : t("chat:models.catalogUnlisted")}
                            </Badge>
                          )}
                          {isSelected ? <CheckIcon className="size-4" /> : null}
                        </span>
                      </DropdownMenuSubTrigger>
                      <DropdownMenuSubContent className="w-max min-w-52 max-w-[min(90vw,28rem)]">
                        <DropdownMenuGroup>
                          <DropdownMenuItem
                            className="pr-2"
                            onClick={() => handleSelect(provider.id, model.id, model.name)}
                          >
                            {t("chat:models.useModel")}
                            <CheckIcon className="ml-auto size-4" />
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuLabel>{t("chat:models.capabilities")}</DropdownMenuLabel>
                          <div className="flex flex-wrap gap-1 px-1.5 pb-1.5">
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
                          </div>
                          {contextWindow ? (
                            <DropdownMenuLabel className="flex items-center justify-between gap-2">
                              <span>{t("chat:models.contextWindow")}</span>
                              <span className="font-mono text-xs text-muted-foreground">
                                {formatModelContextWindow(contextWindow)}
                              </span>
                            </DropdownMenuLabel>
                          ) : (
                            <DropdownMenuLabel className="flex items-center justify-between gap-2">
                              <span>{t("chat:models.contextWindow")}</span>
                              <Badge
                                className="h-4 px-1.5 text-[10px]"
                                variant={catalogStatus === "loading" ? "secondary" : "outline"}
                              >
                                {catalogStatus === "loading"
                                  ? t("chat:models.catalogFetching")
                                  : catalogStatus === "error"
                                    ? t("chat:models.catalogFetchError")
                                    : t("chat:models.catalogUnmatched")}
                              </Badge>
                            </DropdownMenuLabel>
                          )}
                          {caps.reasoning ? (
                            <DropdownMenuSub>
                              <DropdownMenuSubTrigger>
                                <BrainIcon />
                                {t("chat:models.reasoningEffort")}
                                {currentEffort ? (
                                  <Badge
                                    className="ml-auto h-4 px-1.5 text-[10px]"
                                    variant="secondary"
                                  >
                                    {t(
                                      `chat:models.efforts.${currentEffort}`,
                                      REASONING_EFFORT_LABELS[currentEffort],
                                    )}
                                  </Badge>
                                ) : null}
                              </DropdownMenuSubTrigger>
                              <DropdownMenuSubContent>
                                <DropdownMenuRadioGroup
                                  value={currentEffort ?? "medium"}
                                  onValueChange={(effort) =>
                                    handleEffortChange(provider, model.id, model.name, effort)
                                  }
                                >
                                  {getReasoningEfforts(provider).map((effort) => (
                                    <DropdownMenuRadioItem key={effort} value={effort}>
                                      {t(
                                        `chat:models.efforts.${effort}`,
                                        REASONING_EFFORT_LABELS[effort],
                                      )}
                                    </DropdownMenuRadioItem>
                                  ))}
                                </DropdownMenuRadioGroup>
                              </DropdownMenuSubContent>
                            </DropdownMenuSub>
                          ) : null}
                        </DropdownMenuGroup>
                      </DropdownMenuSubContent>
                    </DropdownMenuSub>
                  );
                })}
              {groupIndex < activeProviders.length - 1 ? <DropdownMenuSeparator /> : null}
            </DropdownMenuGroup>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
