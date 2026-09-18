import { useRouterState } from "@tanstack/react-router";
import { CheckIcon, ShieldCheckIcon, ShieldIcon, ZapIcon } from "lucide-react";
import { APPROVAL_PRESETS, matchApprovalPreset, type PermissionRules } from "@/entities/workbench";
import { useSessionSettings } from "@/entities/workbench/model/use-session-settings";
import { useAuth } from "@/features/auth";
import { useTranslation } from "@/shared/i18n";
import { PromptInputButton } from "@/shared/ui/ai-elements/prompt-input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";

// ---------------------------------------------------------------------------
// 审批模式选择器:规则落在 thread.metadata,由工作台 Agent 请求上下文读取。
// 结构:只保留两个预设(逐次审批 / 全部允许);类别策略仍由服务端规则保留,
// 但不在这个入口暴露微调面板,避免把一次简单的全局切换变成多层菜单。
// - 允许:直接执行
// - 询问:流里发 tool-call-approval,渲染审批面板等用户批准
// - 拒绝:该类工具不给模型(自己注入的直接不注入,工作区工具在调用前被拦下)
// 当前模式强制拒绝的类别(如复查模式的写入/执行)仍由服务端执行,
// 不在这个入口重复展示或编辑(见 src/mastra/agents/modes.ts)。
// ---------------------------------------------------------------------------

export function ChatApprovalSelector() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const activeThreadId = useRouterState({
    select: (state) => (state.location.search as { thread?: string }).thread ?? null,
  });
  const { permissionRules, setPermissionRules } = useSessionSettings(
    user?.id ?? "anonymous",
    activeThreadId,
  );
  const activePreset = matchApprovalPreset(permissionRules);
  const allowAll = activePreset === "allow-all";

  const summary =
    activePreset === "standard"
      ? t("chat:approvals.standard.label")
      : activePreset === "allow-all"
        ? t("chat:approvals.allowAll.label")
        : t("chat:approvals.custom");

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <PromptInputButton
            aria-label={t("chat:approvals.title")}
            // min-w-0:按钮默认按 min-content 定宽,而 truncate 含 whitespace-nowrap,
            // 那个 min-content 就是标签全宽 —— 不解开就永远不会收缩,只会顶宽工具栏
            className="min-w-0"
            size="sm"
            title={`${t("chat:approvals.title")}:${summary}`}
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
        <span className="max-w-24 truncate text-xs">{summary}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64 max-w-[min(90vw,24rem)]">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="flex items-center gap-1.5">
            <ShieldIcon className="size-3.5" />
            {t("chat:approvals.title")}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <ApprovalMenuItems activePreset={activePreset} setPermissionRules={setPermissionRules} />
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function ApprovalMenuItems({
  activePreset,
  setPermissionRules,
}: {
  activePreset: ReturnType<typeof matchApprovalPreset>;
  setPermissionRules: (rules: PermissionRules) => Promise<void>;
}) {
  const { t } = useTranslation();
  return (
    <>
      {APPROVAL_PRESETS.map((preset) => {
        const label =
          preset.id === "standard"
            ? t("chat:approvals.standard.label")
            : t("chat:approvals.allowAll.label");
        const desc =
          preset.id === "standard"
            ? t("chat:approvals.standard.desc")
            : t("chat:approvals.allowAll.desc");
        return (
          <DropdownMenuItem
            className="items-start gap-2"
            key={preset.id}
            onClick={() => void setPermissionRules(preset.rules)}
          >
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="flex items-center gap-1.5">
                {label}
                {activePreset === preset.id ? <CheckIcon className="ml-auto size-3.5" /> : null}
              </span>
              <span className="whitespace-normal break-words text-xs leading-snug text-muted-foreground">
                {desc}
              </span>
            </span>
          </DropdownMenuItem>
        );
      })}
    </>
  );
}
