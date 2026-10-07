import { RefreshCwIcon, UploadIcon } from "lucide-react";
import { formatBytes, type LibraryAsset, statusLabel } from "@/entities/library";
import { useTranslation } from "@/shared/i18n";
import { FileTypeIcon } from "@/shared/ui/ai-elements/file-type-icon";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { Progress } from "@/shared/ui/progress";
import { ScrollArea } from "@/shared/ui/scroll-area";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/shared/ui/sheet";
import type { LibraryTransfer } from "./use-library-upload";

export function LibraryTransferPanel({
  open,
  onOpenChange,
  transfers,
  assets,
  uploading,
  progress,
  onRetry,
  onCancel,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  transfers: LibraryTransfer[];
  assets: LibraryAsset[];
  uploading: boolean;
  progress: number;
  onRetry: (id?: string) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const completed = transfers.filter((item) => item.status === "uploaded").length;
  const retryable = transfers.some(
    (item) => item.status === "failed" || item.status === "cancelled",
  );
  const totalBytes = transfers.reduce((sum, item) => sum + item.file.size, 0);
  const uploadedBytes = transfers.reduce((sum, item) => sum + item.uploadedBytes, 0);
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-lg">
        <SheetHeader className="shrink-0 border-b pr-12">
          <SheetTitle className="flex items-center gap-2">
            <UploadIcon className="size-4" />
            {t("library:transferPanel")}
          </SheetTitle>
          <SheetDescription>{t("library:transferPanelHint")}</SheetDescription>
        </SheetHeader>
        <div className="grid shrink-0 gap-2 border-b p-4">
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span>{t("library:transferSummary", { completed, total: transfers.length })}</span>
            <span className="tabular-nums">{progress}%</span>
          </div>
          <Progress value={progress} aria-label={t("library:transferPanel")} />
          <p className="text-xs tabular-nums text-muted-foreground">
            {formatBytes(uploadedBytes)} / {formatBytes(totalBytes)}
          </p>
        </div>
        <ScrollArea className="min-h-0 flex-1">
          <ul className="grid min-w-0 gap-2 p-3">
            {transfers.map((item) => {
              const percent = item.file.size
                ? Math.round((item.uploadedBytes / item.file.size) * 100)
                : 0;
              const asset = assets.find((entry) => entry.id === item.assetId);
              return (
                <li key={item.id} className="grid min-w-0 gap-2 rounded-lg border p-3">
                  <div className="flex min-w-0 items-start gap-2">
                    <FileTypeIcon mediaType={item.file.type} name={item.file.name} />
                    <span className="min-w-0 flex-1 break-words text-sm font-medium">
                      {item.file.name}
                    </span>
                    <Badge
                      variant={item.status === "failed" ? "destructive" : "secondary"}
                      className="shrink-0"
                    >
                      {t(`library:transferStates.${item.status}`)}
                    </Badge>
                  </div>
                  <Progress value={percent} aria-label={item.file.name} />
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs tabular-nums text-muted-foreground">
                    <span>
                      {formatBytes(item.uploadedBytes)} / {formatBytes(item.file.size)}
                    </span>
                    <span>{percent}%</span>
                  </div>
                  {item.error ? (
                    <p role="alert" className="break-words text-xs text-destructive">
                      {item.error}
                    </p>
                  ) : null}
                  {item.status === "uploaded" && asset ? (
                    <p className="break-words text-xs text-muted-foreground">
                      {statusLabel(asset.status)}
                      {asset.indexError ? ` · ${asset.indexError}` : ""}
                    </p>
                  ) : null}
                  {item.status === "failed" || item.status === "cancelled" ? (
                    <Button
                      size="sm"
                      variant="outline"
                      className="justify-self-start"
                      disabled={uploading}
                      onClick={() => onRetry(item.id)}
                    >
                      <RefreshCwIcon />
                      {t("library:retry")}
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </ScrollArea>
        <div className="flex shrink-0 flex-wrap justify-end gap-2 border-t p-3">
          {retryable ? (
            <Button variant="outline" size="sm" disabled={uploading} onClick={() => onRetry()}>
              {t("library:retryUnfinished")}
            </Button>
          ) : null}
          {uploading ? (
            <Button variant="outline" size="sm" onClick={onCancel}>
              {t("library:cancelUpload")}
            </Button>
          ) : null}
          <Button size="sm" onClick={() => onOpenChange(false)}>
            {t("common:close")}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
