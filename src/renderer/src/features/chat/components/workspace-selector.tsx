import { CheckIcon, ChevronDownIcon, FolderIcon, FolderOpenIcon, XIcon } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { dirName, type RecentWorkspace, useWorkbench } from "@/features/workbench";
import { cn } from "@/lib/utils";

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
  const { recentWorkspaces, refreshRecentWorkspaces } = useWorkbench();

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
            <button
              type="button"
              className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              title={value ?? "为新会话选择工作区目录(可选)"}
            />
          }
        >
          <FolderIcon className={cn("size-4 shrink-0", value && "text-primary")} />
          <span className="max-w-64 truncate">
            {value ? dirName(value) : "选择工作区目录(可选)"}
          </span>
          <ChevronDownIcon className="size-3.5 shrink-0 opacity-60" />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="w-max min-w-64 max-w-[min(calc(100vw-2rem),28rem)]"
        >
          <DropdownMenuGroup>
            <DropdownMenuLabel>工作区目录(发送首条消息后锁定)</DropdownMenuLabel>
            {value ? (
              <div className="flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground">
                <CheckIcon className="size-3.5 shrink-0 text-primary" />
                <span className="min-w-0 flex-1 truncate" title={value}>
                  {value}
                </span>
              </div>
            ) : (
              <div className="px-2 py-1.5 text-xs leading-relaxed text-muted-foreground">
                不选择则使用默认目录(仅 Agent 工作目录,不展示文件树)
              </div>
            )}
            {recentWorkspaces.length > 0 ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuLabel>近期使用</DropdownMenuLabel>
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
              选择本地目录…
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      {value ? (
        <button
          type="button"
          className="mr-1 ml-auto flex shrink-0 items-center gap-1 text-[10px] text-muted-foreground transition-colors hover:text-foreground"
          onClick={() => onChange(null)}
          title="清除选择(改为默认目录)"
        >
          <XIcon className="size-3" />
          清除
        </button>
      ) : null}
    </div>
  );
}
