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
import pdfWorkerSrc from "pdfjs-dist/build/pdf.worker.mjs?url";
import * as React from "react";
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

export function WorkspaceFilePreview({
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
  const blobUrl = React.useMemo(() => {
    if (!isDraft || content === undefined) return null;
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
    return URL.createObjectURL(new Blob([content], { type }));
  }, [content, fileName, isDraft, mimeType]);

  React.useEffect(() => {
    return () => {
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [blobUrl]);

  const source = blobUrl || url;
  if (!source) {
    return (
      <div className="flex size-full items-center justify-center text-xs text-muted-foreground">
        无法获取文件预览源
      </div>
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
        toolbar={{
          zoom: true,
          rotate: true,
          download: true,
          fullscreen: true,
          print: true,
          search: true,
        }}
      />
    </div>
  );
}
