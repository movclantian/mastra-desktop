import {
  archivePlugin,
  audioPlugin,
  fallbackPlugin,
  imagePlugin,
  officePlugin,
  pdfPlugin,
  textPlugin,
  videoPlugin,
} from "@open-file-viewer/core";
import "@open-file-viewer/core/style.css";
import {
  autocompletion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import { jsonParseLinter } from "@codemirror/lang-json";
import { syntaxTree } from "@codemirror/language";
import { type Diagnostic, linter, lintGutter } from "@codemirror/lint";
import { search, selectNextOccurrence, selectSelectionMatches } from "@codemirror/search";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { FileViewer } from "@open-file-viewer/react";
import { langs } from "@uiw/codemirror-extensions-langs";
import CodeMirror from "@uiw/react-codemirror";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  BotIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  Code2Icon,
  CopyIcon,
  ExternalLinkIcon,
  EyeIcon,
  FileCode2Icon,
  FileDiffIcon,
  FilePlus2Icon,
  FolderPlusIcon,
  FolderTreeIcon,
  Globe2Icon,
  LoaderCircleIcon,
  MoreHorizontalIcon,
  PencilLineIcon,
  PlayIcon,
  PlusIcon,
  RefreshCwIcon,
  SaveIcon,
  SparklesIcon,
  SquareIcon,
  TerminalIcon,
  XIcon,
} from "lucide-react";
import pdfWorkerSrc from "pdfjs-dist/build/pdf.worker.mjs?url";
import * as React from "react";
import { toast } from "sonner";
import {
  FileTree,
  FileTreeActions,
  FileTreeFile,
  FileTreeFolder,
} from "@/components/ai-elements/file-tree";
import { FileTypeIcon, FolderTypeIcon } from "@/components/ai-elements/file-type-icon";
import {
  WebPreview,
  WebPreviewNavigation,
  WebPreviewNavigationButton,
  WebPreviewUrl,
} from "@/components/ai-elements/web-preview";
import { PanelHeader, PanelSurface } from "@/components/app/primitives";
import { Button } from "@/components/ui/button";
import { CodeComparison } from "@/components/ui/code-comparison";
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
import {
  type ModelSelection,
  reportWorkbenchState,
  type TreeEntry,
  useWorkbench,
  type WorkspaceFileChange,
} from "@/lib/workbench";
import { TerminalSession } from "./terminal-panel";

const NEW_BROWSER_TAB_URL = "https://www.bing.com";

const BINARY_ONLY_PREVIEWABLE_EXTS = new Set([
  "pdf",
  "docx",
  "doc",
  "xlsx",
  "xls",
  "pptx",
  "ppt",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "ico",
  "mp3",
  "wav",
  "ogg",
  "mp4",
  "webm",
  "zip",
  "tar",
  "gz",
]);

const fileViewerPlugins = [
  imagePlugin(),
  textPlugin(),
  pdfPlugin({ workerSrc: pdfWorkerSrc }),
  officePlugin({ pdf: { workerSrc: pdfWorkerSrc } }),
  audioPlugin(),
  videoPlugin(),
  archivePlugin(),
  fallbackPlugin(),
];

function getFileExtension(filename: string) {
  return filename.split(".").pop()?.toLowerCase() ?? "";
}

function isBinaryPreviewable(filename: string) {
  return BINARY_ONLY_PREVIEWABLE_EXTS.has(getFileExtension(filename));
}

function WorkspaceFilePreview({
  filePath,
  fileName,
  url,
  content,
  isDraft,
  mimeType,
}: {
  filePath: string;
  fileName: string;
  url?: string;
  content?: string;
  isDraft?: boolean;
  mimeType?: string;
}) {
  const blobUrl = React.useMemo(() => {
    if (!isDraft || content === undefined) return null;
    const ext = getFileExtension(fileName);
    const type =
      mimeType ||
      (ext === "html" || ext === "htm"
        ? "text/html;charset=utf-8"
        : ext === "svg"
          ? "image/svg+xml"
          : ext === "md" || ext === "markdown" || ext === "mdx"
            ? "text/markdown;charset=utf-8"
            : ext === "json"
              ? "application/json;charset=utf-8"
              : ext === "csv"
                ? "text/csv;charset=utf-8"
                : "text/plain;charset=utf-8");
    return URL.createObjectURL(new Blob([content], { type }));
  }, [content, fileName, isDraft, mimeType]);

  React.useEffect(() => {
    return () => {
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [blobUrl]);

  const source = blobUrl || url;
  if (!source) {
    return (
      <div className="flex size-full items-center justify-center text-xs text-muted-foreground">
        无法获取文件预览源
      </div>
    );
  }

  return (
    <div className="size-full overflow-hidden bg-background">
      <FileViewer
        key={`${filePath}-${isDraft ? "draft" : "raw"}`}
        className="size-full"
        file={source}
        fileName={fileName}
        mimeType={mimeType}
        width="100%"
        height="100%"
        fit="contain"
        fallback="inline"
        locale="zh-CN"
        plugins={fileViewerPlugins}
        toolbar={{
          zoom: true,
          rotate: true,
          download: true,
          fullscreen: true,
          print: true,
          search: true,
        }}
      />
    </div>
  );
}

function editorExtension(path: string) {
  const lower = path.toLowerCase();
  if (/\.(?:tsx)$/.test(lower)) return langs.tsx();
  if (/\.(?:ts|mts|cts)$/.test(lower)) return langs.ts();
  if (/\.(?:jsx)$/.test(lower)) return langs.jsx();
  if (/\.(?:js|mjs|cjs)$/.test(lower)) return langs.js();
  if (/\.py$/.test(lower)) return langs.python();
  if (/\.(?:json|jsonc)$/.test(lower)) return langs.json();
  if (/\.(?:md|mdx)$/.test(lower)) return langs.markdown();
  if (/\.(?:html|htm)$/.test(lower)) return langs.html();
  if (/\.css$/.test(lower)) return langs.css();
  return [];
}

function syntaxLinter(view: EditorView): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  syntaxTree(view.state)
    .cursor()
    .iterate((node) => {
      if (!node.type.isError) return;
      diagnostics.push({
        from: node.from,
        message: "语法错误",
        severity: "error",
        source: "CodeMirror",
        to: Math.max(node.to, node.from + 1),
      });
    });
  return diagnostics;
}

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
      context.addEventListener("abort", () => controller.abort(), { onDocChange: true });
      let response: Response;
      try {
        response = await fetch(
          `${MASTRA_SERVER_URL}/work/threads/${encodeURIComponent(activeThreadIdRef.current)}/inline-completion?resourceId=${encodeURIComponent(resourceIdRef.current)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: controller.signal,
            body: JSON.stringify({
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
            }),
          },
        );
      } catch {
        return null;
      }
      if (context.aborted) return null;
      if (!response.ok) return null;
      const payload = (await response.json().catch(() => null)) as { text?: unknown } | null;
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
        const response = await fetch(
          `${MASTRA_SERVER_URL}/work/threads/${encodeURIComponent(threadId)}/inline-edit?resourceId=${encodeURIComponent(resourceIdRef.current)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: controller.signal,
            body: JSON.stringify({
              path: pathRef.current,
              language: getFileExtension(pathRef.current),
              selectedText,
              beforeContext: includeContext
                ? documentText.slice(
                    Math.max(0, currentSelection.from - 2_000),
                    currentSelection.from,
                  )
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
            }),
          },
        );
        const payload = (await response.json().catch(() => null)) as {
          text?: unknown;
          error?: unknown;
        } | null;
        if (!response.ok) {
          throw new Error(typeof payload?.error === "string" ? payload.error : "内联修改请求失败");
        }
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
          changes: { from: currentSelection.from, to: currentSelection.to, insert: replacement },
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
          run: (view) => selectNextOccurrence({ state: view.state, dispatch: view.dispatch }),
        },
        {
          key: "Mod-Shift-l",
          run: (view) => selectSelectionMatches({ state: view.state, dispatch: view.dispatch }),
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
                {aiBusy ? <LoaderCircleIcon className="animate-spin" /> : <SparklesIcon />}
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
            {aiBusy ? <LoaderCircleIcon className="animate-spin" /> : <SparklesIcon />}
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
      fetch(
        `${MASTRA_SERVER_URL}/work/threads/${activeThreadId}/file?resourceId=${encodeURIComponent(user.id)}&path=${encodeURIComponent(path)}`,
      )
        .then(async (response) => {
          const payload = (await response.json()) as WorkspaceFilePayload & {
            error?: string;
          };
          if (!response.ok) throw new Error(payload.error || "文件读取失败");
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
    return `${MASTRA_SERVER_URL}/work/threads/${activeThreadId}/raw?resourceId=${encodeURIComponent(user.id)}&path=${encodeURIComponent(activeFile.path)}`;
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
        const response = await fetch(
          `${MASTRA_SERVER_URL}/work/threads/${activeThreadId}/file?resourceId=${encodeURIComponent(user.id)}&path=${encodeURIComponent(filePath)}`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content: fileDraft }),
          },
        );
        const payload = (await response.json()) as { error?: string };
        if (!response.ok) throw new Error(payload.error || "保存失败");
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
      <Empty className="h-full">
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
                  <LoaderCircleIcon className="animate-spin" />
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
                <LoaderCircleIcon className="size-5 animate-spin" />
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

const CHANGE_LANGUAGE_BY_EXTENSION: Record<string, string> = {
  css: "css",
  html: "html",
  js: "javascript",
  jsx: "javascript",
  json: "json",
  md: "markdown",
  mdx: "markdown",
  py: "python",
  ts: "typescript",
  tsx: "typescript",
};

function changeLanguage(path: string): string {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  return CHANGE_LANGUAGE_BY_EXTENSION[extension] ?? "text";
}

function changeLabel(change: WorkspaceFileChange): string {
  if (change.kind === "created") return "新增";
  if (change.kind === "deleted") return "删除";
  return "修改";
}

interface WorkspaceChangeGroup {
  path: string;
  changes: WorkspaceFileChange[];
}

function groupWorkspaceChanges(changes: WorkspaceFileChange[]): WorkspaceChangeGroup[] {
  const groups = new Map<string, WorkspaceChangeGroup>();
  for (const change of changes) {
    const group = groups.get(change.path);
    if (group) {
      group.changes.push(change);
    } else {
      groups.set(change.path, { path: change.path, changes: [change] });
    }
  }
  return [...groups.values()];
}

function CodeChangeRow({
  change,
  open,
  onOpenChange,
}: {
  change: WorkspaceFileChange;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const ChangeIcon =
    change.kind === "created" ? CheckCircle2Icon : change.kind === "deleted" ? XIcon : FileDiffIcon;
  const before = change.before ?? "";
  const after = change.after ?? "";
  const timestamp = new Date(change.createdAt);
  return (
    <Collapsible
      className="group/collapsible rounded-md border bg-background"
      onOpenChange={onOpenChange}
      open={open}
    >
      <CollapsibleTrigger className="group sticky top-0 z-10 flex w-full min-w-0 items-center gap-2 border-b bg-background/95 px-2.5 py-2 text-left shadow-sm backdrop-blur supports-[backdrop-filter]:bg-background/80 hover:bg-muted/80">
        <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-open/collapsible:rotate-180" />
        <ChangeIcon
          className={cn(
            "size-3.5 shrink-0",
            change.kind === "created"
              ? "text-emerald-600 dark:text-emerald-400"
              : change.kind === "deleted"
                ? "text-red-600 dark:text-red-400"
                : "text-amber-600 dark:text-amber-400",
          )}
        />
        <span className="min-w-0 flex-1 truncate text-xs">
          <span className="font-medium">{changeLabel(change)}</span>
          <span className="ml-2 font-mono text-muted-foreground">
            {change.toolName.replace(/^mastra_workspace_/, "")}
          </span>
        </span>
        <time className="shrink-0 text-[10px] text-muted-foreground" dateTime={change.createdAt}>
          {Number.isNaN(timestamp.getTime())
            ? ""
            : timestamp.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
        </time>
      </CollapsibleTrigger>
      <CollapsibleContent className="border-t p-2">
        <CodeComparison
          afterCode={after}
          beforeCode={before}
          filename={change.path}
          language={changeLanguage(change.path)}
        />
        <div className="mt-2 flex items-center gap-1.5 px-1 text-[10px] text-muted-foreground">
          <Code2Icon className="size-3" />
          <span>{change.toolName.replace(/^mastra_workspace_/, "")}</span>
          {change.toolCallId ? (
            <span className="truncate font-mono">{change.toolCallId}</span>
          ) : null}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function CodeChangeGroup({
  group,
  open,
  onOpenChange,
  expandedChanges,
  onChangeOpen,
}: {
  group: WorkspaceChangeGroup;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  expandedChanges: Set<string>;
  onChangeOpen: (changeId: string, open: boolean) => void;
}) {
  const latest = group.changes[0];
  const LatestIcon =
    latest.kind === "created" ? CheckCircle2Icon : latest.kind === "deleted" ? XIcon : FileDiffIcon;
  const latestTimestamp = new Date(latest.createdAt);
  return (
    <Collapsible
      className="rounded-md border bg-background"
      onOpenChange={onOpenChange}
      open={open}
    >
      <CollapsibleTrigger className="group flex w-full min-w-0 items-center gap-2 px-2.5 py-2 text-left hover:bg-muted/40">
        <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-open/collapsible:rotate-180" />
        <LatestIcon
          className={cn(
            "size-3.5 shrink-0",
            latest.kind === "created"
              ? "text-emerald-600 dark:text-emerald-400"
              : latest.kind === "deleted"
                ? "text-red-600 dark:text-red-400"
                : "text-amber-600 dark:text-amber-400",
          )}
        />
        <span className="min-w-0 flex-1 truncate font-mono text-xs" title={group.path}>
          {group.path}
        </span>
        <span className="shrink-0 text-[10px] text-muted-foreground">
          {group.changes.length} 次变更
        </span>
        <time className="shrink-0 text-[10px] text-muted-foreground" dateTime={latest.createdAt}>
          {Number.isNaN(latestTimestamp.getTime())
            ? ""
            : latestTimestamp.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
        </time>
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-2 border-t p-2">
        {group.changes.map((change) => (
          <CodeChangeRow
            change={change}
            key={change.id}
            onOpenChange={(nextOpen) => onChangeOpen(change.id, nextOpen)}
            open={expandedChanges.has(change.id)}
          />
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}

function CodeChangesWorkspace({ active }: { active: boolean }) {
  const { activeThreadId, fetchThreadChanges } = useWorkbench();
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
            <Empty className="py-12 text-muted-foreground">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Code2Icon />
                </EmptyMedia>
                <EmptyTitle>还没有代码更改</EmptyTitle>
                <EmptyDescription>Agent 或编辑器保存文件后，历史记录会出现在这里</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            changeGroups.map((group) => (
              <CodeChangeGroup
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
              />
            ))
          )}
        </div>
      </ScrollArea>
    </div>
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
    const controller = new AbortController();
    let disposed = false;
    void (async () => {
      const response = await fetch(browserUrl("/screencast"), { signal: controller.signal });
      if (!response.ok || !response.body) throw new Error("浏览器画面连接失败");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        while (!disposed) {
          const { value, done } = await reader.read();
          buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
          let boundary = buffer.indexOf("\n\n");
          while (boundary >= 0) {
            const block = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const eventName = block.match(/^event:\s*(.+)$/m)?.[1]?.trim() ?? "message";
            const data = block
              .split(/\r?\n/)
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trimStart())
              .join("\n");
            if (eventName === "frame") {
              setFrame(JSON.parse(data) as typeof frame);
              setFrameState("connected");
            } else if (eventName === "url") {
              const payload = JSON.parse(data) as { url?: string };
              if (typeof payload.url === "string") {
                setState((current) => ({ ...current, currentUrl: payload.url ?? null }));
              }
            } else if (eventName === "stop") {
              return;
            } else if (eventName === "error") {
              throw new Error("浏览器画面流发生错误");
            }
            boundary = buffer.indexOf("\n\n");
          }
          if (done) return;
        }
      } finally {
        reader.releaseLock();
      }
    })().catch(() => {
      if (!disposed) setFrameState("error");
    });
    return () => {
      disposed = true;
      controller.abort();
    };
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
