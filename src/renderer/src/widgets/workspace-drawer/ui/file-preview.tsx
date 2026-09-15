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
import { FileQuestionIcon } from "lucide-react";
import pdfWorkerSrc from "pdfjs-dist/build/pdf.worker.mjs?url";
import * as React from "react";
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
          <EmptyTitle>无法预览此文件</EmptyTitle>
          <EmptyDescription>未找到有效的文件内容或预览源（{fileName}）</EmptyDescription>
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
        locale="zh-CN"
        plugins={fileViewerPlugins}
        toolbar={DEFAULT_PREVIEW_TOOLBAR}
      />
    </div>
  );
});
