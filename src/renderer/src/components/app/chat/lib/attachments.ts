import type { FileUIPart } from "ai";
import { MASTRA_SERVER_URL } from "@/lib/providers";
import type { LibraryFilePart } from "../types";

/** 把输入区附件上传到资料库并改写为持久化 LibraryFilePart(已在库里的原样返回) */
export async function persistAttachments(
  files: FileUIPart[],
  userId: string,
  threadId: string,
): Promise<LibraryFilePart[]> {
  const isPersisted = (file: FileUIPart) =>
    /\/work\/library\/assets\/[^/]+\/content/.test(file.url);
  const pending = files.filter((file) => !isPersisted(file));
  if (pending.length === 0) return files as LibraryFilePart[];
  const form = new FormData();
  form.set("resourceId", userId);
  form.set("threadId", threadId);
  for (const file of pending) {
    const source =
      "file" in file && file.file instanceof File
        ? file.file
        : await fetch(file.url).then((response) => response.blob());
    form.append("files", source, file.filename ?? "未命名附件");
  }
  const response = await fetch(`${MASTRA_SERVER_URL}/work/library/assets`, {
    method: "POST",
    body: form,
  });
  const payload = (await response.json()) as {
    assets?: Array<{ id: string; filename: string; mediaType: string; byteSize: number }>;
    error?: string;
  };
  if (!response.ok || !payload.assets) {
    throw new Error(payload.error || "附件保存失败");
  }
  let uploadedIndex = 0;
  return files.map((file) => {
    if (isPersisted(file)) return file;
    const asset = payload.assets?.[uploadedIndex++];
    if (!asset) throw new Error("附件上传结果不完整");
    return {
      type: "file",
      byteSize: asset.byteSize,
      filename: asset.filename,
      mediaType: asset.mediaType,
      url: `${MASTRA_SERVER_URL}/work/library/assets/${encodeURIComponent(asset.id)}/content?resourceId=${encodeURIComponent(userId)}`,
    };
  });
}
