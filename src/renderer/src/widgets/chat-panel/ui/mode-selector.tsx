import { useRouterState } from "@tanstack/react-router";
import { CheckIcon, EyeIcon, HammerIcon, MapIcon } from "lucide-react";
import type { ComponentType } from "react";
import {
  matchApprovalPreset,
  WORK_MODE_IDS,
  WORK_MODE_META,
  type WorkModeId,
} from "@/entities/workbench";
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
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";
import { ApprovalMenuItems } from "./approval-selector";

// ---------------------------------------------------------------------------
// 会话模式选择器(plan → build → review)
// 模式切到哪就写进 thread.metadata.modeId,chat 路由每次请求据此叠加模式指令、
// 并按 Controller 的 availableTools/权限策略收回工具。
// 计划获批后由服务端自动切到 transitionsTo,前端刷新线程即可看到。
// ---------------------------------------------------------------------------

const MODE_ICONS: Record<WorkModeId, ComponentType<{ className?: string }>> = {
  plan: MapIcon,
  build: HammerIcon,
  review: EyeIcon,
};

export function ChatModeSelector() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const activeThreadId = useRouterState({
    select: (state) => (state.location.search as { thread?: string }).thread ?? null,
  });
  const { modeId, setModeId, permissionRules, setPermissionRules } = useSessionSettings(
    user?.id ?? "anonymous",
    activeThreadId,
  );
  const ActiveIcon = MODE_ICONS[modeId];
  const activeModeLabel = t(`chat:modes.${modeId}.label`, WORK_MODE_META[modeId].label);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <PromptInputButton
            aria-label={t("chat:modes.title")}
            // 见 approval-selector 同处注释:解开 min-content 定宽,标签才能截短
            className="min-w-0"
            size="sm"
            title={`${t("chat:modes.title")}:${activeModeLabel}`}
            type="button"
            variant="outline"
          />
        }
      >
        <ActiveIcon className="text-primary" />
        <span className="max-w-20 truncate text-xs">{activeModeLabel}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72 max-w-[min(90vw,26rem)]">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{t("chat:modes.title")}</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {WORK_MODE_IDS.map((id) => {
            const meta = WORK_MODE_META[id];
            const Icon = MODE_ICONS[id];
            const label = t(`chat:modes.${id}.label`, meta.label);
            const desc = t(`chat:modes.${id}.desc`, meta.description);
            const hint = t(`chat:modes.${id}.hint`, meta.hint);
            return (
              <DropdownMenuSub key={id}>
                <DropdownMenuSubTrigger className="items-start gap-2 py-2">
                  <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="flex items-center gap-1.5">
                      {label}
                      {id === modeId ? <CheckIcon className="ml-auto size-3.5" /> : null}
                    </span>
                    <span className="whitespace-normal text-[11px] leading-snug text-muted-foreground">
                      {desc}
                    </span>
                    <Badge className="h-4 w-fit px-1.5 text-[10px]" variant="secondary">
                      {hint}
                    </Badge>
                  </span>
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="w-72">
                  <DropdownMenuGroup>
                    <DropdownMenuLabel>{t("chat:modes.modeTitle")}</DropdownMenuLabel>
                    <DropdownMenuItem onClick={() => void setModeId(id)}>
                      {t("chat:modes.switchTo", { name: label })}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <ApprovalMenuItems
                      activePreset={matchApprovalPreset(permissionRules)}
                      setPermissionRules={setPermissionRules}
                    />
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
