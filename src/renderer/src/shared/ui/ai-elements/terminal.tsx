"use client";

import { TerminalIcon } from "lucide-react";
import * as React from "react";
import { useTranslation } from "@/shared/i18n";
import { cn } from "@/shared/lib";
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockContent,
  CodeBlockCopyButton,
} from "@/shared/ui/code-block";
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "@/shared/ui/trace";

export type TerminalProps = {
  /** 命令原文,如 "pnpm build" */
  command: string;
  /** 已收到的输出;流式期间持续增长 */
  output: string;
  /** 退出码:0 成功,非 0 失败;undefined 表示尚未退出 */
  exitCode?: number;
  /** 命令仍在执行 */
  isStreaming?: boolean;
  /** 未受控时:输出首次到达自动展开,让输出在运行时可见 */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
};

/**
 * Terminal pattern(官方 docs/examples/terminal.mdx):
 * 一条命令一行 Trace,TraceCollapsible 展开它的流式输出。
 * 状态映射:运行中 running、退出 0 无状态、非 0 为 error 且标题带退出码。
 */
export function Terminal({
  command,
  output,
  exitCode,
  isStreaming = false,
  open,
  onOpenChange,
  className,
}: TerminalProps) {
  const { t } = useTranslation();
  const failed = exitCode !== undefined && exitCode !== 0;
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(false);
  const expanded = open ?? uncontrolledOpen;
  const setExpanded = onOpenChange ?? setUncontrolledOpen;

  // 官方:第一段输出到达时展开一次,之后由用户决定保持或收起。
  const hasOpenedRef = React.useRef(false);
  React.useEffect(() => {
    if (hasOpenedRef.current || open !== undefined || !output) return;
    hasOpenedRef.current = true;
    setUncontrolledOpen(true);
  }, [open, output]);

  const status = isStreaming ? "running" : failed ? "error" : undefined;
  const title = isStreaming
    ? t("chat:trace.terminalRunning", { command })
    : failed
      ? t("chat:trace.terminalExited", { command, code: exitCode })
      : t("chat:trace.terminalRan", { command });

  return (
    <Trace className={cn("min-w-0 max-w-full", className)}>
      <TraceCollapsible className="w-full" onOpenChange={setExpanded} open={expanded}>
        <TraceCollapsibleTrigger className="w-full items-start">
          <TraceLine className="w-full items-start" status={status}>
            <TraceIcon className="mt-0.5">
              <TerminalIcon className="size-3.5" />
            </TraceIcon>
            <TraceTitle className="flex-1 whitespace-normal" title={command}>
              {title}
            </TraceTitle>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent>
          <CodeBlock size="sm" variant={failed ? "destructive" : "default"}>
            <CodeBlockActions>
              <CodeBlockCopyButton value={output} />
            </CodeBlockActions>
            <CodeBlockContent wrap className="max-h-64">
              {output}
            </CodeBlockContent>
          </CodeBlock>
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  );
}
