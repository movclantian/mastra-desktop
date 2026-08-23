import { CheckIcon, ShieldCheckIcon, ShieldIcon, ZapIcon } from "lucide-react";
import { PromptInputButton } from "@/components/ai-elements/prompt-input";
import { Badge } from "@/components/ui/badge";
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
} from "@/components/ui/dropdown-menu";
import {
  APPROVAL_PRESETS,
  approvalSummary,
  CATEGORY_META,
  matchApprovalPreset,
  PERMISSION_POLICIES,
  type PermissionPolicy,
  type PermissionRules,
  POLICY_META,
  TOOL_CATEGORIES,
  WORK_MODE_META,
  withCategoryPolicy,
} from "@/lib/session-policy";
import { useWorkbench } from "@/lib/workbench";

// ---------------------------------------------------------------------------
// 审批模式选择器:规则落在 thread.metadata,由工作台 Agent 请求上下文读取。
// 结构:预设(逐次审批 / 全部允许)→ 按类别微调(允许 / 询问 / 拒绝)
// - 允许:直接执行
// - 询问:流里发 tool-call-approval,渲染审批面板等用户批准
// - 拒绝:该类工具不给模型(自己注入的直接不注入,工作区工具在调用前被拦下)
// 当前模式强制拒绝的类别(如复查模式的写入/执行)在此只读展示,不可放开 ——
// 否则「只读复查」这个承诺不成立(见 src/mastra/agents/modes.ts)。
// ---------------------------------------------------------------------------

export function ChatApprovalSelector() {
  const { permissionRules, setPermissionRules, modeId } = useWorkbench();
  const activePreset = matchApprovalPreset(permissionRules);
  const lockedCategories = WORK_MODE_META[modeId].deniedCategories;
  const allowAll = activePreset === "allow-all";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <PromptInputButton
            aria-label="审批模式"
            // min-w-0:按钮默认按 min-content 定宽,而 truncate 含 whitespace-nowrap,
            // 那个 min-content 就是标签全宽 —— 不解开就永远不会收缩,只会顶宽工具栏
            className="min-w-0"
            size="sm"
            title={`工具审批:${approvalSummary(permissionRules)}`}
            type="button"
            variant="outline"
          />
        }
      >
        {allowAll ? (
          <ZapIcon className="text-amber-500" />
        ) : (
          <ShieldCheckIcon className="text-primary" />
        )}
        <span className="max-w-24 truncate text-xs">{approvalSummary(permissionRules)}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-max max-w-[min(90vw,32rem)]">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="flex items-center gap-1.5">
            <ShieldIcon className="size-3.5" />
            工具审批
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <ApprovalMenuItems
            activePreset={activePreset}
            lockedCategories={lockedCategories}
            modeId={modeId}
            permissionRules={permissionRules}
            setPermissionRules={setPermissionRules}
          />
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function ApprovalMenuItems({
  activePreset,
  lockedCategories,
  modeId,
  permissionRules,
  setPermissionRules,
}: {
  activePreset: ReturnType<typeof matchApprovalPreset>;
  lockedCategories: readonly string[];
  modeId: keyof typeof WORK_MODE_META;
  permissionRules: PermissionRules;
  setPermissionRules: (rules: PermissionRules) => Promise<void>;
}) {
  return (
    <>
      {APPROVAL_PRESETS.map((preset) => (
        <DropdownMenuItem
          className="items-start gap-2"
          key={preset.id}
          onClick={() => void setPermissionRules(preset.rules)}
        >
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="flex items-center gap-1.5">
              {preset.label}
              {activePreset === preset.id ? <CheckIcon className="ml-auto size-3.5" /> : null}
            </span>
            <Badge className="h-4 w-fit px-1.5 text-[10px]" variant="secondary">
              {preset.description}
            </Badge>
          </span>
        </DropdownMenuItem>
      ))}
      <DropdownMenuSeparator />
      <DropdownMenuLabel>按类别微调</DropdownMenuLabel>
      {TOOL_CATEGORIES.map((category) => {
        const meta = CATEGORY_META[category];
        const locked = lockedCategories.includes(category);
        const policy: PermissionPolicy = locked
          ? "deny"
          : (permissionRules.categories[category] ?? "ask");
        return (
          <DropdownMenuSub key={category}>
            <DropdownMenuSubTrigger>
              <span className="truncate">{meta.label}</span>
              <Badge className="ml-auto h-4 shrink-0 px-1.5 text-[10px]" variant="secondary">
                {locked ? "模式锁定" : POLICY_META[policy].label}
              </Badge>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-56">
              <DropdownMenuGroup>
                <DropdownMenuLabel className="whitespace-normal text-xs font-normal text-muted-foreground">
                  {meta.description}
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                {locked ? (
                  <DropdownMenuLabel className="whitespace-normal text-xs font-normal text-muted-foreground">
                    「{WORK_MODE_META[modeId].label}」模式强制拒绝这一类,换模式后才能调整。
                  </DropdownMenuLabel>
                ) : (
                  <DropdownMenuRadioGroup
                    onValueChange={(next) =>
                      void setPermissionRules(
                        withCategoryPolicy(permissionRules, category, next as PermissionPolicy),
                      )
                    }
                    value={policy}
                  >
                    {PERMISSION_POLICIES.map((candidate) => (
                      <DropdownMenuRadioItem key={candidate} value={candidate}>
                        <span className="flex min-w-0 flex-col">
                          <span>{POLICY_META[candidate].label}</span>
                          <span className="truncate text-[10px] text-muted-foreground">
                            {POLICY_META[candidate].description}
                          </span>
                        </span>
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                )}
              </DropdownMenuGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        );
      })}
    </>
  );
}
