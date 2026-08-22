import {
  ArchiveIcon,
  ChevronsUpDown,
  LaptopIcon,
  LibraryBigIcon,
  MoonIcon,
  SearchIcon,
  Settings2Icon,
  SparklesIcon,
  SquarePenIcon,
  SunMediumIcon,
  WaypointsIcon,
} from "lucide-react";
import * as React from "react";
import { useTheme } from "@/components/theme-provider";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
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
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
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
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { useWorkbench, type WorkThread } from "@/lib/workbench";
import {
  DirectThreadItem,
  sortThreads,
  ThreadFolder,
  ThreadListSkeleton,
  WorkspaceGroup,
  ThreadSearchDialog,
} from "./components";

// 结构参考:
// - 第一组(无 label)直接操作:新建任务
// - 第二组「任务列表」:components/thread-list.tsx 提供(直接线程平铺 + 显式绑定目录
//   可折叠文件夹 + 工作区文件树懒加载)

function SidebarHeaderBrand() {
  return (
    <SidebarMenu>
      <SidebarMenuItem className="flex items-center gap-1">
        <SidebarMenuButton
          className="min-w-0 flex-1 group-data-[collapsible=icon]:hidden"
          tooltip="MastraWork"
        >
          <div className="flex aspect-square size-6 items-center justify-center rounded-md bg-sidebar-primary text-sidebar-primary-foreground">
            <WaypointsIcon className="size-3.5" />
          </div>
          <span className="truncate font-medium">MastraWork</span>
        </SidebarMenuButton>
        {/* 展开/收起按钮融合进头部:收起时 brand 隐藏,按钮居中占据整行 */}
        <SidebarTrigger className="group-data-[collapsible=icon]:mx-auto" />
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

// 参考 docs/examples/base/sidebar-footer.tsx / sidebar-demo.tsx 的 NavUser
function NavUser() {
  const { isMobile } = useSidebar();
  const { user, setSettingsOpen } = useWorkbench();
  const { theme, setTheme } = useTheme();

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
              {/* 主题子菜单:官方 mode-toggle 的菜单形态(浅色/深色/跟随系统) */}
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <SunMediumIcon className="text-muted-foreground" />
                  <span>主题</span>
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="w-40">
                  <DropdownMenuRadioGroup
                    value={theme}
                    onValueChange={(value) => setTheme(value as "light" | "dark" | "system")}
                  >
                    <DropdownMenuRadioItem value="light">
                      <SunMediumIcon className="text-muted-foreground" />
                      浅色
                    </DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="dark">
                      <MoonIcon className="text-muted-foreground" />
                      深色
                    </DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="system">
                      <LaptopIcon className="text-muted-foreground" />
                      跟随系统
                    </DropdownMenuRadioItem>
                  </DropdownMenuRadioGroup>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
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
    threads,
    threadsLoading,
    createThread,
    renameThread,
    libraryOpen,
    setLibraryOpen,
    skillOpen,
    setSkillOpen,
  } = useWorkbench();
  const [renaming, setRenaming] = React.useState<WorkThread | null>(null);
  const [renameValue, setRenameValue] = React.useState("");
  const [searchOpen, setSearchOpen] = React.useState(false);

  // metadata 经后端归一化为对象,这里仍用可选链兜底:null 会炸掉整个 UI
  const activeThreads = threads.filter((t) => !t.metadata?.archivedAt);
  const archivedThreads = sortThreads(threads.filter((t) => Boolean(t.metadata?.archivedAt)));

  // 显式绑定且已开始工作的线程按目录归组;草稿线程始终平铺,即使旧状态
  // 曾经提前写入过 workspacePath,也不能让空会话占据目录归属。
  const directThreads: WorkThread[] = [];
  const groupsByPath = new Map<string, WorkThread[]>();
  for (const thread of activeThreads) {
    const path =
      thread.metadata?.workspaceExplicit === true ? thread.metadata.workspacePath : undefined;
    if (!path || thread.metadata?.draft === true) {
      directThreads.push(thread);
      continue;
    }
    const group = groupsByPath.get(path);
    if (group) group.push(thread);
    else groupsByPath.set(path, [thread]);
  }
  // 目录组按组内最近活动排序
  const workspaceGroups = [...groupsByPath.entries()]
    .map(([path, groupThreads]) => ({
      path,
      threads: groupThreads,
      latestUpdatedAt: groupThreads.reduce(
        (max, thread) => (thread.updatedAt > max ? thread.updatedAt : max),
        "",
      ),
    }))
    .sort((a, b) => b.latestUpdatedAt.localeCompare(a.latestUpdatedAt));

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
      {/* 头部使用轻微底色层级,与主内容顶栏保持同一高度。 */}
      <SidebarHeader className="bg-sidebar-accent/30">
        <SidebarHeaderBrand />
      </SidebarHeader>
      <SidebarContent>
        {/* 第一组:直接操作,无 GroupLabel */}
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  tooltip="新建任务"
                  onClick={() => {
                    setLibraryOpen(false);
                    setSkillOpen(false);
                    void createThread();
                  }}
                >
                  <SquarePenIcon />
                  <span>新建任务</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  isActive={skillOpen}
                  onClick={() => {
                    setLibraryOpen(false);
                    setSkillOpen(true);
                  }}
                  tooltip="技能套件"
                >
                  <SparklesIcon />
                  <span>技能套件</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  tooltip="资料库"
                  isActive={libraryOpen}
                  onClick={() => {
                    setSkillOpen(false);
                    setLibraryOpen(true);
                  }}
                >
                  <LibraryBigIcon />
                  <span>资料库</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {/* 第二组:任务列表 */}
        <SidebarGroup>
          {/* 官方 sidebar-group-action.tsx 模式:label 右侧操作(检索线程消息) */}
          <SidebarGroupLabel>
            任务列表
            <SidebarGroupAction
              title="检索线程消息"
              onClick={() => setSearchOpen(true)}
              aria-label="检索线程消息"
            >
              <SearchIcon />
              <span className="sr-only">检索线程消息</span>
            </SidebarGroupAction>
          </SidebarGroupLabel>
          <SidebarGroupContent>
            {threadsLoading ? (
              <ThreadListSkeleton />
            ) : (
              <SidebarMenu>
                {/* 直接线程(未显式绑定目录) */}
                {sortThreads(directThreads).map((thread) => (
                  <DirectThreadItem key={thread.id} thread={thread} onRename={openRename} />
                ))}
                {/* 显式绑定目录 = 可折叠文件夹(会话 + 文件树) */}
                {workspaceGroups.map((group) => (
                  <WorkspaceGroup
                    key={group.path}
                    path={group.path}
                    threads={group.threads}
                    onRename={openRename}
                  />
                ))}
                {/* 已归档:默认收起的文件夹 */}
                {archivedThreads.length > 0 ? (
                  <ThreadFolder
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

      {/* 线程消息检索弹窗(Memory.recall 语义检索) */}
      <ThreadSearchDialog open={searchOpen} onOpenChange={setSearchOpen} />
    </Sidebar>
  );
}
