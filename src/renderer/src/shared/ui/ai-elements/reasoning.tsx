"use client";

import { BrainIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { createContext, memo, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Streamdown } from "streamdown";
import { i18n } from "@/shared/i18n";
import { cn } from "@/shared/lib";
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "@/shared/ui/trace";

import { streamdownPlugins } from "./message";

interface ReasoningContextValue {
  isStreaming: boolean;
  isOpen: boolean;
}

const ReasoningContext = createContext<ReasoningContextValue | null>(null);

const useReasoning = () => {
  const context = useContext(ReasoningContext);
  if (!context) {
    throw new Error("Reasoning components must be used within Reasoning");
  }
  return context;
};

export type ReasoningProps = Omit<
  ComponentProps<typeof TraceCollapsible>,
  "open" | "onOpenChange"
> & {
  isStreaming?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export const Reasoning = memo(
  ({ className, isStreaming = false, open, onOpenChange, children, ...props }: ReasoningProps) => {
    const contextValue = useMemo(() => ({ isOpen: open, isStreaming }), [open, isStreaming]);

    return (
      <ReasoningContext.Provider value={contextValue}>
        <Trace>
          <TraceCollapsible
            className={cn("not-prose mb-4", className)}
            onOpenChange={onOpenChange}
            open={open}
            {...props}
          >
            {children}
          </TraceCollapsible>
        </Trace>
      </ReasoningContext.Provider>
    );
  },
);

export type ReasoningTriggerProps = ComponentProps<typeof TraceCollapsibleTrigger> & {
  getThinkingMessage?: (isStreaming: boolean) => ReactNode;
  /** 流式中的推理全文;折叠态在触发行内单行滚动展示最新内容 */
  streamingText?: string;
};

const defaultGetThinkingMessage = (isStreaming: boolean) =>
  i18n.t(isStreaming ? "common:thinking" : "chat:trace.thought");

/** 取最后一个非空行:折叠态摘要只跟最新思路走,历史行已在上文 */
const resolveStreamingTail = (streamingText: string): { key: string; text: string } | null => {
  const lines = streamingText.replace(/\r\n?/g, "\n").split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const text = lines[index]?.trim() ?? "";
    if (text) return { key: String(index), text };
  }
  return null;
};

const TAIL_MASK =
  "linear-gradient(to right, transparent 0, black 16px, black calc(100% - 16px), transparent 100%)";

/**
 * 折叠态的单行流式尾巴:overflow-hidden 视口 + 内容 min-w-max,
 * 每次内容增长把 scrollLeft 推到最右 —— 新 token 把旧文本向左推出,
 * 视觉上永远停在最新一词;溢出后两端加渐隐 mask。
 */
const StreamingTail = memo(function StreamingTail({
  lineKey,
  text,
}: {
  lineKey: string;
  text: string;
}) {
  const viewportRef = useRef<HTMLSpanElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    viewport.scrollLeft = viewport.scrollWidth;
    setOverflowing(viewport.scrollWidth > viewport.clientWidth + 1);
  }, [text]);
  return (
    <>
      <span className="shrink-0 text-muted-foreground/60">·</span>
      <span
        className="min-w-0 flex-1 overflow-hidden whitespace-nowrap text-muted-foreground"
        ref={viewportRef}
        style={overflowing ? { maskImage: TAIL_MASK, WebkitMaskImage: TAIL_MASK } : undefined}
      >
        <span className="inline-block min-w-max" key={lineKey}>
          {text}
        </span>
      </span>
    </>
  );
});

export function ReasoningStreamingPreview({ text }: { text: string }) {
  const tail = resolveStreamingTail(text);
  return tail ? <StreamingTail key={tail.key} lineKey={tail.key} text={tail.text} /> : null;
}

export const ReasoningTrigger = memo(
  ({
    className,
    children,
    getThinkingMessage = defaultGetThinkingMessage,
    streamingText = "",
    ...props
  }: ReasoningTriggerProps) => {
    const { isStreaming, isOpen } = useReasoning();

    return (
      <TraceCollapsibleTrigger
        className={cn(
          "flex w-full items-center gap-2 text-muted-foreground text-sm transition-colors hover:text-foreground",
          className,
        )}
        {...props}
      >
        <TraceLine className="flex-1" status={isStreaming ? "running" : undefined}>
          {children ?? (
            <>
              <TraceIcon>
                <BrainIcon />
              </TraceIcon>
              <TraceTitle className="shrink-0">{getThinkingMessage(isStreaming)}</TraceTitle>
              {isStreaming && !isOpen ? <ReasoningStreamingPreview text={streamingText} /> : null}
            </>
          )}
        </TraceLine>
      </TraceCollapsibleTrigger>
    );
  },
);

export type ReasoningContentProps = ComponentProps<typeof TraceCollapsibleContent> & {
  children: string;
};

export const ReasoningContent = memo(({ className, children, ...props }: ReasoningContentProps) => {
  const { isStreaming } = useReasoning();

  return (
    <TraceCollapsibleContent keepMounted className={cn("text-sm", className)} {...props}>
      <Streamdown plugins={streamdownPlugins} isAnimating={isStreaming}>
        {children}
      </Streamdown>
    </TraceCollapsibleContent>
  );
});

Reasoning.displayName = "Reasoning";
ReasoningTrigger.displayName = "ReasoningTrigger";
ReasoningContent.displayName = "ReasoningContent";
