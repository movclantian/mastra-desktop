import { useNavigate, useRouterState } from "@tanstack/react-router";
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
import { useCreateThreadMutation } from "@/entities/workbench/model/queries/threads";
import { useWorkbenchStore } from "@/entities/workbench/model/workbench-store";
import { useAuth } from "@/features/auth";
import {
  type LibraryUploadTarget,
  useLibraryData,
  useLibraryUpload,
} from "@/features/library-upload";
import { isEditableTarget, isMacPlatform } from "@/shared/config/shortcut-menu";
import { i18n, useTranslation } from "@/shared/i18n";
import { cn, toastError } from "@/shared/lib";
import { FileTypeIcon, FolderTypeIcon } from "@/shared/ui/ai-elements/file-type-icon";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import {
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
  DialogClose,
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
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/shared/ui/field";
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
    toast.error(i18n.t("library:downloadFailed"));
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
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { user: authUser } = useAuth();
  const user = authUser ?? { id: "anonymous", name: "Guest", email: "guest@example.com" };
  const activeThreadId = useRouterState({
    select: (state) => (state.location.search as { thread?: string }).thread ?? null,
  });
  const createThreadMutation = useCreateThreadMutation(user?.id ?? "anonymous");
  const queueLibraryFiles = useWorkbenchStore((state) => state.queueLibraryFiles);
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
  const isMac = React.useMemo(() => isMacPlatform(), []);

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
          asset.hasLibraryReference ||
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
  const previewAsset = React.useMemo(() => {
    if (!selected) return null;
    return {
      ...selected,
      url: libraryAssetContentUrl(selected.id, user.id),
    };
  }, [selected, user.id]);
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
      toastError(error, t("library:createFolderFailed"));
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
    const docName = t("library:unnamedDoc");
    const tableName = t("library:unnamedTable");
    const file =
      kind === "document"
        ? new File([`# ${docName}\n\n`], `${docName}.md`, { type: "text/markdown" })
        : new File(["col1,col2\n\n"], `${tableName}.csv`, { type: "text/csv" });
    void uploadFiles([file], target);
  };

  const removeAsset = async (asset: LibraryAsset) => {
    try {
      await deleteLibraryAsset(asset.id, user.id);
      setSelectedId((current) => (current === asset.id ? null : current));
      setAssets((current) => current.filter((item) => item.id !== asset.id));
      toast.success(t("library:fileAndVectorDeleted"));
    } catch (error) {
      toastError(error, t("library:deleteFileFailed"));
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
      toastError(error, t("library:renameFailed"));
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
      toastError(error, t("library:deleteFolderFailed"));
    }
  };

  const openCreateFolder = (parentId: string | null) => {
    setFolderParentId(parentId);
    setFolderDialog(true);
  };

  const referenceInNewThread = async (asset: LibraryAsset) => {
    const thread = await createThreadMutation.mutateAsync();
    queueLibraryFiles([
      {
        type: "file",
        byteSize: asset.byteSize,
        filename: asset.filename,
        mediaType: asset.mediaType,
        url: libraryAssetContentUrl(asset.id, user.id),
      },
    ]);
    void navigate({ to: "/chat", search: { thread: thread.id } });
    toast.success(t("library:referenceInNewChatSuccess"));
  };

  const reindexOne = async (asset: LibraryAsset) => {
    setReindexingIds((current) => new Set(current).add(asset.id));
    try {
      await reindexLibraryAsset(asset.id, user.id);
      await refresh(true);
      window.setTimeout(() => void refresh(true), 1_000);
      toast.success(t("library:reindexingFile", { filename: asset.filename }));
    } catch (error) {
      toastError(error, t("library:reindexFailed"));
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
      toast.success(t("library:reindexingBatch", { count: assetIds.length }));
    } catch (error) {
      toastError(error, t("library:batchReindexFailed"));
    } finally {
      setBatchReindexing(false);
    }
  };

  const renderAssetRow = (asset: LibraryAsset, depth = 0, keyPrefix = "asset") => {
    return (
      <SidebarMenuItem key={`${keyPrefix}-${asset.id}`}>
        <ContextMenu>
          <ContextMenuTrigger
            className="w-full block"
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || isEditableTarget(event.target)) return;
              if (event.key === "F2") {
                event.preventDefault();
                openRename({ kind: "asset", id: asset.id, name: asset.filename });
              } else if (event.key === "Delete" || (isMac && event.key === "Backspace")) {
                event.preventDefault();
                void removeAsset(asset);
              }
            }}
          >
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
                      ? t("library:attemptNumber", { attempt: asset.indexAttempt })
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
                <span>{t("library:referenceInNewChat")}</span>
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
                  <span>{t("library:reindex")}</span>
                </ContextMenuItem>
              ) : null}
              <ContextMenuItem
                onClick={() => openRename({ kind: "asset", id: asset.id, name: asset.filename })}
              >
                <PencilIcon className="text-muted-foreground" />
                <span>{t("common:rename")}</span>
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
                <span>{t("library:downloadOriginal")}</span>
              </ContextMenuItem>
            </ContextMenuGroup>
            <ContextMenuSeparator />
            <ContextMenuGroup>
              <ContextMenuItem variant="destructive" onClick={() => void removeAsset(asset)}>
                <Trash2Icon className="text-muted-foreground" />
                <span>{t("library:deleteFile")}</span>
                <ContextMenuShortcut>{isMac ? "⌫" : "Del"}</ContextMenuShortcut>
              </ContextMenuItem>
            </ContextMenuGroup>
          </ContextMenuContent>
        </ContextMenu>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <SidebarMenuAction
                showOnHover
                title={t("library:fileActions")}
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
                <span>{t("library:reindex")}</span>
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem
              onClick={() => openRename({ kind: "asset", id: asset.id, name: asset.filename })}
            >
              <PencilIcon />
              <span>{t("common:rename")}</span>
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => void referenceInNewThread(asset)}>
              <ExternalLinkIcon />
              <span>{t("library:referenceInNewChat")}</span>
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
              <span>{t("library:downloadOriginal")}</span>
            </DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onClick={() => void removeAsset(asset)}>
              <Trash2Icon />
              <span>{t("library:deleteFile")}</span>
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
      toast.success(t("library:settingsSaved"));
    } catch {
      toast.error(t("library:saveSettingsFailed"));
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
            "group/sidebar group relative flex h-full min-h-0 flex-col border-r bg-sidebar transition-[width] duration-200 ease-linear overflow-hidden shrink-0",
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
                    tooltip={t("library:searchDocs")}
                  >
                    <SearchIcon />
                    <span className="group-data-[collapsible=icon]/sidebar:hidden">
                      {t("library:searchDocs")}
                    </span>
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
                    tooltip={t("library:sessionFiles")}
                  >
                    <HardDriveIcon />
                    <span className="group-data-[collapsible=icon]/sidebar:hidden">
                      {t("library:sessionFiles")}
                    </span>
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
                    tooltip={t("library:myDocuments")}
                  >
                    <FolderTypeIcon name="library" open={view === "documents"} />
                    <span className="group-data-[collapsible=icon]/sidebar:hidden">
                      {t("library:myDocuments")}
                    </span>
                  </SidebarMenuButton>
                  {failedAssetCount > 0 ? (
                    <SidebarMenuAction
                      showOnHover
                      onClick={() => void reindexFailed()}
                      title={t("library:reindexFailedFiles", { count: failedAssetCount })}
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
                    placeholder={t("library:filterPlaceholder")}
                  />
                </div>
              ) : null}
            </div>

            {/* Content 文件列表 */}
            <div className="min-h-0 flex-1 flex flex-col p-2 overflow-hidden">
              <div className="flex h-8 shrink-0 items-center justify-between px-1 text-xs font-medium text-sidebar-foreground/70">
                <span className="group-data-[collapsible=icon]/sidebar:hidden">
                  {view === "documents"
                    ? t("library:docDirectory")
                    : view === "session"
                      ? t("library:sessionAttachments")
                      : t("library:searchResults")}
                </span>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        className="size-5 rounded-md p-0 group-data-[collapsible=icon]/sidebar:mx-auto"
                        title={t("library:addDocTableFolder")}
                      >
                        <PlusIcon className="size-3.5" />
                      </Button>
                    }
                  />
                  <DropdownMenuContent align="end">
                    <DropdownMenuLabel className="max-w-64 whitespace-normal text-xs font-normal text-muted-foreground">
                      {t("library:uploadCapabilities")}
                    </DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem disabled={uploading} onClick={() => openUpload(uploadTarget)}>
                      {uploading ? (
                        <Dotm3x3_11 size={14} dotSize={2.2} colorPreset="solid-theme" />
                      ) : (
                        <UploadIcon />
                      )}
                      <span>{t("library:uploadFile")}</span>
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={uploading}
                      onClick={() => createBlankFile("document", uploadTarget)}
                    >
                      <FileTextIcon />
                      <span>{t("library:newMarkdownDoc")}</span>
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={uploading}
                      onClick={() => createBlankFile("spreadsheet", uploadTarget)}
                    >
                      <FileSpreadsheetIcon />
                      <span>{t("library:newCsvTable")}</span>
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={() => openCreateFolder(folderId)}>
                      <FolderPlusIcon />
                      <span>{t("library:newFolder")}</span>
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
                      {t("library:loading")}
                    </p>
                  ) : null}
                  {!loading && view !== "documents" && visibleAssets.length === 0 ? (
                    <p className="p-3 text-xs text-muted-foreground group-data-[collapsible=icon]/sidebar:hidden">
                      {view === "search"
                        ? t("library:noMatchingFiles")
                        : view === "session" && !activeThreadId
                          ? t("library:noActiveSession")
                          : t("library:emptyFiles")}
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
                                    ? t("library:expandFolder")
                                    : t("library:collapseFolder")
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
                                <ContextMenuTrigger
                                  className="min-w-0 flex-1"
                                  onKeyDown={(event) => {
                                    if (event.nativeEvent.isComposing || isEditableTarget(event.target)) return;
                                    if (event.key === "F2") {
                                      event.preventDefault();
                                      openRename({
                                        kind: "folder",
                                        id: entry.folder.id,
                                        name: entry.folder.name,
                                      });
                                    } else if (event.key === "Delete" || (isMac && event.key === "Backspace")) {
                                      event.preventDefault();
                                      void removeFolder(entry.folder);
                                    }
                                  }}
                                >
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
                                      <span>{t("library:uploadToFolder")}</span>
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
                                      <span>{t("library:newMarkdownDoc")}</span>
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
                                      <span>{t("library:newCsvTable")}</span>
                                    </ContextMenuItem>
                                    <ContextMenuItem
                                      onClick={() => openCreateFolder(entry.folder.id)}
                                    >
                                      <FolderPlusIcon className="text-muted-foreground" />
                                      <span>{t("library:newSubfolder")}</span>
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
                                      <span>{t("common:rename")}</span>
                                      <ContextMenuShortcut>F2</ContextMenuShortcut>
                                    </ContextMenuItem>
                                    <ContextMenuItem
                                      variant="destructive"
                                      onClick={() => void removeFolder(entry.folder)}
                                    >
                                      <Trash2Icon className="text-muted-foreground" />
                                      <span>{t("library:deleteFolder")}</span>
                                      <ContextMenuShortcut>{isMac ? "⌫" : "Del"}</ContextMenuShortcut>
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
                                    title={t("library:folderActions")}
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
                                  <span>{t("library:uploadToFolder")}</span>
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
                                  <span>{t("library:newMarkdownDoc")}</span>
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
                                  <span>{t("library:newCsvTable")}</span>
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={() => openCreateFolder(entry.folder.id)}>
                                  <FolderPlusIcon />
                                  <span>{t("library:newSubfolder")}</span>
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
                                  <span>{t("common:rename")}</span>
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  variant="destructive"
                                  onClick={() => void removeFolder(entry.folder)}
                                >
                                  <Trash2Icon />
                                  <span>{t("library:deleteFolder")}</span>
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
                      {t("library:emptyFiles")}
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
                      {uploadError
                        ? uploadError
                        : t("library:uploadingCount", { count: retryFiles.length })}
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
                      {t("library:cancelUpload")}
                    </Button>
                  ) : null}
                  {uploadError && !uploading ? (
                    <Button
                      className="w-full h-7 text-xs"
                      size="sm"
                      variant="outline"
                      onClick={retryUpload}
                    >
                      {t("library:retryFromBreakpoint")}
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
              title={directoryOpen ? t("library:collapseDir") : t("library:expandDir")}
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
                <span className="truncate">{selected?.filename ?? t("library:filePreview")}</span>
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
                title={t("library:downloadFile")}
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
                {selected.indexStage
                  ? t("library:stageFailed", { stage: indexStageLabel(selected.indexStage) })
                  : t("library:indexFailed")}
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
                {t("common:retry")}
              </Button>
            </div>
          ) : null}
          <div className="min-h-0 flex-1 overflow-hidden bg-muted/20">
            {previewAsset ? (
              <React.Suspense
                fallback={
                  <div className="flex size-full items-center justify-center gap-2 text-sm text-muted-foreground">
                    <Dotm3x3_1 size={14} dotSize={2.2} colorPreset="solid-theme" />
                    {t("library:loadingPreviewer")}
                  </div>
                }
              >
                <LibraryFilePreview asset={previewAsset} />
              </React.Suspense>
            ) : (
              <div className="flex size-full flex-col items-center justify-center gap-2 text-muted-foreground">
                <FileTypeIcon className="size-8" name="" />
                <p className="text-sm">{t("library:selectToPreview")}</p>
              </div>
            )}
          </div>
        </div>
      </div>

      <Dialog open={folderDialog} onOpenChange={setFolderDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("library:createFolder")}</DialogTitle>
            <DialogDescription>
              {folderParentId ? t("library:createSubfolderHint") : t("library:createFolderHint")}
            </DialogDescription>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor="create-folder-name" className="sr-only">
              {t("library:folderName")}
            </FieldLabel>
            <Input
              id="create-folder-name"
              autoFocus
              value={folderName}
              onChange={(event) => setFolderName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void createFolder();
              }}
              placeholder={t("library:folderName")}
            />
          </Field>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>{t("common:cancel")}</DialogClose>
            <Button onClick={() => void createFolder()}>{t("library:create")}</Button>
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
              {renameTarget?.kind === "folder"
                ? t("library:renameFolder")
                : t("library:renameFile")}
            </DialogTitle>
            <DialogDescription>{t("library:renameDesc")}</DialogDescription>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor="rename-target-name" className="sr-only">
              {t("library:newName")}
            </FieldLabel>
            <Input
              id="rename-target-name"
              autoFocus
              value={renameValue}
              onChange={(event) => setRenameValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void saveRename();
              }}
            />
          </Field>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>{t("common:cancel")}</DialogClose>
            <Button onClick={() => void saveRename()}>{t("common:save")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={settingsOpen} onOpenChange={onSettingsOpenChange}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("library:librarySettings")}</DialogTitle>
            <DialogDescription>{t("library:settingsDesc")}</DialogDescription>
          </DialogHeader>
          <ScrollArea className="min-h-0 max-h-[min(32rem,calc(100svh-12rem))] pr-3">
            <FieldGroup className="gap-4">
              <div className="grid grid-cols-2 gap-4">
                <Field>
                  <FieldLabel htmlFor="settings-chunk-strategy">
                    {t("library:chunkStrategy")}
                  </FieldLabel>
                  <Select
                    value={settings.chunkStrategy}
                    onValueChange={(value) =>
                      setSettings((current) => ({
                        ...current,
                        chunkStrategy: value as LibrarySettings["chunkStrategy"],
                      }))
                    }
                  >
                    <SelectTrigger id="settings-chunk-strategy" className="w-full">
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
                </Field>
                <Field>
                  <FieldLabel htmlFor="settings-chunk-size">{t("library:chunkSize")}</FieldLabel>
                  <Input
                    id="settings-chunk-size"
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
                </Field>
                <Field>
                  <FieldLabel htmlFor="settings-chunk-overlap">
                    {t("library:chunkOverlap")}
                  </FieldLabel>
                  <Input
                    id="settings-chunk-overlap"
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
                </Field>
                <Field>
                  <FieldLabel htmlFor="settings-top-k">{t("library:topK")}</FieldLabel>
                  <Input
                    id="settings-top-k"
                    type="number"
                    min={1}
                    max={30}
                    value={settings.topK}
                    onChange={(event) =>
                      setSettings((current) => ({ ...current, topK: Number(event.target.value) }))
                    }
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="settings-min-score">{t("library:minScore")}</FieldLabel>
                  <Input
                    id="settings-min-score"
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
                </Field>
              </div>
              <Field orientation="horizontal" className="justify-between rounded-lg border p-3">
                <FieldContent>
                  <FieldLabel htmlFor="settings-graph-rag" className="cursor-pointer font-medium">
                    Graph RAG
                  </FieldLabel>
                  <FieldDescription>{t("library:graphDesc")}</FieldDescription>
                </FieldContent>
                <Switch
                  id="settings-graph-rag"
                  checked={settings.graphRag}
                  onCheckedChange={(checked) =>
                    setSettings((current) => ({ ...current, graphRag: checked }))
                  }
                />
              </Field>
              {settings.graphRag ? (
                <div className="grid grid-cols-3 gap-3">
                  <Field>
                    <FieldLabel htmlFor="settings-graph-threshold">
                      {t("library:graphThreshold")}
                    </FieldLabel>
                    <Input
                      id="settings-graph-threshold"
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
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="settings-graph-walk-steps">
                      {t("library:walkSteps")}
                    </FieldLabel>
                    <Input
                      id="settings-graph-walk-steps"
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
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="settings-graph-restart-prob">
                      {t("library:restartProb")}
                    </FieldLabel>
                    <Input
                      id="settings-graph-restart-prob"
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
                  </Field>
                </div>
              ) : null}
              <Field orientation="horizontal" className="justify-between rounded-lg border p-3">
                <FieldContent>
                  <FieldLabel htmlFor="settings-rerank" className="cursor-pointer font-medium">
                    {t("library:modelRerank")}
                  </FieldLabel>
                  <FieldDescription>{t("library:rerankDesc")}</FieldDescription>
                </FieldContent>
                <Switch
                  id="settings-rerank"
                  checked={settings.rerank}
                  onCheckedChange={(checked) =>
                    setSettings((current) => ({ ...current, rerank: checked }))
                  }
                />
              </Field>
              {settings.rerank ? (
                <div className="grid grid-cols-3 gap-3">
                  <Field className="col-span-3">
                    <FieldLabel htmlFor="settings-rerank-scorer">
                      {t("library:rerankScorer")}
                    </FieldLabel>
                    <Select
                      value={settings.rerankScorer}
                      onValueChange={(value) =>
                        setSettings((current) => ({
                          ...current,
                          rerankScorer: value as LibrarySettings["rerankScorer"],
                        }))
                      }
                    >
                      <SelectTrigger id="settings-rerank-scorer" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="model">Mastra rerank</SelectItem>
                        <SelectItem value="mastra-agent">MastraAgentRelevanceScorer</SelectItem>
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="settings-rerank-semantic-weight">
                      {t("library:semanticWeight")}
                    </FieldLabel>
                    <Input
                      id="settings-rerank-semantic-weight"
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
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="settings-rerank-vector-weight">
                      {t("library:vectorWeight")}
                    </FieldLabel>
                    <Input
                      id="settings-rerank-vector-weight"
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
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="settings-rerank-position-weight">
                      {t("library:positionWeight")}
                    </FieldLabel>
                    <Input
                      id="settings-rerank-position-weight"
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
                  </Field>
                </div>
              ) : null}
              <FieldSet className="rounded-lg border p-3">
                <FieldLegend variant="label">{t("library:metadataExtraction")}</FieldLegend>
                <FieldDescription>{t("library:metadataDesc")}</FieldDescription>
                <div className="mt-1 grid grid-cols-2 gap-3">
                  <Field orientation="horizontal" className="items-center">
                    <Switch
                      id="settings-extract-title"
                      checked={settings.extractTitle}
                      onCheckedChange={(checked) =>
                        setSettings((current) => ({ ...current, extractTitle: checked }))
                      }
                    />
                    <FieldLabel htmlFor="settings-extract-title" className="cursor-pointer">
                      {t("library:metaTitle")}
                    </FieldLabel>
                  </Field>
                  <Field orientation="horizontal" className="items-center">
                    <Switch
                      id="settings-extract-summary"
                      checked={settings.extractSummary}
                      onCheckedChange={(checked) =>
                        setSettings((current) => ({ ...current, extractSummary: checked }))
                      }
                    />
                    <FieldLabel htmlFor="settings-extract-summary" className="cursor-pointer">
                      {t("library:metaSummary")}
                    </FieldLabel>
                  </Field>
                  <Field orientation="horizontal" className="items-center">
                    <Switch
                      id="settings-extract-questions"
                      checked={settings.extractQuestions}
                      onCheckedChange={(checked) =>
                        setSettings((current) => ({ ...current, extractQuestions: checked }))
                      }
                    />
                    <FieldLabel htmlFor="settings-extract-questions" className="cursor-pointer">
                      {t("library:metaQuestions")}
                    </FieldLabel>
                  </Field>
                  <Field orientation="horizontal" className="items-center">
                    <Switch
                      id="settings-extract-keywords"
                      checked={settings.extractKeywords}
                      onCheckedChange={(checked) =>
                        setSettings((current) => ({ ...current, extractKeywords: checked }))
                      }
                    />
                    <FieldLabel htmlFor="settings-extract-keywords" className="cursor-pointer">
                      {t("library:metaKeywords")}
                    </FieldLabel>
                  </Field>
                </div>
              </FieldSet>
            </FieldGroup>
          </ScrollArea>
          <DialogFooter className="shrink-0">
            <DialogClose render={<Button variant="outline" />}>{t("common:cancel")}</DialogClose>
            <Button onClick={() => void saveSettings()}>{t("common:save")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <CommandDialog
        open={fileSearchOpen}
        onOpenChange={(open) => {
          setFileSearchOpen(open);
          if (!open) setFileSearchQuery("");
        }}
        title={t("library:searchLibraryFiles")}
        description={t("library:searchLibraryDesc")}
        className="sm:max-w-xl"
      >
        <CommandInput
          autoFocus
          placeholder={t("library:searchPlaceholder")}
          value={fileSearchQuery}
          onValueChange={setFileSearchQuery}
        />
        <CommandList className="max-h-[min(60vh,32rem)]">
          {loading ? (
            <CommandEmpty>{t("library:readingFiles")}</CommandEmpty>
          ) : assets.length === 0 ? (
            <CommandEmpty>{t("library:noFilesInLibrary")}</CommandEmpty>
          ) : (
            <CommandGroup heading={t("library:filesGroup")}>
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
      </CommandDialog>
    </>
  );
}

export { KnowledgeLibraryPage as KnowledgeLibrary };
