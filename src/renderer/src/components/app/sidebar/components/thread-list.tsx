import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  ChevronRightIcon,
  FolderOpenIcon,
  FolderTreeIcon,
  MessageCircleIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PinIcon,
  PinOffIcon,
  Trash2Icon,
} from "lucide-react";
import * as React from "react";
import { FolderTypeIcon } from "@/components/ai-elements/file-type-icon";
import { openPathInApp } from "@/components/ai-elements/open-in-chat";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { dirName, useWorkbench, type WorkThread } from "@/lib/workbench";
import { cn } from "@/lib/utils";

// 侧栏「任务列表」分组:直接线程平铺 + 显式绑定目录作为可折叠文件夹。
// 工作区文件统一从线程菜单进入右侧文件管理器,避免在任务列表中重复展开。

export function sortThreads(threads: WorkThread[]): WorkThread[] {
  return [...threads].sort((a, b) => {
    const pinned = Number(Boolean(b.metadata.pinned)) - Number(Boolean(a.metadata.pinned));
    if (pinned !== 0) return pinned;
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });
}

function ThreadActionMenu({
  thread,
  onRename,
  sub = false,
}: {
  thread: WorkThread;
  onRename: (thread: WorkThread) => void;
  /** 位于 SidebarMenuSub 内时调整定位与 hover 显示行为 */
  sub?: boolean;
}) {
  const { isMobile } = useSidebar();
  const {
    activeThreadId,
    archiveThread,
    deleteThread,
    openWorkspacePanel,
    pinThread,
    setActiveThreadId,
  } = useWorkbench();
  const workspacePath = thread.metadata.workspacePath;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <SidebarMenuAction
            showOnHover={!sub}
            className={
              sub
                ? "top-1 group-focus-within/menu-sub-item:opacity-100 group-hover/menu-sub-item:opacity-100 md:opacity-0"
                : undefined
            }
          />
        }
      >
        <MoreHorizontalIcon />
        <span className="sr-only">More</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        className="w-48 rounded-lg"
        side={isMobile ? "bottom" : "right"}
        align={isMobile ? "end" : "start"}
      >
        <DropdownMenuItem onClick={() => void pinThread(thread.id, !thread.metadata.pinned)}>
          {thread.metadata.pinned ? (
            <PinOffIcon className="text-muted-foreground" />
          ) : (
            <PinIcon className="text-muted-foreground" />
          )}
          <span>{thread.metadata.pinned ? "取消置顶" : "置顶"}</span>
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!workspacePath}
          onClick={() => {
            if (workspacePath) void openPathInApp("explorer", workspacePath, "文件资源管理器");
          }}
        >
          <FolderOpenIcon className="text-muted-foreground" />
          <span>在资源管理器打开</span>
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => {
            if (activeThreadId !== thread.id) setActiveThreadId(thread.id);
            openWorkspacePanel("files");
          }}
        >
          <FolderTreeIcon className="text-muted-foreground" />
          <span>文件管理</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => onRename(thread)}>
          <PencilIcon className="text-muted-foreground" />
          <span>重命名</span>
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => void archiveThread(thread.id, !thread.metadata.archivedAt)}
        >
          {thread.metadata.archivedAt ? (
            <ArchiveRestoreIcon className="text-muted-foreground" />
          ) : (
            <ArchiveIcon className="text-muted-foreground" />
          )}
          <span>{thread.metadata.archivedAt ? "取消归档" : "归档"}</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onClick={() => void deleteThread(thread.id)}>
          <Trash2Icon className="text-muted-foreground" />
          <span>删除</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** 直接线程:未显式绑定目录(隐式/草稿)的平铺菜单项 */
export function DirectThreadItem({
  thread,
  onRename,
}: {
  thread: WorkThread;
  onRename: (thread: WorkThread) => void;
}) {
  const { activeThreadId, setActiveThreadId } = useWorkbench();
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        isActive={thread.id === activeThreadId}
        onClick={() => setActiveThreadId(thread.id)}
        tooltip={thread.title}
      >
        <MessageCircleIcon />
        <span>{thread.title}</span>
      </SidebarMenuButton>
      {thread.metadata.pinned ? (
        <SidebarMenuBadge>
          <PinIcon className="size-3" />
        </SidebarMenuBadge>
      ) : null}
      <ThreadActionMenu thread={thread} onRename={onRename} />
    </SidebarMenuItem>
  );
}

/** 工作区内线程:SidebarMenuSub 子项 */
function WorkspaceThreadItem({
  thread,
  onRename,
}: {
  thread: WorkThread;
  onRename: (thread: WorkThread) => void;
}) {
  const { activeThreadId, setActiveThreadId } = useWorkbench();
  return (
    <SidebarMenuSubItem>
      <SidebarMenuSubButton
        isActive={thread.id === activeThreadId}
        onClick={() => setActiveThreadId(thread.id)}
      >
        <MessageCircleIcon />
        <span>{thread.title}</span>
      </SidebarMenuSubButton>
      <ThreadActionMenu thread={thread} onRename={onRename} sub />
    </SidebarMenuSubItem>
  );
}

/** 显式绑定目录 = 任务列表内的可折叠文件夹:同目录会话 + 工作区文件树 */
export function WorkspaceGroup({
  path,
  threads,
  onRename,
}: {
  path: string;
  threads: WorkThread[];
  onRename: (thread: WorkThread) => void;
}) {
  const sorted = sortThreads(threads);
  const [open, setOpen] = React.useState(false);
  return (
    <Collapsible className="group/collapsible" onOpenChange={setOpen} open={open}>
      <SidebarMenuItem>
        <CollapsibleTrigger render={<SidebarMenuButton tooltip={path} />}>
          <FolderTypeIcon name={dirName(path)} open={open} />
          <span className="truncate">{dirName(path)}</span>
          {sorted.length > 0 ? (
            <span className="ml-1 text-xs text-muted-foreground tabular-nums">{sorted.length}</span>
          ) : null}
          <ChevronRightIcon
            className={cn(
              "ml-auto size-4 shrink-0 text-muted-foreground transition-transform duration-200",
              open && "rotate-90 text-foreground",
            )}
          />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <SidebarMenuSub>
            {sorted.map((thread) => (
              <WorkspaceThreadItem key={thread.id} thread={thread} onRename={onRename} />
            ))}
          </SidebarMenuSub>
        </CollapsibleContent>
      </SidebarMenuItem>
    </Collapsible>
  );
}

/** 普通线程文件夹(已归档):无目录语义,仅收纳 */
export function ThreadFolder({
  name,
  icon,
  threads,
  defaultOpen = true,
  onRename,
}: {
  name: string;
  icon: React.ComponentType<{ className?: string }>;
  threads: WorkThread[];
  defaultOpen?: boolean;
  onRename: (thread: WorkThread) => void;
}) {
  const sorted = sortThreads(threads);
  const [open, setOpen] = React.useState(defaultOpen);
  const Icon = icon;
  return (
    <Collapsible
      defaultOpen={defaultOpen}
      open={open}
      onOpenChange={setOpen}
      className="group/collapsible"
    >
      <SidebarMenuItem>
        <CollapsibleTrigger render={<SidebarMenuButton />}>
          <Icon className="size-4 shrink-0" />
          <span>{name}</span>
          {sorted.length > 0 ? (
            <span className="ml-1 text-xs text-muted-foreground tabular-nums">{sorted.length}</span>
          ) : null}
          <ChevronRightIcon
            className={cn(
              "ml-auto size-4 shrink-0 text-muted-foreground transition-transform duration-200",
              open && "rotate-90 text-foreground",
            )}
          />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <SidebarMenuSub>
            {sorted.map((thread) => (
              <WorkspaceThreadItem key={thread.id} thread={thread} onRename={onRename} />
            ))}
          </SidebarMenuSub>
        </CollapsibleContent>
      </SidebarMenuItem>
    </Collapsible>
  );
}

// 参考 docs/examples/base/sidebar-rsc.tsx 的 NavProjectsSkeleton
const SKELETON_KEYS = ["a", "b", "c", "d"];

export function ThreadListSkeleton() {
  return (
    <SidebarMenu>
      {SKELETON_KEYS.map((key) => (
        <SidebarMenuItem key={key}></SidebarMenuItem>
      ))}
    </SidebarMenu>
  );
}
