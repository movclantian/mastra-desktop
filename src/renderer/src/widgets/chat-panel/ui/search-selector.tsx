import { useNavigate } from "@tanstack/react-router";
import { CheckIcon, CircleSlashIcon, GlobeIcon, SettingsIcon } from "lucide-react";
import {
  isSearchEngineReady,
  SEARCH_DEPTH_META,
  SEARCH_DEPTHS,
  SEARCH_ENGINE_META,
  SEARCH_ENGINES,
  type SearchDepth,
} from "@/entities/workbench";
import { useToolsConfigQuery } from "@/entities/workbench/model/queries/config";
import { useSessionSettings } from "@/entities/workbench/model/use-session-settings";
import { useAuth } from "@/features/auth";
import { useTranslation } from "@/shared/i18n";
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

// ---------------------------------------------------------------------------
// 联网检索选择器:与模型选择器同构的多级菜单
// 结构:引擎行(点击直接启用)→ 二级菜单(引擎说明 + 搜索强度 RadioGroup)
// 选择结果存 workbench.searchSelection,随每次请求以 body.webSearch 上传;
// 服务端按引擎与强度注入对应检索工具(src/mastra/tools/web-search.ts),
// 关闭时 Agent 完全没有检索工具可用。
// ---------------------------------------------------------------------------

export function ChatSearchSelector() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const navigate = useNavigate();
  const toolsConfig = useToolsConfigQuery().data ?? null;
  const openSettings = (section?: string) => {
    void navigate({
      to: "/settings",
      search: (prev) => ({ ...prev, ...(section ? { section } : {}) }),
    });
  };
  const { searchSelection, setSearchSelection, providers, modelSelection } = useSessionSettings(
    user?.id ?? "anonymous",
    null,
  );

  const activeEngine = searchSelection ? SEARCH_ENGINE_META[searchSelection.engine] : null;
  const activeEngineLabel = searchSelection
    ? t(`chat:search.engines.${searchSelection.engine}.label`, activeEngine?.label ?? "")
    : "";
  const activeDepthLabel = searchSelection
    ? t(
        `chat:search.depths.${searchSelection.depth}.label`,
        SEARCH_DEPTH_META[searchSelection.depth].label,
      )
    : "";
  // provider 原生检索的可用性取决于当前选定模型的家族,而非 API Key
  const activeProvider = providers.find((provider) => provider.id === modelSelection?.providerId);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <PromptInputButton
            aria-label={t("chat:search.title")}
            // 见 approval-selector 同处注释:解开 min-content 定宽,标签才能截短
            className="min-w-0"
            size={searchSelection ? "sm" : "icon-sm"}
            title={
              searchSelection
                ? t("chat:search.switchTitle", {
                    label: activeEngineLabel,
                  })
                : t("chat:search.openSearch")
            }
            type="button"
            variant="outline"
          />
        }
      >
        <GlobeIcon className={searchSelection ? "text-primary" : "text-muted-foreground"} />
        {searchSelection ? (
          <span className="max-w-28 truncate text-xs">
            {/* provider 引擎没有强度概念,不显示一个不起作用的档位 */}
            {searchSelection.engine === "provider"
              ? activeEngineLabel
              : `${activeEngineLabel} · ${activeDepthLabel}`}
          </span>
        ) : null}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="w-max min-w-48 max-w-[min(34rem,calc(100vw-1rem))]"
      >
        <DropdownMenuGroup>
          <DropdownMenuLabel className="flex items-center gap-1.5">
            <GlobeIcon className="size-3.5" />
            {t("chat:search.title")}
          </DropdownMenuLabel>
          {searchSelection ? (
            <DropdownMenuItem onClick={() => setSearchSelection(null)}>
              <CircleSlashIcon />
              {t("chat:search.closeSearch")}
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuSeparator />
          {SEARCH_ENGINES.map((engine) => {
            const meta = SEARCH_ENGINE_META[engine];
            const ready = isSearchEngineReady(engine, toolsConfig, activeProvider);
            const selected = searchSelection?.engine === engine ? searchSelection : null;
            const engineLabel = t(`chat:search.engines.${engine}.label`, meta.label);
            const engineDesc = t(`chat:search.engines.${engine}.desc`, meta.description);
            // provider 引擎缺的是「受支持的模型」,其余引擎缺的是 API Key —— 引导要区分
            const blockedBy = engine === "provider" ? "model" : "key";
            // 不可用的引擎不可选中(服务端不会注入工具);缺 Key 的点击引导去设置
            const enable = () => {
              if (ready) {
                setSearchSelection({ engine, depth: searchSelection?.depth ?? "balanced" });
              } else if (blockedBy === "key") {
                openSettings("tools");
              }
            };
            return (
              <DropdownMenuSub key={engine}>
                {/* 引擎行:点击直接启用;hover/展开进入二级菜单选择搜索强度 */}
                <DropdownMenuSubTrigger
                  className="min-w-60 pr-1 [&>svg:last-child]:ml-0"
                  onClick={enable}
                >
                  <span className="min-w-0 flex-1 truncate">{engineLabel}</span>
                  <span className="ml-auto flex shrink-0 items-center gap-1.5">
                    {ready && selected ? (
                      <Badge className="h-5 px-1.5 text-[10px]" variant="secondary">
                        {t(
                          `chat:search.depths.${selected.depth}.label`,
                          SEARCH_DEPTH_META[selected.depth].label,
                        )}
                      </Badge>
                    ) : !ready ? (
                      <Badge className="h-5 px-1.5 text-[10px]" variant="outline">
                        {blockedBy === "model"
                          ? t("chat:search.needModel")
                          : t("chat:search.needKey")}
                      </Badge>
                    ) : null}
                    {selected ? <CheckIcon className="size-4" /> : null}
                  </span>
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="w-max min-w-72 max-w-[min(34rem,calc(100vw-1rem))]">
                  <DropdownMenuGroup>
                    <DropdownMenuLabel className="whitespace-normal text-xs font-normal text-muted-foreground">
                      {engineDesc}
                    </DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    {ready ? (
                      <>
                        <DropdownMenuItem className="pr-2" onClick={enable}>
                          {t("chat:search.useEngine")}
                          <CheckIcon className="ml-auto size-4" />
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        {engine === "provider" ? (
                          // provider 原生检索的结果量由供应商决定,强度档位对它无意义 ——
                          // 不给一个不起作用的选择器,直接说明
                          <DropdownMenuLabel className="whitespace-normal text-xs font-normal text-muted-foreground">
                            {t("chat:search.providerHint")}
                          </DropdownMenuLabel>
                        ) : (
                          <>
                            <DropdownMenuLabel>{t("chat:search.searchDepth")}</DropdownMenuLabel>
                            <DropdownMenuRadioGroup
                              value={selected?.depth ?? "balanced"}
                              onValueChange={(depth) =>
                                setSearchSelection({ engine, depth: depth as SearchDepth })
                              }
                            >
                              {SEARCH_DEPTHS.map((depth) => (
                                <DropdownMenuRadioItem className="pr-2" key={depth} value={depth}>
                                  <span className="flex min-w-0 flex-1 flex-col gap-1">
                                    <Badge className="w-fit px-1.5 text-[10px]" variant="outline">
                                      {t(
                                        `chat:search.depths.${depth}.label`,
                                        SEARCH_DEPTH_META[depth].label,
                                      )}
                                    </Badge>
                                    <span className="whitespace-normal break-words text-[10px] text-muted-foreground">
                                      {t(
                                        `chat:search.depths.${depth}.desc`,
                                        SEARCH_DEPTH_META[depth].description,
                                      )}
                                    </span>
                                  </span>
                                </DropdownMenuRadioItem>
                              ))}
                            </DropdownMenuRadioGroup>
                          </>
                        )}
                      </>
                    ) : blockedBy === "model" ? (
                      <DropdownMenuLabel className="whitespace-normal text-xs font-normal text-muted-foreground">
                        {t("chat:search.unsupportedModel")}
                      </DropdownMenuLabel>
                    ) : (
                      <DropdownMenuItem onClick={() => openSettings("tools")}>
                        <SettingsIcon />
                        {t("chat:search.toSettings")}
                      </DropdownMenuItem>
                    )}
                  </DropdownMenuGroup>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            );
          })}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
