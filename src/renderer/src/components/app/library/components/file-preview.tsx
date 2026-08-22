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
  return (
    <FileViewer
      key={asset.id}
      className="size-full"
      file={asset.url}
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
