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
import { cn, toastError } from "@/shared/lib";
import { Button } from "@/shared/ui/button";
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

const LONG_COMMAND_MS = 10_000;

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
  const containerRef = React.useRef<HTMLDivElement>(null);
  const xtermRef = React.useRef<XtermTerminal | null>(null);
  const fitRef = React.useRef<FitAddon | null>(null);
  const isStartedRef = React.useRef(false);
  const activeRef = React.useRef(active);
  activeRef.current = active;
  const onTitleChangeRef = React.useRef(onTitleChange);
  onTitleChangeRef.current = onTitleChange;

  const { registerTerminalSession, updateTerminalStatus } = useWorkbench();
  const [status, setStatus] = React.useState<TerminalStatus>("idle");
  const [lastCommand, setLastCommand] = React.useState<string | null>(null);
  const [lastExitCode, setLastExitCode] = React.useState<number | null>(null);

  const commandStartTimeRef = React.useRef<number | null>(null);

  React.useEffect(() => {
    registerTerminalSession(sessionId, {
      id: sessionId,
      cwd,
      threadId,
      status,
      lastCommand: lastCommand ?? undefined,
      lastExitCode: lastExitCode ?? undefined,
    });
  }, [sessionId, cwd, threadId, status, lastCommand, lastExitCode, registerTerminalSession]);

  const fitTerminal = React.useCallback(() => {
    const term = xtermRef.current;
    const fit = fitRef.current;
    const api = getTerminalApi();
    if (!term || !fit || !api) return;
    try {
      fit.fit();
      if (term.cols > 0 && term.rows > 0) {
        void api.resize(sessionId, term.cols, term.rows);
      }
    } catch {
      // 容器 display:none 时 fit 会抛异常,忽略
    }
  }, [sessionId]);

  React.useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const term = new XtermTerminal({
      cursorBlink: true,
      fontFamily:
        'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
      fontSize: 12,
      lineHeight: 1.25,
      theme: readTerminalTheme(),
      allowProposedApi: true,
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

    const api = getTerminalApi();
    if (!api) {
      term.writeln("\x1b[33m[PTY 不可用:运行在浏览器预览模式]\x1b[0m");
      return () => {
        themeObserver.disconnect();
        term.dispose();
      };
    }

    const unData = api.onData((id, data) => {
      if (id === sessionId) term.write(data);
    });
    const unExit = api.onExit((id, code) => {
      if (id !== sessionId) return;
      setStatus("idle");
      setLastExitCode(code);
      updateTerminalStatus(sessionId, "idle", { exitCode: code });
      if (commandStartTimeRef.current !== null) {
        const elapsed = Date.now() - commandStartTimeRef.current;
        if (elapsed >= LONG_COMMAND_MS) {
          void reportWorkbenchNotification({
            type: "terminal_long_command",
            title: `终端任务已结束(耗时 ${Math.round(elapsed / 1000)}s)`,
            body: `命令已退出,代码: ${code}`,
            threadId,
            level: code === 0 ? "info" : "error",
          });
        }
        commandStartTimeRef.current = null;
      }
    });
    const unTitle = api.onTitle?.((id, title) => {
      if (id === sessionId) onTitleChangeRef.current?.(title);
    });

    const dataSub = term.onData((data) => {
      void api.write(sessionId, data);
    });

    if (!isStartedRef.current) {
      isStartedRef.current = true;
      requestAnimationFrame(() => {
        fit.fit();
        const cols = Math.max(term.cols || 80, 20);
        const rows = Math.max(term.rows || 24, 5);
        api
          .create({ id: sessionId, cwd, cols, rows })
          .then((res) => {
            if (!res.ok) {
              term.writeln(`\x1b[31m[创建终端失败:${res.error}]\x1b[0m`);
              setStatus("error");
              updateTerminalStatus(sessionId, "error");
            }
          })
          .catch((err) => {
            term.writeln(`\x1b[31m[创建终端异常:${String(err)}]\x1b[0m`);
            setStatus("error");
            updateTerminalStatus(sessionId, "error");
          });
      });
    }

    const resizeObserver = new ResizeObserver(() => {
      if (activeRef.current) fitTerminal();
    });
    resizeObserver.observe(el);

    return () => {
      resizeObserver.disconnect();
      themeObserver.disconnect();
      dataSub.dispose();
      unData();
      unExit();
      unTitle?.();
      term.dispose();
    };
  }, [sessionId, cwd, threadId, fitTerminal, updateTerminalStatus]);

  React.useEffect(() => {
    if (active) {
      const timer = setTimeout(fitTerminal, 50);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [active, fitTerminal]);

  React.useEffect(() => {
    if (!pendingRequest) return;
    const api = getTerminalApi();
    if (!api) return;

    if (pendingRequest.type === "run") {
      setStatus("busy");
      setLastCommand(pendingRequest.command);
      setLastExitCode(null);
      commandStartTimeRef.current = Date.now();
      updateTerminalStatus(sessionId, "busy", { command: pendingRequest.command });
      void api.write(sessionId, `${pendingRequest.command}\n`);
      onHandledRequest?.();
    } else if (pendingRequest.type === "interrupt") {
      void api.interrupt(sessionId);
      setStatus("idle");
      updateTerminalStatus(sessionId, "idle");
      onHandledRequest?.();
    } else if (pendingRequest.type === "clear") {
      xtermRef.current?.clear();
      onHandledRequest?.();
    }
  }, [pendingRequest, sessionId, onHandledRequest, updateTerminalStatus]);

  const handleCopySelection = () => {
    const text = xtermRef.current?.getSelection();
    if (text) {
      void navigator.clipboard.writeText(text);
      toast.success("已复制终端选中文本");
    }
  };

  const handlePaste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        const api = getTerminalApi();
        if (api) void api.write(sessionId, text);
        else xtermRef.current?.paste(text);
      }
    } catch (err) {
      toastError(err, "读取剪贴板失败");
    }
  };

  const handleInterrupt = () => {
    const api = getTerminalApi();
    if (api) void api.interrupt(sessionId);
    setStatus("idle");
    updateTerminalStatus(sessionId, "idle");
  };

  const handleClear = () => {
    xtermRef.current?.clear();
  };

  const handleRestart = async () => {
    const api = getTerminalApi();
    if (!api) return;
    try {
      await api.destroy(sessionId);
      xtermRef.current?.clear();
      isStartedRef.current = false;
      const term = xtermRef.current;
      const cols = Math.max(term?.cols || 80, 20);
      const rows = Math.max(term?.rows || 24, 5);
      await api.create({ id: sessionId, cwd, cols, rows });
      setStatus("idle");
      updateTerminalStatus(sessionId, "idle");
      toast.success("终端会话已重启");
    } catch (err) {
      toastError(err, "重启终端会话失败");
    }
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger className="size-full">
        <div className="relative size-full overflow-hidden bg-background">
          <div ref={containerRef} className="size-full px-2 py-1.5" />
          {status === "busy" ? (
            <div
              className="pointer-events-none absolute right-3 bottom-2 flex items-center gap-1.5 rounded-md border border-border/60 bg-background/85 px-2 py-1 text-[11px] text-muted-foreground shadow-xs backdrop-blur-xs"
              title="任务进行中"
            >
              <DotmSquare10 size={12} dotSize={2} colorPreset="solid-theme" />
              <span>运行中</span>
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
          <ContextMenuItem onClick={handleInterrupt} disabled={status !== "busy"}>
            <SquareIcon className="text-muted-foreground" />
            <span>中断 (Ctrl+C)</span>
            <ContextMenuShortcut>^C</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuItem onClick={handleClear}>
            <EraserIcon className="text-muted-foreground" />
            <span>清屏</span>
            <ContextMenuShortcut>⌘K</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuItem onClick={() => void handleRestart()}>
            <RefreshCwIcon className="text-muted-foreground" />
            <span>重启会话</span>
          </ContextMenuItem>
        </ContextMenuGroup>
      </ContextMenuContent>
    </ContextMenu>
  );
}
