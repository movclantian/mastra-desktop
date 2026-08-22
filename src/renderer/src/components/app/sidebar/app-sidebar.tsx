import {
  ArchiveIcon,
  BotIcon,
  ChevronsUpDown,
  LaptopIcon,
  LibraryBigIcon,
  MoonIcon,
  PaletteIcon,
  SearchIcon,
  Settings2Icon,
  SlidersHorizontalIcon,
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
  useSidebar,
} from "@/components/ui/sidebar";
import { useWorkbench, type WorkThread } from "@/lib/workbench";
import {
  DirectThreadItem,
  sortThreads,
  ThreadFolder,
  ThreadListSkeleton,
  ThreadSearchDialog,
  WorkspaceGroup,
} from "./components";

// 结构参考:
// - 第一组(无 label)直接操作:新建任务 / 技能套件 / 资料库 / 主题风格(可折叠二级子菜单)
// - 第二组「任务列表」:components/thread-list.tsx 提供(直接线程平铺 + 显式绑定目录
//   可折叠文件夹 + 工作区文件树懒加载)

function SidebarHeaderBrand() {
  const { toggleSidebar } = useSidebar();

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton
          className="data-[slot=sidebar-menu-button]:p-1.5!"
          tooltip="收起侧边栏"
          onClick={toggleSidebar}
        >
          <div className="flex aspect-square size-6 items-center justify-center rounded-md bg-sidebar-primary text-sidebar-primary-foreground">
            <WaypointsIcon className="size-3.5" />
          </div>
          <span className="truncate font-semibold">MastraWork</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

// 参考 docs/examples/base/sidebar-footer.tsx / sidebar-demo.tsx 的 NavUser
function NavUser() {
  const { isMobile } = useSidebar();
  const { user, openSettings } = useWorkbench();
  const { mode, setMode, activePresetId, setPreset, presets, isDark } = useTheme();

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
              {/* 主题风格切换子菜单 */}
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <PaletteIcon className="text-muted-foreground" />
                  <span>主题风格</span>
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="w-48">
                  <DropdownMenuRadioGroup
                    value={activePresetId}
                    onValueChange={(val) => setPreset(val)}
                  >
                    {presets.map((p) => {
                      const colors = isDark ? p.dark : p.light;
                      return (
                        <DropdownMenuRadioItem key={p.id} value={p.id} className="gap-2">
                          <span
                            className="size-2.5 rounded-full border shrink-0"
                            style={{
                              backgroundColor: colors.primary,
                              borderColor: colors.border,
                            }}
                          />
                          <span className="truncate">{p.name}</span>
                        </DropdownMenuRadioItem>
                      );
                    })}
                  </DropdownMenuRadioGroup>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => openSettings("themes")}>
                    <SlidersHorizontalIcon className="size-3.5 text-muted-foreground" />
                    <span>主题参数调优…</span>
                  </DropdownMenuItem>
                </DropdownMenuSubContent>
              </DropdownMenuSub>

              {/* 色彩模式子菜单 */}
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <SunMediumIcon className="text-muted-foreground" />
                  <span>色彩模式</span>
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="w-40">
                  <DropdownMenuRadioGroup
                    value={mode}
                    onValueChange={(value) => setMode(value as "light" | "dark" | "system")}
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

              <DropdownMenuItem onClick={() => openSettings("providers")}>
                <Settings2Icon />
                系统设置
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
    agentOpen,
    setAgentOpen,
  } = useWorkbench();

  const [renaming, setRenaming] = React.useState<WorkThread | null>(null);
  const [renameValue, setRenameValue] = React.useState("");
  const [searchOpen, setSearchOpen] = React.useState(false);

  // metadata 经后端归一化为对象,这里仍用可选链兜底:null 会炸掉整个 UI
  const activeThreads = threads.filter((t) => !t.metadata?.archivedAt);
  const archivedThreads = sortThreads(threads.filter((t) => Boolean(t.metadata?.archivedAt)));

  // 显式绑定且已开始工作的线程按目录归组;草稿线程始终平铺
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
    <Sidebar collapsible="offcanvas" side="left" variant="inset" {...props}>
      <SidebarHeader>
        <SidebarHeaderBrand />
      </SidebarHeader>
      <SidebarContent>
        {/* 第一组:直接操作与系统核心功能 */}
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  tooltip="新建任务"
                  onClick={() => {
                    setLibraryOpen(false);
                    setSkillOpen(false);
                    setAgentOpen(false);
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
                    setAgentOpen(false);
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
                    setAgentOpen(false);
                    setLibraryOpen(true);
                  }}
                >
                  <LibraryBigIcon />
                  <span>资料库</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  tooltip="专家"
                  isActive={agentOpen}
                  onClick={() => {
                    setLibraryOpen(false);
                    setSkillOpen(false);
                    setAgentOpen(true);
                  }}
                >
                  <BotIcon />
                  <span>专家</span>
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
