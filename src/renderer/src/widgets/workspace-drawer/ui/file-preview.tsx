import {
  archivePlugin,
  audioPlugin,
  fallbackPlugin,
  imagePlugin,
  officePlugin,
  pdfPlugin,
  textPlugin,
  videoPlugin,
} from "@open-file-viewer/core";
import "@open-file-viewer/core/style.css";
import { FileViewer } from "@open-file-viewer/react";
import { FileCode2Icon, FileQuestionIcon } from "lucide-react";
import pdfWorkerSrc from "pdfjs-dist/build/pdf.worker.mjs?url";
import * as React from "react";
import type { BundledLanguage } from "shiki";
import { useTranslation } from "@/shared/i18n";
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockCopyButton,
  CodeBlockFilename,
  CodeBlockHeader,
  CodeBlockLanguageSelector,
  CodeBlockLanguageSelectorContent,
  CodeBlockLanguageSelectorItem,
  CodeBlockLanguageSelectorTrigger,
  CodeBlockLanguageSelectorValue,
  CodeBlockTitle,
} from "@/shared/ui/ai-elements/code-block";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/shared/ui/empty";
import { getFileExtension } from "../lib/editor";

const fileViewerPlugins = [
  imagePlugin(),
  textPlugin(),
  pdfPlugin({ workerSrc: pdfWorkerSrc }),
  officePlugin({ pdf: { workerSrc: pdfWorkerSrc } }),
  audioPlugin(),
  videoPlugin(),
  archivePlugin(),
  fallbackPlugin(),
];

const DEFAULT_PREVIEW_TOOLBAR = {
  zoom: true,
  rotate: true,
  download: true,
  fullscreen: true,
  print: true,
  search: true,
} as const;

const CODE_LANGUAGES: Record<string, string> = {
  c: "c",
  cpp: "cpp",
  css: "css",
  go: "go",
  html: "html",
  java: "java",
  js: "javascript",
  json: "json",
  jsx: "jsx",
  md: "markdown",
  mdx: "mdx",
  py: "python",
  rb: "ruby",
  rs: "rust",
  sh: "bash",
  sql: "sql",
  ts: "typescript",
  tsx: "tsx",
  vue: "vue",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
};

const CODE_LANGUAGE_OPTIONS = [...new Set(Object.values(CODE_LANGUAGES))].sort();

function WorkspaceCodePreview({
  code,
  fileName,
  initialLanguage,
}: {
  code: string;
  fileName: string;
  initialLanguage: BundledLanguage;
}) {
  const { t } = useTranslation();
  const [language, setLanguage] = React.useState(initialLanguage);

  return (
    <CodeBlock
      className="size-full overflow-auto rounded-none border-0"
      code={code}
      language={language}
      showLineNumbers
    >
      <CodeBlockHeader className="sticky top-0 z-10">
        <CodeBlockTitle className="min-w-0">
          <FileCode2Icon className="size-3.5 shrink-0" />
          <CodeBlockFilename className="truncate" title={fileName}>
            {fileName}
          </CodeBlockFilename>
        </CodeBlockTitle>
        <CodeBlockActions>
          <CodeBlockLanguageSelector
            onValueChange={(value) => {
              if (value) setLanguage(value as BundledLanguage);
            }}
            value={language}
          >
            <CodeBlockLanguageSelectorTrigger aria-label={t("common:language")}>
              <CodeBlockLanguageSelectorValue />
            </CodeBlockLanguageSelectorTrigger>
            <CodeBlockLanguageSelectorContent>
              {CODE_LANGUAGE_OPTIONS.map((option) => (
                <CodeBlockLanguageSelectorItem key={option} value={option}>
                  {option}
                </CodeBlockLanguageSelectorItem>
              ))}
            </CodeBlockLanguageSelectorContent>
          </CodeBlockLanguageSelector>
          <CodeBlockCopyButton size="icon-xs" />
        </CodeBlockActions>
      </CodeBlockHeader>
    </CodeBlock>
  );
}

export const WorkspaceFilePreview = React.memo(function WorkspaceFilePreview({
  filePath,
  fileName,
  url,
  content,
  isDraft,
  mimeType,
}: {
  filePath: string;
  fileName: string;
  url?: string;
  content?: string;
  isDraft?: boolean;
  mimeType?: string;
}) {
  const { t, i18n } = useTranslation();
  const [blobUrl, setBlobUrl] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!isDraft || content === undefined) {
      setBlobUrl(null);
      return;
    }
    const ext = getFileExtension(fileName);
    const type =
      mimeType ||
      (ext === "html" || ext === "htm"
        ? "text/html;charset=utf-8"
        : ext === "svg"
          ? "image/svg+xml"
          : ext === "md" || ext === "markdown" || ext === "mdx"
            ? "text/markdown;charset=utf-8"
            : ext === "json"
              ? "application/json;charset=utf-8"
              : ext === "csv"
                ? "text/csv;charset=utf-8"
                : "text/plain;charset=utf-8");
    const nextUrl = URL.createObjectURL(new Blob([content], { type }));
    setBlobUrl(nextUrl);
    return () => {
      URL.revokeObjectURL(nextUrl);
    };
  }, [content, fileName, isDraft, mimeType]);

  const source = isDraft ? blobUrl : url;
  const language = CODE_LANGUAGES[getFileExtension(fileName)];
  if (content !== undefined && language) {
    return (
      <WorkspaceCodePreview
        code={content}
        fileName={fileName}
        initialLanguage={language as BundledLanguage}
        key={`${filePath}:${language}`}
      />
    );
  }
  if (!source) {
    if (isDraft && content !== undefined) {
      return null;
    }
    return (
      <Empty className="size-full justify-center">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <FileQuestionIcon />
          </EmptyMedia>
          <EmptyTitle>{t("workspace:cannotPreviewFile")}</EmptyTitle>
          <EmptyDescription>{t("workspace:noValidFileContent", { fileName })}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="size-full overflow-hidden bg-background">
      <FileViewer
        key={`${filePath}-${isDraft ? "draft" : "raw"}`}
        className="size-full"
        file={source}
        fileName={fileName}
        mimeType={mimeType}
        width="100%"
        height="100%"
        fit="contain"
        fallback="inline"
        locale={i18n.language === "zh" ? "zh-CN" : "en-US"}
        plugins={fileViewerPlugins}
        toolbar={DEFAULT_PREVIEW_TOOLBAR}
      />
    </div>
  );
});
