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
  ExternalLinkIcon,
  FileCode2Icon,
  FolderTreeIcon,
  Globe2Icon,
  LoaderCircleIcon,
  PlayIcon,
  PlusIcon,
  RefreshCwIcon,
  SaveIcon,
  SquareIcon,
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
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { MASTRA_SERVER_URL } from "@/lib/providers";
import { cn } from "@/lib/utils";
import { type TreeEntry, useWorkbench } from "@/lib/workbench";

function editorExtension(path: string) {
  const lower = path.toLowerCase();
  if (/\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts)$/.test(lower)) {
    return javascript({ jsx: /x$/.test(lower), typescript: /\.(?:ts|tsx|mts|cts)$/.test(lower) });
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
            "&": { height: "100%", backgroundColor: "transparent", fontSize: "13px" },
            ".cm-scroller": { overflow: "auto", fontFamily: "var(--font-mono)" },
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
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
  }, [value]);

  return <div className="size-full overflow-hidden" ref={hostRef} />;
}

function TreeRows({
  entries,
  childrenByPath,
}: {
  entries: TreeEntry[];
  childrenByPath: Record<string, TreeEntry[]>;
}) {
  return entries.map((entry) =>
    entry.type === "dir" ? (
      <FileTreeFolder
        className={cn(entry.hidden && "opacity-65")}
        icon={<FolderTypeIcon name={entry.name} />}
        key={entry.path}
        name={entry.name}
        openIcon={<FolderTypeIcon name={entry.name} open />}
        path={entry.path}
      >
        <TreeRows entries={childrenByPath[entry.path] ?? []} childrenByPath={childrenByPath} />
      </FileTreeFolder>
    ) : (
      <FileTreeFile
        className={cn(entry.hidden && "opacity-65")}
        icon={<FileTypeIcon name={entry.name} />}
        key={entry.path}
        name={entry.name}
        path={entry.path}
      />
    ),
  );
}

const RUNNABLE_FILE = /\.(?:[cm]?js|[cm]?ts|py|ps1|sh)$/i;

function FilesWorkspace() {
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
  const [saving, setSaving] = React.useState(false);
  const loadedPathsRef = React.useRef(new Set<string>());
  const dirty = file ? draft !== file.content : false;

  React.useEffect(() => {
    setEntries([]);
    setChildrenByPath({});
    setExpanded(new Set());
    setSelectedPath(undefined);
    setFile(undefined);
    setDraft("");
    loadedPathsRef.current = new Set();
    if (!activeThreadId || activeThread?.metadata.workspaceExplicit !== true) return;
    void fetchTreeEntries(activeThreadId).then(setEntries);
  }, [activeThread?.metadata.workspaceExplicit, activeThreadId, fetchTreeEntries]);

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
      const allEntries = [entries, ...Object.values(childrenByPath)].flat();
      if (allEntries.find((entry) => entry.path === path)?.type === "dir") return;
      if (dirty && !window.confirm("当前文件有未保存更改，是否放弃并打开其他文件？")) return;
      if (!activeThreadId) return;
      setSelectedPath(path);
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
        .catch((error) => toast.error(error instanceof Error ? error.message : "文件读取失败"))
        .finally(() => setLoading(false));
    },
    [activeThreadId, childrenByPath, dirty, entries, user.id],
  );

  const saveFile = React.useCallback(async () => {
    if (!activeThreadId || !file || !dirty || saving) return;
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
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }, [activeThreadId, dirty, draft, file, saving, user.id]);

  if (activeThread?.metadata.workspaceExplicit !== true) {
    return (
      <Empty className="h-full">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <FolderTreeIcon />
          </EmptyMedia>
          <EmptyTitle>未绑定可浏览工作区</EmptyTitle>
          <EmptyDescription>当前会话没有显式工作区。</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <ResizablePanelGroup className="min-h-0" orientation="horizontal">
      <ResizablePanel defaultSize="72%" minSize="42%">
        <section className="flex size-full min-w-0 flex-col bg-background">
          <header className="flex h-10 shrink-0 items-center gap-2 border-b px-3">
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
                disabled={dirty || saving}
                onClick={() => requestTerminalCommand({ filePath: file.path })}
                size="icon-sm"
                title={dirty ? "保存后运行" : "运行当前文件"}
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
          </header>
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
        </section>
      </ResizablePanel>
      <ResizableHandle />
      <ResizablePanel defaultSize="28%" minSize="22%" maxSize="46%">
        <aside className="flex size-full min-w-0 flex-col bg-muted/20">
          <div className="flex h-10 shrink-0 items-center gap-2 border-b px-3 text-xs font-medium">
            <FolderTreeIcon className="size-4 text-muted-foreground" />
            <span className="truncate" title={activeThread.metadata.workspacePath}>
              {activeThread.metadata.workspacePath
                ?.replaceAll("\\", "/")
                .split("/")
                .filter(Boolean)
                .at(-1)}
            </span>
          </div>
          <ScrollArea className="min-h-0 flex-1">
            <FileTree
              className="min-w-max rounded-none border-0 bg-transparent text-xs"
              expanded={expanded}
              onExpandedChange={handleExpandedChange}
              onSelect={selectFile}
              selectedPath={selectedPath}
            >
              <TreeRows childrenByPath={childrenByPath} entries={entries} />
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

function BrowserWorkspace() {
  const { activeThreadId, user } = useWorkbench();
  const [state, setState] = React.useState<BrowserState>(EMPTY_BROWSER_STATE);
  const [frame, setFrame] = React.useState<{
    data: string;
    viewport: { width: number; height: number };
  }>();
  const [busy, setBusy] = React.useState(false);
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
    void refreshState();
    if (!stateUrl) return;
    const timer = window.setInterval(() => void refreshState(), 1_500);
    return () => window.clearInterval(timer);
  }, [refreshState, stateUrl]);

  React.useEffect(() => {
    if (!stateUrl || !state.active) return;
    const source = new EventSource(browserUrl("/screencast"));
    source.addEventListener("frame", (event) => {
      setFrame(JSON.parse((event as MessageEvent<string>).data) as typeof frame);
    });
    source.addEventListener("url", (event) => {
      const { url } = JSON.parse((event as MessageEvent<string>).data) as { url: string };
      setState((current) => ({ ...current, currentUrl: url }));
    });
    source.addEventListener("stop", () => source.close());
    return () => source.close();
  }, [browserUrl, state.active, stateUrl]);

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
        toast.error(error instanceof Error ? error.message : "网页导航失败");
      } finally {
        setBusy(false);
      }
    },
    [browserUrl, refreshState, stateUrl],
  );

  const action = React.useCallback(
    async (name: string, index?: number) => {
      if (!stateUrl) return;
      setBusy(true);
      try {
        const response = await fetch(browserUrl("/action"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: name, index }),
        });
        const payload = (await response.json()) as { error?: string; state?: BrowserState };
        if (!response.ok) throw new Error(payload.error || "浏览器操作失败");
        if (payload.state) setState(payload.state);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "浏览器操作失败");
      } finally {
        setBusy(false);
      }
    },
    [browserUrl, stateUrl],
  );

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
      event.preventDefault();
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

  if (!activeThreadId) {
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
      key={activeThreadId}
      onUrlChange={navigate}
    >
      <ScrollArea className="shrink-0 border-b">
        <div className="flex h-8 min-w-max items-end px-2">
          {state.tabs.map((tab, index) => (
            <div
              aria-selected={index === state.activeTabIndex}
              className={cn(
                "group flex h-7 max-w-44 items-center gap-1.5 border-x border-t px-2 text-xs",
                index === state.activeTabIndex
                  ? "bg-background text-foreground"
                  : "border-transparent text-muted-foreground hover:bg-muted/50",
              )}
              key={`${tab.url}:${tab.title ?? ""}`}
              onClick={() => void action("switch-tab", index)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  void action("switch-tab", index);
                }
              }}
              role="tab"
              tabIndex={0}
              title={tab.title || tab.url}
            >
              <Globe2Icon className="size-3.5 shrink-0" />
              <span className="truncate">{tab.title || tab.url || "新标签页"}</span>
              <button
                aria-label="关闭标签页"
                className="ml-auto rounded p-0.5 opacity-0 hover:bg-muted focus-visible:opacity-100 group-hover:opacity-100"
                onClick={(event) => {
                  event.stopPropagation();
                  void action("close-tab", index);
                }}
                type="button"
              >
                <XIcon className="size-3" />
              </button>
            </div>
          ))}
          <Button
            aria-label="新建标签页"
            className="size-7"
            onClick={() => void action("new-tab")}
            size="icon-sm"
            title="新建标签页"
            variant="ghost"
          >
            <PlusIcon />
          </Button>
        </div>
        <ScrollBar orientation="horizontal" />
      </ScrollArea>
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
          onClick={() => state.currentUrl && window.open(state.currentUrl, "_blank")}
          tooltip="在系统浏览器中打开"
        >
          <ExternalLinkIcon />
        </WebPreviewNavigationButton>
        <WebPreviewNavigationButton
          disabled={!state.active}
          onClick={() => {
            if (!stateUrl) return;
            void fetch(stateUrl, { method: "DELETE" }).then(() => {
              setState(EMPTY_BROWSER_STATE);
              setFrame(undefined);
            });
          }}
          tooltip="关闭浏览器"
        >
          <SquareIcon />
        </WebPreviewNavigationButton>
      </WebPreviewNavigation>
      <div
        className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-zinc-950"
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
        ) : state.active ? (
          <div className="flex items-center gap-2 text-sm text-zinc-400">
            <LoaderCircleIcon className="size-4 animate-spin" />
            正在连接实时画面
          </div>
        ) : (
          <Empty className="text-zinc-400">
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
  const { openWorkspacePanel, setWorkspacePanelOpen, workspacePanelTab } = useWorkbench();
  return (
    <section className="flex size-full min-w-0 flex-col border-l bg-background">
      <header className="flex h-10 shrink-0 items-center border-b px-2">
        <Tabs
          className="min-w-0 flex-1 gap-0"
          onValueChange={(value) => openWorkspacePanel(value as "files" | "browser")}
          value={workspacePanelTab}
        >
          <TabsList className="h-8" variant="line">
            <TabsTrigger value="files">
              <FolderTreeIcon />
              文件
            </TabsTrigger>
            <TabsTrigger value="browser">
              <Globe2Icon />
              浏览器
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <Button
          aria-label="关闭右侧面板"
          onClick={() => setWorkspacePanelOpen(false)}
          size="icon-sm"
          title="关闭右侧面板"
          variant="ghost"
        >
          <XIcon />
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-hidden">
        {workspacePanelTab === "files" ? <FilesWorkspace /> : <BrowserWorkspace />}
      </div>
    </section>
  );
}
