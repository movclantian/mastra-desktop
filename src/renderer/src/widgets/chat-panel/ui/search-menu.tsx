import { useNavigate } from "@tanstack/react-router";
import { CheckIcon, CircleSlashIcon, SettingsIcon } from "lucide-react";
import {
  isSearchEngineReady,
  SEARCH_DEPTHS,
  SEARCH_ENGINES,
  type SearchDepth,
  type SearchSelection,
} from "@/entities/workbench";
import { useToolsConfigQuery } from "@/entities/workbench/model/queries/config";
import { useTranslation } from "@/shared/i18n";
import { Badge } from "@/shared/ui/badge";
import {
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/shared/ui/dropdown-menu";
import { ScrollArea } from "@/shared/ui/scroll-area";

/** The same engine/depth choices serve the + submenu and its active chip. */
export function SearchMenuItems({
  selection,
  onSelect,
}: {
  selection: SearchSelection | null;
  onSelect: (selection: SearchSelection | null) => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const config = useToolsConfigQuery().data ?? null;
  return (
    <ScrollArea className="max-h-[min(22rem,calc(var(--available-height)-0.5rem))]">
      <DropdownMenuGroup>
        <DropdownMenuItem onClick={() => onSelect(null)}>
          <CircleSlashIcon />
          <span className="min-w-0 flex-1">{t("chat:search.closeSearch")}</span>
          {!selection && <CheckIcon />}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {SEARCH_ENGINES.map((engine) => {
          const ready = isSearchEngineReady(engine, config);
          const selected = selection?.engine === engine;
          return (
            <DropdownMenuSub key={engine}>
              <DropdownMenuSubTrigger>
                <span className="min-w-0 flex-1">{t(`chat:search.engines.${engine}.label`)}</span>
                {!ready && (
                  <Badge variant="outline" className="px-1 text-[10px]">
                    {t("chat:search.needKey")}
                  </Badge>
                )}
                {selected && <CheckIcon className="size-3.5" />}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-64 overflow-hidden">
                <ScrollArea className="max-h-[min(22rem,calc(var(--available-height)-0.5rem))]">
                  <DropdownMenuGroup>
                    <DropdownMenuLabel className="whitespace-normal break-words font-normal">
                      {t(`chat:search.engines.${engine}.desc`)}
                    </DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    {ready ? (
                      <DropdownMenuRadioGroup
                        value={selected ? selection.depth : ""}
                        onValueChange={(depth) => onSelect({ engine, depth: depth as SearchDepth })}
                      >
                        {SEARCH_DEPTHS.map((depth) => (
                          <DropdownMenuRadioItem key={depth} value={depth}>
                            <span className="min-w-0">
                              <span className="block">
                                {t(`chat:search.depths.${depth}.label`)}
                              </span>
                              <span className="block whitespace-normal break-words text-xs text-muted-foreground">
                                {t(`chat:search.depths.${depth}.desc`)}
                              </span>
                            </span>
                          </DropdownMenuRadioItem>
                        ))}
                      </DropdownMenuRadioGroup>
                    ) : (
                      <DropdownMenuItem
                        onClick={() =>
                          void navigate({ to: "/settings", search: { section: "tools" } })
                        }
                      >
                        <SettingsIcon />
                        {t("chat:search.toSettings")}
                      </DropdownMenuItem>
                    )}
                  </DropdownMenuGroup>
                </ScrollArea>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          );
        })}
      </DropdownMenuGroup>
    </ScrollArea>
  );
}
