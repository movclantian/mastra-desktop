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
import { useQueryClient } from "@tanstack/react-query";
import { useRouterState } from "@tanstack/react-router";
import CodeMirror from "@uiw/react-codemirror";
import {
  Code2Icon,
  CopyIcon,
  EyeIcon,
  FileCode2Icon,
  FilePlus2Icon,
  FolderPlusIcon,
  FolderTreeIcon,
  FoldVerticalIcon,
  MoreHorizontalIcon,
  PanelRightCloseIcon,
  PencilLineIcon,
  PlayIcon,
  PlusIcon,
  RefreshCwIcon,
  SaveIcon,
  SparklesIcon,
  UnfoldVerticalIcon,
  XIcon,
} from "lucide-react";
import * as React from "react";
import { usePanelRef } from "react-resizable-panels";
import { toast } from "sonner";
import {
  createWorkspaceEntry,
  fetchTree,
  fetchWorkspaceFile,
  type ModelSelection,
  reportWorkbenchState,
  saveWorkspaceFile,
  type TreeEntry,
  workspaceRawFileUrl,
} from "@/entities/workbench";
import { useThreadsQuery } from "@/entities/workbench/model/queries/threads";
import { qk } from "@/entities/workbench/model/query-keys";
import { useWorkbenchStore } from "@/entities/workbench/model/workbench-store";
import { useAuth } from "@/features/auth";
import { useTranslation } from "@/shared/i18n";
import { cn, setWorkspaceDraftState, toastError } from "@/shared/lib";
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
import { GridPattern } from "@/shared/ui/grid-pattern";
import { Input } from "@/shared/ui/input";
import { PanelHeader, PanelSurface } from "@/shared/ui/panel";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/shared/ui/resizable";
import { Ripple } from "@/shared/ui/ripple";
import { ScrollArea, ScrollBar } from "@/shared/ui/scroll-area";

import { fetchInlineCompletion, requestInlineEdit } from "../api/editor-api";
import {
  editorExtension,
  getFileExtension,
  isBinaryPreviewable,
  syntaxLinter,
} from "../lib/editor";
import { WorkspaceFilePreview } from "./file-preview";

function treeHandleProps(open: boolean) {
  return {
    disabled: !open,
    className: open
      ? "transition-colors hover:bg-primary"
      : "pointer-events-none !w-0 !border-0 opacity-0",
  };
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
  const { t } = useTranslation();
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
      const from = token ? token.from : position;
      const controller = new AbortController();
      context.addEventListener("abort", () => controller.abort(), {
        onDocChange: true,
      });
      let payload: { text?: unknown } | null = null;
      try {
        payload = await fetchInlineCompletion({
          threadId: activeThreadIdRef.current,
          resourceId: resourceIdRef.current,
          path: pathRef.current,
          language: getFileExtension(pathRef.current),
          prefix: context.state.sliceDoc(Math.max(0, position - 4_000), position),
          beforeContext: context.state.sliceDoc(0, position),
          afterContext: context.state.sliceDoc(
            position,
            Math.min(context.state.doc.length, position + 4_000),
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
            detail: modelSelectionRef.current?.modelName ?? t("workspace:currentModel"),
            label: `AI ${firstLine.slice(0, 72) || t("workspace:aiCompletion")}`,
            type: "text",
          },
        ],
        validFor: /^[\w$-]*$/,
      };
    },
    [t],
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
        toast.error(t("workspace:selectionChanged"));
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
            requestedInstruction?.trim() || instruction.trim() || t("workspace:defaultInstruction"),
          modelSelection: modelSelectionRef.current
            ? {
                providerId: modelSelectionRef.current.providerId,
                modelId: modelSelectionRef.current.modelId,
              }
            : undefined,
          signal: controller.signal,
        });
        if (typeof payload?.text !== "string" || !payload.text.trim()) {
          throw new Error(t("workspace:noReplacementCode"));
        }

        const replacement = payload.text;
        const latestDocument = current.state.doc.toString();
        const latestSelection = current.state.selection.main;
        if (
          latestDocument.slice(currentSelection.from, currentSelection.to) !== selectedText ||
          latestSelection.from !== currentSelection.from ||
          latestSelection.to !== currentSelection.to
        ) {
          throw new Error(t("workspace:selectionChangedNotApplied"));
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
          toastError(error, t("workspace:inlineModifyFailed"));
        }
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
        setAiBusy(false);
      }
    },
    [aiBusy, includeContext, instruction, selection, t],
  );

  const modelLabel = modelSelection?.modelName || t("workspace:currentModel");
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
          aria-label={t("workspace:codeInlineActionAria")}
          className="absolute z-20 flex max-w-[min(32rem,calc(100%-1rem))] items-center gap-1 overflow-hidden rounded-md border bg-popover/95 p-1 text-xs shadow-md backdrop-blur"
          onMouseDown={(event) => event.stopPropagation()}
          role="toolbar"
          style={{ left: selection.left, top: selection.top }}
        >
          <Button
            aria-label={
              includeContext ? t("workspace:closeContext") : t("workspace:includeContext")
            }
            className={cn("size-6", includeContext && "bg-muted text-foreground")}
            onClick={() => setIncludeContext((current) => !current)}
            size="icon-xs"
            title={includeContext ? t("workspace:closeContext") : t("workspace:includeContext")}
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
                placeholder={t("workspace:describeInlineChange")}
                value={instruction}
              />
              <Button
                aria-label={t("workspace:submitInlineChange")}
                disabled={aiBusy || !activeThreadId}
                size="icon-xs"
                title={t("workspace:submitInlineChange")}
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
              aria-label={t("workspace:inputInlineRequirement")}
              disabled={aiBusy}
              onClick={() => setPromptOpen(true)}
              size="icon-xs"
              title={t("workspace:inputInlineRequirement")}
              variant="ghost"
            >
              <PencilLineIcon />
            </Button>
          )}
          <Button
            aria-label={t("workspace:useAiToModify")}
            disabled={aiBusy || !activeThreadId}
            onClick={() => void runInlineEdit()}
            size="icon-xs"
            title={
              activeThreadId
                ? t("workspace:modifyWithCurrentModel")
                : t("workspace:pleaseSelectSession")
            }
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
            aria-label={t("workspace:closeInlineBar")}
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
            title={t("common:close")}
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
        placeholder={kind === "dir" ? t("workspace:folderName") : t("workspace:fileName")}
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
  const { t } = useTranslation();
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
              <span>{t("workspace:newFile")}</span>
            </ContextMenuItem>
            <ContextMenuItem onClick={() => onCreateInDirectory?.(entry.path, "dir")}>
              <FolderPlusIcon className="text-muted-foreground" />
              <span>{t("workspace:newFolder")}</span>
            </ContextMenuItem>
          </ContextMenuGroup>
          <ContextMenuSeparator />
          <ContextMenuGroup>
            <ContextMenuItem
              onClick={() => {
                void navigator.clipboard.writeText(entry.path);
                toast.success(t("workspace:copiedRelativePath"));
              }}
            >
              <CopyIcon className="text-muted-foreground" />
              <span>{t("workspace:copyRelativePath")}</span>
            </ContextMenuItem>
            {workspacePath ? (
              <ContextMenuItem
                onClick={() => {
                  const full = `${workspacePath}/${entry.path}`.replace(/\\/g, "/");
                  void navigator.clipboard.writeText(full);
                  toast.success(t("workspace:copiedFullPath"));
                }}
              >
                <CopyIcon className="text-muted-foreground" />
                <span>{t("workspace:copyFullPath")}</span>
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
                title={t("workspace:previewDirectly")}
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
              <span>{t("workspace:previewDirectly")}</span>
            </ContextMenuItem>
            {!isBinaryPreviewable(entry.name) ? (
              <ContextMenuItem onClick={() => onSelectFile?.(entry.path, "edit")}>
                <FileCode2Icon className="text-muted-foreground" />
                <span>{t("workspace:openInEditor")}</span>
              </ContextMenuItem>
            ) : null}
            {RUNNABLE_FILE.test(entry.path) ? (
              <ContextMenuItem onClick={() => onRunFile?.(entry.path)}>
                <PlayIcon className="text-muted-foreground" />
                <span>{t("workspace:runFile")}</span>
              </ContextMenuItem>
            ) : null}
          </ContextMenuGroup>
          <ContextMenuSeparator />
          <ContextMenuGroup>
            <ContextMenuItem
              onClick={() => {
                void navigator.clipboard.writeText(entry.path);
                toast.success(t("workspace:copiedRelativePath"));
              }}
            >
              <CopyIcon className="text-muted-foreground" />
              <span>{t("workspace:copyRelativePath")}</span>
            </ContextMenuItem>
            {workspacePath ? (
              <ContextMenuItem
                onClick={() => {
                  const full = `${workspacePath}/${entry.path}`.replace(/\\/g, "/");
                  void navigator.clipboard.writeText(full);
                  toast.success(t("workspace:copiedFullPath"));
                }}
              >
                <CopyIcon className="text-muted-foreground" />
                <span>{t("workspace:copyFullPath")}</span>
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

function areTreeEntriesEqual(a: TreeEntry[] | undefined, b: TreeEntry[] | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i];
    const bi = b[i];
    if (
      ai.name !== bi.name ||
      ai.path !== bi.path ||
      ai.type !== bi.type ||
      ai.hidden !== bi.hidden
    ) {
      return false;
    }
  }
  return true;
}

/**
 * 文件树 + 编辑器。可多开 —— 每个标签一个独立实例,各自持有展开态与打开的文件。
 *
 * active:只有激活的那个实例上报 editor state lane。多实例同时上报会在同一条
 * lane 上互相覆盖,模型看到的「当前打开的文件」会在几个标签之间来回跳。
 */
export function FilesWorkspace({ active, tabId }: { active: boolean; tabId: string }) {
  const { t } = useTranslation();
  const { user: authUser } = useAuth();
  const user = authUser ?? { id: "anonymous", name: "Guest", email: "guest@example.com" };
  const userId = user.id;
  const queryClient = useQueryClient();
  const activeThreadId = useRouterState({
    select: (state) => (state.location.search as { thread?: string }).thread ?? null,
  });
  const threads = useThreadsQuery(userId).data ?? [];
  const modelSelection = useWorkbenchStore((state) => state.modelSelection);
  const requestTerminalCommand = useWorkbenchStore((state) => state.requestTerminalCommand);
  const fetchTreeEntries = React.useCallback(
    (threadId: string, path?: string) =>
      queryClient.fetchQuery({
        queryKey: qk.treeEntries(threadId, path ?? ""),
        queryFn: () => fetchTree(threadId, userId, path),
        staleTime: 10_000,
      }),
    [queryClient, userId],
  );
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
  const [treeOpen, setTreeOpen] = React.useState(true);
  const treePanelRef = usePanelRef();
  const draftOwnerId = tabId;

  React.useEffect(() => {
    const panel = treePanelRef.current;
    if (!panel) return;
    if (treeOpen) {
      if (panel.isCollapsed()) panel.expand();
    } else {
      if (!panel.isCollapsed()) panel.collapse();
    }
  }, [treeOpen]);

  React.useEffect(() => {
    openFilesRef.current = openFiles;
  }, [openFiles]);

  React.useEffect(() => {
    if (!activeThreadId) return;
    setWorkspaceDraftState(
      activeThreadId,
      draftOwnerId,
      openFiles.some((item) => item.draft !== item.content),
    );
    return () => setWorkspaceDraftState(activeThreadId, draftOwnerId, false);
  }, [activeThreadId, draftOwnerId, openFiles]);

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
    if (!active || !activeThreadId) return;
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

  const collapseAll = React.useCallback(() => {
    setExpanded(new Set());
  }, []);

  const expandAll = React.useCallback(() => {
    const allDirPaths = allEntries
      .filter((entry) => entry.type === "dir")
      .map((entry) => entry.path);
    setExpanded(new Set(allDirPaths));
    for (const dirPath of allDirPaths) loadDirectory(dirPath);
  }, [allEntries, loadDirectory]);

  const toggleExpandAll = React.useCallback(() => {
    if (expanded.size > 0) {
      collapseAll();
    } else {
      expandAll();
    }
  }, [collapseAll, expandAll, expanded.size]);

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
      if (rootEntries) {
        setEntries((current) =>
          areTreeEntriesEqual(current, rootEntries) ? current : rootEntries,
        );
      }
      setChildrenByPath((current) => {
        let changed = false;
        const next = { ...current };
        for (const [path, nextEntries] of visibleEntries) {
          if (path) {
            if (!areTreeEntriesEqual(current[path], nextEntries)) {
              next[path] = nextEntries;
              changed = true;
            }
          }
        }
        return changed ? next : current;
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
        .catch((error) => toastError(error, t("workspace:readFileFailed")))
        .finally(() => {
          setLoadingPaths((current) => {
            const next = new Set(current);
            next.delete(path);
            return next;
          });
        });
    },
    [activeThreadId, allEntries, loadDirectory, loadingPaths, user.id, t],
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
      toast.error(t("workspace:nameCannotContainSeparators"));
      return;
    }
    const path = createDirectory ? `${createDirectory}/${name}` : name;
    try {
      await createWorkspaceEntry(activeThreadId, user.id, path, createKind);
      toast.success(
        createKind === "dir"
          ? t("workspace:createdDir", { name })
          : t("workspace:createdFile", { name }),
      );
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
      toastError(
        error,
        createKind === "dir" ? t("workspace:createDirFailed") : t("workspace:createFileFailed"),
      );
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
    t,
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
        toast.success(t("workspace:savedFile", { name: fileToSave.name }));
        return true;
      } catch (error) {
        toastError(error, t("workspace:saveFailed"));
        return false;
      } finally {
        setSavingPaths((current) => {
          const next = new Set(current);
          next.delete(filePath);
          return next;
        });
      }
    },
    [activeFilePath, activeThreadId, savingPaths, user.id, t],
  );

  const runFile = React.useCallback(async () => {
    if (!activeFile || savingPaths.has(activeFile.path) || !activeThreadId) return;
    if (dirty && !(await saveFile(activeFile.path))) return;
    requestTerminalCommand({ filePath: activeFile.path });
  }, [activeFile, activeThreadId, dirty, requestTerminalCommand, saveFile, savingPaths]);

  const closeFile = React.useCallback(
    async (path: string) => {
      const closing = openFilesRef.current.find((item) => item.path === path);
      if (closing?.draft !== closing?.content) {
        if (!window.confirm(t("workspace:unsavedConfirm"))) return;
        if (!(await saveFile(path))) return;
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
    [activeFilePath, saveFile],
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
            <EmptyTitle>
              {!activeThread ? t("workspace:notSelectedSession") : t("workspace:notBoundWorkspace")}
            </EmptyTitle>
            <EmptyDescription>
              {!activeThread
                ? t("workspace:selectOrCreateSessionDesc")
                : t("workspace:sendFirstMessageDesc")}
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
          <PanelHeader className="h-10 gap-2 px-3">
            {activeFile ? (
              <FileTypeIcon name={activeFile.name} />
            ) : (
              <FileCode2Icon className="size-4 text-muted-foreground" />
            )}
            <span className="min-w-0 flex-1 truncate text-xs font-medium" title={activeFile?.path}>
              {activeFile?.path ?? t("workspace:noFileOpened")}
            </span>
            {dirty ? (
              <span
                className="size-2 shrink-0 rounded-full bg-amber-500"
                title={t("workspace:unSaved")}
              />
            ) : null}
            {activeFile && RUNNABLE_FILE.test(activeFile.path) ? (
              <Button
                aria-label={
                  dirty ? t("workspace:saveAndRunCurrentFile") : t("workspace:runCurrentFile")
                }
                disabled={savingPaths.has(activeFile.path)}
                onClick={() => void runFile()}
                size="icon-sm"
                title={dirty ? t("workspace:saveAndRunCurrentFile") : t("workspace:runCurrentFile")}
                variant="ghost"
              >
                <PlayIcon />
              </Button>
            ) : null}
            {activeFile?.viewMode === "edit" && !activeFile.isBinary ? (
              <Button
                aria-label={t("workspace:saveFile")}
                disabled={!dirty || savingPaths.has(activeFile.path)}
                onClick={() => void saveFile()}
                size="icon-sm"
                title={t("workspace:saveFileShortcut")}
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
                  aria-label={t("workspace:editCode")}
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
                  title={
                    activeFile.isBinary
                      ? t("workspace:binaryNotEditable")
                      : t("workspace:editSource")
                  }
                >
                  <Code2Icon className="size-3.5" />
                  {t("common:edit")}
                </Button>
                <Button
                  aria-label={t("workspace:previewFile")}
                  className={cn(
                    "h-6 gap-1 px-2 text-[11px] font-normal cursor-pointer",
                    activeFile.viewMode === "preview" || activeFile.isBinary
                      ? "bg-background shadow-xs text-foreground font-medium"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                  onClick={() => updateFile(activeFile.path, { viewMode: "preview" })}
                  size="sm"
                  variant="ghost"
                  title={t("workspace:previewFile")}
                >
                  <EyeIcon className="size-3.5" />
                  {t("workspace:previewFile")}
                </Button>
              </div>
            ) : null}

            {/* 关闭当前文件 */}
            {activeFile ? (
              <Button
                aria-label={t("workspace:closeFile")}
                className="size-7 shrink-0 text-muted-foreground hover:text-foreground"
                onClick={() => void closeFile(activeFile.path)}
                size="icon-sm"
                title={t("workspace:closeFile")}
                variant="ghost"
              >
                <XIcon className="size-3.5" />
              </Button>
            ) : null}

            {/* 展开文件目录树:仅在目录树收起时显示,展开后迁移至目录树头部(原收起按钮位置) */}
            {!treeOpen ? (
              <Button
                aria-label={t("workspace:expandFileTree")}
                className="size-7 shrink-0 text-muted-foreground hover:text-foreground"
                onClick={() => setTreeOpen(true)}
                size="icon-sm"
                title={t("workspace:expandFileTree")}
                variant="ghost"
              >
                <FolderTreeIcon className="size-3.5" />
              </Button>
            ) : null}
          </PanelHeader>
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
                    <EmptyTitle>{t("workspace:noFileOpened")}</EmptyTitle>
                  </EmptyHeader>
                </Empty>
              </div>
            )}
          </div>
        </PanelSurface>
      </ResizablePanel>
      <ResizableHandle {...treeHandleProps(treeOpen)} />
      <ResizablePanel
        panelRef={treePanelRef}
        collapsible
        collapsedSize={0}
        defaultSize="28%"
        minSize="20%"
        maxSize="46%"
        groupResizeBehavior="preserve-pixel-size"
        onResize={(panelSize) => setTreeOpen(panelSize.asPercentage > 0)}
      >
        <aside className={cn("flex size-full min-w-0 flex-col bg-muted/20", !treeOpen && "hidden")}>
          <PanelHeader className="h-10 bg-muted/60 px-3 text-xs font-medium">
            <FolderTreeIcon className="size-4 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate" title={activeThread.metadata.workspacePath}>
              {activeThread.metadata.workspacePath
                ?.replaceAll("\\", "/")
                .split("/")
                .filter(Boolean)
                .at(-1)}
            </span>

            {/* 更多文件管理操作 */}
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    aria-label={t("workspace:fileManagementActions")}
                    className="size-7 shrink-0 text-muted-foreground hover:text-foreground"
                    size="icon-sm"
                    title={t("workspace:fileManagementActions")}
                    variant="ghost"
                  />
                }
              >
                <MoreHorizontalIcon className="size-3.5" />
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
                  {t("workspace:newFile")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => {
                    setCreateKind("dir");
                    setCreateName("");
                  }}
                >
                  <FolderPlusIcon />
                  {t("workspace:newFolder")}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={collapseAll}>
                  <FoldVerticalIcon />
                  {t("workspace:collapseAll")}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={expandAll}>
                  <UnfoldVerticalIcon />
                  {t("workspace:expandAll")}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => void refreshTree()}>
                  <RefreshCwIcon className={cn(treeLoading && "animate-spin")} />
                  {t("common:refresh")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            {/* 全部折叠 / 全部展开 目录树节点快捷按钮 */}
            <Button
              aria-label={
                expanded.size > 0 ? t("workspace:collapseAllDirs") : t("workspace:expandAllDirs")
              }
              className="size-7 shrink-0 text-muted-foreground hover:text-foreground"
              onClick={toggleExpandAll}
              size="icon-sm"
              title={expanded.size > 0 ? t("workspace:collapseAll") : t("workspace:expandAll")}
              variant="ghost"
            >
              {expanded.size > 0 ? (
                <FoldVerticalIcon className="size-3.5" />
              ) : (
                <UnfoldVerticalIcon className="size-3.5" />
              )}
            </Button>

            {/* 收起文件目录树面板:控件随容器迁移至此,点击收起后迁移回编辑器顶栏 */}
            <Button
              aria-label={t("workspace:collapseFileTree")}
              className="size-7 shrink-0 text-muted-foreground hover:text-foreground"
              onClick={() => setTreeOpen(false)}
              size="icon-sm"
              title={t("workspace:collapseFileTree")}
              variant="ghost"
            >
              <PanelRightCloseIcon className="size-3.5" />
            </Button>
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
                <p className="px-2 py-2 text-xs text-muted-foreground">
                  {t("workspace:readingDir")}
                </p>
              ) : entries.length === 0 && !createKind ? (
                <p className="px-2 py-2 text-xs text-muted-foreground">{t("workspace:emptyDir")}</p>
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
