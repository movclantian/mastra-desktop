import * as React from "react";
import { toast } from "sonner";
import { getAuthToken } from "@/lib/auth";
import { apiError } from "@/lib/errors";
import { MASTRA_SERVER_URL } from "@/lib/providers";
import type { LibraryAsset, LibraryUploadSession } from "../types";

export interface LibraryUploadTarget {
  folderId: string | null;
  threadId: string | null;
}

/**
 * 资料库分片上传(断点续传),与后端 src/mastra/library/upload.ts 的会话协议对应:
 * - POST   /work/library/uploads                 创建会话(localStorage 记 resumeId 续传)
 * - PUT    /work/library/uploads/:id/chunks/:i   逐片上传(XHR,onprogress 汇报批次进度)
 * - POST   /work/library/uploads/:id/complete    完成并触发服务端索引
 * - DELETE /work/library/uploads/:id             取消并清理未完成会话
 *
 * onUploaded:全部文件完成后回调(调用方刷新资产列表)。
 */
export function useLibraryUpload(resourceId: string, onUploaded: () => Promise<void>) {
  const [uploading, setUploading] = React.useState(false);
  const [uploadProgress, setUploadProgress] = React.useState(0);
  const [retryFiles, setRetryFiles] = React.useState<File[]>([]);
  const [retryTarget, setRetryTarget] = React.useState<LibraryUploadTarget>({
    folderId: null,
    threadId: null,
  });
  const [uploadError, setUploadError] = React.useState<string | null>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const activeUploadXhrRef = React.useRef<XMLHttpRequest | null>(null);
  const activeUploadSessionsRef = React.useRef(new Map<string, string>());

  const uploadFiles = async (files: File[], target: LibraryUploadTarget) => {
    if (files.length === 0) return;
    if (files.length > 10) {
      toast.error("一次最多上传 10 个文件");
      return;
    }
    if (files.some((file) => file.size > 50 * 1024 * 1024)) {
      toast.error("单个文件不能超过 50 MB");
      return;
    }
    if (files.reduce((sum, file) => sum + file.size, 0) > 100 * 1024 * 1024) {
      toast.error("一次上传总大小不能超过 100 MB");
      return;
    }
    setRetryFiles(files);
    setRetryTarget(target);
    setUploadError(null);
    setUploadProgress(0);
    setUploading(true);
    try {
      const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
      let completedBatchBytes = 0;
      for (const file of files) {
        const resumeKey = `mastra-work:library-upload:${JSON.stringify([
          resourceId,
          file.name,
          file.size,
          file.lastModified,
          target.folderId ?? "",
          target.threadId ?? "",
        ])}`;
        const response = await fetch(`${MASTRA_SERVER_URL}/work/library/uploads`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            resourceId,
            filename: file.name,
            mediaType: file.type || "application/octet-stream",
            byteSize: file.size,
            folderId: target.folderId ?? undefined,
            threadId: target.threadId ?? undefined,
            resumeId: localStorage.getItem(resumeKey) ?? undefined,
          }),
        });
        const payload = (await response.json()) as {
          session?: LibraryUploadSession;
          error?: string;
        };
        if (!response.ok || !payload.session) throw apiError(payload, "创建上传会话失败");
        const session = payload.session;
        localStorage.setItem(resumeKey, session.id);
        activeUploadSessionsRef.current.set(session.id, resumeKey);
        const completed = new Set(session.completedChunks);
        const completedFileBytes = session.completedChunks.reduce((sum, index) => {
          const start = index * session.chunkSize;
          return sum + Math.max(0, Math.min(session.chunkSize, file.size - start));
        }, 0);
        setUploadProgress(
          Math.round(((completedBatchBytes + completedFileBytes) / totalBytes) * 100),
        );
        let uploadedFileBytes = completedFileBytes;
        for (let index = 0; index < session.totalChunks; index += 1) {
          if (completed.has(index)) continue;
          const start = index * session.chunkSize;
          const chunk = file.slice(start, Math.min(file.size, start + session.chunkSize));
          await new Promise<void>((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open(
              "PUT",
              `${MASTRA_SERVER_URL}/work/library/uploads/${encodeURIComponent(session.id)}/chunks/${index}?resourceId=${encodeURIComponent(resourceId)}`,
            );
            activeUploadXhrRef.current = xhr;
            xhr.setRequestHeader("Content-Type", "application/octet-stream");
            const token = getAuthToken();
            if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
            xhr.upload.onprogress = (event) => {
              const inFlight = event.lengthComputable ? event.loaded : 0;
              setUploadProgress(
                Math.round(
                  ((completedBatchBytes + uploadedFileBytes + inFlight) / totalBytes) * 100,
                ),
              );
            };
            xhr.onerror = () => reject(new Error("上传连接失败"));
            xhr.onabort = () => reject(new Error("上传已取消"));
            xhr.onload = () => {
              if (xhr.status >= 200 && xhr.status < 300) resolve();
              else {
                try {
                  reject(
                    new Error(
                      (JSON.parse(xhr.responseText) as { error?: string }).error || "上传分片失败",
                    ),
                  );
                } catch {
                  reject(new Error("上传分片失败"));
                }
              }
            };
            xhr.send(chunk);
          });
          uploadedFileBytes += chunk.size;
        }
        const completeResponse = await fetch(
          `${MASTRA_SERVER_URL}/work/library/uploads/${encodeURIComponent(session.id)}/complete`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ resourceId }),
          },
        );
        const completePayload = (await completeResponse.json()) as {
          asset?: LibraryAsset;
          error?: string;
        };
        if (!completeResponse.ok || !completePayload.asset)
          throw new Error(completePayload.error || "完成上传失败");
        localStorage.removeItem(resumeKey);
        activeUploadSessionsRef.current.delete(session.id);
        completedBatchBytes += file.size;
      }
      setUploadProgress(100);
      setRetryFiles([]);
      toast.success("文件已保存到资料库");
      await onUploaded();
    } catch (error) {
      const message = error instanceof Error ? error.message : "上传失败";
      setUploadError(message);
      toast.error(message);
    } finally {
      activeUploadXhrRef.current = null;
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  const cancelUpload = async () => {
    activeUploadXhrRef.current?.abort();
    const sessions = [...activeUploadSessionsRef.current.entries()];
    activeUploadSessionsRef.current.clear();
    await Promise.all(
      sessions.map(async ([sessionId, resumeKey]) => {
        localStorage.removeItem(resumeKey);
        await fetch(
          `${MASTRA_SERVER_URL}/work/library/uploads/${encodeURIComponent(sessionId)}?resourceId=${encodeURIComponent(resourceId)}`,
          { method: "DELETE" },
        ).catch(() => undefined);
      }),
    );
  };

  const retryUpload = () => {
    if (retryFiles.length === 0 || uploading) return;
    void uploadFiles(retryFiles, retryTarget);
  };

  return {
    inputRef,
    uploading,
    uploadProgress,
    retryFiles,
    uploadError,
    uploadFiles,
    cancelUpload,
    retryUpload,
  };
}
