import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XtermTerminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import {
  LoaderCircleIcon,
  PlusIcon,
  RefreshCwIcon,
  SquareIcon,
  TerminalIcon,
  XIcon,
} from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useWorkbench } from "@/lib/workbench";

interface TerminalTab {
  id: number;
  title: string;
  sessionId?: string;
  status: "connecting" | "ready" | "exited" | "error";
}

interface TerminalRuntime {
  threadId: string | null;
  terminal: XtermTerminal;
  fit: FitAddon;
  sessionId?: string;
}

const createTerminalTab = (id: number): TerminalTab => ({
  id,
  status: "connecting",
  title: `终端 ${id}`,
});

function cssColor(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

function readTerminalTheme() {
  const dark = document.documentElement.classList.contains("dark");
  const background = cssColor("--background", dark ? "#09090b" : "#ffffff");
  const foreground = cssColor("--foreground", dark ? "#fafafa" : "#09090b");
  const muted = cssColor("--muted-foreground", dark ? "#a1a1aa" : "#71717a");
  const primary = cssColor("--primary", dark ? "#fafafa" : "#18181b");
  return {
    background,
    foreground,
    cursor: primary,
    cursorAccent: background,
    selectionBackground: dark ? "#ffffff33" : "#00000022",
    black: dark ? "#18181b" : "#f4f4f5",
    red: "#ef4444",
    green: "#22c55e",
    yellow: "#eab308",
    blue: "#3b82f6",
    magenta: "#d946ef",
    cyan: "#06b6d4",
    white: dark ? "#e4e4e7" : "#52525b",
    brightBlack: muted,
    brightRed: "#f87171",
    brightGreen: "#4ade80",
    brightYellow: "#facc15",
    brightBlue: "#60a5fa",
    brightMagenta: "#e879f9",
    brightCyan: "#22d3ee",
    brightWhite: foreground,
  };
}

function quoteForShell(path: string): string {
  if (navigator.userAgent.includes("Windows")) return `"${path.replaceAll('"', '""')}"`;
  return `'${path.replaceAll("'", "'\\''")}'`;
}

function commandForFile(path: string): string | undefined {
  const target = quoteForShell(path);
  const extension = path.split(".").pop()?.toLowerCase();
  if (["js", "mjs", "cjs"].includes(extension ?? "")) return `node ${target}`;
  if (["ts", "mts", "cts"].includes(extension ?? ""))
    return `node --experimental-strip-types ${target}`;
  if (extension === "py") return `python ${target}`;
  if (extension === "ps1") return `powershell -NoLogo -NoProfile -File ${target}`;
  if (extension === "sh") return `sh ${target}`;
  return undefined;
}

export default function TerminalPanel() {
  const { activeThreadId, setTerminalPanelOpen, terminalRequest, threads } = useWorkbench();
  const terminalApi = typeof window === "undefined" ? undefined : window.api?.terminal;
  const activeThread = threads.find((thread) => thread.id === activeThreadId);
  const workspacePath = activeThread?.metadata.workspacePath;
  const [tabs, setTabs] = React.useState<TerminalTab[]>(() => [createTerminalTab(1)]);
  const [activeTabId, setActiveTabId] = React.useState(1);
  const [themeVersion, setThemeVersion] = React.useState(0);
  const nextTabIdRef = React.useRef(1);
  const hostRefs = React.useRef(new Map<number, HTMLDivElement>());
  const runtimeRefs = React.useRef(new Map<number, TerminalRuntime>());
  const consumedRequestRef = React.useRef(0);
  const pendingRunRef = React.useRef<{ command?: string; filePath?: string } | undefined>(
    undefined,
  );
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0];

  React.useEffect(() => {
    const observer = new MutationObserver(() => setThemeVersion((value) => value + 1));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style"],
    });
    return () => observer.disconnect();
  }, []);

  const updateTab = React.useCallback(
    (tabId: number, update: (tab: TerminalTab) => TerminalTab) => {
      setTabs((current) => current.map((tab) => (tab.id === tabId ? update(tab) : tab)));
    },
    [],
  );

  const disposeRuntime = React.useCallback(
    (tabId: number) => {
      const runtime = runtimeRefs.current.get(tabId);
      if (!runtime) return;
      if (runtime.sessionId) terminalApi?.close(runtime.sessionId);
      runtime.terminal.dispose();
      runtimeRefs.current.delete(tabId);
      hostRefs.current.delete(tabId);
    },
    [terminalApi],
  );

  React.useEffect(() => {
    void activeThreadId;
    for (const tabId of runtimeRefs.current.keys()) disposeRuntime(tabId);
    nextTabIdRef.current = 1;
    setTabs([createTerminalTab(1)]);
    setActiveTabId(1);
    pendingRunRef.current = undefined;
  }, [activeThreadId, disposeRuntime]);

  React.useEffect(() => {
    if (!terminalApi) return;
    const unsubscribe = terminalApi.subscribe((event) => {
      const entry = [...runtimeRefs.current.entries()].find(
        ([, runtime]) => runtime.sessionId === event.sessionId,
      );
      if (!entry) return;
      const [tabId, runtime] = entry;
      if (event.type === "data") runtime.terminal.write(event.data);
      if (event.type === "error") {
        runtime.terminal.write(`\r\n\x1b[31m${event.message}\x1b[0m\r\n`);
        updateTab(tabId, (tab) => ({ ...tab, status: "error" }));
      }
      if (event.type === "exit") {
        runtime.terminal.write(
          `\r\n\x1b[90m[进程已退出，代码 ${event.exitCode ?? "?"}]\x1b[0m\r\n`,
        );
        updateTab(tabId, (tab) => ({ ...tab, status: "exited" }));
      }
    });
    return unsubscribe;
  }, [terminalApi, updateTab]);

  React.useEffect(() => {
    void themeVersion;
    const theme = readTerminalTheme();
    for (const runtime of runtimeRefs.current.values()) runtime.terminal.options.theme = theme;
  }, [themeVersion]);

  React.useEffect(() => {
    if (!terminalApi) return;
    for (const tab of tabs) {
      if (runtimeRefs.current.has(tab.id)) continue;
      const host = hostRefs.current.get(tab.id);
      if (!host) continue;
      const terminal = new XtermTerminal({
        convertEol: true,
        cursorBlink: true,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
        fontSize: 13,
        scrollback: 10_000,
        theme: readTerminalTheme(),
      });
      const fit = new FitAddon();
      terminal.loadAddon(fit);
      terminal.open(host);
      const runtime: TerminalRuntime = { fit, terminal, threadId: activeThreadId };
      runtimeRefs.current.set(tab.id, runtime);
      terminal.onData((data) => {
        if (runtime.sessionId) terminalApi.write({ data, sessionId: runtime.sessionId });
      });
      terminal.onResize(({ cols, rows }) => {
        if (runtime.sessionId) terminalApi.resize({ cols, rows, sessionId: runtime.sessionId });
      });
      try {
        fit.fit();
      } catch {
        /* Hidden panel gets fitted when it becomes visible. */
      }
      void terminalApi
        .create({
          cwd: workspacePath,
          cols: Math.max(2, terminal.cols),
          rows: Math.max(2, terminal.rows),
        })
        .then(({ sessionId }) => {
          runtime.sessionId = sessionId;
          updateTab(tab.id, (current) => ({ ...current, sessionId, status: "ready" }));
          if (tab.id === activeTabId) {
            fit.fit();
            terminalApi.resize({ cols: terminal.cols, rows: terminal.rows, sessionId });
          }
          const pending = pendingRunRef.current;
          if (pending && tab.id === activeTabId) {
            pendingRunRef.current = undefined;
            const command =
              pending.command ?? (pending.filePath ? commandForFile(pending.filePath) : undefined);
            if (command) terminalApi.write({ data: `${command}\r`, sessionId });
          }
        })
        .catch((error) => {
          updateTab(tab.id, (current) => ({ ...current, status: "error" }));
          toast.error(error instanceof Error ? error.message : "终端启动失败");
        });
    }
  }, [activeTabId, activeThreadId, tabs, terminalApi, updateTab, workspacePath]);

  React.useEffect(() => {
    const runtime = activeTab ? runtimeRefs.current.get(activeTab.id) : undefined;
    if (!runtime) return;
    const resize = () => {
      try {
        runtime.fit.fit();
        if (runtime.sessionId)
          terminalApi?.resize({
            cols: runtime.terminal.cols,
            rows: runtime.terminal.rows,
            sessionId: runtime.sessionId,
          });
      } catch {
        /* Ignore transient zero-size layouts. */
      }
    };
    resize();
    const observer = new ResizeObserver(resize);
    const host = hostRefs.current.get(activeTab.id);
    if (host) observer.observe(host);
    return () => observer.disconnect();
  }, [activeTab, terminalApi]);

  React.useEffect(() => {
    if (!terminalRequest || terminalRequest.id === consumedRequestRef.current) return;
    consumedRequestRef.current = terminalRequest.id;
    pendingRunRef.current = terminalRequest;
    const runtime = activeTab ? runtimeRefs.current.get(activeTab.id) : undefined;
    if (!runtime?.sessionId) return;
    const command =
      terminalRequest.command ??
      (terminalRequest.filePath ? commandForFile(terminalRequest.filePath) : undefined);
    pendingRunRef.current = undefined;
    if (!command) {
      toast.error("当前文件类型没有可用的运行命令");
      return;
    }
    terminalApi?.write({ data: `${command}\r`, sessionId: runtime.sessionId });
  }, [activeTab, terminalApi, terminalRequest]);

  React.useEffect(
    () => () => {
      for (const tabId of runtimeRefs.current.keys()) disposeRuntime(tabId);
    },
    [disposeRuntime],
  );

  const addTab = () => {
    const id = ++nextTabIdRef.current;
    setTabs((current) => [...current, createTerminalTab(id)]);
    setActiveTabId(id);
  };
  const closeTab = (tabId: number) => {
    disposeRuntime(tabId);
    setTabs((current) => {
      if (current.length === 1) {
        const replacement = createTerminalTab(++nextTabIdRef.current);
        setActiveTabId(replacement.id);
        return [replacement];
      }
      const index = current.findIndex((tab) => tab.id === tabId);
      const next = current.filter((tab) => tab.id !== tabId);
      if (activeTabId === tabId) setActiveTabId(next[Math.max(0, index - 1)]?.id ?? next[0].id);
      return next;
    });
  };

  if (!terminalApi) {
    return (
      <section className="flex size-full min-h-0 flex-col items-center justify-center gap-3 border-t bg-background px-6 text-center text-muted-foreground">
        <TerminalIcon className="size-5" />
        <p className="text-sm">终端桥接尚未加载，请重新加载窗口。</p>
        <Button onClick={() => window.location.reload()} size="sm" variant="outline">
          <RefreshCwIcon />
          重新加载
        </Button>
      </section>
    );
  }

  return (
    <section className="flex size-full min-h-0 flex-col overflow-hidden border-t bg-background text-foreground">
      <header className="flex h-10 shrink-0 items-center gap-2 border-border border-b px-3">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {tabs.map((tab) => (
            <div
              className={cn(
                "group flex h-7 shrink-0 items-center rounded-md text-xs",
                tab.id === activeTabId
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:bg-muted/70",
              )}
              key={tab.id}
            >
              <button
                className="max-w-36 truncate px-2"
                onClick={() => setActiveTabId(tab.id)}
                type="button"
              >
                {tab.title}
              </button>
              <button
                aria-label={`关闭${tab.title}`}
                className="mr-1 rounded p-0.5 opacity-60 hover:bg-background hover:opacity-100"
                onClick={() => closeTab(tab.id)}
                title={`关闭${tab.title}`}
                type="button"
              >
                <XIcon className="size-3" />
              </button>
            </div>
          ))}
          <Button
            aria-label="新建终端"
            className="size-7 shrink-0"
            onClick={addTab}
            size="icon"
            title="新建终端"
            variant="ghost"
          >
            <PlusIcon />
          </Button>
        </div>
        <div className="flex shrink-0 items-center gap-2 text-muted-foreground">
          <span className="hidden max-w-56 truncate text-xs sm:block" title={workspacePath}>
            {workspacePath ?? "系统终端"}
          </span>
          {activeTab?.status === "connecting" ? (
            <LoaderCircleIcon className="size-3 animate-spin" />
          ) : null}
          {activeTab?.status === "ready" ? <span className="text-xs">已连接</span> : null}
          {activeTab?.sessionId ? (
            <Button
              aria-label="中断当前进程"
              className="size-7"
              onClick={() => {
                if (activeTab.sessionId) {
                  terminalApi.write({ data: "\u0003", sessionId: activeTab.sessionId });
                }
              }}
              size="icon"
              title="中断当前进程"
              variant="ghost"
            >
              <SquareIcon />
            </Button>
          ) : null}
          <Button
            aria-label="关闭终端面板"
            className="size-7"
            onClick={() => setTerminalPanelOpen(false)}
            size="icon"
            title="关闭终端面板"
            variant="ghost"
          >
            <XIcon />
          </Button>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-hidden bg-background px-3 py-2">
        {tabs.map((tab) => (
          <div
            className={cn("size-full", tab.id === activeTabId ? "block" : "hidden")}
            key={tab.id}
            ref={(node) => {
              if (node) hostRefs.current.set(tab.id, node);
              else hostRefs.current.delete(tab.id);
            }}
          />
        ))}
      </div>
      <div className="flex h-6 shrink-0 items-center gap-1 border-border border-t px-3 text-[11px] text-muted-foreground">
        <TerminalIcon className="size-3" />
        <span>真实系统终端</span>
      </div>
    </section>
  );
}
