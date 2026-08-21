import { LoaderCircleIcon, PlayIcon, SquareIcon, XIcon } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import {
  Terminal,
  TerminalActions,
  TerminalClearButton,
  TerminalContent,
  TerminalCopyButton,
  TerminalHeader,
  TerminalStatus,
  TerminalTitle,
} from "@/components/ai-elements/terminal";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { MASTRA_SERVER_URL } from "@/lib/providers";
import { useWorkbench } from "@/lib/workbench";

interface CommandChunk {
  type: "start" | "stdout" | "stderr" | "exit" | "error";
  command?: string;
  data?: string;
  error?: string;
  exitCode?: number;
  executionTimeMs?: number;
}

export default function TerminalPanel() {
  const {
    activeThreadId,
    requestTerminalCommand,
    setTerminalPanelOpen,
    terminalRequest,
    threads,
    user,
  } = useWorkbench();
  const activeThread = threads.find((thread) => thread.id === activeThreadId);
  const [command, setCommand] = React.useState("");
  const [output, setOutput] = React.useState("");
  const [streaming, setStreaming] = React.useState(false);
  const abortRef = React.useRef<AbortController | null>(null);
  const consumedRequestRef = React.useRef(0);

  // Reset the terminal whenever the selected thread changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: activeThreadId intentionally triggers the reset.
  React.useEffect(() => {
    setOutput("");
    setStreaming(false);
    abortRef.current?.abort();
  }, [activeThreadId]);

  React.useEffect(() => () => abortRef.current?.abort(), []);

  const execute = React.useCallback(
    async (request: { command?: string; filePath?: string }) => {
      if (!activeThreadId || !activeThread?.metadata.workspacePath || streaming) return;
      const abortController = new AbortController();
      abortRef.current = abortController;
      setStreaming(true);
      try {
        const response = await fetch(
          `${MASTRA_SERVER_URL}/work/threads/${activeThreadId}/command?resourceId=${encodeURIComponent(user.id)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(request),
            signal: abortController.signal,
          },
        );
        if (!response.ok || !response.body) {
          const payload = (await response.json()) as { error?: string };
          throw new Error(payload.error || "命令执行失败");
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let pending = "";
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          pending += decoder.decode(value, { stream: true });
          const lines = pending.split("\n");
          pending = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.trim()) continue;
            const chunk = JSON.parse(line) as CommandChunk;
            if (chunk.type === "start")
              setOutput((current) => `${current}${current ? "\n" : ""}> ${chunk.command ?? ""}\n`);
            if (chunk.type === "stdout") setOutput((current) => current + (chunk.data ?? ""));
            if (chunk.type === "stderr")
              setOutput((current) => `${current}\u001b[31m${chunk.data ?? ""}\u001b[0m`);
            if (chunk.type === "error")
              setOutput(
                (current) => `${current}\u001b[31m${chunk.error ?? "命令执行失败"}\u001b[0m\n`,
              );
            if (chunk.type === "exit")
              setOutput(
                (current) =>
                  `${current}\n[exit ${chunk.exitCode ?? "?"} · ${chunk.executionTimeMs ?? 0}ms]\n`,
              );
          }
        }
      } catch (error) {
        if (!abortController.signal.aborted) {
          const message = error instanceof Error ? error.message : "命令执行失败";
          setOutput((current) => `${current}\n\u001b[31m${message}\u001b[0m\n`);
          toast.error(message);
        }
      } finally {
        if (abortRef.current === abortController) abortRef.current = null;
        setStreaming(false);
      }
    },
    [activeThread?.metadata.workspacePath, activeThreadId, streaming, user.id],
  );

  React.useEffect(() => {
    if (!terminalRequest || terminalRequest.id === consumedRequestRef.current || streaming) return;
    consumedRequestRef.current = terminalRequest.id;
    void execute(terminalRequest);
  }, [execute, streaming, terminalRequest]);

  return (
    <Terminal
      className="size-full rounded-none border-0"
      isStreaming={streaming}
      onClear={() => setOutput("")}
      output={output}
    >
      <TerminalHeader className="h-10 shrink-0 px-3 py-1.5">
        <TerminalTitle className="min-w-0 flex-1">
          <span className="truncate" title={activeThread?.metadata.workspacePath}>
            {activeThread?.metadata.workspacePath ?? "终端"}
          </span>
        </TerminalTitle>
        <div className="flex items-center gap-1">
          <TerminalStatus>
            <LoaderCircleIcon className="size-3 animate-spin" />
            执行中
          </TerminalStatus>
          <TerminalActions>
            {streaming ? (
              <Button
                aria-label="停止命令"
                className="size-7 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
                onClick={() => abortRef.current?.abort()}
                size="icon"
                title="停止命令"
                variant="ghost"
              >
                <SquareIcon />
              </Button>
            ) : null}
            <TerminalCopyButton title="复制输出" />
            <TerminalClearButton title="清空输出" />
            <Button
              aria-label="关闭终端"
              className="size-7 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
              onClick={() => setTerminalPanelOpen(false)}
              size="icon"
              title="关闭终端"
              variant="ghost"
            >
              <XIcon />
            </Button>
          </TerminalActions>
        </div>
      </TerminalHeader>
      <TerminalContent className="min-h-0 flex-1 max-h-none p-3" />
      <form
        className="shrink-0 border-zinc-800 border-t p-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (!command.trim() || streaming) return;
          requestTerminalCommand({ command: command.trim() });
          setCommand("");
        }}
      >
        <InputGroup className="border-zinc-700 bg-zinc-900 dark:bg-zinc-900">
          <InputGroupInput
            aria-label="终端命令"
            autoComplete="off"
            className="font-mono text-zinc-100 placeholder:text-zinc-500"
            disabled={!activeThread?.metadata.workspacePath || streaming}
            onChange={(event) => setCommand(event.target.value)}
            placeholder={
              activeThread?.metadata.workspacePath ? "输入命令" : "当前会话尚未绑定工作区"
            }
            spellCheck={false}
            value={command}
          />
          <InputGroupButton
            aria-label="执行命令"
            disabled={!command.trim() || streaming}
            size="icon-xs"
            title="执行命令"
            type="submit"
          >
            <PlayIcon />
          </InputGroupButton>
        </InputGroup>
      </form>
    </Terminal>
  );
}
