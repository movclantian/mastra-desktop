import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  ArrowLeftIcon,
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
import { FileTree, FileTreeFile, FileTreeFolder } from "@/components/ai-elements/file-tree";
import { FileTypeIcon, FolderTypeIcon } from "@/components/ai-elements/file-type-icon";
import { openPathInApp } from "@/components/ai-elements/open-in-chat";
import { BlurFade } from "@/components/ui/blur-fade";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
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
} from "@/components/ui/context-menu";
import { Dotm3x3_6 } from "@/components/ui/dotm-3x3-6";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { MASTRA_SERVER_URL } from "@/lib/providers";
import { cn } from "@/lib/utils";
import type { TreeEntry } from "@/lib/workbench";
import { dirName, useWorkbench, type WorkThread } from "@/lib/workbench";

// 侧栏「任务列表」分组:直接线程平铺 + 显式绑定目录作为可折叠文件夹。
// 支持左键操作菜单与全局自定义右键上下文菜单。

export function sortThreads(threads: WorkThread[]): WorkThread[] {
  return [...threads].sort((a, b) => {
    const pinned = Number(Boolean(b.metadata.pinned)) - Number(Boolean(a.metadata.pinned));
    if (pinned !== 0) return pinned;
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });
}

function ThreadContextMenuItems({
  thread,
  onRename,
  onOpenFileManager,
}: {
  thread: WorkThread;
  onRename: (thread: WorkThread) => void;
  onOpenFileManager: (threadId: string) => void;
}) {
  const {
    activeThreadId,
    archiveThread,
    deleteThread,
    generateThreadTitle,
    pinThread,
    setActiveThreadId,
    setTerminalPanelOpen,
    cloneThread,
  } = useWorkbench();
  const [generating, setGenerating] = React.useState(false);
  const workspacePath = thread.metadata.workspacePath;

  const handleGenerateTitle = async () => {
    setGenerating(true);
    try {
      const newTitle = await generateThreadTitle(thread.id);
      if (newTitle) {
        toast.success(`已提炼新标题: ${newTitle}`);
      } else {
        toast.error("未能生成标题，请稍后再试");
      }
    } catch {
      toast.error("生成标题失败");
    } finally {
      setGenerating(false);
    }
  };

  const handleCopy = (text: string, label: string) => {
    void navigator.clipboard.writeText(text);
    toast.success(`已复制${label}`);
  };

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
          <span>{thread.metadata.pinned ? "取消置顶" : "置顶会话"}</span>
          <ContextMenuShortcut>{thread.metadata.pinned ? "⇧⌘P" : "⌘P"}</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem onClick={() => onRename(thread)}>
          <PencilIcon className="text-muted-foreground" />
          <span>重命名</span>
          <ContextMenuShortcut>F2</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem disabled={generating} onClick={() => void handleGenerateTitle()}>
          <SparklesIcon className="text-muted-foreground" />
          <span>{generating ? "正在提炼标题…" : "AI 智能起名"}</span>
        </ContextMenuItem>
      </ContextMenuGroup>

      <ContextMenuSeparator />

      <ContextMenuGroup>
        <ContextMenuLabel>工作区操作</ContextMenuLabel>
        <ContextMenuItem
          disabled={!workspacePath}
          onClick={() => {
            if (workspacePath) void openPathInApp("explorer", workspacePath, "文件资源管理器");
          }}
        >
          <FolderOpenIcon className="text-muted-foreground" />
          <span>在资源管理器打开</span>
        </ContextMenuItem>
        <ContextMenuItem
          disabled={!workspacePath}
          onClick={() => {
            onOpenFileManager(thread.id);
          }}
        >
          <FolderTreeIcon className="text-muted-foreground" />
          <span>浏览文件树</span>
        </ContextMenuItem>
        <ContextMenuItem
          disabled={!workspacePath}
          onClick={() => {
            if (activeThreadId !== thread.id) setActiveThreadId(thread.id);
            setTerminalPanelOpen(true);
          }}
        >
          <TerminalIcon className="text-muted-foreground" />
          <span>在终端中打开</span>
        </ContextMenuItem>
      </ContextMenuGroup>

      <ContextMenuSeparator />

      <ContextMenuGroup>
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <CopyIcon className="text-muted-foreground" />
            <span>复制信息</span>
          </ContextMenuSubTrigger>
          <ContextMenuSubContent className="w-48">
            <ContextMenuGroup>
              <ContextMenuItem onClick={() => handleCopy(thread.title, "会话标题")}>
                复制标题
              </ContextMenuItem>
              <ContextMenuItem onClick={() => handleCopy(thread.id, "会话 ID")}>
                复制会话 ID
              </ContextMenuItem>
              {workspacePath ? (
                <ContextMenuItem onClick={() => handleCopy(workspacePath, "工作区路径")}>
                  复制工作区路径
                </ContextMenuItem>
              ) : null}
            </ContextMenuGroup>
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuItem
          onClick={async () => {
            const cloned = await cloneThread(thread.id);
            if (cloned) toast.success(`已克隆会话「${cloned.title}」`);
          }}
        >
          <GitForkIcon className="text-muted-foreground" />
          <span>克隆此会话</span>
        </ContextMenuItem>
        <ContextMenuItem onClick={() => void archiveThread(thread.id, !thread.metadata.archivedAt)}>
          {thread.metadata.archivedAt ? (
            <ArchiveRestoreIcon className="text-muted-foreground" />
          ) : (
            <ArchiveIcon className="text-muted-foreground" />
          )}
          <span>{thread.metadata.archivedAt ? "取消归档" : "归档会话"}</span>
        </ContextMenuItem>
      </ContextMenuGroup>

      <ContextMenuSeparator />

      <ContextMenuGroup>
        <ContextMenuItem variant="destructive" onClick={() => void deleteThread(thread.id)}>
          <Trash2Icon className="text-muted-foreground" />
          <span>删除会话</span>
          <ContextMenuShortcut>⌫</ContextMenuShortcut>
        </ContextMenuItem>
      </ContextMenuGroup>
    </>
  );
}

function ThreadActionMenu({
  thread,
  onRename,
  onOpenFileManager,
  sub = false,
}: {
  thread: WorkThread;
  onRename: (thread: WorkThread) => void;
  onOpenFileManager: (threadId: string) => void;
  sub?: boolean;
}) {
  const { isMobile } = useSidebar();
  const { archiveThread, deleteThread, generateThreadTitle, pinThread } = useWorkbench();
  const [generating, setGenerating] = React.useState(false);
  const workspacePath = thread.metadata.workspacePath;

  const handleGenerateTitle = async () => {
    setGenerating(true);
    try {
      const newTitle = await generateThreadTitle(thread.id);
      if (newTitle) {
        toast.success(`已提炼新标题: ${newTitle}`);
      } else {
        toast.error("未能生成标题，请稍后再试");
      }
    } catch {
      toast.error("生成标题失败");
    } finally {
      setGenerating(false);
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
          disabled={!workspacePath}
          onClick={() => {
            onOpenFileManager(thread.id);
          }}
        >
          <FolderTreeIcon className="text-muted-foreground" />
          <span>文件管理</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={generating} onClick={() => void handleGenerateTitle()}>
          <SparklesIcon className="text-muted-foreground" />
          <span>{generating ? "正在提炼标题…" : "AI 智能起名"}</span>
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
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onClick={() => void deleteThread(thread.id)}>
          <Trash2Icon className="text-muted-foreground" />
          <span>删除</span>
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
  const { activeThreadId, setActiveThreadId, isThreadBusy } = useWorkbench();
  const isWorking = isThreadBusy(thread.id);

  return (
    <BlurFade duration={0.2} blur="3px">
      <SidebarMenuItem>
        <ContextMenu>
          <ContextMenuTrigger className="w-full">
            <SidebarMenuButton
              isActive={thread.id === activeThreadId}
              onClick={() => setActiveThreadId(thread.id)}
              tooltip={thread.title}
            >
              <MessageCircleIcon />
              <span className="truncate">{thread.title}</span>
              {isWorking ? (
                <span
                  className="ml-auto flex items-center pr-1 text-primary"
                  title="Agent 正在工作中…"
                >
                  <Dotm3x3_6 size={12} dotSize={2} colorPreset="solid-theme" />
                </span>
              ) : null}
            </SidebarMenuButton>
          </ContextMenuTrigger>
          <ContextMenuContent className="w-52">
            <ThreadContextMenuItems
              thread={thread}
              onOpenFileManager={onOpenFileManager}
              onRename={onRename}
            />
          </ContextMenuContent>
        </ContextMenu>
        {thread.metadata.pinned ? (
          <SidebarMenuBadge>
            <PinIcon className="size-3" />
          </SidebarMenuBadge>
        ) : null}
        <ThreadActionMenu
          thread={thread}
          onOpenFileManager={onOpenFileManager}
          onRename={onRename}
        />
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
  const { activeThreadId, setActiveThreadId, isThreadBusy } = useWorkbench();
  const isWorking = isThreadBusy(thread.id);

  return (
    <SidebarMenuSubItem>
      <ContextMenu>
        <ContextMenuTrigger className="w-full">
          <SidebarMenuSubButton
            isActive={thread.id === activeThreadId}
            onClick={() => setActiveThreadId(thread.id)}
          >
            <MessageCircleIcon />
            <span className="truncate">{thread.title}</span>
            {isWorking ? (
              <span
                className="ml-auto flex items-center pr-1 text-primary"
                title="Agent 正在工作中…"
              >
                <Dotm3x3_6 size={12} dotSize={2} colorPreset="solid-theme" />
              </span>
            ) : null}
          </SidebarMenuSubButton>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-52">
          <ThreadContextMenuItems
            thread={thread}
            onOpenFileManager={onOpenFileManager}
            onRename={onRename}
          />
        </ContextMenuContent>
      </ContextMenu>
      <ThreadActionMenu
        thread={thread}
        onOpenFileManager={onOpenFileManager}
        onRename={onRename}
        sub
      />
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
  const { createThread, setActiveThreadId, setTerminalPanelOpen, isThreadBusy } = useWorkbench();
  const sorted = sortThreads(threads);
  const [open, setOpen] = React.useState(false);
  const hasWorkingThread = sorted.some((t) => isThreadBusy(t.id));

  const handleCopyPath = () => {
    void navigator.clipboard.writeText(path);
    toast.success("已复制工作区路径");
  };

  const handleCreateThreadInWorkspace = async () => {
    const newThread = await createThread();
    if (newThread) {
      setActiveThreadId(newThread.id);
      toast.success("已在工作区新建会话");
    }
  };

  return (
    <Collapsible className="group/collapsible" onOpenChange={setOpen} open={open}>
      <SidebarMenuItem>
        <ContextMenu>
          <ContextMenuTrigger className="w-full">
            <CollapsibleTrigger render={<SidebarMenuButton tooltip={path} />}>
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
                  title="工作区中有正在运行的会话…"
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
                <span>在此工作区新建会话</span>
                <ContextMenuShortcut>⌘N</ContextMenuShortcut>
              </ContextMenuItem>
            </ContextMenuGroup>
            <ContextMenuSeparator />
            <ContextMenuGroup>
              <ContextMenuItem
                onClick={() => void openPathInApp("explorer", path, "文件资源管理器")}
              >
                <FolderOpenIcon className="text-muted-foreground" />
                <span>在资源管理器打开</span>
              </ContextMenuItem>
              <ContextMenuItem
                onClick={() => {
                  if (threads[0]) onOpenFileManager(threads[0].id);
                }}
              >
                <FolderTreeIcon className="text-muted-foreground" />
                <span>浏览文件管理</span>
              </ContextMenuItem>
              <ContextMenuItem
                onClick={() => {
                  if (threads[0]) setActiveThreadId(threads[0].id);
                  setTerminalPanelOpen(true);
                }}
              >
                <TerminalIcon className="text-muted-foreground" />
                <span>在终端中打开</span>
              </ContextMenuItem>
              <ContextMenuItem onClick={() => void openPathInApp("code", path, "VS Code")}>
                <ExternalLinkIcon className="text-muted-foreground" />
                <span>在 VS Code 中打开</span>
              </ContextMenuItem>
            </ContextMenuGroup>
            <ContextMenuSeparator />
            <ContextMenuGroup>
              <ContextMenuItem onClick={handleCopyPath}>
                <CopyIcon className="text-muted-foreground" />
                <span>复制目录路径</span>
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
        placeholder={kind === "dir" ? "文件夹名称" : "文件名"}
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
  const { fetchTreeEntries, user } = useWorkbench();
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
        toast.error(error instanceof Error ? error.message : "读取文件夹失败");
      }
    },
    [fetchTreeEntries, threadId],
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
      toast.error(error instanceof Error ? error.message : "读取文件树失败");
    } finally {
      setLoading(false);
    }
  }, [fetchTreeEntries, threadId]);

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
      toast.error("名称不能包含路径分隔符");
      return;
    }
    const path = creating.parent ? `${creating.parent}/${name}` : name;
    try {
      const response = await fetch(
        `${MASTRA_SERVER_URL}/work/threads/${threadId}/tree?resourceId=${encodeURIComponent(user.id)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path, type: creating.kind }),
        },
      );
      const payload = (await response.json()) as { error?: string; message?: string };
      if (!response.ok) throw new Error(payload.error || payload.message || "创建失败");
      cancelCreate();
      await refreshDirectory(creating.parent);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "创建失败");
    }
  }, [cancelCreate, createName, creating, refreshDirectory, threadId, user.id]);

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
                <p className="px-2 py-1 text-xs text-muted-foreground">正在读取…</p>
              ) : null}
              {renderEntries(entriesByPath[entry.path] ?? [])}
            </FileTreeFolder>
          </ContextMenuTrigger>
          <ContextMenuContent className="w-44">
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
              新建文件
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
              新建子文件夹
            </ContextMenuItem>
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
          aria-label="返回项目列表"
          className="size-7 shrink-0"
          onClick={onBack}
          size="icon-sm"
          title="返回项目列表"
          variant="ghost"
        >
          <ArrowLeftIcon />
        </Button>
        <span className="min-w-0 flex-1 truncate text-xs font-medium">文件管理</span>
        <Button
          aria-label="刷新文件树"
          className="size-7 shrink-0"
          disabled={loading}
          onClick={() => void refreshTree()}
          size="icon-sm"
          title="刷新文件树"
          variant="ghost"
        >
          <RefreshCwIcon className={cn(loading && "animate-spin")} />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                aria-label="文件管理操作"
                className="size-7 shrink-0"
                size="icon-sm"
                title="文件管理操作"
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
              添加文件
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => {
                setCreating({ parent: "", kind: "dir" });
                setCreateName("");
              }}
            >
              <FolderPlusIcon />
              新建文件夹
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
            <p className="px-2 py-2 text-xs text-muted-foreground">正在读取目录…</p>
          ) : rootEntries.length === 0 && !creating ? (
            <p className="px-2 py-2 text-xs text-muted-foreground">空目录</p>
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
