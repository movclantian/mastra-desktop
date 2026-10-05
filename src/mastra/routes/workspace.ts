/**
 * 工作区路由:读写用户可配置的 Workspace 参数(数据库 app_config 表,保存后实时生效),
 * 近期绑定目录列表与线程工作区文件树。
 * Workspace 主体(文件系统/沙箱/搜索/LSP/Skills)见 src/mastra/workspace/workspace-manager.ts。
 */
import { realpath } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
import { MASTRA_RESOURCE_ID_KEY } from "@mastra/core/request-context";
import { type ContextWithMastra, registerApiRoute } from "@mastra/core/server";
import { LocalFilesystem } from "@mastra/core/workspace";
import { createRoute } from "@mastra/server/server-adapter";
import { z } from "zod";
import { workError, workValidationError } from "../errors";
import {
  listWorkspaceChanges,
  readWorkspaceChangeContent,
  recordWorkspaceChange,
} from "../workspace/changes";
import {
  getWorkspaceConfig,
  listRecentWorkspaces,
  saveWorkspaceConfig,
  workspaceConfigSchema,
} from "../workspace/workspace-manager";
import type { ThreadMetadata } from "./threads/shared";
import { getOwnedThread, getWorkMemory, isTrustedLocalRequest } from "./threads/shared";

// GET /work/workspace — 读取当前工作区配置
export const workspaceConfigRoute = createRoute({
  path: "/work/workspace",
  method: "GET",
  responseType: "json",
  queryParamSchema: z.object({}).strict(),
  onValidationError: workValidationError,
  handler: ({ requestContext }) =>
    getWorkspaceConfig(requestContext.get(MASTRA_RESOURCE_ID_KEY) as string),
});

// POST /work/workspace — 写入工作区配置
export const saveWorkspaceConfigRoute = createRoute({
  path: "/work/workspace",
  method: "POST",
  responseType: "json",
  queryParamSchema: z.object({}).strict(),
  bodySchema: workspaceConfigSchema.transform((config) => ({ config })),
  onValidationError: workValidationError,
  handler: async ({ requestContext, config }) => {
    await saveWorkspaceConfig(config, requestContext.get(MASTRA_RESOURCE_ID_KEY) as string);
    return { ok: true };
  },
});

// GET /work/workspace/recent — 近期显式绑定的工作区目录(promptInput 选择器)
export const recentWorkspacesRoute = createRoute({
  path: "/work/workspace/recent",
  method: "GET",
  responseType: "json",
  queryParamSchema: z.object({}).strict(),
  onValidationError: workValidationError,
  handler: async ({ requestContext }) => ({
    recent: await listRecentWorkspaces(requestContext.get(MASTRA_RESOURCE_ID_KEY) as string),
  }),
});

// GET /work/threads/:threadId/changes?resourceId=<id> — Agent/editor 文件变更历史
export const threadChangesRoute = registerApiRoute("/work/threads/:threadId/changes", {
  method: "GET",
  handler: async (c) => {
    if (!isTrustedLocalRequest(c))
      throw workError("VALIDATION_FAILED", { text: "Untrusted origin" });
    const threadId = c.req.param("threadId");
    const resourceId = c.req.query("resourceId");
    if (!threadId || !resourceId) throw workError("VALIDATION_RESOURCE_ID_REQUIRED");
    const memory = await getWorkMemory(c.get("requestContext"));
    if (!(await getOwnedThread(memory, threadId, resourceId))) throw workError("THREAD_NOT_FOUND");
    const offsetValue = Number(c.req.query("offset"));
    const limitValue = Number(c.req.query("limit"));
    const hasPaging = Number.isFinite(offsetValue) || Number.isFinite(limitValue);
    const offset = Number.isFinite(offsetValue) ? Math.max(0, Math.trunc(offsetValue)) : 0;
    const limit = Number.isFinite(limitValue)
      ? Math.min(500, Math.max(0, Math.trunc(limitValue)))
      : 200;
    const changes = await listWorkspaceChanges(
      threadId,
      resourceId,
      hasPaging ? { offset, limit } : {},
    );
    return c.json({ changes, ...(hasPaging ? { offset, limit } : {}) });
  },
});

// GET /work/threads/:threadId/changes/:changeId/content?resourceId=<id>&side=before|after
// 只在用户展开历史记录时读取完整快照,避免列表接口注入大文件内容。
export const threadChangeContentRoute = registerApiRoute(
  "/work/threads/:threadId/changes/:changeId/content",
  {
    method: "GET",
    handler: async (c) => {
      if (!isTrustedLocalRequest(c))
        throw workError("VALIDATION_FAILED", { text: "Untrusted origin" });
      const threadId = c.req.param("threadId");
      const changeId = c.req.param("changeId");
      const resourceId = c.req.query("resourceId");
      const side = c.req.query("side");
      if (!threadId || !changeId || !resourceId) {
        throw workError("VALIDATION_RESOURCE_ID_REQUIRED");
      }
      if (side !== "before" && side !== "after") {
        throw workError("VALIDATION_FAILED", { text: "side must be before or after" });
      }
      const memory = await getWorkMemory(c.get("requestContext"));
      if (!(await getOwnedThread(memory, threadId, resourceId))) {
        throw workError("THREAD_NOT_FOUND");
      }
      const result = await readWorkspaceChangeContent({
        threadId,
        changeId,
        side,
        userId: resourceId,
      });
      if (!result) throw workError("WORKSPACE_FILE_NOT_FOUND");
      return c.json({ content: result.content, binary: result.binary, metadata: result.metadata });
    },
  },
);

// GET /work/threads/:threadId/tree?path=<相对路径> — 线程工作区文件树(单层按需拉取)
// 显式目录和隐式默认目录都属于线程工作区,均可由用户浏览。
type TreeEntry = { hidden: boolean; name: string; path: string; type: "file" | "dir" };

const MAX_EDITABLE_FILE_BYTES = 2 * 1024 * 1024;

async function ownedWorkspace(c: ContextWithMastra) {
  if (!isTrustedLocalRequest(c)) return null;
  const threadId = c.req.param("threadId");
  const resourceId = c.req.query("resourceId");
  if (!threadId || !resourceId) return null;
  const memory = await getWorkMemory(c.get("requestContext"));
  const thread = await getOwnedThread(memory, threadId, resourceId);
  const metadata = thread?.metadata as ThreadMetadata | undefined;
  if (!metadata?.workspacePath) return null;
  try {
    const root = await realpath(resolve(metadata.workspacePath));
    const config = await getWorkspaceConfig(resourceId);
    return {
      root,
      threadId,
      filesystem: new LocalFilesystem({
        basePath: root,
        contained: true,
        readOnly: config.readOnly,
      }),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export const threadTreeRoute = registerApiRoute("/work/threads/:threadId/tree", {
  method: "GET",
  handler: async (c) => {
    const workspace = await ownedWorkspace(c);
    if (!workspace) {
      throw workError("WORKSPACE_NOT_BROWSABLE");
    }
    const { root, filesystem } = workspace;
    const path = c.req.query("path") || ".";
    const dirents = await filesystem.readdir(path);
    const entries: TreeEntry[] = dirents
      .map((d) => ({
        name: d.name,
        // 返回相对工作区根的 POSIX 风格路径,FileTree 组件直接消费
        path: relative(root, resolve(root, path, d.name)).replaceAll("\\", "/"),
        hidden: d.name.startsWith("."),
        type: d.type === "directory" ? ("dir" as const) : ("file" as const),
      }))
      .sort((a, b) =>
        a.type !== b.type ? (a.type === "dir" ? -1 : 1) : a.name.localeCompare(b.name),
      );
    return c.json({ entries, root: basename(root), rootPath: root });
  },
});

// POST /work/threads/:threadId/tree — 在工作区中创建空文件或目录
export const createThreadTreeEntryRoute = registerApiRoute("/work/threads/:threadId/tree", {
  method: "POST",
  handler: async (c) => {
    const workspace = await ownedWorkspace(c);
    if (!workspace) throw workError("WORKSPACE_NOT_BROWSABLE");

    const body = (await c.req.json()) as { path?: unknown; type?: unknown };
    const relativePath = typeof body.path === "string" ? body.path.trim() : "";
    const type = body.type === "dir" || body.type === "file" ? body.type : undefined;
    if (!relativePath || !type || relativePath.includes("\0")) {
      throw workError("WORKSPACE_PATH_INVALID");
    }

    const { filesystem } = workspace;
    // The target does not yet exist; validate its existing parent through native containment.
    if ((await filesystem.stat(dirname(relativePath))).type !== "directory")
      throw workError("WORKSPACE_PATH_INVALID");
    if (type === "dir") await filesystem.mkdir(relativePath, { recursive: false });
    else await filesystem.writeFile(relativePath, "", { overwrite: false, recursive: false });

    if (type === "file") {
      await recordWorkspaceChange({
        threadId: workspace.threadId,
        userId: c.get("requestContext").get(MASTRA_RESOURCE_ID_KEY) as string,
        path: relativePath,
        before: null,
        after: "",
        toolName: "workspace.create_file",
      }).catch(() => undefined);
    }
    return c.json(
      { ok: true, entry: { name: basename(relativePath), path: relativePath, type } },
      201,
    );
  },
});

const MIME_TYPES: Record<string, string> = {
  // Documents
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  doc: "application/msword",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xls: "application/vnd.ms-excel",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ppt: "application/vnd.ms-powerpoint",
  // Text / Code
  md: "text/markdown; charset=utf-8",
  markdown: "text/markdown; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "application/javascript; charset=utf-8",
  ts: "application/typescript; charset=utf-8",
  jsx: "text/javascript; charset=utf-8",
  tsx: "text/typescript; charset=utf-8",
  json: "application/json; charset=utf-8",
  xml: "application/xml; charset=utf-8",
  yaml: "text/yaml; charset=utf-8",
  yml: "text/yaml; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  svg: "image/svg+xml",
  // Images
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
  // Media
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  mp4: "video/mp4",
  webm: "video/webm",
  // Archives
  zip: "application/zip",
  tar: "application/x-tar",
  gz: "application/gzip",
};

export function getMimeType(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  return MIME_TYPES[ext] || "application/octet-stream";
}

// GET /work/threads/:threadId/raw?path=<相对路径> — 读取原始文件流（供预览与下载）
export const threadRawFileRoute = registerApiRoute("/work/threads/:threadId/raw", {
  method: "GET",
  handler: async (c) => {
    const workspace = await ownedWorkspace(c);
    if (!workspace) throw workError("WORKSPACE_NOT_BROWSABLE");
    const relativePath = c.req.query("path");
    if (!relativePath) throw workError("WORKSPACE_PATH_INVALID");
    const fileInfo = await workspace.filesystem.stat(relativePath);
    if (fileInfo.type !== "file") throw workError("WORKSPACE_FILE_NOT_EDITABLE");
    const buffer = Buffer.from(await workspace.filesystem.readFile(relativePath));
    const mediaType = getMimeType(relativePath);
    return c.body(new Uint8Array(buffer), 200, {
      "Content-Type": mediaType,
      "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(basename(relativePath))}`,
      "Cache-Control": "no-cache",
    });
  },
});

// GET /work/threads/:threadId/file?path=<相对路径> — 编辑器读取 UTF-8 文本
export const threadFileRoute = registerApiRoute("/work/threads/:threadId/file", {
  method: "GET",
  handler: async (c) => {
    const workspace = await ownedWorkspace(c);
    if (!workspace) throw workError("WORKSPACE_NOT_BROWSABLE");
    const relativePath = c.req.query("path");
    if (!relativePath) throw workError("WORKSPACE_PATH_INVALID");
    const fileInfo = await workspace.filesystem.stat(relativePath);
    if (fileInfo.type !== "file") throw workError("WORKSPACE_FILE_NOT_EDITABLE");
    if (fileInfo.size > MAX_EDITABLE_FILE_BYTES) {
      throw workError("WORKSPACE_FILE_TOO_LARGE", { details: { size: fileInfo.size } });
    }
    const content = Buffer.from(await workspace.filesystem.readFile(relativePath));
    if (content.byteLength > MAX_EDITABLE_FILE_BYTES) throw workError("WORKSPACE_FILE_TOO_LARGE");
    const isBinary = content.includes(0);
    return c.json({
      path: relativePath,
      name: basename(relativePath),
      content: isBinary ? "" : content.toString("utf8"),
      isBinary,
      size: fileInfo.size,
      modifiedAt: fileInfo.modifiedAt.toISOString(),
    });
  },
});

// PUT /work/threads/:threadId/file?path=<相对路径> — 保存编辑器全文
export const saveThreadFileRoute = registerApiRoute("/work/threads/:threadId/file", {
  method: "PUT",
  handler: async (c) => {
    const workspace = await ownedWorkspace(c);
    if (!workspace) throw workError("WORKSPACE_NOT_BROWSABLE");
    const relativePath = c.req.query("path");
    if (!relativePath) throw workError("WORKSPACE_PATH_INVALID");
    const body = (await c.req.json()) as { content?: unknown };
    if (typeof body.content !== "string") throw workError("SESSION_INPUT_REQUIRED");
    if (Buffer.byteLength(body.content, "utf8") > MAX_EDITABLE_FILE_BYTES) {
      throw workError("WORKSPACE_FILE_TOO_LARGE");
    }
    const fileInfo = await workspace.filesystem.stat(relativePath);
    if (fileInfo.type !== "file") throw workError("WORKSPACE_FILE_NOT_EDITABLE");
    if (fileInfo.size > MAX_EDITABLE_FILE_BYTES) throw workError("WORKSPACE_FILE_TOO_LARGE");
    const previous = Buffer.from(await workspace.filesystem.readFile(relativePath));
    if (previous.byteLength > MAX_EDITABLE_FILE_BYTES) throw workError("WORKSPACE_FILE_TOO_LARGE");
    if (previous.includes(0)) throw workError("WORKSPACE_FILE_NOT_EDITABLE");
    await workspace.filesystem.writeFile(relativePath, body.content, { recursive: false });
    const updated = await workspace.filesystem.stat(relativePath);
    await recordWorkspaceChange({
      threadId: workspace.threadId,
      userId: c.get("requestContext").get(MASTRA_RESOURCE_ID_KEY) as string,
      path: relativePath,
      before: previous,
      after: body.content,
      toolName: "workspace.editor_save",
    }).catch(() => undefined);
    return c.json({ ok: true, size: updated.size, modifiedAt: updated.modifiedAt.toISOString() });
  },
});
