import { syntaxTree } from "@codemirror/language";
import type { Diagnostic } from "@codemirror/lint";
import type { EditorView } from "@codemirror/view";
import { langs } from "@uiw/codemirror-extensions-langs";

const BINARY_ONLY_PREVIEWABLE_EXTS = new Set([
  "pdf",
  "docx",
  "doc",
  "xlsx",
  "xls",
  "pptx",
  "ppt",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "ico",
  "mp3",
  "wav",
  "ogg",
  "mp4",
  "webm",
  "zip",
  "tar",
  "gz",
]);

export function getFileExtension(filename: string): string {
  return filename.split(".").pop()?.toLowerCase() ?? "";
}

export function isBinaryPreviewable(filename: string): boolean {
  return BINARY_ONLY_PREVIEWABLE_EXTS.has(getFileExtension(filename));
}

export function editorExtension(path: string) {
  const lower = path.toLowerCase();
  if (/\.(?:tsx)$/.test(lower)) return langs.tsx();
  if (/\.(?:ts|mts|cts)$/.test(lower)) return langs.ts();
  if (/\.(?:jsx)$/.test(lower)) return langs.jsx();
  if (/\.(?:js|mjs|cjs)$/.test(lower)) return langs.js();
  if (/\.py$/.test(lower)) return langs.python();
  if (/\.(?:json|jsonc)$/.test(lower)) return langs.json();
  if (/\.(?:md|mdx)$/.test(lower)) return langs.markdown();
  if (/\.(?:html|htm)$/.test(lower)) return langs.html();
  if (/\.css$/.test(lower)) return langs.css();
  return [];
}

import { i18n } from "@/shared/i18n";

export function syntaxLinter(view: EditorView): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  syntaxTree(view.state)
    .cursor()
    .iterate((node) => {
      if (!node.type.isError) return;
      diagnostics.push({
        from: node.from,
        message: i18n.t("workspace:syntaxError"),
        severity: "error",
        source: "CodeMirror",
        to: Math.max(node.to, node.from + 1),
      });
    });
  return diagnostics;
}
