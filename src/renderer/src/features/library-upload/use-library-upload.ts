import * as React from "react";
import { toast } from "sonner";
import {
  cancelLibraryUpload,
  completeLibraryUpload,
  createLibraryUploadSession,
  fetchLibraryUploadSession,
  libraryUploadChunkUrl,
} from "@/entities/library";
import { getAuthToken } from "@/features/auth";
import { useTranslation } from "@/shared/i18n";

export interface LibraryUploadTarget {
  folderId: string | null;
  threadId: string | null;
}

export interface LibraryTransfer {
  id: string;
  file: File;
  target: LibraryUploadTarget;
  status: "queued" | "uploading" | "saving" | "uploaded" | "failed" | "cancelled";
  uploadedBytes: number;
  assetId?: string;
  error?: string;
}

/** Per-file transfer state; the server's completed chunk list is the resume authority. */
export function useLibraryUpload(resourceId: string, onUploaded: () => Promise<void>) {
  const { t } = useTranslation();
  const [uploading, setUploading] = React.useState(false);
  const [transfers, setTransfers] = React.useState<LibraryTransfer[]>([]);
  const [panelOpen, setPanelOpen] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const transfersRef = React.useRef<LibraryTransfer[]>([]);
  const runningRef = React.useRef(false);
  const cancelledRef = React.useRef(false);
  const mountedRef = React.useRef(true);
  const activeUploadXhrRef = React.useRef<XMLHttpRequest | null>(null);

  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cancelledRef.current = true;
      activeUploadXhrRef.current?.abort();
    };
  }, [resourceId]);

  const updateTransfer = (id: string, patch: Partial<LibraryTransfer>) => {
    transfersRef.current = transfersRef.current.map((item) =>
      item.id === id ? { ...item, ...patch } : item,
    );
    if (mountedRef.current) setTransfers(transfersRef.current);
  };

  const runUploads = async (items: LibraryTransfer[]) => {
    if (runningRef.current || !items.length) return;
    runningRef.current = true;
    cancelledRef.current = false;
    setUploading(true);
    setPanelOpen(true);
    for (const item of items) updateTransfer(item.id, { status: "queued", error: undefined });
    let uploadedCount = 0;
    let failedCount = 0;
    try {
      for (const item of items) {
        if (cancelledRef.current) {
          updateTransfer(item.id, { status: "cancelled" });
          continue;
        }
        const { file, target } = item;
        const resumeKey =
          "mastra-work:library-upload:" +
          JSON.stringify([
            resourceId,
            file.name,
            file.size,
            file.lastModified,
            target.folderId ?? "",
            target.threadId ?? "",
          ]);
        let sessionId: string | undefined;
        try {
          updateTransfer(item.id, { status: "uploading" });
          const resumeId = localStorage.getItem(resumeKey);
          const session =
            (resumeId ? await fetchLibraryUploadSession(resumeId, resourceId) : null) ??
            (await createLibraryUploadSession(resourceId, {
              filename: file.name,
              mediaType: file.type || "application/octet-stream",
              byteSize: file.size,
              folderId: target.folderId ?? undefined,
              threadId: target.threadId ?? undefined,
            }));
          sessionId = session.id;
          localStorage.setItem(resumeKey, session.id);
          const completed = new Set(session.completedChunks);
          let uploadedBytes = session.completedChunks.reduce(
            (sum, index) =>
              sum + Math.max(0, Math.min(session.chunkSize, file.size - index * session.chunkSize)),
            0,
          );
          updateTransfer(item.id, { uploadedBytes });
          for (let index = 0; index < session.totalChunks; index++) {
            if (cancelledRef.current) throw new Error(t("library:uploadCancelled"));
            if (completed.has(index)) continue;
            const start = index * session.chunkSize;
            const chunk = file.slice(start, Math.min(file.size, start + session.chunkSize));
            await new Promise<void>((resolve, reject) => {
              const xhr = new XMLHttpRequest();
              activeUploadXhrRef.current = xhr;
              xhr.open("PUT", libraryUploadChunkUrl(session.id, resourceId, index));
              xhr.setRequestHeader("Content-Type", "application/octet-stream");
              const token = getAuthToken();
              if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
              xhr.upload.onprogress = (event) => {
                updateTransfer(item.id, {
                  uploadedBytes: Math.min(
                    file.size,
                    uploadedBytes + (event.lengthComputable ? event.loaded : 0),
                  ),
                });
              };
              xhr.onerror = () => reject(new Error(t("library:uploadConnFailed")));
              xhr.onabort = () => reject(new Error(t("library:uploadCancelled")));
              xhr.onload = () => {
                if (xhr.status >= 200 && xhr.status < 300) resolve();
                else {
                  let message = t("library:chunkUploadFailed");
                  try {
                    const body = JSON.parse(xhr.responseText) as { error?: string };
                    if (typeof body.error === "string") message = body.error;
                  } catch {
                    /* Keep the upload error for non-JSON responses. */
                  }
                  reject(new Error(message));
                }
              };
              xhr.send(chunk);
            });
            activeUploadXhrRef.current = null;
            uploadedBytes += chunk.size;
            updateTransfer(item.id, { uploadedBytes });
          }
          if (cancelledRef.current) throw new Error(t("library:uploadCancelled"));
          updateTransfer(item.id, { status: "saving" });
          const asset = await completeLibraryUpload(session.id, resourceId);
          localStorage.removeItem(resumeKey);
          sessionId = undefined;
          updateTransfer(item.id, {
            status: "uploaded",
            uploadedBytes: file.size,
            assetId: asset.id,
          });
          uploadedCount++;
          // Refresh errors must not turn a successfully saved file into a retryable upload.
          if (mountedRef.current) await onUploaded().catch(() => undefined);
        } catch (error) {
          activeUploadXhrRef.current = null;
          if (cancelledRef.current) {
            updateTransfer(item.id, { status: "cancelled" });
            // Navigation leaves chunks available for resuming after reselecting the file.
            if (mountedRef.current && sessionId) {
              await cancelLibraryUpload(sessionId, resourceId)
                .then(() => localStorage.removeItem(resumeKey))
                .catch(() => undefined);
            }
          } else {
            failedCount++;
            updateTransfer(item.id, {
              status: "failed",
              error: error instanceof Error ? error.message : t("library:uploadFailed"),
            });
          }
        }
      }
      if (mountedRef.current && !cancelledRef.current) {
        if (failedCount) toast.error(t("library:transfersFailed", { count: failedCount }));
        else if (uploadedCount) toast.success(t("library:filesSaved"));
      }
    } finally {
      activeUploadXhrRef.current = null;
      runningRef.current = false;
      if (mountedRef.current) setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  const uploadFiles = async (files: File[], target: LibraryUploadTarget) => {
    if (!files.length || runningRef.current) return;
    if (files.length > 10) return void toast.error(t("library:maxFilesLimit"));
    if (files.some((file) => file.size > 50 * 1024 * 1024))
      return void toast.error(t("library:maxFileSizeLimit"));
    if (files.reduce((sum, file) => sum + file.size, 0) > 100 * 1024 * 1024)
      return void toast.error(t("library:maxTotalSizeLimit"));
    const items: LibraryTransfer[] = files.map((file) => ({
      id: crypto.randomUUID(),
      file,
      target,
      status: "queued",
      uploadedBytes: 0,
    }));
    transfersRef.current = items;
    setTransfers(items);
    await runUploads(items);
  };

  const cancelUpload = () => {
    cancelledRef.current = true;
    activeUploadXhrRef.current?.abort();
  };
  const retryUpload = (id?: string) =>
    runUploads(
      transfersRef.current.filter(
        (item) =>
          (!id || item.id === id) && (item.status === "failed" || item.status === "cancelled"),
      ),
    );
  const totalBytes = transfers.reduce((sum, item) => sum + item.file.size, 0);
  const uploadedBytes = transfers.reduce((sum, item) => sum + item.uploadedBytes, 0);

  return {
    inputRef,
    uploading,
    transfers,
    panelOpen,
    setPanelOpen,
    uploadProgress: totalBytes ? Math.round((uploadedBytes / totalBytes) * 100) : 0,
    uploadFiles,
    cancelUpload,
    retryUpload,
  };
}
