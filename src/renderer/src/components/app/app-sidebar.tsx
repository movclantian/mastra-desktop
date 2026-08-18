import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  ChevronRightIcon,
  ChevronsUpDown,
  FolderIcon,
  MessageCircleIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PinIcon,
  PinOffIcon,
  Settings2Icon,
  SquarePenIcon,
  Trash2Icon,
  WaypointsIcon,
} from "lucide-react";
import * as React from "react";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { Input } from "@/components/ui/input";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar";
import { useWorkbench, type WorkThread } from "@/lib/workbench";

// 结构参考:
// - 第一组(无 label)直接操作:新建任务等
// - 第二组「任务列表」:直接线程平铺 + 工作区作为可折叠文件夹
//   (docs/examples/base/sidebar-menu-collapsible.tsx 的 Collapsible +
//    SidebarMenuSub 写法)

function SidebarHeaderBrand() {
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton size="lg" tooltip="MastraWork">
          <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
            <WaypointsIcon className="size-4" />
          </div>
          <div className="grid flex-1 text-left text-sm leading-tight">
            <span className="truncate font-medium">MastraWork</span>
            <span className="truncate text-xs">AI Work Assistant</span>
          </div>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
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
  const { workspaces, pinThread, archiveThread, deleteThread, moveThread } = useWorkbench();

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
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <FolderIcon className="text-muted-foreground" />
            <span>移动到工作区</span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuItem onClick={() => void moveThread(thread.id, null)}>
              <span>不选择工作区</span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {workspaces.map((workspace) => (
              <DropdownMenuItem
                key={workspace.id}
                onClick={() => void moveThread(thread.id, workspace.id)}
              >
                <span>{workspace.name}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onClick={() => void deleteThread(thread.id)}>
          <Trash2Icon className="text-muted-foreground" />
          <span>删除</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function sortThreads(threads: WorkThread[]): WorkThread[] {
  return [...threads].sort((a, b) => {
    const pinned = Number(Boolean(b.metadata.pinned)) - Number(Boolean(a.metadata.pinned));
    if (pinned !== 0) return pinned;
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });
}

/** 直接线程:无工作区(或工作区已被删除)的平铺菜单项 */
function DirectThreadItem({
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

/** 工作区 = 任务列表内的可折叠文件夹 */
function WorkspaceFolder({
  name,
  icon,
  threads,
  defaultOpen = true,
  onRename,
  onEdit,
}: {
  name: string;
  icon: React.ComponentType<{ className?: string }>;
  threads: WorkThread[];
  defaultOpen?: boolean;
  onRename: (thread: WorkThread) => void;
  onEdit?: () => void;
}) {
  const sorted = sortThreads(threads);
  const Icon = icon;
  return (
    <Collapsible defaultOpen={defaultOpen} className="group/collapsible">
      <SidebarMenuItem>
        <CollapsibleTrigger render={<SidebarMenuButton />}>
          <Icon />
          <span>{name}</span>
          {threads.length > 0 ? (
            <span className="ml-1 text-xs text-muted-foreground tabular-nums">
              {threads.length}
            </span>
          ) : null}
          <ChevronRightIcon className="ml-auto transition-transform group-data-[state=open]/collapsible:rotate-90" />
        </CollapsibleTrigger>
        {onEdit ? (
          <DropdownMenu>
            <DropdownMenuTrigger render={<SidebarMenuAction showOnHover />}>
              <MoreHorizontalIcon />
              <span className="sr-only">More</span>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="right" align="start" className="w-40 rounded-lg">
              <DropdownMenuItem onClick={onEdit}>
                <PencilIcon className="text-muted-foreground" />
                <span>重命名工作区</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
        <CollapsibleContent>
          <SidebarMenuSub>
            {sorted.length === 0 ? (
              <SidebarMenuSubItem>
                <p className="px-2 py-1 text-xs text-muted-foreground">暂无会话</p>
              </SidebarMenuSubItem>
            ) : (
              sorted.map((thread) => (
                <WorkspaceThreadItem key={thread.id} thread={thread} onRename={onRename} />
              ))
            )}
          </SidebarMenuSub>
        </CollapsibleContent>
      </SidebarMenuItem>
    </Collapsible>
  );
}

// 参考 docs/examples/base/sidebar-rsc.tsx 的 NavProjectsSkeleton
const SKELETON_KEYS = ["a", "b", "c", "d"];

function ThreadListSkeleton() {
  return (
    <SidebarMenu>
      {SKELETON_KEYS.map((key) => (
        <SidebarMenuItem key={key}>
          <SidebarMenuSkeleton showIcon />
        </SidebarMenuItem>
      ))}
    </SidebarMenu>
  );
}

// 参考 docs/examples/base/sidebar-footer.tsx / sidebar-demo.tsx 的 NavUser
function NavUser() {
  const { isMobile } = useSidebar();
  const { user, setSettingsOpen } = useWorkbench();

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <SidebarMenuButton
                size="lg"
                className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
              />
            }
          >
            <Avatar className="h-8 w-8 rounded-lg">
              <AvatarFallback className="rounded-lg">
                {user.name.slice(0, 2).toUpperCase()}
              </AvatarFallback>
            </Avatar>
            <div className="grid flex-1 text-left text-sm leading-tight">
              <span className="truncate font-medium">{user.name}</span>
              <span className="truncate text-xs">{user.email}</span>
            </div>
            <ChevronsUpDown className="ml-auto size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-(--radix-dropdown-menu-trigger-width) min-w-56 rounded-lg"
            side={isMobile ? "bottom" : "right"}
            align="end"
            sideOffset={4}
          >
            <DropdownMenuGroup>
              <DropdownMenuLabel className="p-0 font-normal">
                <div className="flex items-center gap-2 px-1 py-1.5 text-left text-sm">
                  <Avatar className="h-8 w-8 rounded-lg">
                    <AvatarFallback className="rounded-lg">
                      {user.name.slice(0, 2).toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                  <div className="grid flex-1 text-left text-sm leading-tight">
                    <span className="truncate font-medium">{user.name}</span>
                    <span className="truncate text-xs">{user.email}</span>
                  </div>
                </div>
              </DropdownMenuLabel>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem onClick={() => setSettingsOpen(true)}>
                <Settings2Icon />
                设置
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const {
    workspaces,
    threads,
    threadsLoading,
    createThread,
    addWorkspace,
    renameWorkspace,
    renameThread,
  } = useWorkbench();
  const [renaming, setRenaming] = React.useState<WorkThread | null>(null);
  const [renameValue, setRenameValue] = React.useState("");
  const [newWorkspaceOpen, setNewWorkspaceOpen] = React.useState(false);
  const [newWorkspaceName, setNewWorkspaceName] = React.useState("");
  const [renamingWorkspace, setRenamingWorkspace] = React.useState<string | null>(null);
  const [renameWorkspaceValue, setRenameWorkspaceValue] = React.useState("");

  const activeThreads = threads.filter((t) => !t.metadata.archivedAt);
  const archivedThreads = sortThreads(threads.filter((t) => Boolean(t.metadata.archivedAt)));
  // 工作区已被删除的线程自动回落为直接线程,无需数据迁移
  const directThreads = sortThreads(
    activeThreads.filter(
      (t) => !t.metadata.workspaceId || !workspaces.some((w) => w.id === t.metadata.workspaceId),
    ),
  );

  const openRename = (thread: WorkThread) => {
    setRenaming(thread);
    setRenameValue(thread.title);
  };

  const handleRenameSubmit = () => {
    if (renaming && renameValue.trim()) {
      void renameThread(renaming.id, renameValue.trim());
    }
    setRenaming(null);
  };

  return (
    <Sidebar collapsible="icon" side="left" variant="sidebar" {...props}>
      <SidebarHeader>
        <SidebarHeaderBrand />
      </SidebarHeader>
      <SidebarContent>
        {/* 第一组:直接操作,无 GroupLabel */}
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton tooltip="新建任务" onClick={() => void createThread(null)}>
                  <SquarePenIcon />
                  <span>新建任务</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton tooltip="新建工作区" onClick={() => setNewWorkspaceOpen(true)}>
                  <FolderIcon />
                  <span>新建工作区</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {/* 第二组:任务列表 */}
        <SidebarGroup>
          <SidebarGroupLabel>任务列表</SidebarGroupLabel>
          <SidebarGroupContent>
            {threadsLoading ? (
              <ThreadListSkeleton />
            ) : (
              <SidebarMenu>
                {/* 直接线程(未按工作区分组) */}
                {directThreads.map((thread) => (
                  <DirectThreadItem key={thread.id} thread={thread} onRename={openRename} />
                ))}
                {/* 工作区 = 可折叠文件夹 */}
                {workspaces.map((workspace) => (
                  <WorkspaceFolder
                    key={workspace.id}
                    name={workspace.name}
                    icon={FolderIcon}
                    threads={activeThreads.filter((t) => t.metadata.workspaceId === workspace.id)}
                    onRename={openRename}
                    onEdit={() => {
                      setRenamingWorkspace(workspace.id);
                      setRenameWorkspaceValue(workspace.name);
                    }}
                  />
                ))}
                {/* 已归档:默认收起的文件夹 */}
                {archivedThreads.length > 0 ? (
                  <WorkspaceFolder
                    name="已归档"
                    icon={ArchiveIcon}
                    threads={archivedThreads}
                    defaultOpen={false}
                    onRename={openRename}
                  />
                ) : null}
              </SidebarMenu>
            )}
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <NavUser />
      </SidebarFooter>
      <SidebarRail />

      {/* 重命名线程弹窗 */}
      <Dialog open={renaming !== null} onOpenChange={(open) => !open && setRenaming(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>重命名会话</DialogTitle>
            <DialogDescription>为这个会话线程输入新名称。</DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleRenameSubmit();
            }}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenaming(null)}>
              取消
            </Button>
            <Button onClick={handleRenameSubmit}>保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 新建工作区弹窗 */}
      <Dialog open={newWorkspaceOpen} onOpenChange={setNewWorkspaceOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>新建工作区</DialogTitle>
            <DialogDescription>工作区是任务列表中的文件夹,用于归组相关会话线程。</DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            placeholder="工作区名称"
            value={newWorkspaceName}
            onChange={(e) => setNewWorkspaceName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && newWorkspaceName.trim()) {
                addWorkspace(newWorkspaceName.trim());
                setNewWorkspaceName("");
                setNewWorkspaceOpen(false);
              }
            }}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setNewWorkspaceOpen(false)}>
              取消
            </Button>
            <Button
              onClick={() => {
                if (newWorkspaceName.trim()) {
                  addWorkspace(newWorkspaceName.trim());
                  setNewWorkspaceName("");
                  setNewWorkspaceOpen(false);
                }
              }}
            >
              创建
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 重命名工作区弹窗 */}
      <Dialog
        open={renamingWorkspace !== null}
        onOpenChange={(open) => !open && setRenamingWorkspace(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>重命名工作区</DialogTitle>
            <DialogDescription>为这个工作区输入新名称。</DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            value={renameWorkspaceValue}
            onChange={(e) => setRenameWorkspaceValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && renamingWorkspace && renameWorkspaceValue.trim()) {
                renameWorkspace(renamingWorkspace, renameWorkspaceValue.trim());
                setRenamingWorkspace(null);
              }
            }}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenamingWorkspace(null)}>
              取消
            </Button>
            <Button
              onClick={() => {
                if (renamingWorkspace && renameWorkspaceValue.trim()) {
                  renameWorkspace(renamingWorkspace, renameWorkspaceValue.trim());
                  setRenamingWorkspace(null);
                }
              }}
            >
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Sidebar>
  );
}
