import { CheckIcon, CircleSlashIcon, GlobeIcon, SettingsIcon } from "lucide-react";
import {
  isSearchEngineReady,
  SEARCH_DEPTH_META,
  SEARCH_DEPTHS,
  SEARCH_ENGINE_META,
  SEARCH_ENGINES,
  type SearchDepth,
  useWorkbench,
} from "@/entities/workbench";
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
  const {
    searchSelection,
    setSearchSelection,
    toolsConfig,
    openSettings,
    providers,
    modelSelection,
  } = useWorkbench();

  const activeEngine = searchSelection ? SEARCH_ENGINE_META[searchSelection.engine] : null;
  // provider 原生检索的可用性取决于当前选定模型的家族,而非 API Key
  const activeProvider = providers.find((provider) => provider.id === modelSelection?.providerId);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <PromptInputButton
            aria-label="联网检索"
            // 见 approval-selector 同处注释:解开 min-content 定宽,标签才能截短
            className="min-w-0"
            size={searchSelection ? "sm" : "icon-sm"}
            title={searchSelection ? `联网检索:${activeEngine?.label}` : "开启联网检索"}
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
              ? activeEngine?.label
              : `${activeEngine?.label} · ${SEARCH_DEPTH_META[searchSelection.depth].label}`}
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
            联网检索
          </DropdownMenuLabel>
          {searchSelection ? (
            <DropdownMenuItem onClick={() => setSearchSelection(null)}>
              <CircleSlashIcon />
              关闭联网检索
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuSeparator />
          {SEARCH_ENGINES.map((engine) => {
            const meta = SEARCH_ENGINE_META[engine];
            const ready = isSearchEngineReady(engine, toolsConfig, activeProvider);
            const selected = searchSelection?.engine === engine ? searchSelection : null;
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
                  <span className="min-w-0 flex-1 truncate">{meta.label}</span>
                  <span className="ml-auto flex shrink-0 items-center gap-1.5">
                    {ready && selected ? (
                      <Badge className="h-5 px-1.5 text-[10px]" variant="secondary">
                        {SEARCH_DEPTH_META[selected.depth].label}
                      </Badge>
                    ) : !ready ? (
                      <Badge className="h-5 px-1.5 text-[10px]" variant="outline">
                        {blockedBy === "model" ? "需换模型" : "需 Key"}
                      </Badge>
                    ) : null}
                    {selected ? <CheckIcon className="size-4" /> : null}
                  </span>
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="w-max min-w-72 max-w-[min(34rem,calc(100vw-1rem))]">
                  <DropdownMenuGroup>
                    <DropdownMenuLabel className="whitespace-normal text-xs font-normal text-muted-foreground">
                      {meta.description}
                    </DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    {ready ? (
                      <>
                        <DropdownMenuItem className="pr-2" onClick={enable}>
                          使用此引擎
                          <CheckIcon className="ml-auto size-4" />
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        {engine === "provider" ? (
                          // provider 原生检索的结果量由供应商决定,强度档位对它无意义 ——
                          // 不给一个不起作用的选择器,直接说明
                          <DropdownMenuLabel className="whitespace-normal text-xs font-normal text-muted-foreground">
                            结果数量由供应商决定,无强度档位;需要读全文时会调用 web_fetch。
                          </DropdownMenuLabel>
                        ) : (
                          <>
                            <DropdownMenuLabel>搜索强度</DropdownMenuLabel>
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
                                      {SEARCH_DEPTH_META[depth].label}
                                    </Badge>
                                    <span className="whitespace-normal break-words text-[10px] text-muted-foreground">
                                      {SEARCH_DEPTH_META[depth].description}
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
                        当前模型不支持:请在模型选择器换成 OpenAI / Anthropic / Google / xAI
                        的内置供应商模型(自定义网关不支持)。
                      </DropdownMenuLabel>
                    ) : (
                      <DropdownMenuItem onClick={() => openSettings("tools")}>
                        <SettingsIcon />
                        去设置填写 API Key
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
