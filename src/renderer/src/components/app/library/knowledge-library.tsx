import {
  ChevronDownIcon,
  DownloadIcon,
  ExternalLinkIcon,
  FileSpreadsheetIcon,
  FileTextIcon,
  FolderPenIcon,
  FolderPlusIcon,
  HardDriveIcon,
  LoaderCircleIcon,
  MoreVerticalIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  Trash2Icon,
  UploadIcon,
} from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { FileTypeIcon, FolderTypeIcon } from "@/components/ai-elements/file-type-icon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
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
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useIsMobile } from "@/hooks/use-mobile";
import { apiError, toastError } from "@/lib/errors";
import { MASTRA_SERVER_URL } from "@/lib/providers";
import { cn } from "@/lib/utils";
import { useWorkbench } from "@/lib/workbench";
import {
  DEFAULT_LIBRARY_SETTINGS,
  formatBytes,
  indexStageLabel,
  type LibraryAsset,
  type LibraryFolder,
  type LibrarySettings,
  type RenameTarget,
  statusLabel,
} from "./types";
import { type LibraryUploadTarget, useLibraryUpload } from "./hooks";

const LibraryFilePreview = React.lazy(() => import("./components/file-preview"));

type LibraryView = "documents" | "session" | "search";

type LibraryTreeEntry =
  | { kind: "folder"; folder: LibraryFolder; depth: number }
  | { kind: "asset"; asset: LibraryAsset; depth: number };

interface KnowledgeLibraryProps {
  settingsOpen: boolean;
  onSettingsOpenChange: (open: boolean) => void;
}

export function KnowledgeLibrary({ settingsOpen, onSettingsOpenChange }: KnowledgeLibraryProps) {
  const { user, activeThreadId, createThread, queueLibraryFiles, setLibraryOpen, providers } =
    useWorkbench();
  const [assets, setAssets] = React.useState<LibraryAsset[]>([]);
  const [folders, setFolders] = React.useState<LibraryFolder[]>([]);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [folderId, setFolderId] = React.useState<string | null>(null);
  const [query, setQuery] = React.useState("");
  const [fileSearchOpen, setFileSearchOpen] = React.useState(false);
  const [fileSearchQuery, setFileSearchQuery] = React.useState("");
  const [view, setView] = React.useState<LibraryView>("documents");
  const [loading, setLoading] = React.useState(true);
  const [directoryOpen, setDirectoryOpen] = React.useState(true);
  const [collapsedFolderIds, setCollapsedFolderIds] = React.useState<Set<string>>(() => new Set());
  const [folderDialog, setFolderDialog] = React.useState(false);
  const [folderName, setFolderName] = React.useState("");
  const [folderParentId, setFolderParentId] = React.useState<string | null>(null);
  const [settings, setSettings] = React.useState(DEFAULT_LIBRARY_SETTINGS);
  const [renameTarget, setRenameTarget] = React.useState<RenameTarget | null>(null);
  const [renameValue, setRenameValue] = React.useState("");
  const [reindexingIds, setReindexingIds] = React.useState<Set<string>>(() => new Set());
  const [batchReindexing, setBatchReindexing] = React.useState(false);
  const isMobile = useIsMobile();

  const refresh = React.useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      try {
        const suffix = `resourceId=${encodeURIComponent(user.id)}`;
        const [assetResponse, folderResponse] = await Promise.all([
          fetch(`${MASTRA_SERVER_URL}/work/library/assets?${suffix}`),
          fetch(`${MASTRA_SERVER_URL}/work/library/folders?${suffix}`),
        ]);
        if (!assetResponse.ok || !folderResponse.ok) throw new Error("读取资料库失败");
        const assetPayload = (await assetResponse.json()) as { assets: LibraryAsset[] };
        const folderPayload = (await folderResponse.json()) as { folders: LibraryFolder[] };
        setAssets(assetPayload.assets);
        setFolders(folderPayload.folders);
        setSelectedId((current) =>
          current && assetPayload.assets.some((asset) => asset.id === current)
            ? current
            : (assetPayload.assets[0]?.id ?? null),
        );
      } catch (error) {
        toastError(error, "读取资料库失败");
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [user.id],
  );

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

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  React.useEffect(() => {
    if (!assets.some((asset) => asset.status === "indexing")) return;
    const timer = window.setTimeout(() => void refresh(true), 1_500);
    return () => window.clearTimeout(timer);
  }, [assets, refresh]);

  React.useEffect(() => {
    if (!settingsOpen) return;
    void fetch(`${MASTRA_SERVER_URL}/work/library/settings`)
      .then(async (response) => {
        if (!response.ok) throw new Error(String(response.status));
        return (await response.json()) as { settings: LibrarySettings };
      })
      .then((payload) => setSettings(payload.settings))
      .catch(() => toast.error("读取资料库设置失败"));
  }, [settingsOpen]);

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
  const providerEmbeddingOptions = React.useMemo(
    () =>
      providers.flatMap((provider) =>
        provider.enabledModels
          .filter((model) => Boolean(model.embedding))
          .map((model) => ({
            value: provider.registryId
              ? `${provider.registryId}/${model.id}`
              : `${provider.id}/${model.id}`,
            label: `${provider.name} / ${model.name}`,
          })),
      ),
    [providers],
  );

  const createFolder = async () => {
    if (!folderName.trim()) return;
    const response = await fetch(`${MASTRA_SERVER_URL}/work/library/folders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        resourceId: user.id,
        name: folderName.trim(),
        parentId: folderParentId ?? undefined,
      }),
    });
    if (!response.ok) {
      toast.error("创建文件夹失败");
      return;
    }
    setFolderDialog(false);
    setFolderName("");
    setFolderParentId(null);
    await refresh();
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
    const response = await fetch(
      `${MASTRA_SERVER_URL}/work/library/assets/${encodeURIComponent(asset.id)}?resourceId=${encodeURIComponent(user.id)}`,
      { method: "DELETE" },
    );
    if (!response.ok) {
      toast.error("删除文件失败");
      return;
    }
    setSelectedId((current) => (current === asset.id ? null : current));
    setAssets((current) => current.filter((item) => item.id !== asset.id));
    toast.success("文件及其向量索引已删除");
  };

  const openRename = (target: RenameTarget) => {
    setRenameTarget(target);
    setRenameValue(target.name);
  };

  const saveRename = async () => {
    if (!renameTarget || !renameValue.trim()) return;
    const endpoint =
      renameTarget.kind === "asset"
        ? `${MASTRA_SERVER_URL}/work/library/assets/${encodeURIComponent(renameTarget.id)}`
        : `${MASTRA_SERVER_URL}/work/library/folders/${encodeURIComponent(renameTarget.id)}`;
    const response = await fetch(endpoint, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        resourceId: user.id,
        ...(renameTarget.kind === "asset" ? { filename: renameValue } : { name: renameValue }),
      }),
    });
    if (!response.ok) {
      toast.error("重命名失败");
      return;
    }
    setRenameTarget(null);
    await refresh(true);
  };

  const removeFolder = async (folder: LibraryFolder) => {
    const response = await fetch(
      `${MASTRA_SERVER_URL}/work/library/folders/${encodeURIComponent(folder.id)}?resourceId=${encodeURIComponent(user.id)}`,
      { method: "DELETE" },
    );
    if (!response.ok) {
      toast.error("删除文件夹失败");
      return;
    }
    if (folderId === folder.id) setFolderId(null);
    setCollapsedFolderIds((current) => {
      const next = new Set(current);
      next.delete(folder.id);
      return next;
    });
    await refresh(true);
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
        url: `${MASTRA_SERVER_URL}/work/library/assets/${encodeURIComponent(asset.id)}/content?resourceId=${encodeURIComponent(user.id)}`,
      },
    ]);
    setLibraryOpen(false);
    toast.success("已在新会话中引用资料");
  };

  const reindexOne = async (asset: LibraryAsset) => {
    setReindexingIds((current) => new Set(current).add(asset.id));
    try {
      const response = await fetch(
        `${MASTRA_SERVER_URL}/work/library/assets/${encodeURIComponent(asset.id)}/reindex`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ resourceId: user.id }),
        },
      );
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw apiError(payload, "重新索引失败");
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
      const response = await fetch(`${MASTRA_SERVER_URL}/work/library/reindex-failed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resourceId: user.id }),
      });
      const payload = (await response.json()) as { assetIds?: string[]; error?: string };
      if (!response.ok) {
        toastError(payload, "批量重新索引失败");
        return;
      }
      await refresh(true);
      window.setTimeout(() => void refresh(true), 1_000);
      toast.success(`已重新开始 ${payload.assetIds?.length ?? 0} 个索引任务`);
    } catch (error) {
      toastError(error, "批量重新索引失败");
    } finally {
      setBatchReindexing(false);
    }
  };

  const renderAssetRow = (asset: LibraryAsset, depth = 0, keyPrefix = "asset") => {
    return (
      <div
        key={`${keyPrefix}-${asset.id}`}
        className={cn(
          "group flex min-w-0 items-center gap-1 rounded-md py-1.5 pr-1 hover:bg-accent",
          selectedId === asset.id && "bg-accent",
        )}
        style={{ paddingLeft: `${8 + depth * 16}px` }}
      >
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          onClick={() => setSelectedId(asset.id)}
        >
          <FileTypeIcon mediaType={asset.mediaType} name={asset.filename} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm">{asset.filename}</span>
            <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
              <span>{formatBytes(asset.byteSize)}</span>
              <span>·</span>
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
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost"
                className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                title="文件操作"
              />
            }
          >
            <MoreVerticalIcon />
          </DropdownMenuTrigger>
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
                  href={`${MASTRA_SERVER_URL}/work/library/assets/${encodeURIComponent(asset.id)}/content?resourceId=${encodeURIComponent(user.id)}`}
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
      </div>
    );
  };

  const saveSettings = async () => {
    const response = await fetch(`${MASTRA_SERVER_URL}/work/library/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settings),
    });
    if (!response.ok) {
      toast.error("保存资料库设置失败");
      return;
    }
    const payload = (await response.json()) as { settings: LibrarySettings };
    setSettings(payload.settings);
    onSettingsOpenChange(false);
    toast.success("资料库设置已保存");
  };

  return (
    <div className="flex size-full min-h-0 min-w-0 overflow-hidden">
      <ResizablePanelGroup
        className="min-h-0 min-w-0 flex-1"
        orientation={isMobile ? "vertical" : "horizontal"}
      >
        {directoryOpen ? (
          <>
            <ResizablePanel
              className="min-h-0 min-w-0"
              defaultSize="28%"
              minSize="22%"
              maxSize="44%"
            >
              <aside className="flex size-full min-h-0 min-w-0 flex-col bg-sidebar/95">
                {/* 标题「资料库」由应用顶栏显示;设置/目录开关已合并到右侧预览栏头部 */}
                <div className="shrink-0 space-y-1 bg-sidebar-accent/25 px-2 py-2">
                  <button
                    type="button"
                    className={cn(
                      "flex h-9 w-full items-center gap-3 rounded-md px-3 text-sm transition-colors hover:bg-sidebar-accent",
                      view === "search" && "bg-sidebar-accent font-medium",
                    )}
                    onClick={() => {
                      setFileSearchOpen(true);
                    }}
                  >
                    <SearchIcon className="size-4 text-muted-foreground" />
                    <span>搜索</span>
                  </button>
                  <button
                    type="button"
                    className={cn(
                      "flex h-9 w-full items-center gap-3 rounded-md px-3 text-sm transition-colors hover:bg-sidebar-accent",
                      view === "session" && "bg-sidebar-accent font-medium",
                    )}
                    onClick={() => {
                      setView("session");
                      setFolderId(null);
                      setQuery("");
                    }}
                  >
                    <HardDriveIcon className="size-4 text-muted-foreground" />
                    <span>会话文件</span>
                    <span className="ml-auto text-xs tabular-nums text-muted-foreground">
                      {sessionAssetCount}
                    </span>
                  </button>
                  {view === "search" ? (
                    <div className="relative px-1 pt-1">
                      <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        autoFocus
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        className="h-9 bg-background pl-9"
                        placeholder="搜索文件名"
                      />
                    </div>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-2 bg-sidebar-accent/15 px-3 py-3">
                  <button
                    type="button"
                    className={cn(
                      "flex min-w-0 flex-1 items-center gap-2 text-left text-sm font-medium",
                      view === "documents" ? "text-foreground" : "text-muted-foreground",
                    )}
                    onClick={() => {
                      setView("documents");
                      setQuery("");
                    }}
                  >
                    <FolderTypeIcon name="资料库" open={view === "documents"} />
                    <span className="truncate">我的文档</span>
                  </button>
                  {failedAssetCount > 0 ? (
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      className="shrink-0 text-destructive hover:text-destructive"
                      disabled={batchReindexing}
                      aria-label={`重新索引 ${failedAssetCount} 个失败文件`}
                      title={`重新索引 ${failedAssetCount} 个失败文件`}
                      onClick={() => void reindexFailed()}
                    >
                      <RefreshCwIcon className={cn(batchReindexing && "animate-spin")} />
                    </Button>
                  ) : null}
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          className="shrink-0"
                          title="添加文档、表格或文件夹"
                        />
                      }
                    >
                      <PlusIcon />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        disabled={uploading}
                        onClick={() => openUpload(uploadTarget)}
                      >
                        {uploading ? <LoaderCircleIcon className="animate-spin" /> : <UploadIcon />}
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
                {uploading || uploadError ? (
                  <div className="shrink-0 space-y-1.5 bg-background/40 p-3">
                    <div className="flex items-center justify-between gap-2 text-xs">
                      <span className="truncate">
                        {uploadError ? uploadError : `正在上传 ${retryFiles.length} 个文件`}
                      </span>
                      <span className="shrink-0 tabular-nums">{uploadProgress}%</span>
                    </div>
                    <Progress value={uploadProgress} />
                    {uploading ? (
                      <Button
                        className="w-full"
                        size="sm"
                        variant="ghost"
                        onClick={() => void cancelUpload()}
                      >
                        取消上传
                      </Button>
                    ) : null}
                    {uploadError && !uploading ? (
                      <Button className="w-full" size="sm" variant="outline" onClick={retryUpload}>
                        从断点重试
                      </Button>
                    ) : null}
                  </div>
                ) : null}
                <ScrollArea className="min-h-0 flex-1">
                  <div className="space-y-1 p-1">
                    {loading ? (
                      <p className="p-3 text-sm text-muted-foreground">正在读取…</p>
                    ) : null}
                    {!loading && view !== "documents" && visibleAssets.length === 0 ? (
                      <p className="p-3 text-sm text-muted-foreground">
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
                            <div
                              key={`folder-${entry.folder.id}`}
                              className="group/folder flex min-w-0 items-center gap-1"
                            >
                              <Button
                                size="icon-xs"
                                variant="ghost"
                                className="shrink-0"
                                style={{ marginLeft: `${entry.depth * 16}px` }}
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
                                    "size-3.5 transition-transform",
                                    collapsedFolderIds.has(entry.folder.id) && "-rotate-90",
                                  )}
                                />
                              </Button>
                              <button
                                type="button"
                                className={cn(
                                  "flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-sidebar-accent",
                                  folderId === entry.folder.id && "bg-sidebar-accent font-medium",
                                )}
                                onClick={() => setFolderId(entry.folder.id)}
                              >
                                <FolderTypeIcon
                                  name={entry.folder.name}
                                  open={!collapsedFolderIds.has(entry.folder.id)}
                                />
                                <span className="truncate">{entry.folder.name}</span>
                              </button>
                              <DropdownMenu>
                                <DropdownMenuTrigger
                                  render={
                                    <Button
                                      size="icon-xs"
                                      variant="ghost"
                                      className="mr-1 opacity-0 group-hover/folder:opacity-100 focus-visible:opacity-100"
                                      title="文件夹操作"
                                    />
                                  }
                                >
                                  <MoreVerticalIcon />
                                </DropdownMenuTrigger>
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
                                  <DropdownMenuItem
                                    onClick={() => openCreateFolder(entry.folder.id)}
                                  >
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
                            </div>
                          ) : (
                            renderAssetRow(entry.asset, entry.depth, "tree")
                          ),
                        )
                      : null}
                    {!loading && view === "documents" && visibleAssets.length === 0 ? (
                      <p className="p-3 text-sm text-muted-foreground">这里还没有文件</p>
                    ) : null}
                    {!loading && view !== "documents"
                      ? visibleAssets.map((asset) => renderAssetRow(asset, 0, view))
                      : null}
                  </div>
                </ScrollArea>
              </aside>
            </ResizablePanel>
            <ResizableHandle withHandle />
          </>
        ) : null}

        <ResizablePanel
          className="min-h-0 min-w-0"
          defaultSize={directoryOpen ? "76%" : "100%"}
          minSize="40%"
        >
          <div className="flex size-full min-h-0 min-w-0 flex-col">
            {/* 预览栏只负责目录开关、文件状态和文件操作;资料库设置位于应用顶栏右上角 */}
            <div className="flex h-12 shrink-0 items-center gap-2 bg-muted/40 px-4">
              <Button
                size="icon-sm"
                variant="ghost"
                title={directoryOpen ? "收起资料目录" : "展开资料目录"}
                onClick={() => setDirectoryOpen(!directoryOpen)}
              >
                {directoryOpen ? <PanelLeftCloseIcon /> : <PanelLeftOpenIcon />}
              </Button>
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
                  href={`${MASTRA_SERVER_URL}/work/library/assets/${encodeURIComponent(selected.id)}/content?resourceId=${encodeURIComponent(user.id)}`}
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
                    <div className="flex size-full items-center justify-center text-sm text-muted-foreground">
                      <LoaderCircleIcon className="mr-2 size-4 animate-spin" />
                      正在加载预览器
                    </div>
                  }
                >
                  <LibraryFilePreview
                    asset={{
                      ...selected,
                      url: `${MASTRA_SERVER_URL}/work/library/assets/${encodeURIComponent(selected.id)}/content?resourceId=${encodeURIComponent(user.id)}`,
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
        </ResizablePanel>
      </ResizablePanelGroup>

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
              默认使用本机 FastEmbed；也可选择模型供应商中启用的 embedding
              模型。向量与原文件都保存在当前 LibSQL 存储目录。
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
                  <span>嵌入模型</span>
                  <Select
                    value={settings.embeddingModel}
                    onValueChange={(value) =>
                      setSettings((current) => ({
                        ...current,
                        embeddingModel: value as LibrarySettings["embeddingModel"],
                      }))
                    }
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="small">FastEmbed Small · 384 维</SelectItem>
                      <SelectItem value="base">FastEmbed Base · 768 维</SelectItem>
                      {providerEmbeddingOptions.length > 0 ? (
                        <>
                          <SelectItem value="__separator" disabled>
                            供应商嵌入模型
                          </SelectItem>
                          {providerEmbeddingOptions.map((option) => (
                            <SelectItem key={option.value} value={option.value}>
                              {option.label}
                            </SelectItem>
                          ))}
                        </>
                      ) : null}
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
    </div>
  );
}
