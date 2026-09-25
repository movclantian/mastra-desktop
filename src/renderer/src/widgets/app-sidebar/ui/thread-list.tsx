import { useRouterState } from "@tanstack/react-router";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  ArrowLeftIcon,
  ArrowLeftRightIcon,
  ChevronRightIcon,
  CopyIcon,
  ExternalLinkIcon,
  FilePlus2Icon,
  FolderOpenIcon,
  FolderPlusIcon,
  FolderTreeIcon,
  GitForkIcon,
  MessageCircleIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PinIcon,
  PinOffIcon,
  PlusIcon,
  RefreshCwIcon,
  SparklesIcon,
  TerminalIcon,
  Trash2Icon,
} from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import type { TreeEntry } from "@/entities/workbench";
import {
  dirName,
  fetchTree,
  fetchWorkUsers,
  openPathInApp,
  type WorkThread,
  type WorkUserOption,
} from "@/entities/workbench";
import {
  useArchiveThreadMutation,
  useCloneThreadMutation,
  useCreateThreadMutation,
  useDeleteThreadMutation,
  useGenerateThreadTitleMutation,
  useIsThreadBusy,
  usePinThreadMutation,
  useSelectThread,
  useTransferThreadMutation,
} from "@/entities/workbench/model/queries/threads";
import { useWorkbenchStore } from "@/entities/workbench/model/workbench-store";
import { useAuth } from "@/features/auth";
import { formatShortcutDisplay, isMacPlatform } from "@/features/command-palette";
import { apiFetch, MASTRA_SERVER_URL } from "@/shared/api";
import { useTranslation } from "@/shared/i18n";
import { cn } from "@/shared/lib";
import { FileTree, FileTreeFile, FileTreeFolder } from "@/shared/ui/ai-elements/file-tree";
import { FileTypeIcon, FolderTypeIcon } from "@/shared/ui/ai-elements/file-type-icon";
import { BlurFade } from "@/shared/ui/blur-fade";
import { Button } from "@/shared/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/shared/ui/collapsible";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
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
import { Dotm3x3_6 } from "@/shared/ui/dotm-3x3-6";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";
import { ScrollArea } from "@/shared/ui/scroll-area";
import { ShineBorder } from "@/shared/ui/shine-border";
import {
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  useSidebar,
} from "@/shared/ui/sidebar";

// 侧栏「任务列表」分组:直接线程平铺 + 显式绑定目录作为可折叠文件夹。
// 支持左键操作菜单与全局自定义右键上下文菜单。

export function sortThreads(threads: WorkThread[]): WorkThread[] {
  return [...threads].sort((a, b) => {
    const pinned = Number(Boolean(b.metadata.pinned)) - Number(Boolean(a.metadata.pinned));
    if (pinned !== 0) return pinned;
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });
}

/**
 * 会话所有权迁移对话框(官方 memory.updateThreadResourceId 的产品落点):
 * 选择目标账户后把线程及全部消息平滑转移过去。挂载在列表项层级而不是菜单内 ——
 * 菜单关闭即卸载,放在里面对话框会跟着消失。
 */
function TransferThreadDialog({
  thread,
  open,
  onOpenChange,
}: {
  thread: WorkThread;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const transferThreadMutation = useTransferThreadMutation(user?.id ?? "anonymous");
  const transferThread = (threadId: string, targetResourceId: string) =>
    transferThreadMutation.mutateAsync({ threadId, targetResourceId });
  const userId = user?.id ?? "anonymous";
  const [candidates, setCandidates] = React.useState<WorkUserOption[] | null>(null);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [transferring, setTransferring] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    setCandidates(null);
    setSelectedId(null);
    let disposed = false;
    void fetchWorkUsers()
      .then((users) => {
        if (!disposed) setCandidates(users.filter((candidate) => candidate.id !== userId));
      })
      .catch(() => {
        if (!disposed) setCandidates([]);
      });
    return () => {
      disposed = true;
    };
  }, [open, userId]);

  const handleTransfer = async () => {
    if (!selectedId || transferring) return;
    setTransferring(true);
    try {
      await transferThread(thread.id, selectedId);
      toast.success(t("sidebar:transferRequestSent"));
      onOpenChange(false);
    } catch {
      toast.error(t("sidebar:transferError"));
    } finally {
      setTransferring(false);
    }
  };

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("sidebar:transferOwnership")}</DialogTitle>
          <DialogDescription>
            {t("sidebar:transferDesc", { title: thread.title })}
          </DialogDescription>
        </DialogHeader>
        <ScrollArea className="max-h-64">
          <div className="flex flex-col gap-1 pr-2">
            {candidates === null ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                {t("sidebar:loadingAccounts")}
              </p>
            ) : candidates.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                {t("sidebar:noOtherAccounts")}
              </p>
            ) : (
              candidates.map((candidate) => (
                <button
                  aria-pressed={selectedId === candidate.id}
                  className="flex min-w-0 items-center gap-3 rounded-lg border border-transparent px-3 py-2 text-left transition-colors hover:bg-accent aria-pressed:border-primary/40 aria-pressed:bg-accent"
                  key={candidate.id}
                  onClick={() => setSelectedId(candidate.id)}
                  type="button"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{candidate.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {candidate.email}
                    </span>
                  </span>
                </button>
              ))
            )}
          </div>
        </ScrollArea>
        <DialogFooter>
          <DialogClose render={<Button variant="outline">{t("common:cancel")}</Button>} />
          <Button disabled={!selectedId || transferring} onClick={() => void handleTransfer()}>
            {transferring ? t("sidebar:transferring") : t("sidebar:transfer")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ThreadContextMenuItems({
  thread,
  onRename,
  onOpenFileManager,
  onTransfer,
}: {
  thread: WorkThread;
  onRename: (thread: WorkThread) => void;
  onOpenFileManager: (threadId: string) => void;
  onTransfer: () => void;
}) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const userId = user?.id ?? "anonymous";
  const activeThreadId = useRouterState({
    select: (state) => (state.location.search as { thread?: string }).thread ?? null,
  });
  const setTerminalPanelOpen = useWorkbenchStore((state) => state.setTerminalPanelOpen);
  const selectThread = useSelectThread();
  const pinThreadMutation = usePinThreadMutation(userId);
  const archiveThreadMutation = useArchiveThreadMutation(userId);
  const deleteThreadMutation = useDeleteThreadMutation(userId);
  const generateTitleMutation = useGenerateThreadTitleMutation(userId);
  const cloneThreadMutation = useCloneThreadMutation(userId);

  const pinThread = (threadId: string, pinned: boolean) =>
    pinThreadMutation.mutateAsync({ threadId, pinned }).catch(() => undefined);
  const archiveThread = (threadId: string, archived: boolean) =>
    archiveThreadMutation.mutateAsync({ threadId, archived }).catch(() => undefined);
  const deleteThread = (threadId: string) =>
    deleteThreadMutation.mutateAsync(threadId).catch(() => undefined);
  const setActiveThreadId = (id: string | null) => selectThread(id);

  const [generating, setGenerating] = React.useState(false);
  const [cloning, setCloning] = React.useState(false);
  const workspacePath = thread.metadata.workspacePath;

  const handleGenerateTitle = async () => {
    setGenerating(true);
    try {
      const newTitle = await generateTitleMutation.mutateAsync(thread.id).catch(() => null);
      if (newTitle) {
        toast.success(t("sidebar:generatedTitle", { title: newTitle }));
      } else {
        toast.error(t("sidebar:failedToGenerateTitle"));
      }
    } finally {
      setGenerating(false);
    }
  };

  // 克隆(官方 copyThread):成功后由 mutation 切换到新分支
  const handleClone = async () => {
    if (cloning) return;
    setCloning(true);
    try {
      const clone = await cloneThreadMutation
        .mutateAsync({ threadId: thread.id })
        .catch(() => null);
      if (clone) toast.success(t("sidebar:branchCreated", { title: clone.title }));
      else toast.error(t("sidebar:cloneFailed"));
    } finally {
      setCloning(false);
    }
  };

  const handleCopy = (text: string, label: string) => {
    void navigator.clipboard.writeText(text);
    toast.success(t("sidebar:copiedItem", { label }));
  };

  const isMac = React.useMemo(() => isMacPlatform(), []);

  return (
    <>
      <ContextMenuGroup>
        <ContextMenuLabel className="truncate max-w-48">{thread.title}</ContextMenuLabel>
        <ContextMenuItem onClick={() => void pinThread(thread.id, !thread.metadata.pinned)}>
          {thread.metadata.pinned ? (
            <PinOffIcon className="text-muted-foreground" />
          ) : (
            <PinIcon className="text-muted-foreground" />
          )}
          <span>{thread.metadata.pinned ? t("sidebar:unpin") : t("sidebar:pinned")}</span>
          <ContextMenuShortcut>
            {formatShortcutDisplay(
              thread.metadata.pinned ? ["Mod", "Shift", "P"] : ["Mod", "P"],
              isMac,
            )}
          </ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem onClick={() => onRename(thread)}>
          <PencilIcon className="text-muted-foreground" />
          <span>{t("common:rename")}</span>
          <ContextMenuShortcut>F2</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem disabled={generating} onClick={() => void handleGenerateTitle()}>
          <SparklesIcon className="text-muted-foreground" />
          <span>{generating ? t("sidebar:generatingTitle") : t("sidebar:aiTitle")}</span>
        </ContextMenuItem>
        <ContextMenuItem disabled={cloning} onClick={() => void handleClone()}>
          <GitForkIcon className="text-muted-foreground" />
          <span>{cloning ? t("sidebar:cloning") : t("sidebar:cloneThread")}</span>
        </ContextMenuItem>
      </ContextMenuGroup>

      <ContextMenuSeparator />

      <ContextMenuGroup>
        <ContextMenuLabel>{t("sidebar:workspaceActions")}</ContextMenuLabel>
        <ContextMenuItem
          disabled={!workspacePath}
          onClick={() => {
            if (workspacePath)
              void openPathInApp("explorer", workspacePath, t("sidebar:fileExplorer"));
          }}
        >
          <FolderOpenIcon className="text-muted-foreground" />
          <span>{t("sidebar:openInExplorer")}</span>
        </ContextMenuItem>
        <ContextMenuItem
          disabled={!workspacePath}
          onClick={() => {
            onOpenFileManager(thread.id);
          }}
        >
          <FolderTreeIcon className="text-muted-foreground" />
          <span>{t("sidebar:browseFiles")}</span>
        </ContextMenuItem>
        <ContextMenuItem
          disabled={!workspacePath}
          onClick={() => {
            if (activeThreadId !== thread.id) setActiveThreadId(thread.id);
            setTerminalPanelOpen(true);
          }}
        >
          <TerminalIcon className="text-muted-foreground" />
          <span>{t("sidebar:openInTerminal")}</span>
        </ContextMenuItem>
      </ContextMenuGroup>

      <ContextMenuSeparator />

      <ContextMenuGroup>
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <CopyIcon className="text-muted-foreground" />
            <span>{t("sidebar:copyInfo")}</span>
          </ContextMenuSubTrigger>
          <ContextMenuSubContent className="w-48">
            <ContextMenuGroup>
              <ContextMenuItem onClick={() => handleCopy(thread.title, t("sidebar:copyTitle"))}>
                {t("sidebar:copyTitle")}
              </ContextMenuItem>
              <ContextMenuItem onClick={() => handleCopy(thread.id, t("sidebar:copyThreadId"))}>
                {t("sidebar:copyThreadId")}
              </ContextMenuItem>
              {workspacePath ? (
                <ContextMenuItem
                  onClick={() => handleCopy(workspacePath, t("sidebar:copyWorkspacePath"))}
                >
                  {t("sidebar:copyWorkspacePath")}
                </ContextMenuItem>
              ) : null}
            </ContextMenuGroup>
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuItem onClick={() => void archiveThread(thread.id, !thread.metadata.archivedAt)}>
          {thread.metadata.archivedAt ? (
            <ArchiveRestoreIcon className="text-muted-foreground" />
          ) : (
            <ArchiveIcon className="text-muted-foreground" />
          )}
          <span>
            {thread.metadata.archivedAt ? t("sidebar:unarchiveThread") : t("sidebar:archiveThread")}
          </span>
        </ContextMenuItem>
        {user?.role === "admin" ? (
          <ContextMenuItem onClick={onTransfer}>
            <ArrowLeftRightIcon className="text-muted-foreground" />
            <span>{t("sidebar:transferThread")}</span>
          </ContextMenuItem>
        ) : null}
      </ContextMenuGroup>

      <ContextMenuSeparator />

      <ContextMenuGroup>
        <ContextMenuItem variant="destructive" onClick={() => void deleteThread(thread.id)}>
          <Trash2Icon className="text-muted-foreground" />
          <span>{t("sidebar:deleteThread")}</span>
          <ContextMenuShortcut>{isMac ? "⌫" : "Del"}</ContextMenuShortcut>
        </ContextMenuItem>
      </ContextMenuGroup>
    </>
  );
}

function ThreadActionMenu({
  thread,
  onRename,
  onOpenFileManager,
  onTransfer,
  sub = false,
}: {
  thread: WorkThread;
  onRename: (thread: WorkThread) => void;
  onOpenFileManager: (threadId: string) => void;
  onTransfer: () => void;
  sub?: boolean;
}) {
  const { t } = useTranslation();
  const { isMobile } = useSidebar();
  const { user } = useAuth();
  const userId = user?.id ?? "anonymous";
  const pinThreadMutation = usePinThreadMutation(userId);
  const archiveThreadMutation = useArchiveThreadMutation(userId);
  const deleteThreadMutation = useDeleteThreadMutation(userId);
  const generateTitleMutation = useGenerateThreadTitleMutation(userId);
  const cloneThreadMutation = useCloneThreadMutation(userId);

  const pinThread = (threadId: string, pinned: boolean) =>
    pinThreadMutation.mutateAsync({ threadId, pinned }).catch(() => undefined);
  const archiveThread = (threadId: string, archived: boolean) =>
    archiveThreadMutation.mutateAsync({ threadId, archived }).catch(() => undefined);
  const deleteThread = (threadId: string) =>
    deleteThreadMutation.mutateAsync(threadId).catch(() => undefined);

  const [generating, setGenerating] = React.useState(false);
  const [cloning, setCloning] = React.useState(false);
  const workspacePath = thread.metadata.workspacePath;

  const handleGenerateTitle = async () => {
    setGenerating(true);
    try {
      const newTitle = await generateTitleMutation.mutateAsync(thread.id).catch(() => null);
      if (newTitle) {
        toast.success(t("sidebar:generatedTitle", { title: newTitle }));
      } else {
        toast.error(t("sidebar:failedToGenerateTitle"));
      }
    } finally {
      setGenerating(false);
    }
  };

  const handleClone = async () => {
    if (cloning) return;
    setCloning(true);
    try {
      const clone = await cloneThreadMutation
        .mutateAsync({ threadId: thread.id })
        .catch(() => null);
      if (clone) toast.success(t("sidebar:branchCreated", { title: clone.title }));
      else toast.error(t("sidebar:cloneFailed"));
    } finally {
      setCloning(false);
    }
  };

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
          <span>{thread.metadata.pinned ? t("sidebar:unpin") : t("sidebar:pin")}</span>
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!workspacePath}
          onClick={() => {
            if (workspacePath)
              void openPathInApp("explorer", workspacePath, t("sidebar:fileExplorer"));
          }}
        >
          <FolderOpenIcon className="text-muted-foreground" />
          <span>{t("sidebar:openInExplorer")}</span>
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!workspacePath}
          onClick={() => {
            onOpenFileManager(thread.id);
          }}
        >
          <FolderTreeIcon className="text-muted-foreground" />
          <span>{t("sidebar:fileManager")}</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={generating} onClick={() => void handleGenerateTitle()}>
          <SparklesIcon className="text-muted-foreground" />
          <span>{generating ? t("sidebar:generatingTitle") : t("sidebar:aiTitle")}</span>
        </DropdownMenuItem>
        <DropdownMenuItem disabled={cloning} onClick={() => void handleClone()}>
          <GitForkIcon className="text-muted-foreground" />
          <span>{cloning ? t("sidebar:cloning") : t("sidebar:cloneThread")}</span>
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => onRename(thread)}>
          <PencilIcon className="text-muted-foreground" />
          <span>{t("common:rename")}</span>
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => void archiveThread(thread.id, !thread.metadata.archivedAt)}
        >
          {thread.metadata.archivedAt ? (
            <ArchiveRestoreIcon className="text-muted-foreground" />
          ) : (
            <ArchiveIcon className="text-muted-foreground" />
          )}
          <span>{thread.metadata.archivedAt ? t("sidebar:unarchive") : t("sidebar:archive")}</span>
        </DropdownMenuItem>
        {user?.role === "admin" ? (
          <DropdownMenuItem onClick={onTransfer}>
            <ArrowLeftRightIcon className="text-muted-foreground" />
            <span>{t("sidebar:transferThread")}</span>
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onClick={() => void deleteThread(thread.id)}>
          <Trash2Icon className="text-muted-foreground" />
          <span>{t("common:delete")}</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** 直接线程:未显式绑定目录(隐式/草稿)的平铺菜单项,支持右键上下文菜单 */
export function DirectThreadItem({
  thread,
  onRename,
  onOpenFileManager,
}: {
  thread: WorkThread;
  onRename: (thread: WorkThread) => void;
  onOpenFileManager: (threadId: string) => void;
}) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const activeThreadId = useRouterState({
    select: (state) => (state.location.search as { thread?: string }).thread ?? null,
  });
  const selectThread = useSelectThread();
  const setActiveThreadId = (id: string | null) => selectThread(id);
  const isThreadBusy = useIsThreadBusy(user?.id ?? "anonymous");
  const isWorking = isThreadBusy(thread.id);
  const [transferOpen, setTransferOpen] = React.useState(false);

  return (
    <BlurFade duration={0.2} blur="3px">
      <SidebarMenuItem>
        <ContextMenu>
          <ContextMenuTrigger className="w-full">
            <SidebarMenuButton
              className="relative"
              isActive={thread.id === activeThreadId}
              onClick={() => setActiveThreadId(thread.id)}
              tooltip={thread.title}
            >
              {/* 当前会话的流动描边:长列表里快速定位"我在哪" */}
              {thread.id === activeThreadId ? (
                <ShineBorder
                  borderWidth={1}
                  duration={9}
                  shineColor={["var(--primary)", "var(--accent)"]}
                />
              ) : null}
              <MessageCircleIcon />
              <span className="min-w-0 flex-1 truncate" title={thread.title}>
                {thread.title}
              </span>
              {isWorking ? (
                <span
                  className="ml-auto flex items-center pr-1 text-primary"
                  title={t("sidebar:agentWorking")}
                >
                  <Dotm3x3_6 size={12} dotSize={2} colorPreset="solid-theme" />
                </span>
              ) : null}
              {thread.metadata.pinned ? (
                <PinIcon
                  className={cn(
                    "size-3 shrink-0 text-muted-foreground/80 group-data-[collapsible=icon]:hidden",
                    !isWorking && "ml-auto",
                  )}
                />
              ) : null}
            </SidebarMenuButton>
          </ContextMenuTrigger>
          <ContextMenuContent className="w-52">
            <ThreadContextMenuItems
              onOpenFileManager={onOpenFileManager}
              onRename={onRename}
              onTransfer={() => setTransferOpen(true)}
              thread={thread}
            />
          </ContextMenuContent>
        </ContextMenu>
        <ThreadActionMenu
          onOpenFileManager={onOpenFileManager}
          onRename={onRename}
          onTransfer={() => setTransferOpen(true)}
          thread={thread}
        />
        <TransferThreadDialog onOpenChange={setTransferOpen} open={transferOpen} thread={thread} />
      </SidebarMenuItem>
    </BlurFade>
  );
}

/** 工作区内线程:SidebarMenuSub 子项,支持右键上下文菜单 */
function WorkspaceThreadItem({
  thread,
  onRename,
  onOpenFileManager,
}: {
  thread: WorkThread;
  onRename: (thread: WorkThread) => void;
  onOpenFileManager: (threadId: string) => void;
}) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const activeThreadId = useRouterState({
    select: (state) => (state.location.search as { thread?: string }).thread ?? null,
  });
  const selectThread = useSelectThread();
  const setActiveThreadId = (id: string | null) => selectThread(id);
  const isThreadBusy = useIsThreadBusy(user?.id ?? "anonymous");
  const isWorking = isThreadBusy(thread.id);
  const isActive = thread.id === activeThreadId;
  const [transferOpen, setTransferOpen] = React.useState(false);

  return (
    <SidebarMenuSubItem>
      <ContextMenu>
        <ContextMenuTrigger className="w-full">
          <SidebarMenuSubButton
            className="relative"
            isActive={isActive}
            onClick={() => setActiveThreadId(thread.id)}
          >
            {/* 当前会话的流动描边:比单纯的背景高亮更容易在长列表里定位到"我在哪" */}
            {isActive ? (
              <ShineBorder
                borderWidth={1}
                duration={9}
                shineColor={["var(--primary)", "var(--accent)"]}
              />
            ) : null}
            <MessageCircleIcon />
            <span className="min-w-0 flex-1 truncate" title={thread.title}>
              {thread.title}
            </span>
            {isWorking ? (
              <span
                className="ml-auto flex items-center pr-1 text-primary"
                title={t("sidebar:agentWorking")}
              >
                <Dotm3x3_6 size={12} dotSize={2} colorPreset="solid-theme" />
              </span>
            ) : null}
            {thread.metadata.pinned ? (
              <PinIcon
                className={cn(
                  "size-3 shrink-0 text-muted-foreground/80 group-data-[collapsible=icon]:hidden",
                  !isWorking && "ml-auto",
                )}
              />
            ) : null}
          </SidebarMenuSubButton>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-52">
          <ThreadContextMenuItems
            onOpenFileManager={onOpenFileManager}
            onRename={onRename}
            onTransfer={() => setTransferOpen(true)}
            thread={thread}
          />
        </ContextMenuContent>
      </ContextMenu>
      <ThreadActionMenu
        onOpenFileManager={onOpenFileManager}
        onRename={onRename}
        onTransfer={() => setTransferOpen(true)}
        sub
        thread={thread}
      />
      <TransferThreadDialog onOpenChange={setTransferOpen} open={transferOpen} thread={thread} />
    </SidebarMenuSubItem>
  );
}

/** 显式绑定目录 = 任务列表内的可折叠文件夹:同目录会话 + 工作区文件树,支持右键菜单 */
export function WorkspaceGroup({
  path,
  threads,
  onRename,
  onOpenFileManager,
}: {
  path: string;
  threads: WorkThread[];
  onRename: (thread: WorkThread) => void;
  onOpenFileManager: (threadId: string) => void;
}) {
  const { t } = useTranslation();
  const isMac = React.useMemo(() => isMacPlatform(), []);
  const { user } = useAuth();
  const userId = user?.id ?? "anonymous";
  const createThreadMutation = useCreateThreadMutation(userId);
  const selectThread = useSelectThread();
  const setActiveThreadId = (id: string | null) => selectThread(id);
  const setTerminalPanelOpen = useWorkbenchStore((state) => state.setTerminalPanelOpen);
  const isThreadBusy = useIsThreadBusy(userId);
  const sorted = sortThreads(threads);
  const [open, setOpen] = React.useState(false);
  const hasWorkingThread = sorted.some((t) => isThreadBusy(t.id));

  const handleCopyPath = () => {
    void navigator.clipboard.writeText(path);
    toast.success(t("sidebar:copiedWorkspacePath"));
  };

  const handleCreateThreadInWorkspace = async () => {
    const newThread = await createThreadMutation.mutateAsync(undefined).catch(() => null);
    if (newThread) {
      setActiveThreadId(newThread.id);
      toast.success(t("sidebar:createdWorkspaceThread"));
    }
  };

  return (
    <Collapsible className="group/collapsible" onOpenChange={setOpen} open={open}>
      <SidebarMenuItem>
        <ContextMenu>
          <ContextMenuTrigger className="w-full">
            <CollapsibleTrigger render={<SidebarMenuButton tooltip={path} className="!pr-2" />}>
              <FolderTypeIcon name={dirName(path)} open={open} />
              <span className="truncate">{dirName(path)}</span>
              {sorted.length > 0 ? (
                <span className="ml-1 text-xs text-muted-foreground tabular-nums">
                  {sorted.length}
                </span>
              ) : null}
              {!open && hasWorkingThread ? (
                <span
                  className="ml-auto mr-1 flex items-center text-primary"
                  title={t("sidebar:workspaceRunning")}
                >
                  <Dotm3x3_6 size={11} dotSize={1.8} colorPreset="solid-theme" />
                </span>
              ) : null}
              <ChevronRightIcon
                className={cn(
                  open || !hasWorkingThread ? "ml-auto" : "",
                  "size-4 shrink-0 text-muted-foreground transition-transform duration-200",
                  open && "rotate-90 text-foreground",
                )}
              />
            </CollapsibleTrigger>
          </ContextMenuTrigger>
          <ContextMenuContent className="w-52">
            <ContextMenuGroup>
              <ContextMenuLabel className="truncate max-w-48">{dirName(path)}</ContextMenuLabel>
              <ContextMenuItem onClick={() => void handleCreateThreadInWorkspace()}>
                <PlusIcon className="text-muted-foreground" />
                <span>{t("sidebar:newThreadInWorkspace")}</span>
                <ContextMenuShortcut>
                  {formatShortcutDisplay(["Mod", "N"], isMac)}
                </ContextMenuShortcut>
              </ContextMenuItem>
            </ContextMenuGroup>
            <ContextMenuSeparator />
            <ContextMenuGroup>
              <ContextMenuItem
                onClick={() => void openPathInApp("explorer", path, t("sidebar:fileExplorer"))}
              >
                <FolderOpenIcon className="text-muted-foreground" />
                <span>{t("sidebar:openInExplorer")}</span>
              </ContextMenuItem>
              <ContextMenuItem
                onClick={() => {
                  if (threads[0]) onOpenFileManager(threads[0].id);
                }}
              >
                <FolderTreeIcon className="text-muted-foreground" />
                <span>{t("sidebar:browseFileManager")}</span>
              </ContextMenuItem>
              <ContextMenuItem
                onClick={() => {
                  if (threads[0]) setActiveThreadId(threads[0].id);
                  setTerminalPanelOpen(true);
                }}
              >
                <TerminalIcon className="text-muted-foreground" />
                <span>{t("sidebar:openInTerminal")}</span>
              </ContextMenuItem>
              <ContextMenuItem onClick={() => void openPathInApp("vscode", path, "VS Code")}>
                <ExternalLinkIcon className="text-muted-foreground" />
                <span>{t("sidebar:openInVsCode")}</span>
              </ContextMenuItem>
            </ContextMenuGroup>
            <ContextMenuSeparator />
            <ContextMenuGroup>
              <ContextMenuItem onClick={handleCopyPath}>
                <CopyIcon className="text-muted-foreground" />
                <span>{t("sidebar:copyDirPath")}</span>
              </ContextMenuItem>
            </ContextMenuGroup>
          </ContextMenuContent>
        </ContextMenu>
        <CollapsibleContent>
          <SidebarMenuSub>
            {sorted.map((thread) => (
              <WorkspaceThreadItem
                key={thread.id}
                thread={thread}
                onOpenFileManager={onOpenFileManager}
                onRename={onRename}
              />
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
  onOpenFileManager,
}: {
  name: string;
  icon: React.ComponentType<{ className?: string }>;
  threads: WorkThread[];
  defaultOpen?: boolean;
  onRename: (thread: WorkThread) => void;
  onOpenFileManager: (threadId: string) => void;
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
        <CollapsibleTrigger render={<SidebarMenuButton className="!pr-2" />}>
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
              <WorkspaceThreadItem
                key={thread.id}
                thread={thread}
                onOpenFileManager={onOpenFileManager}
                onRename={onRename}
              />
            ))}
          </SidebarMenuSub>
        </CollapsibleContent>
      </SidebarMenuItem>
    </Collapsible>
  );
}

function InlineCreateRow({
  kind,
  value,
  onChange,
  onSubmit,
  onCancel,
}: {
  kind: "file" | "dir";
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const inputRef = React.useRef<HTMLInputElement>(null);

  React.useLayoutEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <div className="flex min-w-0 items-center gap-1 rounded-md px-2 py-1 text-xs">
      <span className="size-4 shrink-0" />
      {kind === "dir" ? (
        <FolderPlusIcon className="size-4 shrink-0 text-muted-foreground" />
      ) : (
        <FilePlus2Icon className="size-4 shrink-0 text-muted-foreground" />
      )}
      <input
        className="min-w-0 flex-1 border-0 bg-transparent px-1 py-0.5 outline-none ring-1 ring-ring/50 focus:ring-1"
        onBlur={onCancel}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            onSubmit();
          }
          if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          }
        }}
        placeholder={kind === "dir" ? t("sidebar:folderName") : t("sidebar:fileName")}
        ref={inputRef}
        value={value}
      />
    </div>
  );
}

export function ThreadWorkspaceTree({
  threadId,
  onBack,
}: {
  threadId: string;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const userId = user?.id ?? "anonymous";
  const fetchTreeEntries = (targetThreadId: string, path?: string) =>
    fetchTree(targetThreadId, userId, path ?? "");
  const [entriesByPath, setEntriesByPath] = React.useState<Record<string, TreeEntry[]>>({});
  const [expanded, setExpanded] = React.useState(() => new Set<string>());
  const [creating, setCreating] = React.useState<{
    parent: string;
    kind: "file" | "dir";
  } | null>(null);
  const [createName, setCreateName] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const loadedPathsRef = React.useRef(new Set<string>());

  const loadDirectory = React.useCallback(
    async (path: string) => {
      if (loadedPathsRef.current.has(path)) return;
      loadedPathsRef.current.add(path);
      try {
        const entries = await fetchTreeEntries(threadId, path || undefined);
        setEntriesByPath((current) => ({ ...current, [path]: entries }));
      } catch (error) {
        loadedPathsRef.current.delete(path);
        toast.error(error instanceof Error ? error.message : t("sidebar:readDirFailed"));
      }
    },
    [fetchTreeEntries, t, threadId],
  );

  const refreshTree = React.useCallback(async () => {
    setLoading(true);
    setCreating(null);
    setCreateName("");
    setExpanded(new Set());
    setEntriesByPath({});
    loadedPathsRef.current.clear();
    try {
      const entries = await fetchTreeEntries(threadId);
      loadedPathsRef.current.add("");
      setEntriesByPath({ "": entries });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("sidebar:readTreeFailed"));
    } finally {
      setLoading(false);
    }
  }, [fetchTreeEntries, t, threadId]);

  React.useEffect(() => {
    void refreshTree();
  }, [refreshTree]);

  const handleExpandedChange = React.useCallback(
    (next: Set<string>) => {
      setExpanded(next);
      for (const path of next) void loadDirectory(path);
    },
    [loadDirectory],
  );

  const cancelCreate = React.useCallback(() => {
    setCreating(null);
    setCreateName("");
  }, []);

  const refreshDirectory = React.useCallback(
    async (parent: string) => {
      loadedPathsRef.current.delete(parent);
      await loadDirectory(parent);
      if (parent) setExpanded((current) => new Set(current).add(parent));
    },
    [loadDirectory],
  );

  const submitCreate = React.useCallback(async () => {
    if (!creating) return;
    const name = createName.trim();
    if (!name) {
      cancelCreate();
      return;
    }
    if (name.includes("/") || name.includes("\\")) {
      toast.error(t("sidebar:nameNoSeparator"));
      return;
    }
    const path = creating.parent ? `${creating.parent}/${name}` : name;
    try {
      const response = await apiFetch(
        `${MASTRA_SERVER_URL}/work/threads/${threadId}/tree?resourceId=${encodeURIComponent(userId)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path, type: creating.kind }),
        },
      );
      const payload = (await response.json()) as { error?: string; message?: string };
      if (!response.ok)
        throw new Error(payload.error || payload.message || t("sidebar:createFailed"));
      cancelCreate();
      await refreshDirectory(creating.parent);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("sidebar:createFailed"));
    }
  }, [cancelCreate, createName, creating, refreshDirectory, t, threadId, userId]);

  function renderEntries(entries: TreeEntry[]): React.ReactNode {
    return entries.map((entry) =>
      entry.type === "dir" ? (
        <ContextMenu key={entry.path}>
          <ContextMenuTrigger className="w-full block">
            <FileTreeFolder
              className={cn(entry.hidden && "opacity-65")}
              icon={<FolderTypeIcon name={entry.name} />}
              name={entry.name}
              openIcon={<FolderTypeIcon name={entry.name} open />}
              path={entry.path}
            >
              {creating?.parent === entry.path ? (
                <InlineCreateRow
                  kind={creating.kind}
                  onCancel={cancelCreate}
                  onChange={setCreateName}
                  onSubmit={() => void submitCreate()}
                  value={createName}
                />
              ) : null}
              {expanded.has(entry.path) && !entriesByPath[entry.path] ? (
                <p className="px-2 py-1 text-xs text-muted-foreground">{t("sidebar:reading")}</p>
              ) : null}
              {renderEntries(entriesByPath[entry.path] ?? [])}
            </FileTreeFolder>
          </ContextMenuTrigger>
          <ContextMenuContent className="w-44">
            <ContextMenuGroup>
              <ContextMenuLabel className="truncate max-w-40">{entry.name}</ContextMenuLabel>
              <ContextMenuItem
                onClick={() => {
                  setCreating({ parent: entry.path, kind: "file" });
                  setCreateName("");
                  setExpanded((current) => new Set(current).add(entry.path));
                  void loadDirectory(entry.path);
                }}
              >
                <FilePlus2Icon className="text-muted-foreground" />
                {t("sidebar:addFile")}
              </ContextMenuItem>
              <ContextMenuItem
                onClick={() => {
                  setCreating({ parent: entry.path, kind: "dir" });
                  setCreateName("");
                  setExpanded((current) => new Set(current).add(entry.path));
                  void loadDirectory(entry.path);
                }}
              >
                <FolderPlusIcon className="text-muted-foreground" />
                {t("sidebar:newSubFolder")}
              </ContextMenuItem>
            </ContextMenuGroup>
          </ContextMenuContent>
        </ContextMenu>
      ) : (
        <FileTreeFile
          key={entry.path}
          className={cn(entry.hidden && "opacity-65")}
          icon={<FileTypeIcon name={entry.name} />}
          name={entry.name}
          path={entry.path}
        />
      ),
    );
  }

  const rootEntries = entriesByPath[""] ?? [];

  return (
    <div className="flex min-h-0 size-full flex-col">
      <div className="flex min-w-0 items-center gap-1 border-b px-2 py-1.5">
        <Button
          aria-label={t("sidebar:backToProjects")}
          className="size-7 shrink-0"
          onClick={onBack}
          size="icon-sm"
          title={t("sidebar:backToProjects")}
          variant="ghost"
        >
          <ArrowLeftIcon />
        </Button>
        <span className="min-w-0 flex-1 truncate text-xs font-medium">
          {t("sidebar:fileManager")}
        </span>
        <Button
          aria-label={t("sidebar:refreshTree")}
          className="size-7 shrink-0"
          disabled={loading}
          onClick={() => void refreshTree()}
          size="icon-sm"
          title={t("sidebar:refreshTree")}
          variant="ghost"
        >
          <RefreshCwIcon className={cn(loading && "animate-spin")} />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                aria-label={t("sidebar:fileManagerAction")}
                className="size-7 shrink-0"
                size="icon-sm"
                title={t("sidebar:fileManagerAction")}
                variant="ghost"
              />
            }
          >
            <MoreHorizontalIcon />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-40">
            <DropdownMenuItem
              onClick={() => {
                setCreating({ parent: "", kind: "file" });
                setCreateName("");
              }}
            >
              <FilePlus2Icon />
              {t("sidebar:addFile")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => {
                setCreating({ parent: "", kind: "dir" });
                setCreateName("");
              }}
            >
              <FolderPlusIcon />
              {t("sidebar:newFolder")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <FileTree
          className="min-h-full rounded-none border-0 bg-transparent text-xs"
          expanded={expanded}
          onExpandedChange={handleExpandedChange}
        >
          {creating?.parent === "" ? (
            <InlineCreateRow
              kind={creating.kind}
              onCancel={cancelCreate}
              onChange={setCreateName}
              onSubmit={() => void submitCreate()}
              value={createName}
            />
          ) : null}
          {loading ? (
            <p className="px-2 py-2 text-xs text-muted-foreground">{t("sidebar:readingDir")}</p>
          ) : rootEntries.length === 0 && !creating ? (
            <p className="px-2 py-2 text-xs text-muted-foreground">{t("sidebar:emptyDir")}</p>
          ) : (
            renderEntries(rootEntries)
          )}
        </FileTree>
      </ScrollArea>
    </div>
  );
}

// 参考 docs/examples/base/sidebar-rsc.tsx 的 NavProjectsSkeleton
const SKELETON_KEYS = ["a", "b", "c", "d"];

export function ThreadListSkeleton() {
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
