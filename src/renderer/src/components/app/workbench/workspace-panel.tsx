import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { basicSetup } from "codemirror";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  BotIcon,
  CopyIcon,
  ExternalLinkIcon,
  FileCode2Icon,
  FilePlus2Icon,
  FolderPlusIcon,
  FolderTreeIcon,
  Globe2Icon,
  ListTodoIcon,
  LoaderCircleIcon,
  MoreHorizontalIcon,
  PlayIcon,
  PlusIcon,
  RefreshCwIcon,
  SaveIcon,
  SquareIcon,
  TerminalIcon,
  XIcon,
} from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { FileTree, FileTreeFile, FileTreeFolder } from "@/components/ai-elements/file-tree";
import { FileTypeIcon, FolderTypeIcon } from "@/components/ai-elements/file-type-icon";
import {
  WebPreview,
  WebPreviewNavigation,
  WebPreviewNavigationButton,
  WebPreviewUrl,
} from "@/components/ai-elements/web-preview";
import { PanelHeader, PanelSurface } from "@/components/app/primitives";
import { Button } from "@/components/ui/button";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import { toastError } from "@/lib/errors";
import { MASTRA_SERVER_URL } from "@/lib/providers";
import { cn } from "@/lib/utils";
import { reportWorkbenchState, type TreeEntry, useWorkbench } from "@/lib/workbench";
import { TerminalSession } from "./terminal-panel";

const NEW_BROWSER_TAB_URL = "https://www.bing.com";

function editorExtension(path: string) {
  const lower = path.toLowerCase();
  if (/\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts)$/.test(lower)) {
    return javascript({
      jsx: /x$/.test(lower),
      typescript: /\.(?:ts|tsx|mts|cts)$/.test(lower),
    });
  }
  if (/\.py$/.test(lower)) return python();
  if (/\.(?:json|jsonc)$/.test(lower)) return json();
  if (/\.(?:md|mdx)$/.test(lower)) return markdown();
  if (/\.(?:html|htm)$/.test(lower)) return html();
  if (/\.css$/.test(lower)) return css();
  return [];
}

function CodeEditor({
  path,
  value,
  onChange,
  onSave,
}: {
  path: string;
  value: string;
  onChange: (value: string) => void;
  onSave: () => void;
}) {
  const hostRef = React.useRef<HTMLDivElement>(null);
  const viewRef = React.useRef<EditorView | null>(null);
  const onChangeRef = React.useRef(onChange);
  const onSaveRef = React.useRef(onSave);
  onChangeRef.current = onChange;
  onSaveRef.current = onSave;

  // CodeMirror is initialized once per file path; the following effect applies later value changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: Recreating the editor on every value change loses focus and selection.
  React.useLayoutEffect(() => {
    if (!hostRef.current) return;
    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          basicSetup,
          editorExtension(path),
          EditorState.tabSize.of(2),
          EditorView.lineWrapping,
          keymap.of([
            {
              key: "Mod-s",
              preventDefault: true,
              run: () => {
                onSaveRef.current();
                return true;
              },
            },
          ]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) onChangeRef.current(update.state.doc.toString());
          }),
          EditorView.theme({
            "&": {
              height: "100%",
              backgroundColor: "transparent",
              fontSize: "13px",
            },
            ".cm-scroller": {
              overflow: "auto",
              fontFamily: "var(--font-mono)",
            },
            ".cm-gutters": {
              backgroundColor: "transparent",
              borderRight: "1px solid var(--border)",
            },
            ".cm-activeLine, .cm-activeLineGutter": {
              backgroundColor: "color-mix(in oklab, var(--muted) 55%, transparent)",
            },
            ".cm-content": { caretColor: "var(--foreground)" },
          }),
        ],
      }),
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [path]);

  React.useEffect(() => {
    const view = viewRef.current;
    if (!view || view.state.doc.toString() === value) return;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
    });
  }, [value]);

  return <div className="size-full overflow-hidden" ref={hostRef} />;
}

const RUNNABLE_FILE = /\.(?:[cm]?js|[cm]?ts|py|ps1|sh)$/i;

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
      <Input
        className="h-6 min-w-0 flex-1 border-0 bg-transparent px-1 py-0.5 text-xs outline-none ring-1 ring-ring/50 focus-visible:ring-1"
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

function TreeRows({
  entries,
  childrenByPath,
  onSelectFile,
  onCreateInDirectory,
  creating,
  createName,
  onCreateNameChange,
  onSubmitCreate,
  onCancelCreate,
  onRunFile,
  workspacePath,
}: {
  entries: TreeEntry[];
  childrenByPath: Record<string, TreeEntry[]>;
  onSelectFile?: (path: string) => void;
  onCreateInDirectory?: (path: string, kind: "file" | "dir") => void;
  creating?: { parent: string; kind: "file" | "dir" };
  createName?: string;
  onCreateNameChange?: (value: string) => void;
  onSubmitCreate?: () => void;
  onCancelCreate?: () => void;
  onRunFile?: (path: string) => void;
  workspacePath?: string;
}) {
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
                onCancel={onCancelCreate ?? (() => undefined)}
                onChange={onCreateNameChange ?? (() => undefined)}
                onSubmit={onSubmitCreate ?? (() => undefined)}
                value={createName ?? ""}
              />
            ) : null}
            <TreeRows
              entries={childrenByPath[entry.path] ?? []}
              childrenByPath={childrenByPath}
              createName={createName}
              creating={creating}
              onCancelCreate={onCancelCreate}
              onCreateNameChange={onCreateNameChange}
              onSelectFile={onSelectFile}
              onCreateInDirectory={onCreateInDirectory}
              onRunFile={onRunFile}
              onSubmitCreate={onSubmitCreate}
              workspacePath={workspacePath}
            />
          </FileTreeFolder>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-48">
          <ContextMenuGroup>
            <ContextMenuLabel className="truncate max-w-44">{entry.name}</ContextMenuLabel>
            <ContextMenuItem onClick={() => onCreateInDirectory?.(entry.path, "file")}>
              <FilePlus2Icon className="text-muted-foreground" />
              <span>新建文件</span>
            </ContextMenuItem>
            <ContextMenuItem onClick={() => onCreateInDirectory?.(entry.path, "dir")}>
              <FolderPlusIcon className="text-muted-foreground" />
              <span>新建子文件夹</span>
            </ContextMenuItem>
          </ContextMenuGroup>
          <ContextMenuSeparator />
          <ContextMenuGroup>
            <ContextMenuItem
              onClick={() => {
                void navigator.clipboard.writeText(entry.path);
                toast.success("已复制相对路径");
              }}
            >
              <CopyIcon className="text-muted-foreground" />
              <span>复制相对路径</span>
            </ContextMenuItem>
            {workspacePath ? (
              <ContextMenuItem
                onClick={() => {
                  const full = `${workspacePath}/${entry.path}`.replace(/\\/g, "/");
                  void navigator.clipboard.writeText(full);
                  toast.success("已复制完整路径");
                }}
              >
                <CopyIcon className="text-muted-foreground" />
                <span>复制完整路径</span>
              </ContextMenuItem>
            ) : null}
          </ContextMenuGroup>
        </ContextMenuContent>
      </ContextMenu>
    ) : (
      <ContextMenu key={entry.path}>
        <ContextMenuTrigger className="w-full block">
          <FileTreeFile
            className={cn(entry.hidden && "opacity-65")}
            icon={<FileTypeIcon name={entry.name} />}
            name={entry.name}
            path={entry.path}
          />
        </ContextMenuTrigger>
        <ContextMenuContent className="w-48">
          <ContextMenuGroup>
            <ContextMenuLabel className="truncate max-w-44">{entry.name}</ContextMenuLabel>
            <ContextMenuItem onClick={() => onSelectFile?.(entry.path)}>
              <FileCode2Icon className="text-muted-foreground" />
              <span>在编辑器打开</span>
            </ContextMenuItem>
            {RUNNABLE_FILE.test(entry.path) ? (
              <ContextMenuItem onClick={() => onRunFile?.(entry.path)}>
                <PlayIcon className="text-muted-foreground" />
                <span>运行此文件</span>
              </ContextMenuItem>
            ) : null}
          </ContextMenuGroup>
          <ContextMenuSeparator />
          <ContextMenuGroup>
            <ContextMenuItem
              onClick={() => {
                void navigator.clipboard.writeText(entry.path);
                toast.success("已复制相对路径");
              }}
            >
              <CopyIcon className="text-muted-foreground" />
              <span>复制相对路径</span>
            </ContextMenuItem>
            {workspacePath ? (
              <ContextMenuItem
                onClick={() => {
                  const full = `${workspacePath}/${entry.path}`.replace(/\\/g, "/");
                  void navigator.clipboard.writeText(full);
                  toast.success("已复制完整路径");
                }}
              >
                <CopyIcon className="text-muted-foreground" />
                <span>复制完整路径</span>
              </ContextMenuItem>
            ) : null}
          </ContextMenuGroup>
        </ContextMenuContent>
      </ContextMenu>
    ),
  );
}

/**
 * 文件树 + 编辑器。可多开 —— 每个标签一个独立实例,各自持有展开态与打开的文件。
 *
 * active:只有激活的那个实例上报 editor state lane。多实例同时上报会在同一条
 * lane 上互相覆盖,模型看到的「当前打开的文件」会在几个标签之间来回跳。
 */
function FilesWorkspace({ active }: { active: boolean }) {
  const { activeThreadId, fetchTreeEntries, requestTerminalCommand, threads, user } =
    useWorkbench();
  const activeThread = threads.find((thread) => thread.id === activeThreadId);
  const [entries, setEntries] = React.useState<TreeEntry[]>([]);
  const [childrenByPath, setChildrenByPath] = React.useState<Record<string, TreeEntry[]>>({});
  const [expanded, setExpanded] = React.useState(() => new Set<string>());
  const [selectedPath, setSelectedPath] = React.useState<string>();
  const [file, setFile] = React.useState<{
    path: string;
    name: string;
    content: string;
    size: number;
  }>();
  const [draft, setDraft] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [treeLoading, setTreeLoading] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [createKind, setCreateKind] = React.useState<"file" | "dir">();
  const [createName, setCreateName] = React.useState("");
  const loadedPathsRef = React.useRef(new Set<string>());
  const dirty = file ? draft !== file.content : false;

  const allEntries = React.useMemo(
    () => [entries, ...Object.values(childrenByPath)].flat(),
    [childrenByPath, entries],
  );

  const refreshTree = React.useCallback(async () => {
    if (!activeThreadId) return;
    setTreeLoading(true);
    loadedPathsRef.current = new Set();
    setEntries([]);
    setChildrenByPath({});
    setExpanded(new Set());
    setSelectedPath(undefined);
    try {
      setEntries(await fetchTreeEntries(activeThreadId));
    } finally {
      setTreeLoading(false);
    }
  }, [activeThreadId, fetchTreeEntries]);

  React.useEffect(() => {
    setSelectedPath(undefined);
    setFile(undefined);
    setDraft("");
    void refreshTree();
  }, [refreshTree]);

  // 编辑器状态 → editor state lane:模型据此知道用户正在看哪个文件、有没有
  // 未保存改动,不必再靠工具去猜(等价于 IDE 的 opened-file / selection 上下文)。
  // 只有激活实例上报 —— 见组件顶部关于 active 的说明。
  React.useEffect(() => {
    if (!active) return;
    reportWorkbenchState(activeThreadId, user.id, {
      editor: {
        ...(activeThread?.metadata.workspacePath
          ? { workspacePath: activeThread.metadata.workspacePath }
          : {}),
        ...(file?.path ? { openPath: file.path, dirty } : {}),
        ...(selectedPath ? { selectedPath } : {}),
      },
    });
  }, [
    active,
    activeThread?.metadata.workspacePath,
    activeThreadId,
    dirty,
    file?.path,
    selectedPath,
    user.id,
  ]);

  const loadDirectory = React.useCallback(
    (path: string) => {
      if (!activeThreadId || loadedPathsRef.current.has(path)) return;
      loadedPathsRef.current.add(path);
      void fetchTreeEntries(activeThreadId, path).then((next) =>
        setChildrenByPath((current) => ({ ...current, [path]: next })),
      );
    },
    [activeThreadId, fetchTreeEntries],
  );

  const handleExpandedChange = React.useCallback(
    (next: Set<string>) => {
      setExpanded(next);
      for (const path of next) loadDirectory(path);
    },
    [loadDirectory],
  );

  const selectFile = React.useCallback(
    (path: string) => {
      const selectedEntry = allEntries.find((entry) => entry.path === path);
      setSelectedPath(path);
      if (selectedEntry?.type === "dir") {
        setExpanded((current) => new Set(current).add(path));
        loadDirectory(path);
        return;
      }
      if (dirty && !window.confirm("当前文件有未保存更改，是否放弃并打开其他文件？")) return;
      if (!activeThreadId) return;
      setLoading(true);
      fetch(
        `${MASTRA_SERVER_URL}/work/threads/${activeThreadId}/file?resourceId=${encodeURIComponent(user.id)}&path=${encodeURIComponent(path)}`,
      )
        .then(async (response) => {
          const payload = (await response.json()) as {
            error?: string;
            path: string;
            name: string;
            content: string;
            size: number;
          };
          if (!response.ok) throw new Error(payload.error || "文件读取失败");
          setFile(payload);
          setDraft(payload.content);
        })
        .catch((error) => toastError(error, "文件读取失败"))
        .finally(() => setLoading(false));
    },
    [activeThreadId, allEntries, dirty, loadDirectory, user.id],
  );

  const createDirectory = React.useMemo(() => {
    if (!selectedPath) return "";
    const selectedEntry = allEntries.find((entry) => entry.path === selectedPath);
    if (selectedEntry?.type === "dir") return selectedEntry.path;
    return selectedPath.includes("/") ? selectedPath.slice(0, selectedPath.lastIndexOf("/")) : "";
  }, [allEntries, selectedPath]);

  const cancelCreate = React.useCallback(() => {
    setCreateKind(undefined);
    setCreateName("");
  }, []);

  const createEntry = React.useCallback(async () => {
    const name = createName.trim();
    if (!createKind || !activeThreadId) return;
    if (!name) {
      cancelCreate();
      return;
    }
    if (name.includes("/") || name.includes("\\")) {
      toast.error("名称不能包含路径分隔符");
      return;
    }
    const path = createDirectory ? `${createDirectory}/${name}` : name;
    try {
      const response = await fetch(
        `${MASTRA_SERVER_URL}/work/threads/${activeThreadId}/tree?resourceId=${encodeURIComponent(user.id)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path, type: createKind }),
        },
      );
      const payload = (await response.json()) as { error?: string; message?: string };
      if (!response.ok) throw new Error(payload.error || payload.message || "创建失败");
      toast.success(createKind === "dir" ? `已创建文件夹 ${name}` : `已创建文件 ${name}`);
      cancelCreate();
      await refreshTree();
      if (createDirectory) {
        const directoryParts = createDirectory.split("/");
        const directories = directoryParts.map((_, index) =>
          directoryParts.slice(0, index + 1).join("/"),
        );
        setExpanded(new Set(directories));
        for (const directory of directories) loadDirectory(directory);
      }
    } catch (error) {
      toastError(error, createKind === "dir" ? "新建文件夹失败" : "添加文件失败");
    }
  }, [
    activeThreadId,
    createDirectory,
    cancelCreate,
    createKind,
    createName,
    loadDirectory,
    refreshTree,
    user.id,
  ]);

  const saveFile = React.useCallback(async (): Promise<boolean> => {
    if (!activeThreadId || !file || !dirty || saving) return false;
    setSaving(true);
    try {
      const response = await fetch(
        `${MASTRA_SERVER_URL}/work/threads/${activeThreadId}/file?resourceId=${encodeURIComponent(user.id)}&path=${encodeURIComponent(file.path)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: draft }),
        },
      );
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error || "保存失败");
      setFile((current) => (current ? { ...current, content: draft } : current));
      toast.success(`已保存 ${file.name}`);
      return true;
    } catch (error) {
      toastError(error, "保存失败");
      return false;
    } finally {
      setSaving(false);
    }
  }, [activeThreadId, dirty, draft, file, saving, user.id]);

  const runFile = React.useCallback(async () => {
    if (!file || saving || !activeThreadId) return;
    if (dirty && !(await saveFile())) return;
    requestTerminalCommand({ filePath: file.path });
  }, [activeThreadId, dirty, file, requestTerminalCommand, saveFile, saving]);

  if (activeThread?.metadata.workspaceExplicit !== true) {
    const hasImplicitWorkspace = Boolean(activeThread?.metadata.workspacePath);
    return (
      <Empty className="h-full">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <FolderTreeIcon />
          </EmptyMedia>
          <EmptyTitle>
            {!activeThread
              ? "尚未选择会话"
              : hasImplicitWorkspace
                ? "当前为 Agent 默认工作区"
                : "未绑定可浏览工作区"}
          </EmptyTitle>
          <EmptyDescription>
            {!activeThread
              ? "选择或创建一个会话后,这里会显示它的工作区。"
              : hasImplicitWorkspace
                ? "当前会话使用默认工作目录,因此不展示可浏览文件树。"
                : "发送首条消息前,在输入框上方选择一个本地目录即可浏览和编辑文件。"}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <ResizablePanelGroup className="min-h-0" orientation="horizontal">
      <ResizablePanel defaultSize="72%" minSize="42%">
        <PanelSurface>
          <PanelHeader className="gap-2 px-3">
            {file ? (
              <FileTypeIcon name={file.name} />
            ) : (
              <FileCode2Icon className="size-4 text-muted-foreground" />
            )}
            <span className="min-w-0 flex-1 truncate text-xs font-medium" title={file?.path}>
              {file?.path ?? "未打开文件"}
            </span>
            {dirty ? <span className="size-2 rounded-full bg-amber-500" title="未保存" /> : null}
            {file && RUNNABLE_FILE.test(file.path) ? (
              <Button
                aria-label="运行当前文件"
                disabled={saving}
                onClick={() => void runFile()}
                size="icon-sm"
                title={dirty ? "保存并运行当前文件" : "运行当前文件"}
                variant="ghost"
              >
                <PlayIcon />
              </Button>
            ) : null}
            <Button
              aria-label="保存文件"
              disabled={!dirty || saving}
              onClick={() => void saveFile()}
              size="icon-sm"
              title="保存文件 (Ctrl+S)"
              variant="ghost"
            >
              {saving ? <LoaderCircleIcon className="animate-spin" /> : <SaveIcon />}
            </Button>
          </PanelHeader>
          <div className="min-h-0 flex-1 overflow-hidden">
            {loading ? (
              <div className="flex size-full items-center justify-center text-muted-foreground">
                <LoaderCircleIcon className="size-5 animate-spin" />
              </div>
            ) : file ? (
              <CodeEditor
                key={file.path}
                onChange={setDraft}
                onSave={() => void saveFile()}
                path={file.path}
                value={draft}
              />
            ) : (
              <Empty className="h-full">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <FileCode2Icon />
                  </EmptyMedia>
                  <EmptyTitle>尚未打开文件</EmptyTitle>
                </EmptyHeader>
              </Empty>
            )}
          </div>
        </PanelSurface>
      </ResizablePanel>
      <ResizableHandle />
      <ResizablePanel defaultSize="28%" minSize="22%" maxSize="46%">
        <aside className="flex size-full min-w-0 flex-col bg-muted/20">
          <PanelHeader className="bg-muted/60 px-3 text-xs font-medium">
            <FolderTreeIcon className="size-4 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate" title={activeThread.metadata.workspacePath}>
              {activeThread.metadata.workspacePath
                ?.replaceAll("\\", "/")
                .split("/")
                .filter(Boolean)
                .at(-1)}
            </span>
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
              <DropdownMenuContent
                align="end"
                className="w-max min-w-36 max-w-[min(calc(100vw-2rem),20rem)]"
              >
                <DropdownMenuItem
                  onClick={() => {
                    setCreateKind("file");
                    setCreateName("");
                  }}
                >
                  <FilePlus2Icon />
                  添加文件
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => {
                    setCreateKind("dir");
                    setCreateName("");
                  }}
                >
                  <FolderPlusIcon />
                  新建文件夹
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => void refreshTree()}>
                  <RefreshCwIcon className={cn(treeLoading && "animate-spin")} />
                  刷新
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </PanelHeader>
          <ScrollArea className="min-h-0 flex-1">
            <FileTree
              className="min-w-max rounded-none border-0 bg-transparent text-xs"
              expanded={expanded}
              onExpandedChange={handleExpandedChange}
              onSelect={selectFile}
              selectedPath={selectedPath}
            >
              {createKind ? (
                createDirectory === "" ? (
                  <InlineCreateRow
                    kind={createKind}
                    onCancel={cancelCreate}
                    onChange={setCreateName}
                    onSubmit={() => void createEntry()}
                    value={createName}
                  />
                ) : null
              ) : null}
              {treeLoading ? (
                <p className="px-2 py-2 text-xs text-muted-foreground">正在读取目录…</p>
              ) : entries.length === 0 && !createKind ? (
                <p className="px-2 py-2 text-xs text-muted-foreground">空目录</p>
              ) : (
                <TreeRows
                  childrenByPath={childrenByPath}
                  createName={createName}
                  creating={createKind ? { kind: createKind, parent: createDirectory } : undefined}
                  entries={entries}
                  onCancelCreate={cancelCreate}
                  onCreateNameChange={setCreateName}
                  onSelectFile={selectFile}
                  onCreateInDirectory={(dirPath, kind) => {
                    setSelectedPath(dirPath);
                    setCreateKind(kind);
                    setCreateName("");
                    setExpanded((current) => new Set(current).add(dirPath));
                    loadDirectory(dirPath);
                  }}
                  onSubmitCreate={() => void createEntry()}
                  onRunFile={(filePath) => {
                    selectFile(filePath);
                    void runFile();
                  }}
                  workspacePath={activeThread.metadata.workspacePath}
                />
              )}
            </FileTree>
            <ScrollBar orientation="horizontal" />
          </ScrollArea>
        </aside>
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}

interface BrowserState {
  active: boolean;
  status: string;
  currentUrl: string | null;
  tabs: Array<{ url: string; title?: string }>;
  activeTabIndex: number;
}

const EMPTY_BROWSER_STATE: BrowserState = {
  active: false,
  status: "closed",
  currentUrl: null,
  tabs: [],
  activeTabIndex: 0,
};

/**
 * 线程浏览器会话:状态轮询、screencast、导航、标签操作与输入注入。
 *
 * 从原 BrowserWorkspace 里提出来,是因为页面标签要和「文件」标签并列渲染在
 * WorkspacePanel 的 header 上 —— state.tabs 与 action() 必须在那一层可见。
 */
function useBrowserSession() {
  const { activeThreadId, activePanelTab, browserRequest, user } = useWorkbench();
  // 浏览器标签当前是否激活:只在用户或 Agent 已打开浏览器时连接 SSE 视频流。
  const viewActive = activePanelTab.kind === "browser";
  const [state, setState] = React.useState<BrowserState>(EMPTY_BROWSER_STATE);
  const [frame, setFrame] = React.useState<{
    data: string;
    viewport: { width: number; height: number };
  }>();
  const [busy, setBusy] = React.useState(false);
  const [frameState, setFrameState] = React.useState<"idle" | "connecting" | "connected" | "error">(
    "idle",
  );
  const [screencastAttempt, setScreencastAttempt] = React.useState(0);
  const pointerMoveAtRef = React.useRef(0);
  const browserPath = activeThreadId
    ? `${MASTRA_SERVER_URL}/work/threads/${activeThreadId}/browser`
    : "";
  const browserUrl = React.useCallback(
    (suffix = "") =>
      browserPath ? `${browserPath}${suffix}?resourceId=${encodeURIComponent(user.id)}` : "",
    [browserPath, user.id],
  );
  const stateUrl = browserUrl();

  const refreshState = React.useCallback(async () => {
    if (!stateUrl) return setState(EMPTY_BROWSER_STATE);
    try {
      const response = await fetch(stateUrl);
      if (!response.ok) return setState(EMPTY_BROWSER_STATE);
      setState((await response.json()) as BrowserState);
    } catch {
      setState(EMPTY_BROWSER_STATE);
    }
  }, [stateUrl]);

  React.useEffect(() => {
    setFrame(undefined);
    setFrameState("idle");
    void refreshState();
    if (!stateUrl) return;
    const timer = window.setInterval(() => void refreshState(), 1_500);
    return () => window.clearInterval(timer);
  }, [refreshState, stateUrl]);

  React.useEffect(() => {
    void screencastAttempt;
    // 切到文件标签时断开视频流:标签栏只需要 refreshState 的轮询就够了
    if (!viewActive || !stateUrl || !state.active) return;
    setFrameState("connecting");
    const source = new EventSource(browserUrl("/screencast"));
    source.addEventListener("frame", (event) => {
      setFrame(JSON.parse((event as MessageEvent<string>).data) as typeof frame);
      setFrameState("connected");
    });
    source.addEventListener("url", (event) => {
      const { url } = JSON.parse((event as MessageEvent<string>).data) as {
        url: string;
      };
      setState((current) => ({ ...current, currentUrl: url }));
    });
    source.addEventListener("stop", () => source.close());
    source.addEventListener("error", () => {
      setFrameState("error");
      source.close();
    });
    return () => source.close();
  }, [browserUrl, screencastAttempt, viewActive, state.active, stateUrl]);

  const retryFrame = React.useCallback(() => {
    setFrame(undefined);
    setFrameState("connecting");
    setScreencastAttempt((attempt) => attempt + 1);
    void refreshState();
  }, [refreshState]);

  const navigate = React.useCallback(
    async (url: string) => {
      if (!stateUrl || !url.trim()) return;
      setBusy(true);
      try {
        const response = await fetch(browserUrl("/navigate"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url }),
        });
        const payload = (await response.json()) as {
          error?: string;
          message?: string;
          state?: BrowserState;
        };
        if (!response.ok) throw new Error(payload.message || payload.error || "网页导航失败");
        if (payload.state) setState(payload.state);
        await refreshState();
      } catch (error) {
        toastError(error, "网页导航失败");
      } finally {
        setBusy(false);
      }
    },
    [browserUrl, refreshState, stateUrl],
  );

  const action = React.useCallback(
    async (name: string, index?: number, url?: string) => {
      if (!stateUrl) return;
      setBusy(true);

      // 乐观更新:秒级响应用户意图,彻底消除网络往返等待时的「慢半拍」卡顿感
      if (name === "new-tab") {
        const newUrl = url || NEW_BROWSER_TAB_URL;
        setState((current) => ({
          ...current,
          active: true,
          currentUrl: newUrl,
          tabs: [...current.tabs, { url: newUrl, title: "新标签页" }],
        }));
      } else if (name === "close-tab" && typeof index === "number") {
        setState((current) => {
          const nextTabs = current.tabs.filter((_, i) => i !== index);
          const nextIndex = Math.max(0, Math.min(nextTabs.length - 1, index - 1));
          return {
            ...current,
            currentUrl: nextTabs[nextIndex]?.url ?? "",
            tabs: nextTabs,
          };
        });
      }

      try {
        const response = await fetch(browserUrl("/action"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: name,
            index,
            ...(url ? { url } : {}),
          }),
        });
        const payload = (await response.json()) as {
          error?: string;
          message?: string;
          state?: BrowserState;
        };
        if (!response.ok) throw new Error(payload.message || payload.error || "浏览器操作失败");
        if (payload.state) setState(payload.state);
      } catch (error) {
        toastError(error, "浏览器操作失败");
        void refreshState();
      } finally {
        setBusy(false);
      }
    },
    [browserUrl, refreshState, stateUrl],
  );

  const consumedBrowserRequestRef = React.useRef(0);
  React.useEffect(() => {
    if (!browserRequest || browserRequest.id === consumedBrowserRequestRef.current) return;
    if (browserRequest.threadId !== activeThreadId) {
      consumedBrowserRequestRef.current = browserRequest.id;
      return;
    }
    if (!activeThreadId) return;
    consumedBrowserRequestRef.current = browserRequest.id;
    if (state.active && browserRequest.newTab) {
      void action("new-tab", undefined, browserRequest.url);
    } else {
      void navigate(browserRequest.url);
    }
  }, [action, activeThreadId, browserRequest, navigate, state.active]);

  const injectMouse = React.useCallback(
    (event: React.PointerEvent<HTMLImageElement>, type: "mousePressed" | "mouseReleased") => {
      if (!stateUrl || !frame) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      const x = ((event.clientX - bounds.left) / bounds.width) * frame.viewport.width;
      const y = ((event.clientY - bounds.top) / bounds.height) * frame.viewport.height;
      void fetch(browserUrl("/mouse"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type, x, y, button: "left", clickCount: 1 }),
      });
    },
    [browserUrl, frame, stateUrl],
  );

  const injectMouseMove = React.useCallback(
    (event: React.PointerEvent<HTMLImageElement>) => {
      const now = performance.now();
      if (now - pointerMoveAtRef.current < 30) return;
      pointerMoveAtRef.current = now;
      if (!stateUrl || !frame) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      const x = ((event.clientX - bounds.left) / bounds.width) * frame.viewport.width;
      const y = ((event.clientY - bounds.top) / bounds.height) * frame.viewport.height;
      void fetch(browserUrl("/mouse"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "mouseMoved", x, y, button: "none" }),
      });
    },
    [browserUrl, frame, stateUrl],
  );

  const injectWheel = React.useCallback(
    (event: React.WheelEvent<HTMLImageElement>) => {
      if (!stateUrl || !frame) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      const x = ((event.clientX - bounds.left) / bounds.width) * frame.viewport.width;
      const y = ((event.clientY - bounds.top) / bounds.height) * frame.viewport.height;
      void fetch(browserUrl("/mouse"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "mouseWheel",
          x,
          y,
          deltaX: event.deltaX,
          deltaY: event.deltaY,
          modifiers:
            (event.altKey ? 1 : 0) |
            (event.ctrlKey ? 2 : 0) |
            (event.metaKey ? 4 : 0) |
            (event.shiftKey ? 8 : 0),
        }),
      });
    },
    [browserUrl, frame, stateUrl],
  );

  const injectKey = React.useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (!stateUrl) return;
      event.preventDefault();
      const modifiers =
        (event.altKey ? 1 : 0) |
        (event.ctrlKey ? 2 : 0) |
        (event.metaKey ? 4 : 0) |
        (event.shiftKey ? 8 : 0);
      const payload = {
        key: event.key,
        code: event.code,
        modifiers,
        windowsVirtualKeyCode: event.keyCode,
      };
      for (const type of ["keyDown", "keyUp"] as const) {
        void fetch(browserUrl("/keyboard"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...payload,
            type,
            ...(type === "keyDown" && event.key.length === 1 ? { text: event.key } : {}),
          }),
        });
      }
    },
    [browserUrl, stateUrl],
  );

  /** 关闭线程浏览器并把本地视图归零;再次使用时由显式导航或新建标签按需启动。 */
  const closeBrowser = React.useCallback(() => {
    if (!stateUrl) return;
    setState(EMPTY_BROWSER_STATE);
    setFrame(undefined);
    setFrameState("idle");
    void fetch(stateUrl, { method: "DELETE" }).then(() => {
      void refreshState();
    });
  }, [refreshState, stateUrl]);

  return {
    action,
    busy,
    closeBrowser,
    frame,
    frameState,
    hasThread: Boolean(activeThreadId),
    injectKey,
    injectMouse,
    injectMouseMove,
    injectWheel,
    navigate,
    retryFrame,
    state,
    threadKey: activeThreadId,
  };
}

type BrowserSession = ReturnType<typeof useBrowserSession>;

/**
 * 浏览器视图:导航栏 + 实时画面 + 输入注入。
 * 页面标签栏不在这里 —— 它和「文件」标签合成一条,渲染在 WorkspacePanel 上。
 */
function BrowserView({
  onCloseBrowser,
  session,
}: {
  onCloseBrowser: () => void;
  session: BrowserSession;
}) {
  const {
    action,
    busy,
    frame,
    frameState,
    hasThread,
    injectKey,
    injectMouse,
    injectMouseMove,
    injectWheel,
    navigate,
    retryFrame,
    state,
    threadKey,
  } = session;

  if (!hasThread) {
    return (
      <Empty className="h-full">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Globe2Icon />
          </EmptyMedia>
          <EmptyTitle>未选择会话</EmptyTitle>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <WebPreview
      className="rounded-none border-0"
      defaultUrl={state.currentUrl ?? ""}
      key={threadKey ?? ""}
      onUrlChange={navigate}
    >
      <WebPreviewNavigation className="h-10 shrink-0 gap-0.5 p-1">
        <WebPreviewNavigationButton
          disabled={!state.active || busy}
          onClick={() => void action("back")}
          tooltip="后退"
        >
          <ArrowLeftIcon />
        </WebPreviewNavigationButton>
        <WebPreviewNavigationButton
          disabled={!state.active || busy}
          onClick={() => void action("forward")}
          tooltip="前进"
        >
          <ArrowRightIcon />
        </WebPreviewNavigationButton>
        <WebPreviewNavigationButton
          disabled={!state.active || busy}
          onClick={() => void action("reload")}
          tooltip="刷新"
        >
          <RefreshCwIcon className={cn(busy && "animate-spin")} />
        </WebPreviewNavigationButton>
        <WebPreviewUrl />
        <WebPreviewNavigationButton
          disabled={!state.currentUrl}
          onClick={() => {
            if (state.currentUrl) void window.api.openExternal(state.currentUrl);
          }}
          tooltip="在系统浏览器中打开"
        >
          <ExternalLinkIcon />
        </WebPreviewNavigationButton>
        <WebPreviewNavigationButton
          disabled={!state.active}
          onClick={onCloseBrowser}
          tooltip="关闭浏览器"
        >
          <SquareIcon />
        </WebPreviewNavigationButton>
      </WebPreviewNavigation>
      <div
        className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-muted/30"
        onKeyDown={injectKey}
        role="application"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: The preview is the keyboard target for browser input injection.
        tabIndex={0}
      >
        {frame ? (
          <img
            alt="Agent 浏览器实时画面"
            className="max-h-full max-w-full cursor-default object-contain select-none"
            draggable={false}
            onPointerDown={(event) => {
              injectMouse(event, "mousePressed");
              event.currentTarget.parentElement?.focus();
            }}
            onPointerMove={injectMouseMove}
            onPointerUp={(event) => injectMouse(event, "mouseReleased")}
            onWheel={injectWheel}
            src={`data:image/jpeg;base64,${frame.data}`}
          />
        ) : state.active && frameState === "error" ? (
          <div className="flex flex-col items-center gap-3 text-sm text-muted-foreground">
            <span>实时画面连接失败</span>
            <Button onClick={retryFrame} size="sm" variant="outline">
              重试连接
            </Button>
          </div>
        ) : state.active ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <LoaderCircleIcon className="size-4 animate-spin" />
            {frameState === "connecting" ? "正在连接实时画面" : "等待浏览器画面"}
          </div>
        ) : (
          <Empty className="text-muted-foreground">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <BotIcon />
              </EmptyMedia>
              <EmptyTitle className="text-zinc-200">浏览器未启动</EmptyTitle>
            </EmptyHeader>
          </Empty>
        )}
        {busy ? (
          <div className="absolute top-0 inset-x-0 h-0.5 overflow-hidden bg-zinc-800">
            <span className="block h-full w-1/3 animate-pulse bg-sky-500" />
          </div>
        ) : null}
      </div>
    </WebPreview>
  );
}

export default function WorkspacePanel() {
  const {
    activePanelTab,
    activatePanelTab,
    addPanelTab,
    closePanelTab,
    panelTabs,
    setWorkspacePanelOpen,
  } = useWorkbench();
  // 会话状态在面板层建立(无条件调用),浏览器视图按当前标签渲染
  const browserSession = useBrowserSession();
  const { action, closeBrowser, state } = browserSession;
  const browserActive = activePanelTab.kind === "browser";

  const closeBrowserAndReturnToLocalTab = () => {
    closeBrowser();
    const fallback = panelTabs[panelTabs.length - 1];
    if (fallback) {
      activatePanelTab({ kind: fallback.kind, id: fallback.id });
    } else {
      activatePanelTab({ kind: "welcome", id: "welcome" });
    }
  };

  /** 切到某个浏览器页面:先切服务端活动页,再把面板切到浏览器视图 */
  const openBrowserTab = (index: number) => {
    activatePanelTab({ kind: "browser", index });
    void action("switch-tab", index);
  };

  /**
   * 关闭一个页面标签:
   * 1. 优先平滑回退到左侧前一个标签;
   * 2. 若关掉的是唯一一个浏览器标签,回落到最后一个本地标签或起始页。
   */
  const closeBrowserTab = (index: number) => {
    if (state.tabs.length <= 1) {
      closeBrowserAndReturnToLocalTab();
      return;
    }
    if (activePanelTab.kind === "browser" && activePanelTab.index === index) {
      const prevIndex = index > 0 ? index - 1 : 0;
      activatePanelTab({ kind: "browser", index: prevIndex });
    } else if (activePanelTab.kind === "browser" && activePanelTab.index > index) {
      activatePanelTab({ kind: "browser", index: activePanelTab.index - 1 });
    }
    void action("close-tab", index);
  };

  const isWelcomeActive =
    activePanelTab.kind === "welcome" || (panelTabs.length === 0 && state.tabs.length === 0);

  return (
    <PanelSurface>
      <PanelHeader className="gap-1 bg-muted/40 px-1">
        {/* 一条统一标签栏:前半是前端拥有的实例(文件树 / 终端),
            后半是由服务端 state.tabs 派生的浏览器页面。支持横向滚轮与横向滚动条。 */}
        <div
          className="flex h-full min-w-0 flex-1 items-center gap-1 overflow-x-auto overflow-y-hidden"
          data-horizontal-scroll="true"
        >
          {panelTabs.map((tab) => {
            const isSelected =
              activePanelTab.kind !== "browser" &&
              activePanelTab.kind !== "welcome" &&
              activePanelTab.id === tab.id;
            return (
              <div
                className="group relative flex h-7 shrink-0 items-center"
                key={tab.id}
                role="presentation"
              >
                <ContextMenu>
                  <ContextMenuTrigger>
                    <button
                      className={cn(
                        "flex h-7 max-w-44 min-w-0 flex-none items-center gap-1.5 rounded-md px-2 pr-7 text-xs transition-colors",
                        isSelected
                          ? "!bg-primary !font-semibold !text-primary-foreground shadow-sm"
                          : "text-muted-foreground hover:bg-muted hover:text-foreground",
                      )}
                      onClick={() => activatePanelTab({ kind: tab.kind, id: tab.id })}
                      title={tab.title}
                      type="button"
                    >
                      {tab.kind === "files" ? (
                        <FolderTreeIcon className="size-3.5 shrink-0" />
                      ) : (
                        <TerminalIcon className="size-3.5 shrink-0" />
                      )}
                      <span className="truncate">{tab.title}</span>
                    </button>
                  </ContextMenuTrigger>
                  <ContextMenuContent className="w-48">
                    <ContextMenuGroup>
                      <ContextMenuLabel className="truncate max-w-44">{tab.title}</ContextMenuLabel>
                      <ContextMenuItem onClick={() => closePanelTab(tab.id)}>
                        <XIcon className="text-muted-foreground" />
                        <span>关闭标签</span>
                        <ContextMenuShortcut>⌘W</ContextMenuShortcut>
                      </ContextMenuItem>
                      <ContextMenuItem
                        onClick={() => {
                          for (const other of panelTabs) {
                            if (other.id !== tab.id) closePanelTab(other.id);
                          }
                        }}
                      >
                        <span>关闭其他标签</span>
                      </ContextMenuItem>
                    </ContextMenuGroup>
                    <ContextMenuSeparator />
                    <ContextMenuGroup>
                      <ContextMenuSub>
                        <ContextMenuSubTrigger>
                          <PlusIcon className="text-muted-foreground" />
                          <span>新建标签</span>
                        </ContextMenuSubTrigger>
                        <ContextMenuSubContent className="w-44">
                          <ContextMenuGroup>
                            <ContextMenuItem onClick={() => addPanelTab("files")}>
                              <FolderTreeIcon className="text-muted-foreground" />
                              <span>文件树</span>
                            </ContextMenuItem>
                            <ContextMenuItem onClick={() => addPanelTab("terminal")}>
                              <TerminalIcon className="text-muted-foreground" />
                              <span>终端</span>
                            </ContextMenuItem>
                            <ContextMenuItem
                              onClick={() => {
                                activatePanelTab({
                                  kind: "browser",
                                  index: state.tabs.length,
                                });
                                void action("new-tab", undefined, NEW_BROWSER_TAB_URL);
                              }}
                            >
                              <Globe2Icon className="text-muted-foreground" />
                              <span>浏览页面</span>
                            </ContextMenuItem>
                          </ContextMenuGroup>
                        </ContextMenuSubContent>
                      </ContextMenuSub>
                    </ContextMenuGroup>
                  </ContextMenuContent>
                </ContextMenu>
                <button
                  aria-label={`关闭${tab.title}`}
                  className="absolute right-1 rounded p-0.5 opacity-0 hover:bg-muted-foreground/15 focus-visible:opacity-100 group-hover:opacity-100"
                  onClick={(event) => {
                    event.stopPropagation();
                    closePanelTab(tab.id);
                  }}
                  type="button"
                >
                  <XIcon className="size-3" />
                </button>
              </div>
            );
          })}
          {state.tabs.map((tab, index) => {
            const isSelected = activePanelTab.kind === "browser" && activePanelTab.index === index;
            return (
              <div
                className="group relative flex h-7 shrink-0 items-center"
                // biome-ignore lint/suspicious/noArrayIndexKey: 页面标签就是 state.tabs 的下标,Mastra 的 tabs API 也只按 index 寻址
                key={`${index}:${tab.url}:${tab.title ?? ""}`}
                role="presentation"
              >
                <button
                  className={cn(
                    "flex h-7 max-w-44 min-w-0 flex-none items-center gap-1.5 rounded-md px-2 pr-7 text-xs transition-colors",
                    isSelected
                      ? "!bg-primary !font-semibold !text-primary-foreground shadow-sm"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground",
                  )}
                  onClick={() => openBrowserTab(index)}
                  title={tab.title || tab.url}
                  type="button"
                >
                  <Globe2Icon className="size-3.5 shrink-0" />
                  <span className="truncate">{tab.title || tab.url || "新标签页"}</span>
                </button>
                <button
                  aria-label="关闭页面"
                  className="absolute right-1 rounded p-0.5 opacity-0 hover:bg-muted-foreground/15 focus-visible:opacity-100 group-hover:opacity-100"
                  onClick={(event) => {
                    event.stopPropagation();
                    closeBrowserTab(index);
                  }}
                  type="button"
                >
                  <XIcon className="size-3" />
                </button>
              </div>
            );
          })}
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  aria-label="新建标签"
                  className="size-7 shrink-0"
                  size="icon-sm"
                  title="新建标签"
                  variant="ghost"
                />
              }
            >
              <PlusIcon />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem
                onClick={() => {
                  activatePanelTab({
                    kind: "browser",
                    index: state.tabs.length,
                  });
                  void action("new-tab", undefined, NEW_BROWSER_TAB_URL);
                }}
              >
                <Globe2Icon />
                新建浏览页面
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => addPanelTab("terminal")}>
                <TerminalIcon />
                新建终端
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => addPanelTab("files")}>
                <FolderTreeIcon />
                新建文件树
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <Button
          aria-label="关闭右侧面板"
          className="shrink-0"
          onClick={() => setWorkspacePanelOpen(false)}
          size="icon-sm"
          title="关闭右侧面板"
          variant="ghost"
        >
          <XIcon />
        </Button>
      </PanelHeader>
      {/* 所有标签内容常驻,靠 hidden 切换:xterm 卸载会丢 scrollback 与会话,
          文件树卸载会丢展开层级。浏览器只有一个实例 —— screencast 是每线程单路的,
          页面之间靠 switch-tab 切换而不是多份视图。 */}
      <div className="relative min-h-0 flex-1 overflow-hidden">
        {panelTabs.map((tab) => {
          const selected =
            !isWelcomeActive && activePanelTab.kind !== "browser" && activePanelTab.id === tab.id;
          return (
            <div className={cn("size-full", selected ? "block" : "hidden")} key={tab.id}>
              {tab.kind === "files" ? (
                <FilesWorkspace active={selected} />
              ) : (
                <div className="size-full px-3 py-2">
                  <TerminalSession active={selected} />
                </div>
              )}
            </div>
          );
        })}
        <div className={cn("size-full", !isWelcomeActive && browserActive ? "block" : "hidden")}>
          <BrowserView onCloseBrowser={closeBrowserAndReturnToLocalTab} session={browserSession} />
        </div>
        {isWelcomeActive ? (
          <div className="flex size-full flex-col items-center justify-center p-8 select-none">
            <div className="w-full max-w-sm space-y-6">
              <div className="text-sm font-normal text-muted-foreground">从这里开始</div>
              <div className="space-y-1">
                {/* 1. 任务摘要 */}
                <button
                  type="button"
                  onClick={() => {
                    addPanelTab("files");
                  }}
                  className="group flex w-full items-center gap-3.5 rounded-lg p-2.5 text-left transition-colors hover:bg-muted/70 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  <ListTodoIcon className="size-4 shrink-0 text-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="text-xs font-medium text-foreground">任务摘要</span>
                      <span className="text-xs text-muted-foreground truncate">
                        查看任务执行进展、产物汇总及关联信息
                      </span>
                    </div>
                  </div>
                </button>

                {/* 2. 浏览器 */}
                <button
                  type="button"
                  onClick={() => {
                    activatePanelTab({
                      kind: "browser",
                      index: state.tabs.length,
                    });
                    void action("new-tab", undefined, NEW_BROWSER_TAB_URL);
                  }}
                  className="group flex w-full items-center gap-3.5 rounded-lg p-2.5 text-left transition-colors hover:bg-muted/70 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  <Globe2Icon className="size-4 shrink-0 text-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="text-xs font-medium text-foreground">浏览器</span>
                      <span className="text-xs text-muted-foreground truncate">浏览及调试网页</span>
                    </div>
                  </div>
                </button>

                {/* 3. 终端 */}
                <button
                  type="button"
                  onClick={() => {
                    addPanelTab("terminal");
                  }}
                  className="group flex w-full items-center gap-3.5 rounded-lg p-2.5 text-left transition-colors hover:bg-muted/70 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  <TerminalIcon className="size-4 shrink-0 text-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="text-xs font-medium text-foreground">终端</span>
                      <span className="text-xs text-muted-foreground truncate">运行命令及脚本</span>
                    </div>
                  </div>
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </PanelSurface>
  );
}
