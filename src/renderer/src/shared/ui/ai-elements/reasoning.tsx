"use client";

import { useControllableState } from "@radix-ui/react-use-controllable-state";
import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { math } from "@streamdown/math";
import { mermaid } from "@streamdown/mermaid";
import { BrainIcon, ChevronDownIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Streamdown } from "streamdown";
import { i18n } from "@/shared/i18n";
import { cn } from "@/shared/lib";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/shared/ui/collapsible";

import { Shimmer } from "./shimmer";

interface ReasoningContextValue {
  isStreaming: boolean;
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
  duration: number | undefined;
}

const ReasoningContext = createContext<ReasoningContextValue | null>(null);

const useReasoning = () => {
  const context = useContext(ReasoningContext);
  if (!context) {
    throw new Error("Reasoning components must be used within Reasoning");
  }
  return context;
};

export type ReasoningProps = ComponentProps<typeof Collapsible> & {
  isStreaming?: boolean;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  duration?: number;
};

const MS_IN_S = 1000;

export const Reasoning = memo(
  ({
    className,
    isStreaming = false,
    open,
    defaultOpen,
    onOpenChange,
    duration: durationProp,
    children,
    ...props
  }: ReasoningProps) => {
    // 默认折叠:流式内容由触发行的单行尾巴承载,展开后才是全文(参考 zcode)
    const resolvedDefaultOpen = defaultOpen ?? false;

    const [isOpen, setIsOpen] = useControllableState<boolean>({
      defaultProp: resolvedDefaultOpen,
      onChange: onOpenChange,
      prop: open,
    });
    const [duration, setDuration] = useControllableState<number | undefined>({
      defaultProp: undefined,
      prop: durationProp,
    });

    const startTimeRef = useRef<number | null>(null);

    // Track when streaming starts and compute duration
    useEffect(() => {
      if (isStreaming) {
        if (startTimeRef.current === null) {
          startTimeRef.current = Date.now();
        }
      } else if (startTimeRef.current !== null) {
        setDuration(Math.ceil((Date.now() - startTimeRef.current) / MS_IN_S));
        startTimeRef.current = null;
      }
    }, [isStreaming, setDuration]);

    const handleOpenChange = useCallback(
      (newOpen: boolean) => {
        setIsOpen(newOpen);
      },
      [setIsOpen],
    );

    const contextValue = useMemo(
      () => ({ duration, isOpen, isStreaming, setIsOpen }),
      [duration, isOpen, isStreaming, setIsOpen],
    );

    return (
      <ReasoningContext.Provider value={contextValue}>
        <Collapsible
          className={cn("not-prose mb-4", className)}
          onOpenChange={handleOpenChange}
          open={isOpen}
          {...props}
        >
          {children}
        </Collapsible>
      </ReasoningContext.Provider>
    );
  },
);

export type ReasoningTriggerProps = ComponentProps<typeof CollapsibleTrigger> & {
  getThinkingMessage?: (isStreaming: boolean, duration?: number) => ReactNode;
  /** 流式中的推理全文;折叠态在触发行内单行滚动展示最新内容 */
  streamingText?: string;
};

const defaultGetThinkingMessage = (isStreaming: boolean, duration?: number) => {
  if (isStreaming || duration === 0) {
    return <Shimmer>{i18n.t("common:thinking")}</Shimmer>;
  }
  if (duration === undefined) {
    return <p>{i18n.t("common:thoughtBriefly")}</p>;
  }
  return <p>{i18n.t("common:thoughtDuration", { duration })}</p>;
};

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
    const { isStreaming, isOpen, duration } = useReasoning();

    return (
      <CollapsibleTrigger
        className={cn(
          "flex w-full items-center gap-2 text-muted-foreground text-sm transition-colors hover:text-foreground",
          className,
        )}
        {...props}
      >
        {children ?? (
          <>
            <BrainIcon className="size-4 shrink-0" />
            <span className="shrink-0">{getThinkingMessage(isStreaming, duration)}</span>
            {isStreaming && !isOpen ? <ReasoningStreamingPreview text={streamingText} /> : null}
            <ChevronDownIcon
              className={cn(
                "size-4 shrink-0 transition-transform",
                isOpen ? "rotate-180" : "rotate-0",
              )}
            />
          </>
        )}
      </CollapsibleTrigger>
    );
  },
);

export type ReasoningContentProps = ComponentProps<typeof CollapsibleContent> & {
  children: string;
};

const streamdownPlugins = { cjk, code, math, mermaid };

export const ReasoningContent = memo(({ className, children, ...props }: ReasoningContentProps) => {
  const { isStreaming } = useReasoning();

  return (
    <CollapsibleContent
      className={cn(
        "mt-0 text-sm",
        "data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 text-muted-foreground outline-none data-[state=closed]:animate-out data-[state=open]:animate-in",
        className,
      )}
      {...props}
    >
      {isStreaming ? (
        <div className="whitespace-pre-wrap break-words">{children}</div>
      ) : (
        <Streamdown plugins={streamdownPlugins}>{children}</Streamdown>
      )}
    </CollapsibleContent>
  );
});

Reasoning.displayName = "Reasoning";
ReasoningTrigger.displayName = "ReasoningTrigger";
ReasoningContent.displayName = "ReasoningContent";
