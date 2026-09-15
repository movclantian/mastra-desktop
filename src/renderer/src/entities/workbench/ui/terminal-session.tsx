import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XtermTerminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import {
  ClipboardPasteIcon,
  EraserIcon,
  RefreshCwIcon,
  SquareIcon,
  TerminalIcon,
} from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { reportWorkbenchNotification } from "@/shared/api";
import { toastError } from "@/shared/lib";
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
import { DotmSquare10 } from "@/shared/ui/dotm-square-10";
import type { TerminalEvent } from "../../../../../shared/terminal-contract";
import type { TerminalStatus } from "../model/terminal";
import { getTerminalApi } from "../model/terminal";
import type { TerminalRequest } from "../model/types";
import { useWorkbench } from "../model/workbench-context";

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

export function commandForFile(path: string): string | undefined {
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

const LONG_SESSION_MS = 10_000;
const TERMINAL_DEFAULT_COLS = 80;
const TERMINAL_DEFAULT_ROWS = 24;

function terminalDimension(value: number, fallback: number, maximum: number): number {
  return Number.isFinite(value) && value >= 2 ? Math.min(maximum, Math.floor(value)) : fallback;
}

function terminalSize(term: XtermTerminal) {
  return {
    cols: terminalDimension(term.cols, TERMINAL_DEFAULT_COLS, 500),
    rows: terminalDimension(term.rows, TERMINAL_DEFAULT_ROWS, 300),
  };
}

export function TerminalSession({
  sessionId,
  active,
  cwd,
  threadId,
  onTitleChange,
  pendingRequest,
  onHandledRequest,
}: {
  sessionId: string;
  active: boolean;
  cwd?: string;
  threadId?: string;
  onTitleChange?: (title: string) => void;
  pendingRequest?: TerminalRequest | null;
  onHandledRequest?: () => void;
}) {
  const { user, activeThreadId, threads, reportTerminalSession } = useWorkbench();
  const targetThreadId = threadId ?? activeThreadId;
  const workingDirectory =
    cwd ?? threads.find((thread) => thread.id === targetThreadId)?.metadata.workspacePath;
  const containerRef = React.useRef<HTMLDivElement>(null);
  const xtermRef = React.useRef<XtermTerminal | null>(null);
  const fitRef = React.useRef<FitAddon | null>(null);
  const ptyIdRef = React.useRef<string | null>(null);
  const activeRef = React.useRef(active);
  activeRef.current = active;
  const onTitleChangeRef = React.useRef(onTitleChange);
  onTitleChangeRef.current = onTitleChange;
  const handledRequestRef = React.useRef<number | null>(null);
  const [restart, setRestart] = React.useState(0);
  const [status, setStatus] = React.useState<TerminalStatus>("connecting");
  const [title, setTitle] = React.useState("Terminal");
  const [lastCommand, setLastCommand] = React.useState<string>();
  const [lastExitCode, setLastExitCode] = React.useState<number>();
  const [settledAt, setSettledAt] = React.useState<number>();

  React.useEffect(() => {
    reportTerminalSession(sessionId, { title, status, lastCommand, lastExitCode, settledAt });
  }, [sessionId, title, status, lastCommand, lastExitCode, settledAt, reportTerminalSession]);

  React.useEffect(
    () => () => reportTerminalSession(sessionId, null),
    [sessionId, reportTerminalSession],
  );

  const fitTerminal = React.useCallback(() => {
    const term = xtermRef.current;
    const fit = fitRef.current;
    const api = getTerminalApi();
    if (!term || !fit || !api || !activeRef.current) return;
    fit.fit();
    const ptyId = ptyIdRef.current;
    if (ptyId) api.resize({ sessionId: ptyId, ...terminalSize(term) });
  }, []);

  React.useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let disposed = false;
    let createdId: string | undefined;
    let creating = true;
    const earlyEvents: TerminalEvent[] = [];
    const startedAt = Date.now();
    setStatus("connecting");
    setTitle("Terminal");
    setLastCommand(undefined);
    setLastExitCode(undefined);
    setSettledAt(undefined);
    const term = new XtermTerminal({
      cursorBlink: true,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      fontSize: 12,
      lineHeight: 1.25,
      theme: readTerminalTheme(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    xtermRef.current = term;
    fitRef.current = fit;
    const themeObserver = new MutationObserver(() => {
      term.options.theme = readTerminalTheme();
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "data-theme", "style"],
    });
    const resizeObserver = new ResizeObserver(fitTerminal);
    resizeObserver.observe(el);
    const api = getTerminalApi();

    const receive = (event: TerminalEvent) => {
      if (disposed || event.sessionId !== createdId) return;
      if (event.type === "data") {
        term.write(event.data);
      } else if (event.type === "error") {
        term.writeln(event.message);
        setStatus("error");
      } else {
        ptyIdRef.current = null;
        setStatus("exited");
        setLastExitCode(event.exitCode);
        setSettledAt(Date.now());
        if (targetThreadId && Date.now() - startedAt >= LONG_SESSION_MS) {
          reportWorkbenchNotification(targetThreadId, user.id, {
            source: "terminal",
            kind: "session-exited",
            summary: "Terminal session exited",
            payload: { sessionId: createdId, exitCode: event.exitCode },
          });
        }
      }
    };
    // Subscribe before creation so fast shell output is retained until IPC returns its ID.
    const unsubscribe = api?.subscribe((event) => {
      if (creating) earlyEvents.push(event);
      else receive(event);
    });
    const dataSub = term.onData((data) => {
      if (ptyIdRef.current) api?.write({ sessionId: ptyIdRef.current, data });
    });
    const titleSub = term.onTitleChange((nextTitle) => {
      setTitle(nextTitle);
      onTitleChangeRef.current?.(nextTitle);
    });
    const frame = requestAnimationFrame(() => {
      if (!api) {
        creating = false;
        setStatus("error");
        term.writeln("PTY unavailable");
        return;
      }
      if (activeRef.current) fit.fit();
      void api.create({ cwd: workingDirectory, ...terminalSize(term) }).then(
        ({ sessionId: id }) => {
          if (disposed) {
            api.close(id);
            return;
          }
          createdId = id;
          ptyIdRef.current = id;
          creating = false;
          setStatus("ready");
          for (const event of earlyEvents) receive(event);
          earlyEvents.length = 0;
          fitTerminal();
        },
        (error: unknown) => {
          if (disposed) return;
          creating = false;
          earlyEvents.length = 0;
          term.writeln(String(error));
          setStatus("error");
        },
      );
    });

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      unsubscribe?.();
      resizeObserver.disconnect();
      themeObserver.disconnect();
      dataSub.dispose();
      titleSub.dispose();
      if (createdId) api?.close(createdId);
      ptyIdRef.current = null;
      xtermRef.current = null;
      fitRef.current = null;
      term.dispose();
    };
  }, [sessionId, workingDirectory, targetThreadId, user.id, restart, fitTerminal]);

  React.useEffect(() => {
    if (!active) return;
    const frame = requestAnimationFrame(fitTerminal);
    return () => cancelAnimationFrame(frame);
  }, [active, fitTerminal]);

  React.useEffect(() => {
    if (!active || !pendingRequest || status !== "ready") return;
    if (handledRequestRef.current === pendingRequest.id) return;
    const api = getTerminalApi();
    const ptyId = ptyIdRef.current;
    if (!api || !ptyId) return;
    const command =
      pendingRequest.command ??
      (pendingRequest.filePath ? commandForFile(pendingRequest.filePath) : undefined);
    handledRequestRef.current = pendingRequest.id;
    if (command) {
      api.write({ sessionId: ptyId, data: `${command}\r` });
      setLastCommand(command);
      setLastExitCode(undefined);
      setSettledAt(undefined);
    } else {
      toast.error("Unsupported terminal command");
    }
    onHandledRequest?.();
  }, [active, pendingRequest, status, onHandledRequest]);

  const handleCopySelection = () => {
    const text = xtermRef.current?.getSelection();
    if (text) {
      void navigator.clipboard.writeText(text).catch((error) => toastError(error, "Copy failed"));
    }
  };

  const handlePaste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text && ptyIdRef.current) xtermRef.current?.paste(text);
    } catch (error) {
      toastError(error, "Paste failed");
    }
  };

  const handleInterrupt = () => {
    const api = getTerminalApi();
    if (api && ptyIdRef.current) {
      api.write({ sessionId: ptyIdRef.current, data: "\x03" });
    }
  };

  const handleClear = () => xtermRef.current?.clear();
  const handleRestart = () => {
    setStatus("connecting");
    setRestart((value) => value + 1);
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger className="size-full">
        <div className="relative size-full overflow-hidden bg-background">
          <div ref={containerRef} className="size-full px-2 py-1.5" />
          {status === "connecting" ? (
            <div
              className="pointer-events-none absolute right-3 bottom-2 flex items-center gap-1.5 rounded-md border border-border/60 bg-background/85 px-2 py-1 text-[11px] text-muted-foreground shadow-xs backdrop-blur-xs"
              title="连接终端"
            >
              <DotmSquare10 size={12} dotSize={2} colorPreset="solid-theme" />
              <span>连接中</span>
            </div>
          ) : null}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-48">
        <ContextMenuGroup>
          <ContextMenuLabel className="text-xs">终端操作</ContextMenuLabel>
          <ContextMenuItem onClick={handleCopySelection}>
            <TerminalIcon className="text-muted-foreground" />
            <span>复制选中</span>
            <ContextMenuShortcut>⌘C</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuItem onClick={() => void handlePaste()}>
            <ClipboardPasteIcon className="text-muted-foreground" />
            <span>粘贴剪贴板</span>
            <ContextMenuShortcut>⌘V</ContextMenuShortcut>
          </ContextMenuItem>
        </ContextMenuGroup>
        <ContextMenuSeparator />
        <ContextMenuGroup>
          <ContextMenuItem onClick={handleInterrupt} disabled={status !== "ready"}>
            <SquareIcon className="text-muted-foreground" />
            <span>中断 (Ctrl+C)</span>
            <ContextMenuShortcut>^C</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuItem onClick={handleClear}>
            <EraserIcon className="text-muted-foreground" />
            <span>清屏</span>
            <ContextMenuShortcut>⌘K</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuItem onClick={handleRestart} disabled={status === "connecting"}>
            <RefreshCwIcon className="text-muted-foreground" />
            <span>重启会话</span>
          </ContextMenuItem>
        </ContextMenuGroup>
      </ContextMenuContent>
    </ContextMenu>
  );
}
