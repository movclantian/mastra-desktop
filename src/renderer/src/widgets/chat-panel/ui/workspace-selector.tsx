import { CheckIcon, ChevronDownIcon, FolderIcon, FolderOpenIcon, XIcon } from "lucide-react";
import { dirName, type RecentWorkspace } from "@/entities/workbench";
import { useRecentWorkspacesQuery } from "@/entities/workbench/model/queries/workspace";
import { useAuth } from "@/features/auth";
import { useTranslation } from "@/shared/i18n";
import { cn } from "@/shared/lib";
import { Button } from "@/shared/ui/button";
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
// 工作区选择器(输入框上方的独立卡片,新会话首条消息前显示):
// 下拉列出近期绑定过的目录,或调用系统目录选择器选定本地工作目录;
// 选择只保存在当前输入状态,随首条消息上传并锁定到 thread.metadata;
// 已有消息的会话工作区不可中途更换。
// 选择器与下方输入框共享圆角容器,通过相邻背景层自然衔接;
// w-[96%] mx-auto 略窄于输入框,与 Queue 卡片同宽基准。
// ---------------------------------------------------------------------------

export function ChatWorkspaceSelector({
  value,
  onChange,
  className,
}: {
  /** 用户为新会话显式选定的工作区目录;null = 未选择(将隐式绑定默认目录) */
  value: string | null;
  onChange: (path: string | null) => void;
  /** 附加类名(如上方还有 Queue 卡片时去除顶边与其相接) */
  className?: string;
}) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const recentWorkspacesQuery = useRecentWorkspacesQuery(user?.id ?? "anonymous");
  const recentWorkspaces = recentWorkspacesQuery.data ?? [];
  const refreshRecentWorkspaces = () => recentWorkspacesQuery.refetch();

  const pickDirectory = async () => {
    const dir = await window.api?.filesystem.pickDirectory?.();
    if (dir) onChange(dir);
  };

  return (
    <div
      className={cn(
        "mx-auto flex w-[96%] items-center gap-1 rounded-xl rounded-b-none border border-b-0 bg-background px-2 py-1.5 shadow-xs",
        className,
      )}
    >
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="xs"
              className="h-7 min-w-0 gap-2 px-2 text-xs font-normal text-muted-foreground hover:text-foreground"
              title={value ?? t("chat:workspaceSelector.titleTooltip")}
            />
          }
        >
          <FolderIcon className={cn("size-4 shrink-0", value && "text-primary")} />
          <span className="max-w-64 truncate">
            {value ? dirName(value) : t("chat:workspaceSelector.selectPlaceholder")}
          </span>
          <ChevronDownIcon className="size-3.5 shrink-0 opacity-60" />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="w-max min-w-64 max-w-[min(calc(100vw-2rem),28rem)]"
        >
          <DropdownMenuGroup>
            <DropdownMenuLabel>{t("chat:workspaceSelector.menuLabel")}</DropdownMenuLabel>
            {value ? (
              <div className="flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground">
                <CheckIcon className="size-3.5 shrink-0 text-primary" />
                <span className="min-w-0 flex-1 truncate" title={value}>
                  {value}
                </span>
              </div>
            ) : (
              <div className="px-2 py-1.5 text-xs leading-relaxed text-muted-foreground">
                {t("chat:workspaceSelector.defaultDirectoryHint")}
              </div>
            )}
            {recentWorkspaces.length > 0 ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuLabel>{t("chat:workspaceSelector.recentlyUsed")}</DropdownMenuLabel>
                {recentWorkspaces.map((workspace: RecentWorkspace) => (
                  <DropdownMenuItem
                    key={workspace.path}
                    onClick={() => onChange(workspace.path)}
                    title={workspace.path}
                  >
                    <FolderOpenIcon />
                    <span className="min-w-0 flex-1 truncate">{dirName(workspace.path)}</span>
                    {value === workspace.path ? <CheckIcon className="size-4 shrink-0" /> : null}
                  </DropdownMenuItem>
                ))}
              </>
            ) : null}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => {
                void pickDirectory().then(() => void refreshRecentWorkspaces());
              }}
            >
              <FolderOpenIcon />
              {t("chat:workspaceSelector.chooseLocalDir")}
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      {value ? (
        <Button
          variant="ghost"
          size="xs"
          className="mr-1 ml-auto h-6 shrink-0 gap-1 px-1.5 text-[10px] text-muted-foreground hover:text-foreground"
          onClick={() => onChange(null)}
          title={t("chat:workspaceSelector.clearTooltip")}
        >
          <XIcon className="size-3" />
          {t("chat:workspaceSelector.clear")}
        </Button>
      ) : null}
    </div>
  );
}
