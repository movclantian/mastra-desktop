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
import { LoaderCircleIcon } from "lucide-react";
import pdfWorkerSrc from "pdfjs-dist/build/pdf.worker.mjs?url";
import * as React from "react";
import { useTheme } from "@/components/theme-provider";

const plugins = [
  imagePlugin(),
  textPlugin(),
  pdfPlugin({ workerSrc: pdfWorkerSrc }),
  officePlugin({ pdf: { workerSrc: pdfWorkerSrc } }),
  audioPlugin(),
  videoPlugin(),
  archivePlugin(),
  fallbackPlugin(),
];

export interface PreviewLibraryAsset {
  id: string;
  filename: string;
  mediaType: string;
  url: string;
}

export default function LibraryFilePreview({ asset }: { asset: PreviewLibraryAsset }) {
  const { theme } = useTheme();
  const [fileUrl, setFileUrl] = React.useState<string | null | undefined>(undefined);

  React.useEffect(() => {
    let disposed = false;
    let objectUrl: string | undefined;
    setFileUrl(undefined);
    void fetch(asset.url)
      .then(async (response) => {
        if (!response.ok) throw new Error("文件加载失败");
        return response.blob();
      })
      .then((blob) => {
        objectUrl = URL.createObjectURL(blob);
        if (disposed) {
          URL.revokeObjectURL(objectUrl);
        } else {
          setFileUrl(objectUrl);
        }
      })
      .catch(() => {
        if (!disposed) setFileUrl(null);
      });
    return () => {
      disposed = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [asset.url]);

  if (fileUrl === undefined) {
    return (
      <div className="flex size-full items-center justify-center gap-2 text-sm text-muted-foreground">
        <LoaderCircleIcon className="size-4 animate-spin" />
        正在加载预览
      </div>
    );
  }
  if (!fileUrl) {
    return (
      <div className="flex size-full items-center justify-center text-sm text-destructive">
        文件加载失败
      </div>
    );
  }

  return (
    <FileViewer
      key={asset.id}
      className="size-full"
      file={fileUrl}
      fileName={asset.filename}
      mimeType={asset.mediaType}
      width="100%"
      height="100%"
      fit="contain"
      fallback="inline"
      locale="zh-CN"
      plugins={plugins}
      theme={theme === "system" ? "auto" : theme}
      toolbar={{
        zoom: true,
        rotate: true,
        download: true,
        fullscreen: true,
        print: true,
        search: true,
      }}
    />
  );
}
