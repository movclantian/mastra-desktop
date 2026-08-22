import { CheckIcon, EyeIcon, HammerIcon, MapIcon } from "lucide-react";
import type { ComponentType } from "react";
import { PromptInputButton } from "@/components/ai-elements/prompt-input";
import { Badge } from "@/components/ui/badge";
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
} from "@/components/ui/dropdown-menu";
import { matchApprovalPreset, WORK_MODE_IDS, WORK_MODE_META, type WorkModeId } from "@/lib/session-policy";
import { useWorkbench } from "@/lib/workbench";
import { ApprovalMenuItems } from "./approval-selector";

// ---------------------------------------------------------------------------
// 会话模式选择器(plan → build → review)
// 模式切到哪就写进 thread.metadata.modeId,chat 路由每次请求据此叠加模式指令、
// 并按模式的 deniedCategories 收回工具(src/mastra/agents/modes.ts)。
// 计划获批后由服务端自动切到 transitionsTo,前端刷新线程即可看到。
// ---------------------------------------------------------------------------

const MODE_ICONS: Record<WorkModeId, ComponentType<{ className?: string }>> = {
  plan: MapIcon,
  build: HammerIcon,
  review: EyeIcon,
};

export function ChatModeSelector() {
  const { modeId, setModeId, permissionRules, setPermissionRules } = useWorkbench();
  const ActiveIcon = MODE_ICONS[modeId];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <PromptInputButton
            aria-label="会话模式"
            // 见 approval-selector 同处注释:解开 min-content 定宽,标签才能截短
            className="min-w-0"
            size="sm"
            title={`会话模式:${WORK_MODE_META[modeId].label}`}
            type="button"
            variant="outline"
          />
        }
      >
        <ActiveIcon className="text-primary" />
        <span className="max-w-20 truncate text-xs">{WORK_MODE_META[modeId].label}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-max max-w-[min(90vw,32rem)]">
        <DropdownMenuGroup>
          <DropdownMenuLabel>会话模式</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {WORK_MODE_IDS.map((id) => {
            const meta = WORK_MODE_META[id];
            const Icon = MODE_ICONS[id];
            return (
              <DropdownMenuSub key={id}>
                <DropdownMenuSubTrigger className="items-start gap-2 py-2">
                  <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="flex items-center gap-1.5">{meta.label}{id === modeId ? <CheckIcon className="ml-auto size-3.5" /> : null}</span>
                    <span className="whitespace-normal text-[11px] leading-snug text-muted-foreground">{meta.description}</span>
                    <Badge className="h-4 w-fit px-1.5 text-[10px]" variant="secondary">{meta.hint}</Badge>
                  </span>
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="w-72">
                  <DropdownMenuGroup>
                    <DropdownMenuLabel>模式与工具审批</DropdownMenuLabel>
                    <DropdownMenuItem onClick={() => void setModeId(id)}>切换到{meta.label}</DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <ApprovalMenuItems
                      activePreset={matchApprovalPreset(permissionRules)}
                      lockedCategories={meta.deniedCategories}
                      modeId={id}
                      permissionRules={permissionRules}
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
