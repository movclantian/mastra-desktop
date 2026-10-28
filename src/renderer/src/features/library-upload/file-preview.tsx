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
import { EditorView } from "@codemirror/view";
import { FileViewer } from "@open-file-viewer/react";
import CodeMirror from "@uiw/react-codemirror";
import { AlertCircleIcon, PencilLineIcon, SaveIcon } from "lucide-react";
import pdfWorkerSrc from "pdfjs-dist/build/pdf.worker.mjs?url";
import * as React from "react";
import { toast } from "sonner";
import { fetchLibraryAssetBlob } from "@/entities/library";
import type { LibraryAsset, LibraryFolder } from "@/entities/library/model/types";
import { requestJson } from "@/shared/api";
import { useTranslation } from "@/shared/i18n";
import { useTheme } from "@/shared/theme";
import { confirmAction } from "@/shared/ui/alert-dialog";
import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { Dotm3x3_1 } from "@/shared/ui/dotm-3x3-1";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/shared/ui/empty";
import { Field, FieldLabel } from "@/shared/ui/field";
import { Input } from "@/shared/ui/input";
import { ScrollArea } from "@/shared/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/shared/ui/select";
import {
  MAX_TEXT_DOCUMENT_BYTES,
  TextDocumentFilenameSchema,
} from "../../../../shared/workspace-contract";

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

interface PreviewLibraryAsset {
  id: string;
  filename: string;
  mediaType: string;
  url: string;
  byteSize?: number;
  folderIds?: string[];
}

const LIBRARY_PREVIEW_TOOLBAR = {
  zoom: true,
  rotate: true,
  download: true,
  fullscreen: true,
  print: true,
  search: true,
} as const;

interface DocumentEditingProps {
  resourceId: string;
  folders: LibraryFolder[];
  onSaved: (asset: LibraryAsset) => Promise<void>;
}

export default React.memo(function LibraryFilePreview({
  asset,
  editing,
  linkTarget,
}: {
  asset: PreviewLibraryAsset;
  editing?: DocumentEditingProps;
  linkTarget: "browser" | "external";
}) {
  const { t, i18n } = useTranslation();
  const { mode } = useTheme();
  const [loadedState, setLoadedState] = React.useState<{
    url: string;
    blob: Blob | null;
  } | null>(null);

  React.useEffect(() => {
    let disposed = false;
    void fetchLibraryAssetBlob(asset.url)
      .then((blob) => {
        if (!disposed) setLoadedState({ url: asset.url, blob });
      })
      .catch(() => {
        if (!disposed) {
          setLoadedState({ url: asset.url, blob: null });
        }
      });

    return () => {
      disposed = true;
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

  const file = loadedState.blob;
  if (!file) {
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
    <div className="flex size-full min-h-0 min-w-0 flex-col" data-link-target={linkTarget}>
      {editing &&
      /\.(?:md|markdown|txt|csv)$/i.test(asset.filename) &&
      (asset.byteSize ?? Infinity) <= MAX_TEXT_DOCUMENT_BYTES ? (
        <LibraryDocumentEditor key={asset.id} asset={asset} editing={editing} />
      ) : null}
      <div className="min-h-0 min-w-0 flex-1">
        <FileViewer
          key={asset.id}
          className="size-full"
          file={file}
          fileName={asset.filename}
          mimeType={asset.mediaType || file.type}
          width="100%"
          height="100%"
          fit="contain"
          fallback="inline"
          locale={i18n.language.startsWith("zh") ? "zh-CN" : "en-US"}
          plugins={plugins}
          theme={mode === "system" ? "auto" : mode}
          toolbar={LIBRARY_PREVIEW_TOOLBAR}
        />
      </div>
    </div>
  );
});

/** Copy-on-write editing preserves existing attachment IDs and delivery history. */
function LibraryDocumentEditor({
  asset,
  editing,
}: {
  asset: PreviewLibraryAsset;
  editing: DocumentEditingProps;
}) {
  const { t } = useTranslation();
  const { mode } = useTheme();
  const [open, setOpen] = React.useState(false);
  const [source, setSource] = React.useState<{ content: string; sha256: string } | null>(null);
  const [content, setContent] = React.useState("");
  const [filename, setFilename] = React.useState("");
  const [folderId, setFolderId] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [loadFailed, setLoadFailed] = React.useState(false);
  const savingRef = React.useRef(false);
  const [retry, setRetry] = React.useState(0);
  const folders = editing.folders.filter((folder) => !folder.threadId);
  const foldersRef = React.useRef(folders);
  foldersRef.current = folders;
  React.useEffect(() => {
    if (!open || source) return;
    let disposed = false;
    setLoading(true);
    setLoadFailed(false);
    void requestJson<{ content: string; sha256: string }>(
      ["/work/library/assets", encodeURIComponent(asset.id), "text"].join("/"),
      {},
      t("documentEdit:loadFailed"),
    )
      .then((result) => {
        if (disposed) return;
        setSource(result);
        setContent(result.content);
        setLoading(false);
        setFilename(asset.filename.replace(/(\.[^.]+)$/, "-edited$1"));
        setFolderId(
          asset.folderIds?.find((id) => foldersRef.current.some((folder) => folder.id === id)) ??
            null,
        );
      })
      .catch((error: unknown) => {
        if (!disposed) {
          setLoadFailed(true);
          toast.error(error instanceof Error ? error.message : t("documentEdit:loadFailed"));
        }
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [open, source, asset.id, asset.filename, retry, t]);
  const changeOpen = async (next: boolean) => {
    if (savingRef.current) return;
    if (
      !next &&
      source &&
      (content !== source.content ||
        filename !== asset.filename.replace(/(\.[^.]+)$/, "-edited$1")) &&
      !(await confirmAction(t("documentEdit:discard")))
    )
      return;
    if (!next) {
      setSource(null);
      setContent("");
    }
    setOpen(next);
  };
  const save = async () => {
    if (!source || savingRef.current) return;
    if (
      !content.trim() ||
      new TextEncoder().encode(content).byteLength > MAX_TEXT_DOCUMENT_BYTES ||
      !TextDocumentFilenameSchema.safeParse(filename).success
    ) {
      toast.error(t("documentEdit:invalid"));
      return;
    }
    savingRef.current = true;
    setSaving(true);
    try {
      const { asset: next } = await requestJson<{ asset: LibraryAsset }>(
        ["/work/library/assets", encodeURIComponent(asset.id), "text"].join("/"),
        {
          method: "POST",
          body: { content, filename: filename.trim(), sourceSha256: source.sha256, folderId },
        },
        t("documentEdit:saveFailed"),
      );
      setOpen(false);
      setSource(null);
      setContent("");
      toast.success(t("documentEdit:saved"));
      await editing.onSaved(next).catch(() => toast.error(t("documentEdit:refreshFailed")));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("documentEdit:saveFailed"));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };
  return (
    <div className="flex shrink-0 justify-end border-b p-1">
      <Button size="sm" variant="outline" onClick={() => void changeOpen(true)}>
        <PencilLineIcon />
        {t("documentEdit:title")}
      </Button>
      <Dialog open={open} onOpenChange={(next) => void changeOpen(next)}>
        <DialogContent className="flex h-[85vh] max-h-[900px] min-h-0 min-w-0 flex-col sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>{t("documentEdit:title")}</DialogTitle>
            <DialogDescription>{t("documentEdit:hint")}</DialogDescription>
          </DialogHeader>
          <ScrollArea className="min-h-0 flex-1">
            <div className="flex min-w-0 flex-col gap-3 p-1">
              <Field>
                <FieldLabel>{t("documentEdit:filename")}</FieldLabel>
                <Input
                  value={filename}
                  disabled={loading || saving || !source}
                  onChange={(event) => setFilename(event.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel>{t("documentEdit:folder")}</FieldLabel>
                <Select
                  value={folderId ?? "root"}
                  disabled={loading || saving || !source}
                  onValueChange={(value) => value && setFolderId(value === "root" ? null : value)}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="root">{t("documentEdit:root")}</SelectItem>
                    {folders.map((folder) => (
                      <SelectItem key={folder.id} value={folder.id}>
                        {folder.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              {loading ? (
                <p role="status" className="text-xs text-muted-foreground">
                  {t("common:loading")}
                </p>
              ) : null}
              {loadFailed ? (
                <Button variant="outline" onClick={() => setRetry((value) => value + 1)}>
                  {t("common:retry")}
                </Button>
              ) : null}
              {source ? (
                <CodeMirror
                  aria-label={t("documentEdit:content")}
                  value={content}
                  height="45vh"
                  editable={!saving}
                  theme={mode === "dark" ? "dark" : "light"}
                  extensions={[EditorView.lineWrapping]}
                  onChange={setContent}
                />
              ) : null}
            </div>
          </ScrollArea>
          <div className="flex shrink-0 flex-wrap justify-end gap-2">
            <Button variant="outline" disabled={saving} onClick={() => void changeOpen(false)}>
              {t("common:cancel")}
            </Button>
            <Button
              disabled={!source || loading || saving || !content.trim()}
              onClick={() => void save()}
            >
              <SaveIcon />
              {t("documentEdit:save")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
