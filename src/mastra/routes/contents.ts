import { type ContextWithMastra, registerApiRoute } from "@mastra/core/server";
import { workError } from "../errors";
import { type ContentObjectKind, readContentObject } from "../storage/content-objects";
import { isTrustedLocalRequest } from "./threads/shared";

/**
 * GET /work/contents/:objectId?resourceId=<user>&kind=<kind>&threadId=<thread>&type=<mime>
 *
 * 用户内容对象的渲染端取回通道。内容对象落盘在 storage/users/<uid>/ 下,
 * 不在会话工作区内,线程 raw 路由读不到(截图、网页归档等二进制归档由此提供)。
 * kind/threadId 参与对象路径拼装,与写入侧 objectPath 的约定一致。
 */
export const contentObjectRoute = registerApiRoute("/work/contents/:objectId", {
  method: "GET",
  handler: async (c: ContextWithMastra) => {
    if (!isTrustedLocalRequest(c)) throw workError("WORKSPACE_NOT_BROWSABLE");
    const resourceId = c.req.query("resourceId");
    const objectId = c.req.param("objectId");
    const kind = c.req.query("kind");
    if (!resourceId || !objectId || !kind) throw workError("WORKSPACE_PATH_INVALID");
    const threadId = c.req.query("threadId");
    const bytes = await readContentObject(objectId, {
      kind: kind as ContentObjectKind,
      userId: resourceId,
      ...(threadId ? { threadId } : {}),
    });
    if (!bytes) throw workError("WORKSPACE_FILE_NOT_EDITABLE");
    const type = c.req.query("type");
    return c.body(new Uint8Array(bytes), 200, {
      "Content-Type": type && /^[\w.+-]+\/[\w.+-]+$/.test(type) ? type : "application/octet-stream",
      "Cache-Control": "no-cache",
    });
  },
});
