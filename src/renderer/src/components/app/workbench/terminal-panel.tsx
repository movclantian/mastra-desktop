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
import { nanoid } from "nanoid";
import * as React from "react";
import { toast } from "sonner";
import { PanelHeader, PanelSurface } from "@/components/app/primitives";
import { Button } from "@/components/ui/button";
import { toastError } from "@/lib/errors";
import { cn } from "@/lib/utils";
import { reportWorkbenchNotification, type TerminalRequest, useWorkbench } from "@/lib/workbench";

export type TerminalStatus = "connecting" | "ready" | "exited" | "error";

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

/** 超过这个时长的应用发起命令在结束时投一条通知记录进收件箱 */
const LONG_COMMAND_MS = 10_000;

/**
 * 单个真实终端会话:一个 xterm + 一个主进程 PTY。
 *
 * 抽成独立组件是为了让「一标签即一会话」在两处都成立 —— 底部面板用它渲染自己
 * 标签条里的每个会话,右侧工作区面板的每个终端标签也各挂一个,两边的会话彼此
 * 独立。会话状态统一登记到 workbench 的注册表,由那里聚合成 terminal state lane
 * (否则模型只能看到其中一个面板里的终端)。
 */
export function TerminalSession({
  active,
  request,
  onStateChange,
}: {
  /** 是否为宿主面板当前可见的标签。隐藏元素尺寸为 0,fit() 只在可见时才有意义。 */
  active: boolean;
  /** 应用发起的待执行命令(只有底部面板消费 requestTerminalCommand,避免同一条命令被两处执行) */
  request?: TerminalRequest | null;
  /** 状态与会话 id 变化,供宿主渲染标题栏、发送中断信号 */
  onStateChange?: (state: { status: TerminalStatus; sessionId?: string }) => void;
}) {
  const { activeThreadId, reportTerminalSession, threads, user } = useWorkbench();
  const terminalApi = typeof window === "undefined" ? undefined : window.api?.terminal;
  const workspacePath = threads.find((thread) => thread.id === activeThreadId)?.metadata
    .workspacePath;

  const hostRef = React.useRef<HTMLDivElement>(null);
  const terminalRef = React.useRef<XtermTerminal | undefined>(undefined);
  const fitRef = React.useRef<FitAddon | undefined>(undefined);
  const sessionIdRef = React.useRef<string | undefined>(undefined);
  /** 本会话在 workbench 注册表里的稳定键 */
  const registryKeyRef = React.useRef<string>(nanoid());
  /** 应用发起命令的跟踪:用户手敲的命令是裸字节流,拿不到文本,只有退出码 */
  const lastRunRef = React.useRef<{ command: string; startedAt: number } | undefined>(undefined);
  const consumedRequestRef = React.useRef(0);

  const [status, setStatus] = React.useState<TerminalStatus>("connecting");
  const [sessionId, setSessionId] = React.useState<string>();
  const [lastExit, setLastExit] = React.useState<{ command?: string; exitCode?: number }>();
  const [themeVersion, setThemeVersion] = React.useState(0);

  const title = workspacePath ? `终端 · ${workspacePath.split(/[/\\]/).pop()}` : "系统终端";

  /**
   * 回调放进 ref 再通知宿主:宿主几乎总是传内联箭头函数(每次渲染新引用),
   * 若让通知 effect 直接依赖它,宿主的任何一次重渲染都会重跑 effect 并回调
   * 宿主 → 宿主再渲染 → 无限循环。这里只在状态**真的**变了时才通知。
   */
  const onStateChangeRef = React.useRef(onStateChange);
  React.useEffect(() => {
    onStateChangeRef.current = onStateChange;
  }, [onStateChange]);

  React.useEffect(() => {
    onStateChangeRef.current?.({ status, sessionId });
  }, [sessionId, status]);

  // 会话信息登记到 workbench 注册表;卸载时撤销,让聚合上报立刻反映真实会话数
  React.useEffect(() => {
    reportTerminalSession(registryKeyRef.current, {
      title,
      status,
      ...(lastExit?.command ? { lastCommand: lastExit.command } : {}),
      ...(lastExit?.exitCode === undefined ? {} : { lastExitCode: lastExit.exitCode }),
      ...(lastExit ? { settledAt: Date.now() } : {}),
    });
  }, [lastExit, reportTerminalSession, status, title]);

  React.useEffect(() => {
    const key = registryKeyRef.current;
    return () => reportTerminalSession(key, null);
  }, [reportTerminalSession]);

  React.useEffect(() => {
    const observer = new MutationObserver(() => setThemeVersion((value) => value + 1));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style"],
    });
    return () => observer.disconnect();
  }, []);

  React.useEffect(() => {
    void themeVersion;
    if (terminalRef.current) terminalRef.current.options.theme = readTerminalTheme();
  }, [themeVersion]);

  /** 下发一条应用发起的命令,记下起点以便退出时还原「跑了什么、跑了多久」 */
  const runTrackedCommand = React.useCallback(
    (command: string, target: string) => {
      lastRunRef.current = { command, startedAt: Date.now() };
      terminalApi?.write({ data: `${command}\r`, sessionId: target });
    },
    [terminalApi],
  );

  // 建 xterm 并拉起 PTY。线程换了就整个重建 —— 会话的工作目录跟着线程工作区走。
  React.useEffect(() => {
    if (!terminalApi || !hostRef.current) return;
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
    terminal.open(hostRef.current);
    terminalRef.current = terminal;
    fitRef.current = fit;
    setStatus("connecting");

    terminal.onData((data) => {
      if (sessionIdRef.current) terminalApi.write({ data, sessionId: sessionIdRef.current });
    });
    terminal.onResize(({ cols, rows }) => {
      if (sessionIdRef.current) {
        terminalApi.resize({ cols, rows, sessionId: sessionIdRef.current });
      }
    });
    try {
      fit.fit();
    } catch {
      /* 隐藏的标签尺寸为 0,变可见时再 fit */
    }

    let disposed = false;
    void terminalApi
      .create({
        cwd: workspacePath,
        cols: Math.max(2, terminal.cols),
        rows: Math.max(2, terminal.rows),
      })
      .then(({ sessionId: created }) => {
        if (disposed) {
          terminalApi.close(created);
          return;
        }
        sessionIdRef.current = created;
        setSessionId(created);
        setStatus("ready");
      })
      .catch((error) => {
        if (disposed) return;
        setStatus("error");
        toastError(error, "终端启动失败");
      });

    return () => {
      disposed = true;
      if (sessionIdRef.current) terminalApi.close(sessionIdRef.current);
      sessionIdRef.current = undefined;
      terminal.dispose();
      terminalRef.current = undefined;
      fitRef.current = undefined;
    };
  }, [terminalApi, workspacePath]);

  // 只处理属于本会话的事件:主进程的事件流是所有会话共享的
  React.useEffect(() => {
    if (!terminalApi || !sessionId) return;
    return terminalApi.subscribe((event) => {
      if (event.sessionId !== sessionId) return;
      const terminal = terminalRef.current;
      if (!terminal) return;
      if (event.type === "data") terminal.write(event.data);
      if (event.type === "error") {
        terminal.write(`\r\n\x1b[31m${event.message}\x1b[0m\r\n`);
        setStatus("error");
      }
      if (event.type === "exit") {
        terminal.write(`\r\n\x1b[90m[进程已退出，代码 ${event.exitCode ?? "?"}]\x1b[0m\r\n`);
        setStatus("exited");
        const run = lastRunRef.current;
        const exitCode = event.exitCode ?? undefined;
        setLastExit({
          ...(run ? { command: run.command } : {}),
          ...(exitCode === undefined ? {} : { exitCode }),
        });
        if (!run) return;
        lastRunRef.current = undefined;
        // 短命令靠 state lane 传达就够了;跑够久的才值得占一条收件箱记录
        const durationMs = Date.now() - run.startedAt;
        if (durationMs < LONG_COMMAND_MS) return;
        reportWorkbenchNotification(activeThreadId, user.id, {
          source: "terminal",
          kind: "command-exit",
          priority: exitCode === 0 ? "medium" : "high",
          summary: `Terminal command finished with exit code ${exitCode ?? "unknown"}: ${run.command}`,
          payload: { command: run.command, exitCode, durationMs },
          dedupeKey: `terminal:${sessionId}:${run.command}`,
        });
      }
    });
  }, [activeThreadId, sessionId, terminalApi, user.id]);

  // 变可见或容器尺寸变化时重新 fit:隐藏期间拿不到有效尺寸
  React.useEffect(() => {
    if (!active) return;
    const resize = () => {
      const terminal = terminalRef.current;
      const fit = fitRef.current;
      if (!terminal || !fit) return;
      try {
        fit.fit();
        if (sessionIdRef.current) {
          terminalApi?.resize({
            cols: terminal.cols,
            rows: terminal.rows,
            sessionId: sessionIdRef.current,
          });
        }
      } catch {
        /* 忽略瞬时的零尺寸布局 */
      }
    };
    resize();
    const observer = new ResizeObserver(resize);
    if (hostRef.current) observer.observe(hostRef.current);
    return () => observer.disconnect();
  }, [active, terminalApi]);

  // 应用发起的命令(文件树的「运行此文件」)。只在会话就绪且本会话可见时消费。
  React.useEffect(() => {
    if (!request || !active || !sessionId) return;
    if (request.id === consumedRequestRef.current) return;
    consumedRequestRef.current = request.id;
    const command =
      request.command ?? (request.filePath ? commandForFile(request.filePath) : undefined);
    if (!command) {
      toast.error("当前文件类型没有可用的运行命令");
      return;
    }
    runTrackedCommand(command, sessionId);
  }, [active, request, runTrackedCommand, sessionId]);

  if (!terminalApi) {
    return (
      <div className="flex size-full flex-col items-center justify-center gap-3 px-6 text-center text-muted-foreground">
        <TerminalIcon className="size-5" />
        <p className="text-sm">终端桥接尚未加载，请重新加载窗口。</p>
        <Button onClick={() => window.location.reload()} size="sm" variant="outline">
          <RefreshCwIcon />
          重新加载
        </Button>
      </div>
    );
  }

  return <div className="size-full" ref={hostRef} />;
}

interface BottomTerminalTab {
  id: string;
  title: string;
  status: TerminalStatus;
  sessionId?: string;
}

const createBottomTab = (index: number): BottomTerminalTab => ({
  id: nanoid(),
  status: "connecting",
  title: `终端 ${index}`,
});

/**
 * 底部终端面板:宽屏读日志的那一路。自带标签条与会话列表,与右侧工作区面板的
 * 终端标签**互不共享会话** —— 两处各开各的,由 TerminalSession 各自持有 PTY。
 */
export default function TerminalPanel() {
  const { activeThreadId, setTerminalPanelOpen, terminalRequest, threads } = useWorkbench();
  const terminalApi = typeof window === "undefined" ? undefined : window.api?.terminal;
  const workspacePath = threads.find((thread) => thread.id === activeThreadId)?.metadata
    .workspacePath;
  const [tabs, setTabs] = React.useState<BottomTerminalTab[]>(() => [createBottomTab(1)]);
  const [activeTabId, setActiveTabId] = React.useState<string>(() => tabs[0].id);
  const nextIndexRef = React.useRef(1);
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0];

  // 状态没变就返回原数组:map() 总会造新数组,React 按引用比较,
  // 那样每次上报都算一次 state 变化,足以和会话侧的通知构成死循环。
  const updateTab = React.useCallback((id: string, patch: Partial<BottomTerminalTab>) => {
    setTabs((current) => {
      const index = current.findIndex((tab) => tab.id === id);
      if (index < 0) return current;
      const tab = current[index];
      if (tab.status === patch.status && tab.sessionId === patch.sessionId) return current;
      const next = [...current];
      next[index] = { ...tab, ...patch };
      return next;
    });
  }, []);

  const addTab = () => {
    const tab = createBottomTab(++nextIndexRef.current);
    setTabs((current) => [...current, tab]);
    setActiveTabId(tab.id);
  };

  const closeTab = (id: string) => {
    setTabs((current) => {
      if (current.length === 1) {
        const replacement = createBottomTab(++nextIndexRef.current);
        setActiveTabId(replacement.id);
        return [replacement];
      }
      const index = current.findIndex((tab) => tab.id === id);
      const next = current.filter((tab) => tab.id !== id);
      if (activeTabId === id) setActiveTabId(next[Math.max(0, index - 1)]?.id ?? next[0].id);
      return next;
    });
  };

  return (
    <PanelSurface className="border-t">
      <PanelHeader className="gap-2 px-3">
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
                  // ETX(Ctrl-C):用转义写法而不是裸控制字符,免得被编辑器或格式化吞掉
                  terminalApi?.write({ data: "\u0003", sessionId: activeTab.sessionId });
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
      </PanelHeader>
      {/* 所有会话常驻,靠 hidden 切换:xterm 卸载会丢 scrollback,PTY 也会被关掉 */}
      <div className="min-h-0 flex-1 overflow-hidden bg-background px-3 py-2">
        {tabs.map((tab) => (
          <div
            className={cn("size-full", tab.id === activeTabId ? "block" : "hidden")}
            key={tab.id}
          >
            <TerminalSession
              active={tab.id === activeTabId}
              onStateChange={(next) => updateTab(tab.id, next)}
              request={tab.id === activeTabId ? terminalRequest : null}
            />
          </div>
        ))}
      </div>
      {/* <PanelFooter className="gap-1 px-3 text-[11px]">
        <TerminalIcon className="size-3" />
        <span>真实系统终端</span>
      </PanelFooter> */}
    </PanelSurface>
  );
}
