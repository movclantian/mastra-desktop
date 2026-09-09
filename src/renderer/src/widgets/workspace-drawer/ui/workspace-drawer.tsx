import {
  autocompletion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import { jsonParseLinter } from "@codemirror/lang-json";
import { linter, lintGutter } from "@codemirror/lint";
import { search, selectNextOccurrence, selectSelectionMatches } from "@codemirror/search";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import CodeMirror from "@uiw/react-codemirror";
import {
  Code2Icon,
  CopyIcon,
  EyeIcon,
  FileCode2Icon,
  FileDiffIcon,
  FilePlus2Icon,
  FolderPlusIcon,
  FolderTreeIcon,
  Globe2Icon,
  MoreHorizontalIcon,
  PencilLineIcon,
  PlayIcon,
  PlusIcon,
  RefreshCwIcon,
  SaveIcon,
  SparklesIcon,
  TerminalIcon,
  XIcon,
} from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import {
  createWorkspaceEntry,
  fetchWorkspaceFile,
  type ModelSelection,
  reportWorkbenchState,
  saveWorkspaceFile,
  TerminalSession,
  type TreeEntry,
  useWorkbench,
  type WorkspaceFileChange,
  workspaceRawFileUrl,
} from "@/entities/workbench";
import { cn, toastError } from "@/shared/lib";
import {
  FileTree,
  FileTreeActions,
  FileTreeFile,
  FileTreeFolder,
} from "@/shared/ui/ai-elements/file-tree";
import { FileTypeIcon, FolderTypeIcon } from "@/shared/ui/ai-elements/file-type-icon";
import { Button } from "@/shared/ui/button";
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
import { Dotm3x3_1 } from "@/shared/ui/dotm-3x3-1";
import { Dotm3x3_11 } from "@/shared/ui/dotm-3x3-11";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/shared/ui/empty";
import { FlickeringGrid } from "@/shared/ui/flickering-grid";
import { GridPattern } from "@/shared/ui/grid-pattern";
import { Input } from "@/shared/ui/input";
import { PanelHeader, PanelSurface } from "@/shared/ui/panel";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/shared/ui/resizable";
import { Ripple } from "@/shared/ui/ripple";
import { ScrollArea, ScrollBar } from "@/shared/ui/scroll-area";
import { fetchInlineCompletion, requestInlineEdit } from "../api/editor-api";
import { groupWorkspaceChanges } from "../lib/changes";
import {
  editorExtension,
  getFileExtension,
  isBinaryPreviewable,
  syntaxLinter,
} from "../lib/editor";
import { useBrowserSession } from "../model/use-browser-session";
import { BrowserView } from "./browser-view";
import { CodeChangeGroup as WorkspaceCodeChangeGroup } from "./code-changes";
import { WorkspaceFilePreview } from "./file-preview";

const NEW_BROWSER_TAB_URL = "https://www.bing.com";

function CodeEditor({
  path,
  value,
  onChange,
  onSave,
  activeThreadId,
  modelSelection,
  resourceId,
}: {
  path: string;
  value: string;
  onChange: (value: string) => void;
  onSave: () => void;
  activeThreadId: string | null;
  modelSelection: ModelSelection | null;
  resourceId: string;
}) {
  const onChangeRef = React.useRef(onChange);
  const onSaveRef = React.useRef(onSave);
  const activeThreadIdRef = React.useRef(activeThreadId);
  const modelSelectionRef = React.useRef(modelSelection);
  const pathRef = React.useRef(path);
  const resourceIdRef = React.useRef(resourceId);
  const editorRef = React.useRef<EditorView | null>(null);
  const wrapperRef = React.useRef<HTMLDivElement | null>(null);
  const abortRef = React.useRef<AbortController | null>(null);
  const [selection, setSelection] = React.useState<{
    from: number;
    to: number;
    text: string;
    top: number;
    left: number;
  }>();
  const [instruction, setInstruction] = React.useState("");
  const [promptOpen, setPromptOpen] = React.useState(false);
  const [includeContext, setIncludeContext] = React.useState(true);
  const [aiBusy, setAiBusy] = React.useState(false);

  onChangeRef.current = onChange;
  onSaveRef.current = onSave;
  activeThreadIdRef.current = activeThreadId;
  modelSelectionRef.current = modelSelection;
  pathRef.current = path;
  resourceIdRef.current = resourceId;

  React.useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  const handleEditorUpdate = React.useCallback(
    (viewUpdate: import("@codemirror/view").ViewUpdate) => {
      const range = viewUpdate.state.selection.main;
      if (range.empty) {
        setSelection(undefined);
        setPromptOpen(false);
        return;
      }

      const wrapper = wrapperRef.current;
      const coords = viewUpdate.view.coordsAtPos(range.from);
      if (!wrapper || !coords) return;
      const wrapperRect = wrapper.getBoundingClientRect();
      const nextSelection = {
        from: range.from,
        to: range.to,
        text: viewUpdate.state.sliceDoc(range.from, range.to),
        top: Math.min(
          Math.max(coords.bottom - wrapperRect.top + 8, 8),
          Math.max(8, wrapperRect.height - 44),
        ),
        left: Math.min(
          Math.max(coords.left - wrapperRect.left, 8),
          Math.max(8, wrapperRect.width - 340),
        ),
      };
      setSelection((current) =>
        current &&
        current.from === nextSelection.from &&
        current.to === nextSelection.to &&
        current.text === nextSelection.text &&
        Math.abs(current.top - nextSelection.top) < 1 &&
        Math.abs(current.left - nextSelection.left) < 1
          ? current
          : nextSelection,
      );
    },
    [],
  );

  const aiCompletionSource = React.useCallback(
    async (context: CompletionContext): Promise<CompletionResult | null> => {
      if (!context.explicit || !activeThreadIdRef.current) return null;
      const mainSelection = context.state.selection.main;
      if (!mainSelection.empty) return null;

      const position = context.pos;
      const token = context.matchBefore(/[\w$-]*/);
      const from = token?.from ?? position;
      const documentText = context.state.doc.toString();
      const controller = new AbortController();
      context.addEventListener("abort", () => controller.abort(), {
        onDocChange: true,
      });
      let payload: { text?: unknown } | null;
      try {
        payload = await fetchInlineCompletion({
          threadId: activeThreadIdRef.current,
          resourceId: resourceIdRef.current,
          path: pathRef.current,
          language: getFileExtension(pathRef.current),
          prefix: documentText.slice(from, position),
          beforeContext: documentText.slice(Math.max(0, position - 4_000), position),
          afterContext: documentText.slice(
            position,
            Math.min(documentText.length, position + 2_000),
          ),
          modelSelection: modelSelectionRef.current
            ? {
                providerId: modelSelectionRef.current.providerId,
                modelId: modelSelectionRef.current.modelId,
              }
            : undefined,
          signal: controller.signal,
        });
      } catch {
        return null;
      }
      if (context.aborted) return null;
      if (typeof payload?.text !== "string" || !payload.text.trim()) return null;
      const text = payload.text;
      const firstLine = text.split(/\r?\n/, 1)[0].trim();
      return {
        from,
        options: [
          {
            apply: text,
            detail: modelSelectionRef.current?.modelName ?? "当前模型",
            label: `AI ${firstLine.slice(0, 72) || "补全"}`,
            type: "text",
          },
        ],
        validFor: /^[\w$-]*$/,
      };
    },
    [],
  );

  const runInlineEdit = React.useCallback(
    async (requestedInstruction?: string) => {
      const current = editorRef.current;
      const currentSelection = selection;
      const threadId = activeThreadIdRef.current;
      if (!current || !currentSelection || !threadId || aiBusy) return;

      const documentText = current.state.doc.toString();
      const selectedText = current.state.sliceDoc(currentSelection.from, currentSelection.to);
      if (
        !selectedText ||
        selectedText !== currentSelection.text ||
        current.state.selection.main.from !== currentSelection.from ||
        current.state.selection.main.to !== currentSelection.to
      ) {
        toast.error("选区已变化,请重新选择代码");
        return;
      }

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setAiBusy(true);
      try {
        const payload = await requestInlineEdit({
          threadId,
          resourceId: resourceIdRef.current,
          path: pathRef.current,
          language: getFileExtension(pathRef.current),
          selectedText,
          beforeContext: includeContext
            ? documentText.slice(Math.max(0, currentSelection.from - 2_000), currentSelection.from)
            : "",
          afterContext: includeContext
            ? documentText.slice(
                currentSelection.to,
                Math.min(documentText.length, currentSelection.to + 2_000),
              )
            : "",
          instruction:
            requestedInstruction?.trim() ||
            instruction.trim() ||
            "改进这段代码,保持原有行为、接口和外部可观察结果不变。",
          modelSelection: modelSelectionRef.current
            ? {
                providerId: modelSelectionRef.current.providerId,
                modelId: modelSelectionRef.current.modelId,
              }
            : undefined,
          signal: controller.signal,
        });
        if (typeof payload?.text !== "string" || !payload.text.trim()) {
          throw new Error("模型没有返回可替换的代码");
        }

        const replacement = payload.text;
        const latestDocument = current.state.doc.toString();
        const latestSelection = current.state.selection.main;
        if (
          latestDocument.slice(currentSelection.from, currentSelection.to) !== selectedText ||
          latestSelection.from !== currentSelection.from ||
          latestSelection.to !== currentSelection.to
        ) {
          throw new Error("选区已变化,未应用模型结果");
        }
        current.dispatch({
          changes: {
            from: currentSelection.from,
            to: currentSelection.to,
            insert: replacement,
          },
          selection: {
            anchor: currentSelection.from,
            head: currentSelection.from + replacement.length,
          },
        });
        setInstruction("");
        setPromptOpen(false);
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          toastError(error, "内联修改失败");
        }
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
        setAiBusy(false);
      }
    },
    [aiBusy, includeContext, instruction, selection],
  );

  const modelLabel = modelSelection?.modelName || "当前模型";
  const reasoningLabel =
    modelSelection && modelSelection.reasoningEffort !== "off"
      ? ` · ${modelSelection.reasoningEffort}`
      : "";

  const extensions = React.useMemo(
    () => [
      editorExtension(path),
      EditorState.tabSize.of(2),
      EditorView.lineWrapping,
      autocompletion({
        activateOnTyping: false,
        maxRenderedOptions: 6,
        override: [aiCompletionSource],
      }),
      search({ top: true }),
      ...(getFileExtension(path) === "json"
        ? [linter(jsonParseLinter(), { delay: 350 }), lintGutter()]
        : [linter(syntaxLinter, { delay: 500 }), lintGutter()]),
      keymap.of([
        {
          key: "Mod-s",
          preventDefault: true,
          run: () => {
            onSaveRef.current();
            return true;
          },
        },
        {
          key: "Mod-d",
          run: (view) =>
            selectNextOccurrence({
              state: view.state,
              dispatch: view.dispatch,
            }),
        },
        {
          key: "Mod-Shift-l",
          run: (view) =>
            selectSelectionMatches({
              state: view.state,
              dispatch: view.dispatch,
            }),
        },
      ]),
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
    [aiCompletionSource, path],
  );

  return (
    <div className="relative size-full" ref={wrapperRef}>
      <CodeMirror
        basicSetup
        className="size-full overflow-hidden"
        extensions={extensions}
        onChange={(nextValue) => onChangeRef.current(nextValue)}
        onCreateEditor={(view) => {
          editorRef.current = view;
        }}
        onUpdate={handleEditorUpdate}
        spellCheck={false}
        theme="none"
        value={value}
      />
      {selection ? (
        <div
          aria-label="代码选区快捷操作"
          className="absolute z-20 flex max-w-[min(32rem,calc(100%-1rem))] items-center gap-1 overflow-hidden rounded-md border bg-popover/95 p-1 text-xs shadow-md backdrop-blur"
          onMouseDown={(event) => event.stopPropagation()}
          role="toolbar"
          style={{ left: selection.left, top: selection.top }}
        >
          <Button
            aria-label={includeContext ? "关闭周边代码上下文" : "附带周边代码上下文"}
            className={cn("size-6", includeContext && "bg-muted text-foreground")}
            onClick={() => setIncludeContext((current) => !current)}
            size="icon-xs"
            title={includeContext ? "关闭周边代码上下文" : "附带周边代码上下文"}
            variant="ghost"
          >
            <PlusIcon />
          </Button>
          {promptOpen ? (
            <form
              className="flex min-w-0 flex-1 items-center gap-1"
              onSubmit={(event) => {
                event.preventDefault();
                void runInlineEdit(instruction);
              }}
            >
              <Input
                autoFocus
                className="h-6 min-w-20 flex-1 border-0 bg-transparent px-1.5 py-0 text-xs shadow-none focus-visible:ring-1"
                onChange={(event) => setInstruction(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    setPromptOpen(false);
                  }
                }}
                placeholder="描述要如何修改..."
                value={instruction}
              />
              <Button
                aria-label="提交内联修改"
                disabled={aiBusy || !activeThreadId}
                size="icon-xs"
                title="提交内联修改"
                type="submit"
                variant="ghost"
              >
                {aiBusy ? (
                  <Dotm3x3_11 size={14} dotSize={2.2} colorPreset="solid-theme" />
                ) : (
                  <SparklesIcon />
                )}
              </Button>
            </form>
          ) : (
            <Button
              aria-label="输入内联修改要求"
              disabled={aiBusy}
              onClick={() => setPromptOpen(true)}
              size="icon-xs"
              title="输入内联修改要求"
              variant="ghost"
            >
              <PencilLineIcon />
            </Button>
          )}
          <Button
            aria-label="使用 AI 修改选中内容"
            disabled={aiBusy || !activeThreadId}
            onClick={() => void runInlineEdit()}
            size="icon-xs"
            title={activeThreadId ? "使用当前线程和模型修改选中内容" : "请先选择会话"}
            variant="ghost"
          >
            {aiBusy ? (
              <Dotm3x3_11 size={14} dotSize={2.2} colorPreset="solid-theme" />
            ) : (
              <SparklesIcon />
            )}
          </Button>
          <span
            className="max-w-36 truncate border-l px-1.5 text-[10px] text-muted-foreground"
            title={`${modelLabel}${reasoningLabel}`}
          >
            {modelLabel}
            {reasoningLabel}
          </span>
          <Button
            aria-label="关闭内联编辑工具条"
            onClick={() => {
              const current = editorRef.current;
              if (current) {
                const position = current.state.selection.main.to;
                current.dispatch({ selection: { anchor: position } });
              }
              setSelection(undefined);
              setPromptOpen(false);
            }}
            size="icon-xs"
            title="关闭"
            variant="ghost"
          >
            <XIcon />
          </Button>
        </div>
      ) : null}
    </div>
  );
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
  onSelectFile?: (path: string, initialMode?: "edit" | "preview") => void;
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
            className={cn(entry.hidden && "opacity-65", "group/file")}
            icon={<FileTypeIcon name={entry.name} />}
            name={entry.name}
            path={entry.path}
          >
            <FileTypeIcon name={entry.name} />
            <span className="truncate flex-1 min-w-0">{entry.name}</span>
            <FileTreeActions className="opacity-0 group-hover/file:opacity-100 transition-opacity">
              <Button
                size="icon-xs"
                variant="ghost"
                className="size-5 p-0 text-muted-foreground hover:text-foreground cursor-pointer"
                title="直接预览"
                onClick={(e) => {
                  e.stopPropagation();
                  onSelectFile?.(entry.path, "preview");
                }}
              >
                <EyeIcon className="size-3" />
              </Button>
            </FileTreeActions>
          </FileTreeFile>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-48">
          <ContextMenuGroup>
            <ContextMenuLabel className="truncate max-w-44">{entry.name}</ContextMenuLabel>
            <ContextMenuItem onClick={() => onSelectFile?.(entry.path, "preview")}>
              <EyeIcon className="text-muted-foreground" />
              <span>直接预览</span>
            </ContextMenuItem>
            {!isBinaryPreviewable(entry.name) ? (
              <ContextMenuItem onClick={() => onSelectFile?.(entry.path, "edit")}>
                <FileCode2Icon className="text-muted-foreground" />
                <span>在编辑器打开</span>
              </ContextMenuItem>
            ) : null}
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

type WorkspaceFilePayload = {
  path: string;
  name: string;
  content: string;
  size: number;
  isBinary?: boolean;
};

type OpenWorkspaceFile = WorkspaceFilePayload & {
  draft: string;
  viewMode: "edit" | "preview";
};

/**
 * 文件树 + 编辑器。可多开 —— 每个标签一个独立实例,各自持有展开态与打开的文件。
 *
 * active:只有激活的那个实例上报 editor state lane。多实例同时上报会在同一条
 * lane 上互相覆盖,模型看到的「当前打开的文件」会在几个标签之间来回跳。
 */
function FilesWorkspace({ active }: { active: boolean }) {
  const {
    activeThreadId,
    fetchTreeEntries,
    modelSelection,
    requestTerminalCommand,
    threads,
    user,
  } = useWorkbench();
  const activeThread = threads.find((thread) => thread.id === activeThreadId);
  const [entries, setEntries] = React.useState<TreeEntry[]>([]);
  const [childrenByPath, setChildrenByPath] = React.useState<Record<string, TreeEntry[]>>({});
  const [expanded, setExpanded] = React.useState(() => new Set<string>());
  const [selectedPath, setSelectedPath] = React.useState<string>();
  const [openFiles, setOpenFiles] = React.useState<OpenWorkspaceFile[]>([]);
  const [activeFilePath, setActiveFilePath] = React.useState<string>();
  const [loadingPaths, setLoadingPaths] = React.useState<Set<string>>(new Set());
  const [treeLoading, setTreeLoading] = React.useState(false);
  const [savingPaths, setSavingPaths] = React.useState<Set<string>>(new Set());
  const [createKind, setCreateKind] = React.useState<"file" | "dir">();
  const [createName, setCreateName] = React.useState("");
  const loadedPathsRef = React.useRef(new Set<string>());
  const treeRefreshRequestRef = React.useRef(0);
  const openFilesRef = React.useRef(openFiles);
  const activeFile = openFiles.find((item) => item.path === activeFilePath);
  const dirty = activeFile ? activeFile.draft !== activeFile.content : false;

  React.useEffect(() => {
    openFilesRef.current = openFiles;
  }, [openFiles]);

  const allEntries = React.useMemo(
    () => [entries, ...Object.values(childrenByPath)].flat(),
    [childrenByPath, entries],
  );

  const refreshTree = React.useCallback(async () => {
    if (!activeThreadId) return;
    const requestId = ++treeRefreshRequestRef.current;
    setTreeLoading(true);
    loadedPathsRef.current = new Set();
    setEntries([]);
    setChildrenByPath({});
    setExpanded(new Set());
    setSelectedPath(undefined);
    try {
      const nextEntries = await fetchTreeEntries(activeThreadId);
      if (requestId === treeRefreshRequestRef.current) setEntries(nextEntries);
    } finally {
      if (requestId === treeRefreshRequestRef.current) setTreeLoading(false);
    }
  }, [activeThreadId, fetchTreeEntries]);

  React.useEffect(() => {
    setSelectedPath(undefined);
    setOpenFiles([]);
    setActiveFilePath(undefined);
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
        ...(activeFile?.path ? { openPath: activeFile.path, dirty } : {}),
        ...(selectedPath ? { selectedPath } : {}),
      },
    });
  }, [
    active,
    activeThread?.metadata.workspacePath,
    activeThreadId,
    dirty,
    activeFile?.path,
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

  // Agent tools, terminals, and external editors can change the workspace without
  // going through this component. Refresh only the root and currently expanded
  // directories so the tree stays current without collapsing the user's view.
  const refreshVisibleTree = React.useCallback(async () => {
    if (!active || !activeThreadId || document.hidden) return;
    const requestId = treeRefreshRequestRef.current;
    const paths = ["", ...expanded];
    try {
      const visibleEntries = await Promise.all(
        paths.map(
          async (path) =>
            [path, await fetchTreeEntries(activeThreadId, path || undefined)] as const,
        ),
      );
      if (requestId !== treeRefreshRequestRef.current) return;
      const rootEntries = visibleEntries.find(([path]) => path === "")?.[1];
      if (rootEntries) setEntries(rootEntries);
      setChildrenByPath((current) => {
        const next = { ...current };
        for (const [path, nextEntries] of visibleEntries) {
          if (path) next[path] = nextEntries;
        }
        return next;
      });
    } catch {
      // Keep the last known tree when a transient filesystem request fails.
    }
  }, [active, activeThreadId, expanded, fetchTreeEntries]);

  React.useEffect(() => {
    if (!active || !activeThreadId) return;
    const refresh = () => void refreshVisibleTree();
    const timer = window.setInterval(refresh, 1000);
    const handleVisibilityChange = () => {
      if (!document.hidden) refresh();
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [active, activeThreadId, refreshVisibleTree]);

  const selectFile = React.useCallback(
    (path: string, initialMode?: "edit" | "preview") => {
      const selectedEntry = allEntries.find((entry) => entry.path === path);
      setSelectedPath(path);
      if (selectedEntry?.type === "dir") {
        setExpanded((current) => new Set(current).add(path));
        loadDirectory(path);
        return;
      }
      if (!activeThreadId) return;

      const openFile = openFilesRef.current.find((item) => item.path === path);
      if (loadingPaths.has(path)) return;
      if (openFile) {
        setActiveFilePath(path);
        setOpenFiles((current) =>
          current.map((item) =>
            item.path === path && initialMode ? { ...item, viewMode: initialMode } : item,
          ),
        );
        return;
      }

      setLoadingPaths((current) => new Set(current).add(path));
      fetchWorkspaceFile(activeThreadId, user.id, path)
        .then((payload) => {
          const mode = payload.isBinary ? "preview" : (initialMode ?? "edit");
          setOpenFiles((current) => [
            ...current,
            { ...payload, draft: payload.content, viewMode: mode },
          ]);
          setActiveFilePath(payload.path);
        })
        .catch((error) => toastError(error, "文件读取失败"))
        .finally(() => {
          setLoadingPaths((current) => {
            const next = new Set(current);
            next.delete(path);
            return next;
          });
        });
    },
    [activeThreadId, allEntries, loadDirectory, loadingPaths, user.id],
  );

  const rawFileUrl = React.useMemo(() => {
    if (!activeThreadId || !activeFile?.path) return undefined;
    return workspaceRawFileUrl(activeThreadId, user.id, activeFile.path);
  }, [activeFile?.path, activeThreadId, user.id]);

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
      await createWorkspaceEntry(activeThreadId, user.id, path, createKind);
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

  const saveFile = React.useCallback(
    async (requestedPath = activeFilePath): Promise<boolean> => {
      const fileToSave = openFilesRef.current.find((item) => item.path === requestedPath);
      if (
        !activeThreadId ||
        !fileToSave ||
        fileToSave.draft === fileToSave.content ||
        savingPaths.has(fileToSave.path)
      ) {
        return false;
      }
      const filePath = fileToSave.path;
      const fileDraft = fileToSave.draft;
      setSavingPaths((current) => new Set(current).add(filePath));
      try {
        await saveWorkspaceFile(activeThreadId, user.id, filePath, fileDraft);
        setOpenFiles((current) =>
          current.map((item) => (item.path === filePath ? { ...item, content: fileDraft } : item)),
        );
        toast.success(`已保存 ${fileToSave.name}`);
        return true;
      } catch (error) {
        toastError(error, "保存失败");
        return false;
      } finally {
        setSavingPaths((current) => {
          const next = new Set(current);
          next.delete(filePath);
          return next;
        });
      }
    },
    [activeFilePath, activeThreadId, savingPaths, user.id],
  );

  const runFile = React.useCallback(async () => {
    if (!activeFile || savingPaths.has(activeFile.path) || !activeThreadId) return;
    if (dirty && !(await saveFile(activeFile.path))) return;
    requestTerminalCommand({ filePath: activeFile.path });
  }, [activeFile, activeThreadId, dirty, requestTerminalCommand, saveFile, savingPaths]);

  const closeFile = React.useCallback(
    (path: string) => {
      const closing = openFilesRef.current.find((item) => item.path === path);
      if (
        closing &&
        closing.draft !== closing.content &&
        !window.confirm("当前文件有未保存更改，确定关闭吗？")
      ) {
        return;
      }
      setOpenFiles((current) => {
        const index = current.findIndex((item) => item.path === path);
        const next = current.filter((item) => item.path !== path);
        if (path === activeFilePath) {
          const nextPath = next[Math.max(0, index - 1)]?.path;
          setActiveFilePath(nextPath);
          setSelectedPath(nextPath);
        }
        return next;
      });
    },
    [activeFilePath],
  );

  const updateFile = React.useCallback((path: string, update: Partial<OpenWorkspaceFile>) => {
    setOpenFiles((current) =>
      current.map((item) => (item.path === path ? { ...item, ...update } : item)),
    );
  }, []);

  if (!activeThread?.metadata.workspacePath) {
    return (
      /* 等待绑定 = 呼吸涟漪。背景层与 Empty 同级,不塞进 Empty 内部,
         否则会顶开 EmptyMedia 的居中定位 */
      <div className="relative flex h-full min-h-0 items-center justify-center overflow-hidden">
        <Ripple
          className="pointer-events-none opacity-60"
          mainCircleSize={140}
          mainCircleOpacity={0.14}
          numCircles={6}
        />
        <Empty className="relative z-10 h-full bg-transparent">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FolderTreeIcon />
            </EmptyMedia>
            <EmptyTitle>{!activeThread ? "尚未选择会话" : "未绑定工作区"}</EmptyTitle>
            <EmptyDescription>
              {!activeThread
                ? "选择或创建一个会话后,这里会显示它的工作区。"
                : "发送首条消息后,这里会显示该会话绑定的工作区。"}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    );
  }

  return (
    <ResizablePanelGroup className="min-h-0" orientation="horizontal">
      <ResizablePanel defaultSize="72%" minSize="42%">
        <PanelSurface>
          <PanelHeader className="gap-2 px-3">
            {activeFile ? (
              <FileTypeIcon name={activeFile.name} />
            ) : (
              <FileCode2Icon className="size-4 text-muted-foreground" />
            )}
            <span className="min-w-0 flex-1 truncate text-xs font-medium" title={activeFile?.path}>
              {activeFile?.path ?? "未打开文件"}
            </span>
            {dirty ? (
              <span className="size-2 shrink-0 rounded-full bg-amber-500" title="未保存" />
            ) : null}
            {activeFile && RUNNABLE_FILE.test(activeFile.path) ? (
              <Button
                aria-label="运行当前文件"
                disabled={savingPaths.has(activeFile.path)}
                onClick={() => void runFile()}
                size="icon-sm"
                title={dirty ? "保存并运行当前文件" : "运行当前文件"}
                variant="ghost"
              >
                <PlayIcon />
              </Button>
            ) : null}
            {activeFile?.viewMode === "edit" && !activeFile.isBinary ? (
              <Button
                aria-label="保存文件"
                disabled={!dirty || savingPaths.has(activeFile.path)}
                onClick={() => void saveFile()}
                size="icon-sm"
                title="保存文件 (Ctrl+S)"
                variant="ghost"
              >
                {savingPaths.has(activeFile.path) ? (
                  <Dotm3x3_1 size={14} dotSize={2.2} colorPreset="solid-theme" />
                ) : (
                  <SaveIcon />
                )}
              </Button>
            ) : null}

            {/* 编辑 / 预览 切换模式按钮组 */}
            {activeFile ? (
              <div className="flex items-center rounded-md border bg-muted/40 p-0.5">
                <Button
                  aria-label="编辑代码"
                  className={cn(
                    "h-6 gap-1 px-2 text-[11px] font-normal cursor-pointer",
                    activeFile.viewMode === "edit" && !activeFile.isBinary
                      ? "bg-background shadow-xs text-foreground font-medium"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                  disabled={activeFile.isBinary}
                  onClick={() => updateFile(activeFile.path, { viewMode: "edit" })}
                  size="sm"
                  variant="ghost"
                  title={activeFile.isBinary ? "二进制文件不支持文本编辑" : "编辑源码"}
                >
                  <Code2Icon className="size-3.5" />
                  编辑
                </Button>
                <Button
                  aria-label="预览文件"
                  className={cn(
                    "h-6 gap-1 px-2 text-[11px] font-normal cursor-pointer",
                    activeFile.viewMode === "preview" || activeFile.isBinary
                      ? "bg-background shadow-xs text-foreground font-medium"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                  onClick={() => updateFile(activeFile.path, { viewMode: "preview" })}
                  size="sm"
                  variant="ghost"
                  title="文件预览"
                >
                  <EyeIcon className="size-3.5" />
                  预览
                </Button>
              </div>
            ) : null}
          </PanelHeader>
          <ScrollArea className="shrink-0 border-b bg-muted/20">
            <div className="flex min-w-max items-center gap-1 px-2 py-1">
              {openFiles.map((item) => (
                <div className="group relative flex h-7 shrink-0 items-center" key={item.path}>
                  <button
                    className={cn(
                      "flex h-7 max-w-44 min-w-0 items-center gap-1.5 rounded-md px-2 pr-7 text-xs",
                      item.path === activeFilePath
                        ? "bg-background font-medium text-foreground shadow-xs"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground",
                    )}
                    onClick={() => {
                      setActiveFilePath(item.path);
                      setSelectedPath(item.path);
                    }}
                    title={item.path}
                    type="button"
                  >
                    <FileTypeIcon name={item.name} />
                    <span className="truncate">{item.name}</span>
                    {item.draft !== item.content ? (
                      <span className="size-1.5 rounded-full bg-amber-500" />
                    ) : null}
                  </button>
                  <button
                    aria-label={`关闭${item.name}`}
                    className="absolute right-1 rounded p-0.5 text-muted-foreground opacity-0 hover:bg-muted group-hover:opacity-100"
                    onClick={() => closeFile(item.path)}
                    type="button"
                  >
                    <XIcon className="size-3" />
                  </button>
                </div>
              ))}
            </div>
            <ScrollBar orientation="horizontal" />
          </ScrollArea>
          <div className="min-h-0 flex-1 overflow-hidden">
            {loadingPaths.size > 0 && !activeFile ? (
              <div className="flex size-full items-center justify-center text-muted-foreground">
                <Dotm3x3_1 size={20} dotSize={3} colorPreset="solid-theme" />
              </div>
            ) : activeFile ? (
              <div className="relative size-full">
                {openFiles
                  .filter((item) => !item.isBinary)
                  .map((item) => (
                    <div
                      className={cn(
                        "absolute inset-0",
                        item.path === activeFilePath && item.viewMode === "edit" && !item.isBinary
                          ? "visible"
                          : "invisible pointer-events-none",
                      )}
                      aria-hidden={
                        item.path !== activeFilePath || item.viewMode !== "edit" || item.isBinary
                      }
                      key={item.path}
                    >
                      <CodeEditor
                        activeThreadId={activeThreadId}
                        modelSelection={modelSelection}
                        onChange={(value) => updateFile(item.path, { draft: value })}
                        onSave={() => void saveFile(item.path)}
                        path={item.path}
                        resourceId={user.id}
                        value={item.draft}
                      />
                    </div>
                  ))}
                {activeFile.viewMode === "preview" || activeFile.isBinary ? (
                  <div className="absolute inset-0">
                    <WorkspaceFilePreview
                      filePath={activeFile.path}
                      fileName={activeFile.name}
                      url={rawFileUrl}
                      content={activeFile.draft}
                      isDraft={dirty}
                    />
                  </div>
                ) : null}
              </div>
            ) : (
              /* 代码编辑区空态 = 网格底纹,暗示这是等待填入代码的画布 */
              <div className="relative flex h-full min-h-0 items-center justify-center overflow-hidden">
                <GridPattern
                  className="pointer-events-none [mask-image:radial-gradient(ellipse_at_center,white,transparent_72%)] opacity-45"
                  width={28}
                  height={28}
                />
                <Empty className="relative z-10 h-full bg-transparent">
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <FileCode2Icon />
                    </EmptyMedia>
                    <EmptyTitle>尚未打开文件</EmptyTitle>
                  </EmptyHeader>
                </Empty>
              </div>
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

function CodeChangesWorkspace({ active }: { active: boolean }) {
  const { activeThreadId, fetchThreadChanges, fetchThreadChangeContent } = useWorkbench();
  const [changes, setChanges] = React.useState<WorkspaceFileChange[]>([]);
  const [expandedFiles, setExpandedFiles] = React.useState<Set<string>>(new Set());
  const [expandedChanges, setExpandedChanges] = React.useState<Set<string>>(new Set());
  const [loading, setLoading] = React.useState(false);
  const refreshRequestRef = React.useRef(0);

  const refresh = React.useCallback(async () => {
    const requestId = ++refreshRequestRef.current;
    if (!activeThreadId) {
      setChanges([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const next = await fetchThreadChanges(activeThreadId);
      if (requestId !== refreshRequestRef.current) return;
      setChanges((current) => {
        const unchanged =
          current.length === next.length &&
          current.every((item, index) => item.id === next[index]?.id);
        return unchanged ? current : next;
      });
      setExpandedFiles((current) => {
        const valid = new Set(next.map((item) => item.path));
        const kept = new Set([...current].filter((path) => valid.has(path)));
        if (kept.size === 0 && next.length > 0) kept.add(next[next.length - 1].path);
        return kept;
      });
      setExpandedChanges((current) => {
        const valid = new Set(next.map((item) => item.id));
        const kept = new Set([...current].filter((id) => valid.has(id)));
        if (kept.size === 0 && next.length > 0) kept.add(next[next.length - 1].id);
        return kept;
      });
    } finally {
      if (requestId === refreshRequestRef.current) setLoading(false);
    }
  }, [activeThreadId, fetchThreadChanges]);

  React.useEffect(() => {
    if (!active) return;
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1000);
    return () => window.clearInterval(timer);
  }, [active, refresh]);

  const orderedChanges = React.useMemo(() => [...changes].reverse(), [changes]);
  const changeGroups = React.useMemo(() => groupWorkspaceChanges(orderedChanges), [orderedChanges]);
  const fetchContent = React.useCallback(
    (changeId: string, side: "before" | "after") => {
      if (!activeThreadId) return Promise.resolve(null);
      return fetchThreadChangeContent(activeThreadId, changeId, side);
    },
    [activeThreadId, fetchThreadChangeContent],
  );
  return (
    <div className="flex size-full min-h-0 flex-col bg-muted/10">
      <PanelHeader className="h-10 shrink-0 justify-between border-b bg-muted/30 px-3">
        <div className="flex min-w-0 items-center gap-2">
          <FileDiffIcon className="size-4 shrink-0 text-muted-foreground" />
          <span className="text-xs font-medium">代码更改</span>
          <span className="text-[10px] text-muted-foreground">
            {changeGroups.length} 个文件 · {changes.length} 条记录
          </span>
        </div>
        <Button
          aria-label="刷新代码更改"
          className="size-7"
          onClick={() => void refresh()}
          size="icon"
          title="刷新代码更改"
          variant="ghost"
        >
          <RefreshCwIcon className={cn("size-3.5", loading && "animate-spin")} />
        </Button>
      </PanelHeader>
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-2 p-3">
          {!activeThreadId ? (
            <Empty className="py-12 text-muted-foreground">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <FileDiffIcon />
                </EmptyMedia>
                <EmptyTitle>选择一个会话</EmptyTitle>
                <EmptyDescription>当前会话的文件更改会显示在这里</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : orderedChanges.length === 0 ? (
            /* 变更历史空态 = 闪烁点阵网格,像一块待写入的终端屏幕 */
            <div className="relative overflow-hidden rounded-lg">
              <FlickeringGrid
                className="pointer-events-none absolute inset-0 [mask-image:radial-gradient(ellipse_at_center,white,transparent_78%)]"
                squareSize={3}
                gridGap={7}
                flickerChance={0.14}
                maxOpacity={0.22}
                color="var(--primary)"
              />
              <Empty className="relative z-10 bg-transparent py-12 text-muted-foreground">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <Code2Icon />
                  </EmptyMedia>
                  <EmptyTitle>还没有代码更改</EmptyTitle>
                  <EmptyDescription>
                    Agent 或编辑器保存文件后，历史记录会出现在这里
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            </div>
          ) : (
            changeGroups.map((group) => (
              <WorkspaceCodeChangeGroup
                expandedChanges={expandedChanges}
                group={group}
                key={group.path}
                onChangeOpen={(changeId, open) => {
                  setExpandedChanges((current) => {
                    const next = new Set(current);
                    if (open) next.add(changeId);
                    else next.delete(changeId);
                    return next;
                  });
                }}
                onOpenChange={(open) => {
                  setExpandedFiles((current) => {
                    const next = new Set(current);
                    if (open) next.add(group.path);
                    else next.delete(group.path);
                    return next;
                  });
                }}
                open={expandedFiles.has(group.path)}
                fetchContent={fetchContent}
              />
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

export function WorkspaceDrawer() {
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
        {/* 一条统一标签栏:前半是前端拥有的实例(文件树 / 终端 / 代码更改),
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
                      ) : tab.kind === "terminal" ? (
                        <TerminalIcon className="size-3.5 shrink-0" />
                      ) : (
                        <FileDiffIcon className="size-3.5 shrink-0" />
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
                            <ContextMenuItem onClick={() => addPanelTab("changes")}>
                              <FileDiffIcon className="text-muted-foreground" />
                              <span>代码更改</span>
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
              <DropdownMenuItem onClick={() => addPanelTab("changes")}>
                <FileDiffIcon />
                代码更改
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
              ) : tab.kind === "changes" ? (
                <CodeChangesWorkspace active={selected} />
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
                {/* 1. 文件浏览器 */}
                <button
                  type="button"
                  onClick={() => {
                    addPanelTab("files");
                  }}
                  className="group flex w-full items-center gap-3.5 rounded-lg p-2.5 text-left transition-colors hover:bg-muted/70 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring cursor-pointer"
                >
                  <FolderTreeIcon className="size-4 shrink-0 text-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="text-xs font-medium text-foreground">文件浏览器</span>
                      <span className="text-xs text-muted-foreground truncate">
                        浏览及管理工作区目录与代码文件
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

                {/* 4. 代码更改 */}
                <button
                  type="button"
                  onClick={() => {
                    addPanelTab("changes");
                  }}
                  className="group flex w-full items-center gap-3.5 rounded-lg p-2.5 text-left transition-colors hover:bg-muted/70 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  <FileDiffIcon className="size-4 shrink-0 text-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="text-xs font-medium text-foreground">代码更改</span>
                      <span className="truncate text-xs text-muted-foreground">
                        查看本会话线程的文件更改历史
                      </span>
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
