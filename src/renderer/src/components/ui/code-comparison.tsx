"use client";

import { diffLines } from "diff";
import { ChevronRightIcon } from "lucide-react";
import type { HTMLAttributes } from "react";
import { useMemo } from "react";
import { cn } from "@/lib/utils";

export interface CodeComparisonProps extends HTMLAttributes<HTMLDivElement> {
  beforeCode: string;
  afterCode: string;
  language?: string;
  filename?: string;
}

interface ComparisonLine {
  before: string | null;
  after: string | null;
  beforeNumber?: number;
  afterNumber?: number;
  changed: boolean;
}

function splitLines(value: string): string[] {
  if (!value) return [];
  return value.replace(/\r\n/g, "\n").split("\n");
}

function buildLines(beforeCode: string, afterCode: string): ComparisonLine[] {
  const lines: ComparisonLine[] = [];
  let beforeNumber = 1;
  let afterNumber = 1;
  for (const part of diffLines(beforeCode, afterCode)) {
    const source = splitLines(part.value);
    if (part.removed) {
      for (const line of source) {
        lines.push({ before: line, after: null, beforeNumber, changed: true });
        beforeNumber += 1;
      }
      continue;
    }
    if (part.added) {
      for (const line of source) {
        lines.push({ after: line, before: null, afterNumber, changed: true });
        afterNumber += 1;
      }
      continue;
    }
    for (const line of source) {
      lines.push({
        before: line,
        after: line,
        beforeNumber,
        afterNumber,
        changed: false,
      });
      beforeNumber += 1;
      afterNumber += 1;
    }
  }
  return lines;
}

function CodeSide({
  side,
  lines,
  language,
}: {
  side: "before" | "after";
  lines: ComparisonLine[];
  language: string;
}) {
  return (
    <div className="min-w-0 flex-1 overflow-x-auto">
      <div className="border-b bg-muted/50 px-3 py-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {side === "before" ? "原始" : "更改后"}
      </div>
      <pre className="m-0 min-w-max p-0 font-mono text-[11px] leading-5">
        <code data-language={language}>
          {lines.map((line, index) => {
            const value = line[side];
            const number = side === "before" ? line.beforeNumber : line.afterNumber;
            const isEmpty = value === null;
            return (
              <span
                className={cn(
                  "flex min-h-5 whitespace-pre",
                  line.changed && !isEmpty
                    ? side === "before"
                      ? "bg-red-500/10 text-red-950 dark:text-red-100"
                      : "bg-emerald-500/10 text-emerald-950 dark:text-emerald-100"
                    : "text-foreground/85",
                  isEmpty && "bg-muted/25 text-transparent",
                )}
                key={`${side}-${index}`}
              >
                <span className="w-9 shrink-0 select-none border-r border-border/50 px-2 text-right text-muted-foreground/50">
                  {number ?? ""}
                </span>
                <span className="px-2">{value ?? " "}</span>
              </span>
            );
          })}
        </code>
      </pre>
    </div>
  );
}

export function CodeComparison({
  beforeCode,
  afterCode,
  language = "text",
  filename,
  className,
  ...props
}: CodeComparisonProps) {
  const lines = useMemo(() => buildLines(beforeCode, afterCode), [afterCode, beforeCode]);
  const changedLines = lines.filter((line) => line.changed).length;

  return (
    <div
      className={cn("w-full overflow-hidden rounded-md border bg-background", className)}
      {...props}
    >
      <div className="flex min-w-0 items-center gap-2 border-b bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
        <span className="truncate font-mono text-foreground">{filename ?? "代码更改"}</span>
        <ChevronRightIcon className="size-3 shrink-0" />
        <span className="shrink-0">{language}</span>
        <span className="ml-auto shrink-0 font-mono">{changedLines} 行变化</span>
      </div>
      <div className="flex min-w-0 divide-x divide-border">
        <CodeSide language={language} lines={lines} side="before" />
        <CodeSide language={language} lines={lines} side="after" />
      </div>
    </div>
  );
}
