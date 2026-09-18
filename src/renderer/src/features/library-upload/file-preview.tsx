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
import { AlertCircleIcon } from "lucide-react";
import pdfWorkerSrc from "pdfjs-dist/build/pdf.worker.mjs?url";
import * as React from "react";
import { fetchLibraryAssetBlob } from "@/entities/library";
import { useTranslation } from "@/shared/i18n";
import { useTheme } from "@/shared/theme";
import { Dotm3x3_1 } from "@/shared/ui/dotm-3x3-1";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/shared/ui/empty";

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

const LIBRARY_PREVIEW_TOOLBAR = {
  zoom: true,
  rotate: true,
  download: true,
  fullscreen: true,
  print: true,
  search: true,
} as const;

export default React.memo(function LibraryFilePreview({ asset }: { asset: PreviewLibraryAsset }) {
  const { t, i18n } = useTranslation();
  const { theme } = useTheme();
  const [loadedState, setLoadedState] = React.useState<{
    url: string;
    objectUrl: string | null;
  } | null>(null);

  React.useEffect(() => {
    let disposed = false;
    let objectUrl: string | undefined;

    void fetchLibraryAssetBlob(asset.url)
      .then((blob) => {
        objectUrl = URL.createObjectURL(blob);
        if (disposed) {
          URL.revokeObjectURL(objectUrl);
        } else {
          setLoadedState({ url: asset.url, objectUrl });
        }
      })
      .catch(() => {
        if (!disposed) {
          setLoadedState({ url: asset.url, objectUrl: null });
        }
      });

    return () => {
      disposed = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [asset.url]);

  const isLoading = !loadedState || loadedState.url !== asset.url;
  if (isLoading) {
    return (
      <div className="flex size-full items-center justify-center gap-2 text-sm text-muted-foreground">
        <Dotm3x3_1 size={14} dotSize={2.2} colorPreset="solid-theme" />
        <span>{t("library:loadingPreview")}</span>
      </div>
    );
  }

  const fileUrl = loadedState.objectUrl;
  if (!fileUrl) {
    return (
      <Empty className="size-full justify-center">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <AlertCircleIcon className="text-destructive" />
          </EmptyMedia>
          <EmptyTitle className="text-destructive">{t("library:loadPreviewFailed")}</EmptyTitle>
          <EmptyDescription>
            {t("library:loadPreviewFailedDesc", { filename: asset.filename })}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
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
      locale={i18n.language.startsWith("zh") ? "zh-CN" : "en-US"}
      plugins={plugins}
      theme={theme === "system" ? "auto" : theme}
      toolbar={LIBRARY_PREVIEW_TOOLBAR}
    />
  );
});
