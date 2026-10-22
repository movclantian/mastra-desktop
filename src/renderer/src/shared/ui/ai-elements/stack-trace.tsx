"use client";

import { AlertTriangleIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { createContext, memo, useCallback, useContext, useMemo } from "react";
import { cn } from "@/shared/lib";
import { Button } from "@/shared/ui/button";
import { CodeBlock, CodeBlockContent, CodeBlockCopyButton } from "@/shared/ui/code-block";
import { ScrollArea } from "@/shared/ui/scroll-area";
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "@/shared/ui/trace";

// Regex patterns for parsing stack traces
const STACK_FRAME_WITH_PARENS_REGEX = /^at\s+(.+?)\s+\((.+):(\d+):(\d+)\)$/;
const STACK_FRAME_WITHOUT_FN_REGEX = /^at\s+(.+):(\d+):(\d+)$/;
const ERROR_TYPE_REGEX = /^(\w+Error|Error):\s*(.*)$/;
const AT_PREFIX_REGEX = /^at\s+/;

interface StackFrame {
  raw: string;
  functionName: string | null;
  filePath: string | null;
  lineNumber: number | null;
  columnNumber: number | null;
  isInternal: boolean;
}

interface ParsedStackTrace {
  errorType: string | null;
  errorMessage: string;
  frames: StackFrame[];
  raw: string;
}

interface StackTraceContextValue {
  trace: ParsedStackTrace;
  raw: string;
  onFilePathClick?: (filePath: string, line?: number, column?: number) => void;
}

const StackTraceContext = createContext<StackTraceContextValue | null>(null);

const useStackTrace = () => {
  const context = useContext(StackTraceContext);
  if (!context) {
    throw new Error("StackTrace components must be used within StackTrace");
  }
  return context;
};

const parseStackFrame = (line: string): StackFrame => {
  const trimmed = line.trim();

  // Pattern: at functionName (filePath:line:column)
  const withParensMatch = trimmed.match(STACK_FRAME_WITH_PARENS_REGEX);
  if (withParensMatch) {
    const [, functionName, filePath, lineNum, colNum] = withParensMatch;
    const isInternal =
      filePath.includes("node_modules") ||
      filePath.startsWith("node:") ||
      filePath.includes("internal/");
    return {
      columnNumber: colNum ? Number.parseInt(colNum, 10) : null,
      filePath: filePath ?? null,
      functionName: functionName ?? null,
      isInternal,
      lineNumber: lineNum ? Number.parseInt(lineNum, 10) : null,
      raw: trimmed,
    };
  }

  // Pattern: at filePath:line:column (no function name)
  const withoutFnMatch = trimmed.match(STACK_FRAME_WITHOUT_FN_REGEX);
  if (withoutFnMatch) {
    const [, filePath, lineNum, colNum] = withoutFnMatch;
    const isInternal =
      (filePath?.includes("node_modules") ?? false) ||
      (filePath?.startsWith("node:") ?? false) ||
      (filePath?.includes("internal/") ?? false);
    return {
      columnNumber: colNum ? Number.parseInt(colNum, 10) : null,
      filePath: filePath ?? null,
      functionName: null,
      isInternal,
      lineNumber: lineNum ? Number.parseInt(lineNum, 10) : null,
      raw: trimmed,
    };
  }

  // Fallback: unparseable line
  return {
    columnNumber: null,
    filePath: null,
    functionName: null,
    isInternal: trimmed.includes("node_modules") || trimmed.includes("node:"),
    lineNumber: null,
    raw: trimmed,
  };
};

const parseStackTrace = (trace: string): ParsedStackTrace => {
  const lines = trace.split("\n").filter((line) => line.trim());

  if (lines.length === 0) {
    return {
      errorMessage: trace,
      errorType: null,
      frames: [],
      raw: trace,
    };
  }

  const firstLine = lines[0].trim();
  let errorType: string | null = null;
  let errorMessage = firstLine;

  // Try to extract error type from "ErrorType: message" format
  const errorMatch = firstLine.match(ERROR_TYPE_REGEX);
  if (errorMatch) {
    const [, type, msg] = errorMatch;
    errorType = type;
    errorMessage = msg || "";
  }

  // Parse stack frames (lines starting with "at")
  const frames = lines
    .slice(1)
    .filter((line) => line.trim().startsWith("at "))
    .map(parseStackFrame);

  return {
    errorMessage,
    errorType,
    frames,
    raw: trace,
  };
};

export type StackTraceProps = Omit<
  ComponentProps<typeof TraceCollapsible>,
  "open" | "onOpenChange"
> & {
  trace: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onFilePathClick?: (filePath: string, line?: number, column?: number) => void;
};

export const StackTrace = memo(
  ({
    trace,
    className,
    open,
    onOpenChange,
    onFilePathClick,
    children,
    ...props
  }: StackTraceProps) => {
    const parsedTrace = useMemo(() => parseStackTrace(trace), [trace]);

    const contextValue = useMemo(
      () => ({
        onFilePathClick,
        raw: trace,
        trace: parsedTrace,
      }),
      [parsedTrace, trace, onFilePathClick],
    );

    return (
      <StackTraceContext.Provider value={contextValue}>
        <Trace>
          <TraceCollapsible
            open={open}
            onOpenChange={onOpenChange}
            className={cn(
              "not-prose w-full overflow-hidden rounded-lg border bg-background font-mono text-sm",
              className,
            )}
            {...props}
          >
            {children}
          </TraceCollapsible>
        </Trace>
      </StackTraceContext.Provider>
    );
  },
);

export type StackTraceHeaderProps = ComponentProps<typeof TraceCollapsibleTrigger> & {
  action?: ReactNode;
};

export const StackTraceHeader = memo(
  ({ className, children, action, ...props }: StackTraceHeaderProps) => (
    <div className="flex min-w-0 items-center gap-1 pr-2">
      <TraceCollapsibleTrigger className={cn("w-full p-3", className)} {...props}>
        <TraceLine status="error" className="flex-1">
          <TraceIcon>
            <AlertTriangleIcon />
          </TraceIcon>
          {children}
        </TraceLine>
      </TraceCollapsibleTrigger>
      {action}
    </div>
  ),
);

export type StackTraceErrorProps = ComponentProps<typeof TraceTitle>;

export const StackTraceError = memo(({ className, children, ...props }: StackTraceErrorProps) => (
  <TraceTitle
    className={cn("flex flex-1 items-center gap-2 whitespace-normal", className)}
    {...props}
  >
    {children}
  </TraceTitle>
));

export type StackTraceErrorTypeProps = ComponentProps<"span">;

export const StackTraceErrorType = memo(
  ({ className, children, ...props }: StackTraceErrorTypeProps) => {
    const { trace } = useStackTrace();

    return (
      <span className={cn("shrink-0 font-semibold text-destructive", className)} {...props}>
        {children ?? trace.errorType}
      </span>
    );
  },
);

export type StackTraceErrorMessageProps = ComponentProps<"span">;

export const StackTraceErrorMessage = memo(
  ({ className, children, ...props }: StackTraceErrorMessageProps) => {
    const { trace } = useStackTrace();

    return (
      <span className={cn("truncate text-foreground", className)} {...props}>
        {children ?? trace.errorMessage}
      </span>
    );
  },
);

export const StackTraceCopyButton = memo(() => {
  const { raw } = useStackTrace();
  return <CodeBlockCopyButton value={raw} />;
});

export type StackTraceContentProps = ComponentProps<typeof TraceCollapsibleContent> & {
  maxHeight?: number;
};

export const StackTraceContent = memo(
  ({ className, maxHeight = 400, children, ...props }: StackTraceContentProps) => (
    <TraceCollapsibleContent className={className} {...props}>
      <ScrollArea style={{ maxHeight }}>{children}</ScrollArea>
    </TraceCollapsibleContent>
  ),
);

export type StackTraceFramesProps = ComponentProps<"div"> & {
  showInternalFrames?: boolean;
};

interface FilePathButtonProps {
  frame: StackFrame;
  onFilePathClick?: (filePath: string, lineNumber?: number, columnNumber?: number) => void;
}

const FilePathButton = memo(({ frame, onFilePathClick }: FilePathButtonProps) => {
  const handleClick = useCallback(() => {
    if (frame.filePath) {
      onFilePathClick?.(
        frame.filePath,
        frame.lineNumber ?? undefined,
        frame.columnNumber ?? undefined,
      );
    }
  }, [frame, onFilePathClick]);

  return (
    <Button
      variant="link"
      size="xs"
      className={cn(
        "h-auto min-w-0 p-0 text-xs whitespace-normal break-all underline decoration-dotted hover:text-primary",
        onFilePathClick && "cursor-pointer",
      )}
      disabled={!onFilePathClick}
      onClick={handleClick}
      type="button"
    >
      {frame.filePath}
      {frame.lineNumber !== null && `:${frame.lineNumber}`}
      {frame.columnNumber !== null && `:${frame.columnNumber}`}
    </Button>
  );
});

FilePathButton.displayName = "FilePathButton";

export const StackTraceFrames = memo(
  ({ className, showInternalFrames = true, ...props }: StackTraceFramesProps) => {
    const { trace, onFilePathClick } = useStackTrace();

    const framesToShow = showInternalFrames
      ? trace.frames
      : trace.frames.filter((f) => !f.isInternal);

    return (
      <div className={className} {...props}>
        <CodeBlock size="sm">
          <CodeBlockContent wrap>
            {framesToShow.map((frame, index) => (
              <span
                className={cn(
                  "block text-xs",
                  frame.isInternal ? "text-muted-foreground/50" : "text-foreground/90",
                )}
                key={`${index}:${frame.raw}`}
              >
                <span className="text-muted-foreground">at </span>
                {frame.functionName && (
                  <span className={frame.isInternal ? "" : "text-foreground"}>
                    {frame.functionName}{" "}
                  </span>
                )}
                {frame.filePath && (
                  <>
                    <span className="text-muted-foreground">(</span>
                    <FilePathButton frame={frame} onFilePathClick={onFilePathClick} />
                    <span className="text-muted-foreground">)</span>
                  </>
                )}
                {!(frame.filePath || frame.functionName) && (
                  <span>{frame.raw.replace(AT_PREFIX_REGEX, "")}</span>
                )}
              </span>
            ))}
            {framesToShow.length === 0 && (
              <span className="text-muted-foreground text-xs">{trace.raw}</span>
            )}
          </CodeBlockContent>
        </CodeBlock>
      </div>
    );
  },
);

StackTrace.displayName = "StackTrace";
StackTraceHeader.displayName = "StackTraceHeader";
StackTraceError.displayName = "StackTraceError";
StackTraceErrorType.displayName = "StackTraceErrorType";
StackTraceErrorMessage.displayName = "StackTraceErrorMessage";
StackTraceCopyButton.displayName = "StackTraceCopyButton";
StackTraceContent.displayName = "StackTraceContent";
StackTraceFrames.displayName = "StackTraceFrames";
