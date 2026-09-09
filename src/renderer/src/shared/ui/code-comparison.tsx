import { langs } from "@uiw/codemirror-extensions-langs";
import type { HTMLAttributes } from "react";
import { useMemo } from "react";
import CodeMirrorMerge from "react-codemirror-merge";
import { cn } from "@/shared/lib";

export interface CodeComparisonProps extends HTMLAttributes<HTMLDivElement> {
  beforeCode: string;
  afterCode: string;
  language?: string;
  filename?: string;
}

function languageExtension(filename: string, language: string) {
  const lower = filename.toLowerCase();
  if (language === "typescript" || /\.(?:tsx|ts|mts|cts)$/.test(lower)) {
    return /\.tsx$/.test(lower) ? langs.tsx() : langs.ts();
  }
  if (language === "javascript" || /\.(?:jsx|js|mjs|cjs)$/.test(lower)) {
    return /\.jsx$/.test(lower) ? langs.jsx() : langs.js();
  }
  if (language === "python" || /\.py$/.test(lower)) return langs.python();
  if (language === "json" || /\.jsonc?$/.test(lower)) return langs.json();
  if (language === "markdown" || /\.(?:md|mdx)$/.test(lower)) return langs.markdown();
  if (language === "html" || /\.(?:html|htm)$/.test(lower)) return langs.html();
  if (language === "css" || /\.css$/.test(lower)) return langs.css();
  return [];
}

export function CodeComparison({
  beforeCode,
  afterCode,
  language = "text",
  filename,
  className,
  ...props
}: CodeComparisonProps) {
  const extensions = useMemo(
    () => [languageExtension(filename ?? "", language)],
    [filename, language],
  );
  return (
    <div
      className={cn("w-full min-w-0 overflow-hidden rounded-md border bg-background", className)}
      {...props}
    >
      <div className="flex min-w-0 items-center gap-2 border-b bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
        <span className="min-w-0 flex-1 truncate font-mono text-foreground">
          {filename ?? "代码更改"}
        </span>
        <span className="shrink-0">{language}</span>
      </div>
      <CodeMirrorMerge
        className="min-h-48"
        collapseUnchanged={{ margin: 3, minSize: 4 }}
        gutter
        highlightChanges
        orientation="a-b"
        theme="none"
      >
        <CodeMirrorMerge.Original
          basicSetup
          editable={false}
          extensions={extensions}
          readOnly
          value={beforeCode}
        />
        <CodeMirrorMerge.Modified
          basicSetup
          editable={false}
          extensions={extensions}
          readOnly
          value={afterCode}
        />
      </CodeMirrorMerge>
    </div>
  );
}
