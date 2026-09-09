import {
  ChevronDownIcon,
  DownloadIcon,
  ExternalLinkIcon,
  FileSpreadsheetIcon,
  FileTextIcon,
  FolderPenIcon,
  FolderPlusIcon,
  HardDriveIcon,
  MoreVerticalIcon,
  PanelLeftIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  Trash2Icon,
  UploadIcon,
} from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import {
  createLibraryFolder,
  deleteLibraryAsset,
  deleteLibraryFolder,
  fetchLibraryAssetBlob,
  formatBytes,
  indexStageLabel,
  type LibraryAsset,
  type LibraryFolder,
  type LibrarySettings,
  libraryAssetContentUrl,
  type RenameTarget,
  reindexFailedLibraryAssets,
  reindexLibraryAsset,
  renameLibraryTarget,
  saveLibrarySettings,
  statusLabel,
} from "@/entities/library";
import { useWorkbench } from "@/entities/workbench";
import {
  type LibraryUploadTarget,
  useLibraryData,
  useLibraryUpload,
} from "@/features/library-upload";
import { cn, toastError } from "@/shared/lib";
import { FileTypeIcon, FolderTypeIcon } from "@/shared/ui/ai-elements/file-type-icon";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/shared/ui/command";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "@/shared/ui/context-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { Dotm3x3_1 } from "@/shared/ui/dotm-3x3-1";
import { Dotm3x3_11 } from "@/shared/ui/dotm-3x3-11";
import { DotmHex1 } from "@/shared/ui/dotm-hex-1";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";
import { Input } from "@/shared/ui/input";
import { Progress } from "@/shared/ui/progress";
import { ScrollArea } from "@/shared/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/shared/ui/select";
import { Separator } from "@/shared/ui/separator";
import {
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/shared/ui/sidebar";
import { Switch } from "@/shared/ui/switch";

const LibraryFilePreview = React.lazy(() => import("@/features/library-upload/file-preview"));

async function downloadLibraryAsset(
  event: React.MouseEvent<HTMLAnchorElement>,
  url: string,
  filename: string,
): Promise<void> {
  event.preventDefault();
  try {
    const objectUrl = URL.createObjectURL(await fetchLibraryAssetBlob(url));
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = filename;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
  } catch {
    toast.error("文件下载失败");
  }
}

type LibraryView = "documents" | "session" | "search";

type LibraryTreeEntry =
  | { kind: "folder"; folder: LibraryFolder; depth: number }
  | { kind: "asset"; asset: LibraryAsset; depth: number };

interface KnowledgeLibraryProps {
  settingsOpen: boolean;
  onSettingsOpenChange: (open: boolean) => void;
}

export function KnowledgeLibraryPage({
  settingsOpen,
  onSettingsOpenChange,
}: KnowledgeLibraryProps) {
  const { user, activeThreadId, createThread, queueLibraryFiles, setActiveView } = useWorkbench();
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [folderId, setFolderId] = React.useState<string | null>(null);
  const [query, setQuery] = React.useState("");
  const [fileSearchOpen, setFileSearchOpen] = React.useState(false);
  const [fileSearchQuery, setFileSearchQuery] = React.useState("");
  const [view, setView] = React.useState<LibraryView>("documents");
  const [directoryOpen, setDirectoryOpen] = React.useState(true);
  const [collapsedFolderIds, setCollapsedFolderIds] = React.useState<Set<string>>(() => new Set());
  const [folderDialog, setFolderDialog] = React.useState(false);
  const [folderName, setFolderName] = React.useState("");
  const [folderParentId, setFolderParentId] = React.useState<string | null>(null);
  const [renameTarget, setRenameTarget] = React.useState<RenameTarget | null>(null);
  const [renameValue, setRenameValue] = React.useState("");
  const [reindexingIds, setReindexingIds] = React.useState<Set<string>>(() => new Set());
  const [batchReindexing, setBatchReindexing] = React.useState(false);

  const { assets, setAssets, folders, settings, setSettings, loading, refresh } = useLibraryData({
    resourceId: user.id,
    settingsOpen,
  });

  const {
    inputRef,
    uploading,
    uploadProgress,
    retryFiles,
    uploadError,
    uploadFiles,
    cancelUpload,
    retryUpload,
  } = useLibraryUpload(user.id, refresh);

  const documentFolders = React.useMemo(
    () => folders.filter((folder) => !folder.threadId),
    [folders],
  );
  const documentFolderIds = React.useMemo(
    () => new Set(documentFolders.map((folder) => folder.id)),
    [documentFolders],
  );

  const scopedAssets = React.useMemo(() => {
    if (view === "session") {
      if (!activeThreadId) return [];
      return assets.filter(
        (asset) => asset.threadIds.length > 0 && asset.threadIds.includes(activeThreadId),
      );
    }
    if (view === "documents") {
      return assets.filter(
        (asset) =>
          asset.folderIds.some((id) => documentFolderIds.has(id)) ||
          (asset.folderIds.length === 0 && asset.threadIds.length === 0),
      );
    }
    return assets;
  }, [activeThreadId, assets, documentFolderIds, view]);

  const sessionAssetCount = React.useMemo(
    () =>
      activeThreadId
        ? assets.filter(
            (asset) => asset.threadIds.length > 0 && asset.threadIds.includes(activeThreadId),
          ).length
        : 0,
    [activeThreadId, assets],
  );

  const visibleAssets = React.useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return scopedAssets.filter(
      (asset) => !needle || asset.filename.toLocaleLowerCase().includes(needle),
    );
  }, [query, scopedAssets]);

  const failedAssetCount = React.useMemo(
    () => assets.filter((asset) => asset.status === "error").length,
    [assets],
  );

  React.useEffect(() => {
    if (selectedId && visibleAssets.some((asset) => asset.id === selectedId)) return;
    setSelectedId(visibleAssets[0]?.id ?? null);
  }, [selectedId, visibleAssets]);

  const selected = visibleAssets.find((asset) => asset.id === selectedId) ?? null;
  const documentTree = React.useMemo<LibraryTreeEntry[]>(() => {
    const entries: LibraryTreeEntry[] = [];
    const children = new Map<string | null, LibraryFolder[]>();
    for (const folder of documentFolders) {
      const group = children.get(folder.parentId) ?? [];
      group.push(folder);
      children.set(folder.parentId, group);
    }
    for (const group of children.values()) group.sort((a, b) => a.name.localeCompare(b.name));

    const visit = (parentId: string | null, depth: number) => {
      for (const folder of children.get(parentId) ?? []) {
        entries.push({ kind: "folder", folder, depth });
        if (collapsedFolderIds.has(folder.id)) continue;
        visit(folder.id, depth + 1);
        for (const asset of visibleAssets) {
          const primaryFolderId = asset.folderIds.find((id) => documentFolderIds.has(id));
          if (primaryFolderId === folder.id) {
            entries.push({ kind: "asset", asset, depth: depth + 1 });
          }
        }
      }
    };
    visit(null, 0);
    for (const asset of visibleAssets) {
      if (asset.folderIds.length === 0) entries.push({ kind: "asset", asset, depth: 0 });
    }
    return entries;
  }, [collapsedFolderIds, documentFolderIds, documentFolders, visibleAssets]);
  const createFolder = async () => {
    if (!folderName.trim()) return;
    try {
      await createLibraryFolder(user.id, folderName.trim(), folderParentId);
      setFolderDialog(false);
      setFolderName("");
      setFolderParentId(null);
      await refresh();
    } catch (error) {
      toastError(error, "创建文件夹失败");
    }
  };

  const uploadTarget = {
    folderId: view === "documents" ? folderId : null,
    threadId: null,
  };

  const uploadTargetRef = React.useRef<LibraryUploadTarget>(uploadTarget);
  uploadTargetRef.current = uploadTarget;

  const openUpload = (target: LibraryUploadTarget) => {
    uploadTargetRef.current = target;
    inputRef.current?.click();
  };

  const createBlankFile = (
    kind: "document" | "spreadsheet",
    target: LibraryUploadTarget = uploadTarget,
  ) => {
    const file =
      kind === "document"
        ? new File(["# 未命名文档\n\n"], "未命名文档.md", { type: "text/markdown" })
        : new File(["列1,列2\n\n"], "未命名表格.csv", { type: "text/csv" });
    void uploadFiles([file], target);
  };

  const removeAsset = async (asset: LibraryAsset) => {
    try {
      await deleteLibraryAsset(asset.id, user.id);
      setSelectedId((current) => (current === asset.id ? null : current));
      setAssets((current) => current.filter((item) => item.id !== asset.id));
      toast.success("文件及其向量索引已删除");
    } catch (error) {
      toastError(error, "删除文件失败");
    }
  };

  const openRename = (target: RenameTarget) => {
    setRenameTarget(target);
    setRenameValue(target.name);
  };

  const saveRename = async () => {
    if (!renameTarget || !renameValue.trim()) return;
    try {
      await renameLibraryTarget(renameTarget, user.id, renameValue);
      setRenameTarget(null);
      await refresh(true);
    } catch (error) {
      toastError(error, "重命名失败");
    }
  };

  const removeFolder = async (folder: LibraryFolder) => {
    try {
      await deleteLibraryFolder(folder.id, user.id);
      if (folderId === folder.id) setFolderId(null);
      setCollapsedFolderIds((current) => {
        const next = new Set(current);
        next.delete(folder.id);
        return next;
      });
      await refresh(true);
    } catch (error) {
      toastError(error, "删除文件夹失败");
    }
  };

  const openCreateFolder = (parentId: string | null) => {
    setFolderParentId(parentId);
    setFolderDialog(true);
  };

  const referenceInNewThread = async (asset: LibraryAsset) => {
    const thread = await createThread();
    if (!thread) {
      toast.error("创建新会话失败");
      return;
    }
    queueLibraryFiles([
      {
        type: "file",
        byteSize: asset.byteSize,
        filename: asset.filename,
        mediaType: asset.mediaType,
        url: libraryAssetContentUrl(asset.id, user.id),
      },
    ]);
    setActiveView("chat");
    toast.success("已在新会话中引用资料");
  };

  const reindexOne = async (asset: LibraryAsset) => {
    setReindexingIds((current) => new Set(current).add(asset.id));
    try {
      await reindexLibraryAsset(asset.id, user.id);
      await refresh(true);
      window.setTimeout(() => void refresh(true), 1_000);
      toast.success(`已重新开始索引「${asset.filename}」`);
    } catch (error) {
      toastError(error, "重新索引失败");
    } finally {
      setReindexingIds((current) => {
        const next = new Set(current);
        next.delete(asset.id);
        return next;
      });
    }
  };

  const reindexFailed = async () => {
    setBatchReindexing(true);
    try {
      const assetIds = await reindexFailedLibraryAssets(user.id);
      await refresh(true);
      window.setTimeout(() => void refresh(true), 1_000);
      toast.success(`已重新开始 ${assetIds.length} 个索引任务`);
    } catch (error) {
      toastError(error, "批量重新索引失败");
    } finally {
      setBatchReindexing(false);
    }
  };

  const renderAssetRow = (asset: LibraryAsset, depth = 0, keyPrefix = "asset") => {
    return (
      <SidebarMenuItem key={`${keyPrefix}-${asset.id}`}>
        <ContextMenu>
          <ContextMenuTrigger className="w-full block">
            <SidebarMenuButton
              isActive={selectedId === asset.id}
              onClick={() => setSelectedId(asset.id)}
              tooltip={asset.filename}
              className="h-auto py-1.5 w-full"
              style={{ paddingLeft: directoryOpen ? `${8 + depth * 12}px` : undefined }}
            >
              <FileTypeIcon mediaType={asset.mediaType} name={asset.filename} />
              <span className="min-w-0 flex-1 group-data-[collapsible=icon]/sidebar:hidden">
                <span className="block truncate text-sm">{asset.filename}</span>
                <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
                  <span>{formatBytes(asset.byteSize)}</span>
                  <span>·</span>
                  {/* 蜂巢点阵 = 正在切块/嵌入入库,把「索引中」这个后台过程画出来 */}
                  {asset.status === "indexing" ? (
                    <DotmHex1 size={12} dotSize={1.4} colorPreset="solid-theme" />
                  ) : null}
                  <span className="truncate">
                    {statusLabel(asset.status)}
                    {(asset.status === "error" || asset.status === "indexing") && asset.indexStage
                      ? ` · ${indexStageLabel(asset.indexStage)}`
                      : ""}
                    {asset.status === "error" && asset.indexAttempt > 0
                      ? ` · 第 ${asset.indexAttempt} 次`
                      : ""}
                  </span>
                </span>
                {asset.status === "error" && asset.indexError ? (
                  <span
                    className="mt-0.5 block truncate text-[11px] text-destructive"
                    title={asset.indexError}
                  >
                    {asset.indexError}
                  </span>
                ) : null}
              </span>
            </SidebarMenuButton>
          </ContextMenuTrigger>
          <ContextMenuContent className="w-52">
            <ContextMenuGroup>
              <ContextMenuLabel className="truncate max-w-48">{asset.filename}</ContextMenuLabel>
              <ContextMenuItem onClick={() => void referenceInNewThread(asset)}>
                <ExternalLinkIcon className="text-muted-foreground" />
                <span>在新会话中引用</span>
              </ContextMenuItem>
              {asset.status === "error" || asset.status === "unsupported" ? (
                <ContextMenuItem
                  disabled={reindexingIds.has(asset.id)}
                  onClick={() => void reindexOne(asset)}
                >
                  <RefreshCwIcon
                    className={cn(
                      "text-muted-foreground",
                      reindexingIds.has(asset.id) && "animate-spin",
                    )}
                  />
                  <span>重新索引</span>
                </ContextMenuItem>
              ) : null}
              <ContextMenuItem
                onClick={() => openRename({ kind: "asset", id: asset.id, name: asset.filename })}
              >
                <PencilIcon className="text-muted-foreground" />
                <span>重命名</span>
                <ContextMenuShortcut>F2</ContextMenuShortcut>
              </ContextMenuItem>
              <ContextMenuItem
                render={
                  <a
                    download={asset.filename}
                    href={libraryAssetContentUrl(asset.id, user.id)}
                    onClick={(event) =>
                      void downloadLibraryAsset(
                        event,
                        libraryAssetContentUrl(asset.id, user.id),
                        asset.filename,
                      )
                    }
                  />
                }
              >
                <DownloadIcon className="text-muted-foreground" />
                <span>下载原文件</span>
              </ContextMenuItem>
            </ContextMenuGroup>
            <ContextMenuSeparator />
            <ContextMenuGroup>
              <ContextMenuItem variant="destructive" onClick={() => void removeAsset(asset)}>
                <Trash2Icon className="text-muted-foreground" />
                <span>删除文件</span>
                <ContextMenuShortcut>⌫</ContextMenuShortcut>
              </ContextMenuItem>
            </ContextMenuGroup>
          </ContextMenuContent>
        </ContextMenu>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <SidebarMenuAction
                showOnHover
                title="文件操作"
                className="group-data-[collapsible=icon]/sidebar:hidden"
              >
                <MoreVerticalIcon />
              </SidebarMenuAction>
            }
          />
          <DropdownMenuContent align="end">
            {asset.status === "error" || asset.status === "unsupported" ? (
              <DropdownMenuItem
                disabled={reindexingIds.has(asset.id)}
                onClick={() => void reindexOne(asset)}
              >
                <RefreshCwIcon className={cn(reindexingIds.has(asset.id) && "animate-spin")} />
                <span>重新索引</span>
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem
              onClick={() => openRename({ kind: "asset", id: asset.id, name: asset.filename })}
            >
              <PencilIcon />
              <span>重命名</span>
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => void referenceInNewThread(asset)}>
              <ExternalLinkIcon />
              <span>在新会话中引用</span>
            </DropdownMenuItem>
            <DropdownMenuItem
              render={
                <a
                  download={asset.filename}
                  href={libraryAssetContentUrl(asset.id, user.id)}
                  onClick={(event) =>
                    void downloadLibraryAsset(
                      event,
                      libraryAssetContentUrl(asset.id, user.id),
                      asset.filename,
                    )
                  }
                />
              }
            >
              <DownloadIcon />
              <span>下载原文件</span>
            </DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onClick={() => void removeAsset(asset)}>
              <Trash2Icon />
              <span>删除文件</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    );
  };

  const saveSettings = async () => {
    try {
      const nextSettings = await saveLibrarySettings(settings);
      setSettings(nextSettings);
      onSettingsOpenChange(false);
      toast.success("资料库设置已保存");
    } catch {
      toast.error("保存资料库设置失败");
    }
  };

  return (
    <>
      <div className="flex size-full min-h-0 min-w-0 overflow-hidden bg-background">
        {/* 资料库内部二级侧栏:纯 relative 布局,绝对不逃逸出当前容器,完美收缩为 48px 图标栏 */}
        <aside
          data-state={directoryOpen ? "expanded" : "collapsed"}
          data-collapsible={directoryOpen ? "" : "icon"}
          data-slot="sidebar"
          data-sidebar="sidebar"
          className={cn(
            "group/sidebar relative flex h-full min-h-0 flex-col border-r bg-sidebar transition-[width] duration-200 ease-linear overflow-hidden shrink-0",
            directoryOpen ? "w-64 md:w-72" : "w-12",
          )}
        >
          <div className="flex h-full w-full min-h-0 shrink-0 flex-col">
            {/* Header 导航 */}
            <div className="border-b border-sidebar-border p-2 shrink-0">
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    isActive={view === "search"}
                    onClick={() => setFileSearchOpen(true)}
                    tooltip="搜索资料"
                  >
                    <SearchIcon />
                    <span className="group-data-[collapsible=icon]/sidebar:hidden">搜索资料</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    isActive={view === "session"}
                    onClick={() => {
                      setView("session");
                      setFolderId(null);
                      setQuery("");
                    }}
                    tooltip="会话文件"
                  >
                    <HardDriveIcon />
                    <span className="group-data-[collapsible=icon]/sidebar:hidden">会话文件</span>
                  </SidebarMenuButton>
                  <SidebarMenuBadge className="group-data-[collapsible=icon]/sidebar:hidden">
                    {sessionAssetCount}
                  </SidebarMenuBadge>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    isActive={view === "documents"}
                    onClick={() => {
                      setView("documents");
                      setQuery("");
                    }}
                    tooltip="我的文档"
                  >
                    <FolderTypeIcon name="资料库" open={view === "documents"} />
                    <span className="group-data-[collapsible=icon]/sidebar:hidden">我的文档</span>
                  </SidebarMenuButton>
                  {failedAssetCount > 0 ? (
                    <SidebarMenuAction
                      showOnHover
                      onClick={() => void reindexFailed()}
                      title={`重新索引 ${failedAssetCount} 个失败文件`}
                      className="group-data-[collapsible=icon]/sidebar:hidden"
                    >
                      <RefreshCwIcon
                        className={cn(batchReindexing && "animate-spin", "text-destructive")}
                      />
                    </SidebarMenuAction>
                  ) : null}
                </SidebarMenuItem>
              </SidebarMenu>

              {view === "search" && directoryOpen ? (
                <div className="relative pt-2">
                  <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    autoFocus
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    className="h-8 bg-background pl-8 text-xs"
                    placeholder="过滤文件名..."
                  />
                </div>
              ) : null}
            </div>

            {/* Content 文件列表 */}
            <div className="min-h-0 flex-1 flex flex-col p-2 overflow-hidden">
              <div className="flex h-8 shrink-0 items-center justify-between px-1 text-xs font-medium text-sidebar-foreground/70">
                <span className="group-data-[collapsible=icon]/sidebar:hidden">
                  {view === "documents" ? "文档目录" : view === "session" ? "会话附件" : "搜索结果"}
                </span>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        className="size-5 rounded-md p-0 group-data-[collapsible=icon]/sidebar:mx-auto"
                        title="添加文档、表格或文件夹"
                      >
                        <PlusIcon className="size-3.5" />
                      </Button>
                    }
                  />
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem disabled={uploading} onClick={() => openUpload(uploadTarget)}>
                      {uploading ? (
                        <Dotm3x3_11 size={14} dotSize={2.2} colorPreset="solid-theme" />
                      ) : (
                        <UploadIcon />
                      )}
                      <span>上传文件</span>
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={uploading}
                      onClick={() => createBlankFile("document", uploadTarget)}
                    >
                      <FileTextIcon />
                      <span>新建文档（Markdown）</span>
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={uploading}
                      onClick={() => createBlankFile("spreadsheet", uploadTarget)}
                    >
                      <FileSpreadsheetIcon />
                      <span>新建表格（CSV）</span>
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={() => openCreateFolder(folderId)}>
                      <FolderPlusIcon />
                      <span>新建文件夹</span>
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
                <input
                  ref={inputRef}
                  hidden
                  type="file"
                  multiple
                  onChange={(event) =>
                    void uploadFiles(
                      event.target.files ? [...event.target.files] : [],
                      uploadTargetRef.current,
                    )
                  }
                />
              </div>
              <ScrollArea className="min-h-0 flex-1">
                <SidebarMenu>
                  {loading ? (
                    <p className="p-3 text-xs text-muted-foreground group-data-[collapsible=icon]/sidebar:hidden">
                      正在读取…
                    </p>
                  ) : null}
                  {!loading && view !== "documents" && visibleAssets.length === 0 ? (
                    <p className="p-3 text-xs text-muted-foreground group-data-[collapsible=icon]/sidebar:hidden">
                      {view === "search"
                        ? "没有匹配的文件"
                        : view === "session" && !activeThreadId
                          ? "当前没有活动会话"
                          : "这里还没有文件"}
                    </p>
                  ) : null}
                  {!loading && view === "documents"
                    ? documentTree.map((entry) =>
                        entry.kind === "folder" ? (
                          <SidebarMenuItem key={`folder-${entry.folder.id}`}>
                            <div className="flex w-full min-w-0 items-center gap-0.5">
                              <Button
                                size="icon-xs"
                                variant="ghost"
                                className="size-6 shrink-0 group-data-[collapsible=icon]/sidebar:hidden"
                                style={{ marginLeft: `${entry.depth * 12}px` }}
                                title={
                                  collapsedFolderIds.has(entry.folder.id)
                                    ? "展开文件夹"
                                    : "折叠文件夹"
                                }
                                onClick={() =>
                                  setCollapsedFolderIds((current) => {
                                    const next = new Set(current);
                                    if (next.has(entry.folder.id)) next.delete(entry.folder.id);
                                    else next.add(entry.folder.id);
                                    return next;
                                  })
                                }
                              >
                                <ChevronDownIcon
                                  className={cn(
                                    "size-3.5 transition-transform duration-200",
                                    collapsedFolderIds.has(entry.folder.id) && "-rotate-90",
                                  )}
                                />
                              </Button>
                              <ContextMenu>
                                <ContextMenuTrigger className="min-w-0 flex-1">
                                  <SidebarMenuButton
                                    isActive={folderId === entry.folder.id}
                                    onClick={() => setFolderId(entry.folder.id)}
                                    tooltip={entry.folder.name}
                                    className="w-full"
                                  >
                                    <FolderTypeIcon
                                      name={entry.folder.name}
                                      open={!collapsedFolderIds.has(entry.folder.id)}
                                    />
                                    <span className="truncate group-data-[collapsible=icon]/sidebar:hidden">
                                      {entry.folder.name}
                                    </span>
                                  </SidebarMenuButton>
                                </ContextMenuTrigger>
                                <ContextMenuContent className="w-52">
                                  <ContextMenuGroup>
                                    <ContextMenuLabel className="truncate max-w-48">
                                      {entry.folder.name}
                                    </ContextMenuLabel>
                                    <ContextMenuItem
                                      disabled={uploading}
                                      onClick={() =>
                                        openUpload({ folderId: entry.folder.id, threadId: null })
                                      }
                                    >
                                      <UploadIcon className="text-muted-foreground" />
                                      <span>上传文件到此文件夹</span>
                                    </ContextMenuItem>
                                    <ContextMenuItem
                                      disabled={uploading}
                                      onClick={() =>
                                        createBlankFile("document", {
                                          folderId: entry.folder.id,
                                          threadId: null,
                                        })
                                      }
                                    >
                                      <FileTextIcon className="text-muted-foreground" />
                                      <span>新建文档（Markdown）</span>
                                    </ContextMenuItem>
                                    <ContextMenuItem
                                      disabled={uploading}
                                      onClick={() =>
                                        createBlankFile("spreadsheet", {
                                          folderId: entry.folder.id,
                                          threadId: null,
                                        })
                                      }
                                    >
                                      <FileSpreadsheetIcon className="text-muted-foreground" />
                                      <span>新建表格（CSV）</span>
                                    </ContextMenuItem>
                                    <ContextMenuItem
                                      onClick={() => openCreateFolder(entry.folder.id)}
                                    >
                                      <FolderPlusIcon className="text-muted-foreground" />
                                      <span>新建子文件夹</span>
                                    </ContextMenuItem>
                                  </ContextMenuGroup>
                                  <ContextMenuSeparator />
                                  <ContextMenuGroup>
                                    <ContextMenuItem
                                      onClick={() =>
                                        openRename({
                                          kind: "folder",
                                          id: entry.folder.id,
                                          name: entry.folder.name,
                                        })
                                      }
                                    >
                                      <FolderPenIcon className="text-muted-foreground" />
                                      <span>重命名</span>
                                      <ContextMenuShortcut>F2</ContextMenuShortcut>
                                    </ContextMenuItem>
                                    <ContextMenuItem
                                      variant="destructive"
                                      onClick={() => void removeFolder(entry.folder)}
                                    >
                                      <Trash2Icon className="text-muted-foreground" />
                                      <span>删除文件夹</span>
                                      <ContextMenuShortcut>⌫</ContextMenuShortcut>
                                    </ContextMenuItem>
                                  </ContextMenuGroup>
                                </ContextMenuContent>
                              </ContextMenu>
                            </div>
                            <DropdownMenu>
                              <DropdownMenuTrigger
                                render={
                                  <SidebarMenuAction
                                    showOnHover
                                    title="文件夹操作"
                                    className="group-data-[collapsible=icon]/sidebar:hidden"
                                  >
                                    <MoreVerticalIcon />
                                  </SidebarMenuAction>
                                }
                              />
                              <DropdownMenuContent align="end">
                                <DropdownMenuItem
                                  disabled={uploading}
                                  onClick={() =>
                                    openUpload({ folderId: entry.folder.id, threadId: null })
                                  }
                                >
                                  <UploadIcon />
                                  <span>上传文件到此文件夹</span>
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  disabled={uploading}
                                  onClick={() =>
                                    createBlankFile("document", {
                                      folderId: entry.folder.id,
                                      threadId: null,
                                    })
                                  }
                                >
                                  <FileTextIcon />
                                  <span>新建文档（Markdown）</span>
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  disabled={uploading}
                                  onClick={() =>
                                    createBlankFile("spreadsheet", {
                                      folderId: entry.folder.id,
                                      threadId: null,
                                    })
                                  }
                                >
                                  <FileSpreadsheetIcon />
                                  <span>新建表格（CSV）</span>
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={() => openCreateFolder(entry.folder.id)}>
                                  <FolderPlusIcon />
                                  <span>新建子文件夹</span>
                                </DropdownMenuItem>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                  onClick={() =>
                                    openRename({
                                      kind: "folder",
                                      id: entry.folder.id,
                                      name: entry.folder.name,
                                    })
                                  }
                                >
                                  <FolderPenIcon />
                                  <span>重命名</span>
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  variant="destructive"
                                  onClick={() => void removeFolder(entry.folder)}
                                >
                                  <Trash2Icon />
                                  <span>删除文件夹</span>
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </SidebarMenuItem>
                        ) : (
                          renderAssetRow(entry.asset, entry.depth, "tree")
                        ),
                      )
                    : null}
                  {!loading && view === "documents" && visibleAssets.length === 0 ? (
                    <p className="p-3 text-xs text-muted-foreground group-data-[collapsible=icon]/sidebar:hidden">
                      这里还没有文件
                    </p>
                  ) : null}
                  {!loading && view !== "documents"
                    ? visibleAssets.map((asset) => renderAssetRow(asset, 0, view))
                    : null}
                </SidebarMenu>
              </ScrollArea>
            </div>

            {/* Footer 上传进度 */}
            {uploading || uploadError ? (
              <div className="border-t border-sidebar-border p-2 shrink-0">
                <div className="space-y-1.5 bg-background/40 p-2 rounded-md group-data-[collapsible=icon]/sidebar:hidden">
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <span className="truncate">
                      {uploadError ? uploadError : `正在上传 ${retryFiles.length} 个文件`}
                    </span>
                    <span className="shrink-0 tabular-nums">{uploadProgress}%</span>
                  </div>
                  <Progress value={uploadProgress} />
                  {uploading ? (
                    <Button
                      className="w-full h-7 text-xs"
                      size="sm"
                      variant="ghost"
                      onClick={() => void cancelUpload()}
                    >
                      取消上传
                    </Button>
                  ) : null}
                  {uploadError && !uploading ? (
                    <Button
                      className="w-full h-7 text-xs"
                      size="sm"
                      variant="outline"
                      onClick={retryUpload}
                    >
                      从断点重试
                    </Button>
                  ) : null}
                </div>
              </div>
            ) : null}
          </div>
        </aside>

        {/* 右侧文件预览主区域 */}
        <div className="flex flex-1 min-h-0 min-w-0 flex-col overflow-hidden bg-background">
          <div className="flex h-12 shrink-0 items-center gap-2 bg-muted/40 px-4">
            <Button
              size="icon-sm"
              variant="ghost"
              className="-ml-1"
              title={directoryOpen ? "收起资料目录" : "展开资料目录"}
              onClick={() => setDirectoryOpen(!directoryOpen)}
            >
              <PanelLeftIcon />
            </Button>
            <Separator orientation="vertical" className="mx-1 h-4" />
            <p className="min-w-0 flex-1 truncate text-sm font-medium">
              <span className="flex min-w-0 items-center gap-2">
                {selected ? (
                  <FileTypeIcon mediaType={selected.mediaType} name={selected.filename} />
                ) : null}
                <span className="truncate">{selected?.filename ?? "文件预览"}</span>
              </span>
            </p>
            {selected ? <Badge variant="outline">{statusLabel(selected.status)}</Badge> : null}
            {selected ? (
              <a
                className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                download={selected.filename}
                href={libraryAssetContentUrl(selected.id, user.id)}
                onClick={(event) =>
                  void downloadLibraryAsset(
                    event,
                    libraryAssetContentUrl(selected.id, user.id),
                    selected.filename,
                  )
                }
                title="下载文件"
              >
                <DownloadIcon className="size-4" />
              </a>
            ) : null}
          </div>
          {selected?.status === "error" ? (
            <div className="flex min-w-0 shrink-0 items-center gap-2 bg-destructive/5 px-4 py-2 text-xs">
              <span
                className="min-w-0 flex-1 truncate text-destructive"
                title={selected.indexError ?? undefined}
              >
                {selected.indexStage ? `${indexStageLabel(selected.indexStage)}失败` : "索引失败"}
                {selected.indexError ? `：${selected.indexError}` : ""}
              </span>
              <Button
                size="sm"
                variant="outline"
                className="shrink-0"
                disabled={reindexingIds.has(selected.id)}
                onClick={() => void reindexOne(selected)}
              >
                <RefreshCwIcon className={cn(reindexingIds.has(selected.id) && "animate-spin")} />
                重试
              </Button>
            </div>
          ) : null}
          <div className="min-h-0 flex-1 overflow-hidden bg-muted/20">
            {selected ? (
              <React.Suspense
                fallback={
                  <div className="flex size-full items-center justify-center gap-2 text-sm text-muted-foreground">
                    <Dotm3x3_1 size={14} dotSize={2.2} colorPreset="solid-theme" />
                    正在加载预览器
                  </div>
                }
              >
                <LibraryFilePreview
                  asset={{
                    ...selected,
                    url: libraryAssetContentUrl(selected.id, user.id),
                  }}
                />
              </React.Suspense>
            ) : (
              <div className="flex size-full flex-col items-center justify-center gap-2 text-muted-foreground">
                <FileTypeIcon className="size-8" name="" />
                <p className="text-sm">选择一个文件进行预览</p>
              </div>
            )}
          </div>
        </div>
      </div>

      <Dialog open={folderDialog} onOpenChange={setFolderDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>新建文件夹</DialogTitle>
            <DialogDescription>
              {folderParentId
                ? "将在当前文件夹中创建子文件夹。"
                : "用文件夹组织长期资料；会话附件会另外按线程自动归类。"}
            </DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            value={folderName}
            onChange={(event) => setFolderName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void createFolder();
            }}
            placeholder="文件夹名称"
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setFolderDialog(false)}>
              取消
            </Button>
            <Button onClick={() => void createFolder()}>创建</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(renameTarget)}
        onOpenChange={(open) => {
          if (!open) setRenameTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {renameTarget?.kind === "folder" ? "重命名文件夹" : "重命名文件"}
            </DialogTitle>
            <DialogDescription>名称只影响资料库显示，不会改变已保存的文件内容。</DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            value={renameValue}
            onChange={(event) => setRenameValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void saveRename();
            }}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameTarget(null)}>
              取消
            </Button>
            <Button onClick={() => void saveRename()}>保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={settingsOpen} onOpenChange={onSettingsOpenChange}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>资料库设置</DialogTitle>
            <DialogDescription>
              使用本机 FastEmbed Small(384 维)。向量与原文件都保存在当前 LibSQL 存储目录。
            </DialogDescription>
          </DialogHeader>
          <ScrollArea className="min-h-0 max-h-[min(32rem,calc(100svh-12rem))] pr-3">
            <div className="grid gap-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5 text-sm">
                  <span>分块策略</span>
                  <Select
                    value={settings.chunkStrategy}
                    onValueChange={(value) =>
                      setSettings((current) => ({
                        ...current,
                        chunkStrategy: value as LibrarySettings["chunkStrategy"],
                      }))
                    }
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {[
                        "recursive",
                        "character",
                        "token",
                        "markdown",
                        "html",
                        "json",
                        "latex",
                        "sentence",
                        "semantic-markdown",
                      ].map((strategy) => (
                        <SelectItem key={strategy} value={strategy}>
                          {strategy}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5 text-sm">
                  <span>分块大小</span>
                  <Input
                    type="number"
                    min={300}
                    max={4000}
                    value={settings.chunkSize}
                    onChange={(event) =>
                      setSettings((current) => ({
                        ...current,
                        chunkSize: Number(event.target.value),
                      }))
                    }
                  />
                </div>
                <div className="space-y-1.5 text-sm">
                  <span>重叠字符数</span>
                  <Input
                    type="number"
                    min={0}
                    max={800}
                    value={settings.chunkOverlap}
                    onChange={(event) =>
                      setSettings((current) => ({
                        ...current,
                        chunkOverlap: Number(event.target.value),
                      }))
                    }
                  />
                </div>
                <div className="space-y-1.5 text-sm">
                  <span>召回数量</span>
                  <Input
                    type="number"
                    min={1}
                    max={30}
                    value={settings.topK}
                    onChange={(event) =>
                      setSettings((current) => ({ ...current, topK: Number(event.target.value) }))
                    }
                  />
                </div>
                <div className="space-y-1.5 text-sm">
                  <span>最低相似度</span>
                  <Input
                    type="number"
                    min={0}
                    max={1}
                    step={0.05}
                    value={settings.minScore}
                    onChange={(event) =>
                      setSettings((current) => ({
                        ...current,
                        minScore: Number(event.target.value),
                      }))
                    }
                  />
                </div>
              </div>
              <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
                <span>
                  <span className="block text-sm font-medium">Graph RAG</span>
                  <span className="block text-xs text-muted-foreground">
                    为相关分块建立关联图并扩展检索结果
                  </span>
                </span>
                <Switch
                  checked={settings.graphRag}
                  onCheckedChange={(checked) =>
                    setSettings((current) => ({ ...current, graphRag: checked }))
                  }
                />
              </div>
              {settings.graphRag ? (
                <div className="grid grid-cols-3 gap-3">
                  <div className="space-y-1.5 text-sm">
                    <span>图阈值</span>
                    <Input
                      type="number"
                      min={0.4}
                      max={0.9}
                      step={0.05}
                      value={settings.graphThreshold}
                      onChange={(event) =>
                        setSettings((current) => ({
                          ...current,
                          graphThreshold: Number(event.target.value),
                        }))
                      }
                    />
                  </div>
                  <div className="space-y-1.5 text-sm">
                    <span>随机游走步数</span>
                    <Input
                      type="number"
                      min={10}
                      max={500}
                      value={settings.graphRandomWalkSteps}
                      onChange={(event) =>
                        setSettings((current) => ({
                          ...current,
                          graphRandomWalkSteps: Number(event.target.value),
                        }))
                      }
                    />
                  </div>
                  <div className="space-y-1.5 text-sm">
                    <span>重启概率</span>
                    <Input
                      type="number"
                      min={0.01}
                      max={0.9}
                      step={0.01}
                      value={settings.graphRestartProb}
                      onChange={(event) =>
                        setSettings((current) => ({
                          ...current,
                          graphRestartProb: Number(event.target.value),
                        }))
                      }
                    />
                  </div>
                </div>
              ) : null}
              <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
                <span>
                  <span className="block text-sm font-medium">模型重排</span>
                  <span className="block text-xs text-muted-foreground">
                    当前请求模型可直接调用时，对向量召回结果进行语义重排，会增加一次模型调用
                  </span>
                </span>
                <Switch
                  checked={settings.rerank}
                  onCheckedChange={(checked) =>
                    setSettings((current) => ({ ...current, rerank: checked }))
                  }
                />
              </div>
              {settings.rerank ? (
                <div className="grid grid-cols-3 gap-3">
                  <div className="col-span-3 space-y-1.5 text-sm">
                    <span>重排评分器</span>
                    <Select
                      value={settings.rerankScorer}
                      onValueChange={(value) =>
                        setSettings((current) => ({
                          ...current,
                          rerankScorer: value as LibrarySettings["rerankScorer"],
                        }))
                      }
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="model">Mastra rerank</SelectItem>
                        <SelectItem value="mastra-agent">MastraAgentRelevanceScorer</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5 text-sm">
                    <span>语义权重</span>
                    <Input
                      type="number"
                      min={0}
                      max={1}
                      step={0.05}
                      value={settings.rerankSemanticWeight}
                      onChange={(event) =>
                        setSettings((current) => ({
                          ...current,
                          rerankSemanticWeight: Number(event.target.value),
                        }))
                      }
                    />
                  </div>
                  <div className="space-y-1.5 text-sm">
                    <span>向量权重</span>
                    <Input
                      type="number"
                      min={0}
                      max={1}
                      step={0.05}
                      value={settings.rerankVectorWeight}
                      onChange={(event) =>
                        setSettings((current) => ({
                          ...current,
                          rerankVectorWeight: Number(event.target.value),
                        }))
                      }
                    />
                  </div>
                  <div className="space-y-1.5 text-sm">
                    <span>位置权重</span>
                    <Input
                      type="number"
                      min={0}
                      max={1}
                      step={0.05}
                      value={settings.rerankPositionWeight}
                      onChange={(event) =>
                        setSettings((current) => ({
                          ...current,
                          rerankPositionWeight: Number(event.target.value),
                        }))
                      }
                    />
                  </div>
                </div>
              ) : null}
              <div className="rounded-lg border p-3">
                <p className="text-sm font-medium">元数据抽取</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  索引时使用当前选定模型生成可检索的标题、摘要、问题与关键词。
                </p>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <div className="flex items-center gap-2 text-sm">
                    <Switch
                      checked={settings.extractTitle}
                      onCheckedChange={(checked) =>
                        setSettings((current) => ({ ...current, extractTitle: checked }))
                      }
                    />
                    标题
                  </div>
                  <div className="flex items-center gap-2 text-sm">
                    <Switch
                      checked={settings.extractSummary}
                      onCheckedChange={(checked) =>
                        setSettings((current) => ({ ...current, extractSummary: checked }))
                      }
                    />
                    摘要
                  </div>
                  <div className="flex items-center gap-2 text-sm">
                    <Switch
                      checked={settings.extractQuestions}
                      onCheckedChange={(checked) =>
                        setSettings((current) => ({ ...current, extractQuestions: checked }))
                      }
                    />
                    问题
                  </div>
                  <div className="flex items-center gap-2 text-sm">
                    <Switch
                      checked={settings.extractKeywords}
                      onCheckedChange={(checked) =>
                        setSettings((current) => ({ ...current, extractKeywords: checked }))
                      }
                    />
                    关键词
                  </div>
                </div>
              </div>
            </div>
          </ScrollArea>
          <DialogFooter className="shrink-0">
            <Button variant="outline" onClick={() => onSettingsOpenChange(false)}>
              取消
            </Button>
            <Button onClick={() => void saveSettings()}>保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <CommandDialog
        open={fileSearchOpen}
        onOpenChange={(open) => {
          setFileSearchOpen(open);
          if (!open) setFileSearchQuery("");
        }}
        title="搜索资料库文件"
        description="按文件名快速定位资料库中的文件"
        className="sm:max-w-xl"
      >
        <Command>
          <CommandInput
            autoFocus
            placeholder="搜索文件名…"
            value={fileSearchQuery}
            onValueChange={setFileSearchQuery}
          />
          <CommandList className="max-h-[min(60vh,32rem)]">
            {loading ? (
              <CommandEmpty>正在读取文件…</CommandEmpty>
            ) : assets.length === 0 ? (
              <CommandEmpty>资料库中还没有文件</CommandEmpty>
            ) : (
              <CommandGroup heading="文件">
                {assets.map((asset) => (
                  <CommandItem
                    key={asset.id}
                    value={`${asset.filename} ${asset.status}`}
                    onSelect={() => {
                      setSelectedId(asset.id);
                      setView("search");
                      setFolderId(null);
                      setQuery("");
                      setFileSearchOpen(false);
                    }}
                    className="h-auto py-2"
                  >
                    <FileTypeIcon mediaType={asset.mediaType} name={asset.filename} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">{asset.filename}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {formatBytes(asset.byteSize)} · {statusLabel(asset.status)}
                      </span>
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </CommandDialog>
    </>
  );
}

export { KnowledgeLibraryPage as KnowledgeLibrary };
