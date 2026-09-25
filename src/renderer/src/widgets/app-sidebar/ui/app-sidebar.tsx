import { useLocation, useNavigate, useRouterState } from "@tanstack/react-router";
import {
  ArchiveIcon,
  ArrowLeftIcon,
  ArrowLeftRightIcon,
  BotIcon,
  CalendarClockIcon,
  ChevronsUpDown,
  KeyboardIcon,
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
import {
  useActiveThreadResolver,
  useCreateThreadMutation,
  useRenameThreadMutation,
  useThreadsQuery,
} from "@/entities/workbench/model/queries/threads";
import type { MainView, WorkThread } from "@/entities/workbench/model/types";
import { viewFromPath } from "@/entities/workbench/model/types";
import { useWorkbenchStore } from "@/entities/workbench";
import { useAuth } from "@/features/auth";
import { formatShortcutDisplay, isMacPlatform } from "@/features/command-palette";
import { useTranslation } from "@/shared/i18n";
import { cn } from "@/shared/lib";
import { useTheme } from "@/shared/theme";
import { Avatar, AvatarFallback } from "@/shared/ui/avatar";
import { Button } from "@/shared/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/shared/ui/context-menu";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
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
} from "@/shared/ui/dropdown-menu";
import { Field, FieldLabel } from "@/shared/ui/field";
import { Input } from "@/shared/ui/input";
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
} from "@/shared/ui/sidebar";
import {
  DirectThreadItem,
  sortThreads,
  ThreadListSkeleton,
  ThreadWorkspaceTree,
  WorkspaceGroup,
} from "./thread-list";
import { ThreadTransferInboxDialog } from "./thread-transfer-inbox";

// 结构参考:
// - 第一组(无 label)直接操作:新建任务 / 技能套件 / 资料库 / 主题风格(可折叠二级子菜单)
// - 第二组「任务列表」:components/thread-list.tsx 提供(直接线程平铺 + 显式绑定目录
//   可折叠文件夹 + 工作区文件树懒加载)

function SidebarHeaderBrand() {
  const { t } = useTranslation();
  const { toggleSidebar } = useSidebar();

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton size="sm" tooltip={t("sidebar:collapseSidebar")} onClick={toggleSidebar}>
          <div className="flex aspect-square size-6 items-center justify-center rounded-md bg-sidebar-primary text-sidebar-primary-foreground">
            <img
              src="./icon.png"
              alt=""
              className="size-6 rounded-md object-cover"
              draggable={false}
            />
          </div>
          <span className="truncate font-semibold">MastraWork</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

// 参考 docs/examples/base/sidebar-footer.tsx / sidebar-demo.tsx 的 NavUser
function NavUser() {
  const { t } = useTranslation();
  const { isMobile } = useSidebar();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [transferCenterOpen, setTransferCenterOpen] = React.useState(false);
  const openSettings = (section?: string) => {
    void navigate({
      to: "/settings",
      search: (prev) => ({ ...prev, ...(section ? { section } : {}) }),
    });
  };
  const { mode, setMode, activePresetId, setPreset, presets, isDark } = useTheme();

  if (!user) return null;

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
                  <span>{t("sidebar:theme")}</span>
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
                    <span>{t("sidebar:themeCustomize")}</span>
                  </DropdownMenuItem>
                </DropdownMenuSubContent>
              </DropdownMenuSub>

              {/* 色彩模式子菜单 */}
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <SunMediumIcon className="text-muted-foreground" />
                  <span>{t("sidebar:colorMode")}</span>
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="w-40">
                  <DropdownMenuRadioGroup
                    value={mode}
                    onValueChange={(value) => setMode(value as "light" | "dark" | "system")}
                  >
                    <DropdownMenuRadioItem value="light">
                      <SunMediumIcon className="text-muted-foreground" />
                      {t("sidebar:lightMode")}
                    </DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="dark">
                      <MoonIcon className="text-muted-foreground" />
                      {t("sidebar:darkMode")}
                    </DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="system">
                      <LaptopIcon className="text-muted-foreground" />
                      {t("sidebar:systemMode")}
                    </DropdownMenuRadioItem>
                  </DropdownMenuRadioGroup>
                </DropdownMenuSubContent>
              </DropdownMenuSub>

              <DropdownMenuItem onClick={() => openSettings("providers")}>
                <Settings2Icon />
                {t("sidebar:settings")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setTransferCenterOpen(true)}>
                <ArrowLeftRightIcon />
                {t("sidebar:transferCenter")}
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
      <ThreadTransferInboxDialog
        onOpenChange={setTransferCenterOpen}
        open={transferCenterOpen}
        userId={user.id}
      />
    </SidebarMenu>
  );
}

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const userId = user?.id ?? "anonymous";
  const navigate = useNavigate();
  const location = useLocation();
  const threadsQuery = useThreadsQuery(userId);
  const threads = threadsQuery.data ?? [];
  const threadsLoading = threadsQuery.isPending;
  const createThreadMutation = useCreateThreadMutation(userId);
  const renameThreadMutation = useRenameThreadMutation(userId);
  const activeView = viewFromPath(location.pathname);
  useActiveThreadResolver(threads);
  const { mode, setMode, activePresetId, setPreset, presets, isDark } = useTheme();

  const activeThreadId = useRouterState({
    select: (state) => (state.location.search as { thread?: string }).thread ?? null,
  });

  const createThread = (title?: string) =>
    createThreadMutation.isPending
      ? Promise.resolve(null)
      : createThreadMutation.mutateAsync(title).catch(() => null);
  const renameThread = (threadId: string, title: string) =>
    renameThreadMutation.mutateAsync({ threadId, title }).catch(() => undefined);
  const setActiveView = (view: MainView) => {
    void navigate({
      to: `/${view}`,
      ...(view === "library" ? { search: { thread: activeThreadId ?? undefined } } : {}),
    });
  };
  const openSettings = (section?: string) => {
    void navigate({
      to: "/settings",
      search: (prev) => ({ ...prev, ...(section ? { section } : {}) }),
    });
  };

  const renaming = useWorkbenchStore((state) => state.renamingThread);
  const setRenaming = useWorkbenchStore((state) => state.setRenamingThread);
  const [renameValue, setRenameValue] = React.useState("");
  const setSearchOpen = useWorkbenchStore((state) => state.setThreadSearchOpen);
  const setCommandPaletteOpen = useWorkbenchStore((state) => state.setCommandPaletteOpen);
  const setShortcutsHelpOpen = useWorkbenchStore((state) => state.setShortcutsHelpOpen);
  const isMac = React.useMemo(() => isMacPlatform(), []);
  const [fileManagerThreadId, setFileManagerThreadId] = React.useState<string | null>(null);
  const [showArchived, setShowArchived] = React.useState(false);

  React.useEffect(() => {
    if (renaming) {
      setRenameValue(renaming.title);
    }
  }, [renaming]);

  // metadata 经后端归一化为对象,这里仍用可选链兜底:null 会炸掉整个 UI
  const activeThreads = threads.filter((t) => !t.metadata?.archivedAt);
  const archivedThreads = sortThreads(threads.filter((t) => Boolean(t.metadata?.archivedAt)));
  const activeThreadIsArchived = Boolean(
    activeThreadId &&
      threads.some((thread) => thread.id === activeThreadId && thread.metadata.archivedAt),
  );

  // 若当前 URL 指定的会话本身就是已归档会话，自动切到归档视图以便定位高亮
  React.useEffect(() => {
    if (activeThreadIsArchived) setShowArchived(true);
  }, [activeThreadId, activeThreadIsArchived]);
  const fileManagerThread = fileManagerThreadId
    ? threads.find((thread) => thread.id === fileManagerThreadId)
    : undefined;

  const openFileManager = (threadId: string) => {
    setFileManagerThreadId(threadId);
    setActiveView("chat");
  };

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
      <ContextMenu>
        <ContextMenuTrigger className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <SidebarContent className="h-full">
            {/* 第一组:直接操作与系统核心功能 */}
            <SidebarGroup>
              <SidebarGroupContent>
                <SidebarMenu>
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      tooltip={t("sidebar:newTask")}
                      onClick={() => {
                        setFileManagerThreadId(null);
                        setActiveView("chat");
                        void createThread();
                      }}
                    >
                      <SquarePenIcon />
                      <span>{t("sidebar:newTask")}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      isActive={activeView === "skills"}
                      onClick={() => {
                        setFileManagerThreadId(null);
                        setActiveView("skills");
                      }}
                      tooltip={t("sidebar:skills")}
                    >
                      <SparklesIcon />
                      <span>{t("sidebar:skills")}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      tooltip={t("sidebar:library")}
                      isActive={activeView === "library"}
                      onClick={() => {
                        setFileManagerThreadId(null);
                        setActiveView("library");
                      }}
                    >
                      <LibraryBigIcon />
                      <span>{t("sidebar:library")}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      tooltip={t("sidebar:agents")}
                      isActive={activeView === "agents"}
                      onClick={() => {
                        setFileManagerThreadId(null);
                        setActiveView("agents");
                      }}
                    >
                      <BotIcon />
                      <span>{t("sidebar:agents")}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      tooltip={t("sidebar:schedules")}
                      isActive={activeView === "schedules"}
                      onClick={() => {
                        setFileManagerThreadId(null);
                        setActiveView("schedules");
                      }}
                    >
                      <CalendarClockIcon />
                      <span>{t("sidebar:schedules")}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>

            {/* 第二组:任务列表或当前线程的文件管理 */}
            {fileManagerThread ? (
              <SidebarGroup className="min-h-0 flex-1">
                <SidebarGroupContent className="min-h-0 h-full">
                  <ThreadWorkspaceTree
                    threadId={fileManagerThread.id}
                    onBack={() => setFileManagerThreadId(null)}
                  />
                </SidebarGroupContent>
              </SidebarGroup>
            ) : (
              <SidebarGroup>
                <SidebarGroupLabel className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5 min-w-0 pr-6">
                    <span className="shrink-0">{t("sidebar:taskList")}</span>
                    <button
                      type="button"
                      onClick={() => setShowArchived((prev) => !prev)}
                      className={cn(
                        "flex h-5 items-center gap-1 rounded-md px-1.5 text-[11px] transition-all cursor-pointer select-none",
                        showArchived
                          ? "bg-primary text-primary-foreground font-medium shadow-xs ring-1 ring-primary/30"
                          : "text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground border border-transparent hover:border-border/60",
                      )}
                      title={
                        showArchived ? t("sidebar:returnToActive") : t("sidebar:archivedTitle")
                      }
                    >
                      <ArchiveIcon className="size-3 shrink-0" />
                      <span>{t("sidebar:archived")}</span>
                      {archivedThreads.length > 0 ? (
                        <span
                          className={cn(
                            "rounded px-1 py-0.2 text-[10px] tabular-nums font-semibold leading-none",
                            showArchived
                              ? "bg-primary-foreground/20 text-primary-foreground"
                              : "bg-muted text-muted-foreground",
                          )}
                        >
                          {archivedThreads.length}
                        </span>
                      ) : null}
                    </button>
                  </div>
                  <SidebarGroupAction
                    title={t("sidebar:searchPlaceholder")}
                    onClick={() => setSearchOpen(true)}
                    aria-label={t("sidebar:searchMessages")}
                  >
                    <SearchIcon />
                    <span className="sr-only">{t("sidebar:searchMessages")}</span>
                  </SidebarGroupAction>
                </SidebarGroupLabel>
                <SidebarGroupContent>
                  {threadsLoading ? (
                    <ThreadListSkeleton />
                  ) : showArchived ? (
                    <SidebarMenu>
                      <div className="flex items-center justify-between px-2 py-1 text-xs text-muted-foreground">
                        <span className="flex items-center gap-1.5 font-medium text-foreground">
                          <ArchiveIcon className="size-3.5 text-primary" />
                          <span>{t("sidebar:archivedTitle")}</span>
                          <span className="text-xs text-muted-foreground tabular-nums">
                            ({archivedThreads.length})
                          </span>
                        </span>
                        <Button type="button" onClick={() => setShowArchived(false)} size="sm">
                          <ArrowLeftIcon data-icon="inline-start" />
                          {t("sidebar:returnToActive")}
                        </Button>
                      </div>
                      {archivedThreads.length === 0 ? (
                        <div className="flex flex-col items-center justify-center py-8 text-center text-xs text-muted-foreground">
                          <ArchiveIcon className="mb-2 size-7 opacity-30" />
                          <span>{t("sidebar:noArchived")}</span>
                        </div>
                      ) : (
                        archivedThreads.map((thread) => (
                          <DirectThreadItem
                            key={thread.id}
                            thread={thread}
                            onOpenFileManager={openFileManager}
                            onRename={openRename}
                          />
                        ))
                      )}
                    </SidebarMenu>
                  ) : (
                    <SidebarMenu>
                      {/* 直接线程(未显式绑定目录) */}
                      {sortThreads(directThreads).map((thread) => (
                        <DirectThreadItem
                          key={thread.id}
                          thread={thread}
                          onOpenFileManager={openFileManager}
                          onRename={openRename}
                        />
                      ))}
                      {/* 显式绑定目录 = 可折叠文件夹(会话 + 文件树) */}
                      {workspaceGroups.map((group) => (
                        <WorkspaceGroup
                          key={group.path}
                          path={group.path}
                          threads={group.threads}
                          onOpenFileManager={openFileManager}
                          onRename={openRename}
                        />
                      ))}
                    </SidebarMenu>
                  )}
                </SidebarGroupContent>
              </SidebarGroup>
            )}
          </SidebarContent>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-56">
          <ContextMenuGroup>
            <ContextMenuLabel>{t("sidebar:quickActions")}</ContextMenuLabel>
            <ContextMenuItem onClick={() => setCommandPaletteOpen(true)}>
              <SearchIcon className="text-muted-foreground" />
              <span>{t("commandPalette:actionCommandPalette")}</span>
              <ContextMenuShortcut>
                {formatShortcutDisplay(["Mod", "K"], isMac)}
              </ContextMenuShortcut>
            </ContextMenuItem>
            <ContextMenuItem
              onClick={() => {
                setFileManagerThreadId(null);
                setActiveView("chat");
                void createThread();
              }}
            >
              <SquarePenIcon className="text-muted-foreground" />
              <span>{t("sidebar:newTask")}</span>
              <ContextMenuShortcut>
                {formatShortcutDisplay(["Mod", "N"], isMac)}
              </ContextMenuShortcut>
            </ContextMenuItem>
            <ContextMenuItem onClick={() => setSearchOpen(true)}>
              <SearchIcon className="text-muted-foreground" />
              <span>{t("sidebar:searchMessages")}</span>
              <ContextMenuShortcut>
                {formatShortcutDisplay(["Mod", "F"], isMac)}
              </ContextMenuShortcut>
            </ContextMenuItem>
            <ContextMenuItem onClick={() => setShortcutsHelpOpen(true)}>
              <KeyboardIcon className="text-muted-foreground" />
              <span>{t("commandPalette:shortcutsGuide")}</span>
              <ContextMenuShortcut>
                {formatShortcutDisplay(["Mod", "/"], isMac)}
              </ContextMenuShortcut>
            </ContextMenuItem>
          </ContextMenuGroup>
          <ContextMenuSeparator />
          <ContextMenuGroup>
            <ContextMenuLabel>{t("sidebar:navigation")}</ContextMenuLabel>
            <ContextMenuItem
              onClick={() => {
                setFileManagerThreadId(null);
                setActiveView("chat");
              }}
            >
              <WaypointsIcon className="text-muted-foreground" />
              <span>{t("sidebar:newChat")}</span>
              <ContextMenuShortcut>
                {formatShortcutDisplay(["Mod", "1"], isMac)}
              </ContextMenuShortcut>
            </ContextMenuItem>
            <ContextMenuItem
              onClick={() => {
                setFileManagerThreadId(null);
                setActiveView("skills");
              }}
            >
              <SparklesIcon className="text-muted-foreground" />
              <span>{t("sidebar:skills")}</span>
              <ContextMenuShortcut>
                {formatShortcutDisplay(["Mod", "2"], isMac)}
              </ContextMenuShortcut>
            </ContextMenuItem>
            <ContextMenuItem
              onClick={() => {
                setFileManagerThreadId(null);
                setActiveView("library");
              }}
            >
              <LibraryBigIcon className="text-muted-foreground" />
              <span>{t("sidebar:library")}</span>
              <ContextMenuShortcut>
                {formatShortcutDisplay(["Mod", "3"], isMac)}
              </ContextMenuShortcut>
            </ContextMenuItem>
            <ContextMenuItem
              onClick={() => {
                setFileManagerThreadId(null);
                setActiveView("agents");
              }}
            >
              <BotIcon className="text-muted-foreground" />
              <span>{t("sidebar:agents")}</span>
              <ContextMenuShortcut>
                {formatShortcutDisplay(["Mod", "4"], isMac)}
              </ContextMenuShortcut>
            </ContextMenuItem>
            <ContextMenuItem
              onClick={() => {
                setFileManagerThreadId(null);
                setActiveView("schedules");
              }}
            >
              <CalendarClockIcon className="text-muted-foreground" />
              <span>{t("sidebar:schedules")}</span>
              <ContextMenuShortcut>
                {formatShortcutDisplay(["Mod", "5"], isMac)}
              </ContextMenuShortcut>
            </ContextMenuItem>
          </ContextMenuGroup>
          <ContextMenuSeparator />
          <ContextMenuGroup>
            <ContextMenuSub>
              <ContextMenuSubTrigger>
                <PaletteIcon className="text-muted-foreground" />
                <span>{t("sidebar:theme")}</span>
              </ContextMenuSubTrigger>
              <ContextMenuSubContent className="w-48">
                <ContextMenuRadioGroup
                  value={activePresetId}
                  onValueChange={(val) => setPreset(val)}
                >
                  {presets.map((p) => {
                    const colors = isDark ? p.dark : p.light;
                    return (
                      <ContextMenuRadioItem key={p.id} value={p.id} className="gap-2">
                        <span
                          className="size-2.5 rounded-full border shrink-0"
                          style={{
                            backgroundColor: colors.primary,
                            borderColor: colors.border,
                          }}
                        />
                        <span className="truncate">{p.name}</span>
                      </ContextMenuRadioItem>
                    );
                  })}
                </ContextMenuRadioGroup>
                <ContextMenuSeparator />
                <ContextMenuItem onClick={() => openSettings("themes")}>
                  <SlidersHorizontalIcon className="size-3.5 text-muted-foreground" />
                  <span>{t("sidebar:themeCustomize")}</span>
                </ContextMenuItem>
              </ContextMenuSubContent>
            </ContextMenuSub>
            <ContextMenuSub>
              <ContextMenuSubTrigger>
                <SunMediumIcon className="text-muted-foreground" />
                <span>{t("sidebar:colorMode")}</span>
              </ContextMenuSubTrigger>
              <ContextMenuSubContent className="w-40">
                <ContextMenuRadioGroup
                  value={mode}
                  onValueChange={(val) => setMode(val as "light" | "dark" | "system")}
                >
                  <ContextMenuRadioItem value="light">
                    <SunMediumIcon className="text-muted-foreground" />
                    {t("sidebar:lightMode")}
                  </ContextMenuRadioItem>
                  <ContextMenuRadioItem value="dark">
                    <MoonIcon className="text-muted-foreground" />
                    {t("sidebar:darkMode")}
                  </ContextMenuRadioItem>
                  <ContextMenuRadioItem value="system">
                    <LaptopIcon className="text-muted-foreground" />
                    {t("sidebar:systemMode")}
                  </ContextMenuRadioItem>
                </ContextMenuRadioGroup>
              </ContextMenuSubContent>
            </ContextMenuSub>
            <ContextMenuItem onClick={() => openSettings("providers")}>
              <Settings2Icon className="text-muted-foreground" />
              <span>{t("sidebar:settings")}</span>
              <ContextMenuShortcut>
                {formatShortcutDisplay(["Mod", ","], isMac)}
              </ContextMenuShortcut>
            </ContextMenuItem>
          </ContextMenuGroup>
        </ContextMenuContent>
      </ContextMenu>
      <SidebarFooter>
        <NavUser />
      </SidebarFooter>
      <SidebarRail />

      {/* 重命名线程弹窗 */}
      <Dialog open={renaming !== null} onOpenChange={(open) => !open && setRenaming(null)}>
        <DialogContent>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleRenameSubmit();
            }}
          >
            <DialogHeader>
              <DialogTitle>{t("sidebar:renameDialogTitle")}</DialogTitle>
              <DialogDescription>{t("sidebar:renameDialogDesc")}</DialogDescription>
            </DialogHeader>
            <Field className="py-4">
              <FieldLabel htmlFor="rename-thread-input" className="sr-only">
                {t("sidebar:threadName")}
              </FieldLabel>
              <Input
                id="rename-thread-input"
                autoFocus
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
              />
            </Field>
            <DialogFooter>
              <DialogClose render={<Button variant="outline">{t("common:cancel")}</Button>} />
              <Button type="submit">{t("common:save")}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </Sidebar>
  );
}
