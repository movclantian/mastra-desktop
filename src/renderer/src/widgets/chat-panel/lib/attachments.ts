import type { FileUIPart } from "ai";
import { uploadChatAttachments } from "../api/chat-api";
import type { LibraryFilePart } from "../model/types";

/** 把输入区附件上传到资料库并改写为持久化 LibraryFilePart(已在库里的原样返回) */
export async function persistAttachments(
  files: FileUIPart[],
  userId: string,
  threadId: string,
): Promise<LibraryFilePart[]> {
  return uploadChatAttachments(files, userId, threadId);
}
