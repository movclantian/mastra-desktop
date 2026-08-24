/**
 * 工作区路由:读写用户可配置的 Workspace 参数(数据库 app_config 表,保存后实时生效),
 * 近期绑定目录列表与线程工作区文件树。
 * Workspace 主体(文件系统/沙箱/搜索/LSP/Skills)见 src/mastra/workspace/index.ts。
 */
import { type Dirent, readdirSync } from "node:fs";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { type ContextWithMastra, registerApiRoute } from "@mastra/core/server";
import { workError } from "../errors";
import {
  getWorkspaceConfig,
  listRecentWorkspaces,
  saveWorkspaceConfig,
  type WorkspaceUserConfig,
} from "../workspace";
import {
  listWorkspaceChanges,
  readWorkspaceChangeContent,
  recordWorkspaceChange,
} from "../workspace/changes";
import { getOwnedThread, getWorkMemoryForThread, isTrustedLocalRequest } from "./threads/shared";
import type { ThreadMetadata } from "./threads/types";

// GET /work/workspace — 读取当前工作区配置
export const workspaceConfigRoute = registerApiRoute("/work/workspace", {
  method: "GET",
  handler: async (c) => {
    return c.json(await getWorkspaceConfig());
  },
});

// POST /work/workspace — 写入工作区配置
export const saveWorkspaceConfigRoute = registerApiRoute("/work/workspace", {
  method: "POST",
  handler: async (c) => {
    await saveWorkspaceConfig(await c.req.json<WorkspaceUserConfig>());
    return c.json({ ok: true });
  },
});

// GET /work/workspace/recent — 近期显式绑定的工作区目录(promptInput 选择器)
export const recentWorkspacesRoute = registerApiRoute("/work/workspace/recent", {
  method: "GET",
  handler: async (c) => {
    return c.json({ recent: await listRecentWorkspaces() });
  },
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
    const memory = await getWorkMemoryForThread(c.get("requestContext"), threadId, resourceId);
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
      const memory = await getWorkMemoryForThread(c.get("requestContext"), threadId, resourceId);
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
  const memory = await getWorkMemoryForThread(c.get("requestContext"), threadId, resourceId);
  const thread = await getOwnedThread(memory, threadId, resourceId);
  const metadata = thread?.metadata as ThreadMetadata | undefined;
  if (!metadata?.workspacePath) return null;
  try {
    return { root: await realpath(resolve(metadata.workspacePath)), threadId };
  } catch {
    return null;
  }
}

function containedPath(root: string, relativePath: string | undefined) {
  const target = resolve(root, relativePath || ".");
  return target === root || target.startsWith(`${root}\\`) || target.startsWith(`${root}/`)
    ? target
    : null;
}

async function containedExistingPath(root: string, relativePath: string | undefined) {
  const target = containedPath(root, relativePath);
  if (!target) return null;
  try {
    const canonical = await realpath(target);
    return containedPath(root, canonical) === canonical ? canonical : null;
  } catch {
    return null;
  }
}

export const threadTreeRoute = registerApiRoute("/work/threads/:threadId/tree", {
  method: "GET",
  handler: async (c) => {
    const workspace = await ownedWorkspace(c);
    if (!workspace) {
      throw workError("WORKSPACE_NOT_BROWSABLE");
    }
    const { root } = workspace;
    const target = await containedExistingPath(root, c.req.query("path"));
    if (!target) throw workError("VALIDATION_FAILED", { text: "Path escapes workspace" });
    let dirents: Dirent[];
    try {
      dirents = readdirSync(target, { withFileTypes: true });
    } catch {
      throw workError("WORKSPACE_FILE_NOT_FOUND");
    }
    const entries: TreeEntry[] = dirents
      .map((d) => ({
        name: d.name,
        // 返回相对工作区根的 POSIX 风格路径,FileTree 组件直接消费
        path: relative(root, join(target, d.name)).replaceAll("\\", "/"),
        hidden: d.name.startsWith("."),
        type: d.isDirectory() ? ("dir" as const) : ("file" as const),
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
    if ((await getWorkspaceConfig()).readOnly) throw workError("WORKSPACE_READ_ONLY");

    const body = (await c.req.json()) as { path?: unknown; type?: unknown };
    const relativePath = typeof body.path === "string" ? body.path.trim() : "";
    const type = body.type === "dir" || body.type === "file" ? body.type : undefined;
    if (!relativePath || !type || relativePath.includes("\0")) {
      throw workError("WORKSPACE_PATH_INVALID");
    }

    const target = containedPath(workspace.root, relativePath);
    const parent = await containedExistingPath(workspace.root, dirname(relativePath));
    if (!target || !parent) throw workError("WORKSPACE_PATH_INVALID");

    try {
      const parentInfo = await stat(parent);
      if (!parentInfo.isDirectory()) throw workError("WORKSPACE_PATH_INVALID");
      await stat(target);
      throw workError("VALIDATION_FAILED", { text: "Path already exists" });
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code !== "ENOENT"
      ) {
        throw error;
      }
      if (error instanceof Error && "status" in error) throw error;
    }

    try {
      if (type === "dir") await mkdir(target);
      else await writeFile(target, "", { encoding: "utf8", flag: "wx" });
    } catch {
      throw workError("VALIDATION_FAILED", { text: "Could not create workspace entry" });
    }

    if (type === "file") {
      await recordWorkspaceChange({
        threadId: workspace.threadId,
        path: relativePath,
        before: null,
        after: "",
        toolName: "workspace.create_file",
      }).catch(() => undefined);
    }
    return c.json({ ok: true, entry: { name: basename(target), path: relativePath, type } }, 201);
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
    const target = await containedExistingPath(workspace.root, relativePath);
    if (!target || !relativePath) throw workError("WORKSPACE_PATH_INVALID");
    try {
      const fileInfo = await stat(target);
      if (!fileInfo.isFile()) throw workError("WORKSPACE_FILE_NOT_EDITABLE");
      const buffer = await readFile(target);
      const mediaType = getMimeType(target);
      return c.body(buffer as never, 200, {
        "Content-Type": mediaType,
        "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(basename(target))}`,
        "Cache-Control": "no-cache",
      });
    } catch {
      throw workError("WORKSPACE_FILE_NOT_FOUND");
    }
  },
});

// GET /work/threads/:threadId/file?path=<相对路径> — 编辑器读取 UTF-8 文本
export const threadFileRoute = registerApiRoute("/work/threads/:threadId/file", {
  method: "GET",
  handler: async (c) => {
    const workspace = await ownedWorkspace(c);
    if (!workspace) throw workError("WORKSPACE_NOT_BROWSABLE");
    const relativePath = c.req.query("path");
    const target = await containedExistingPath(workspace.root, relativePath);
    if (!target || !relativePath) throw workError("WORKSPACE_PATH_INVALID");
    try {
      const fileInfo = await stat(target);
      if (!fileInfo.isFile()) throw workError("WORKSPACE_FILE_NOT_EDITABLE");
      if (fileInfo.size > MAX_EDITABLE_FILE_BYTES) {
        throw workError("WORKSPACE_FILE_TOO_LARGE", { details: { size: fileInfo.size } });
      }
      const content = await readFile(target);
      const isBinary = content.includes(0);
      return c.json({
        path: relativePath,
        name: basename(target),
        content: isBinary ? "" : content.toString("utf8"),
        isBinary,
        size: fileInfo.size,
        modifiedAt: fileInfo.mtime.toISOString(),
      });
    } catch {
      throw workError("WORKSPACE_FILE_NOT_FOUND");
    }
  },
});

// PUT /work/threads/:threadId/file?path=<相对路径> — 保存编辑器全文
export const saveThreadFileRoute = registerApiRoute("/work/threads/:threadId/file", {
  method: "PUT",
  handler: async (c) => {
    const workspace = await ownedWorkspace(c);
    if (!workspace) throw workError("WORKSPACE_NOT_BROWSABLE");
    if ((await getWorkspaceConfig()).readOnly) {
      throw workError("WORKSPACE_READ_ONLY");
    }
    const relativePath = c.req.query("path");
    const target = await containedExistingPath(workspace.root, relativePath);
    if (!target || !relativePath) throw workError("WORKSPACE_PATH_INVALID");
    const body = (await c.req.json()) as { content?: unknown };
    if (typeof body.content !== "string") throw workError("SESSION_INPUT_REQUIRED");
    if (Buffer.byteLength(body.content, "utf8") > MAX_EDITABLE_FILE_BYTES) {
      throw workError("WORKSPACE_FILE_TOO_LARGE");
    }
    const previousContent = await readFile(target, "utf8").catch(() => null);
    try {
      const fileInfo = await stat(target);
      if (!fileInfo.isFile()) throw workError("WORKSPACE_FILE_NOT_EDITABLE");
      await writeFile(target, body.content, "utf8");
      const updated = await stat(target);
      await recordWorkspaceChange({
        threadId: workspace.threadId,
        path: relativePath,
        before: previousContent,
        after: body.content,
        toolName: "workspace.editor_save",
      }).catch(() => undefined);
      return c.json({ ok: true, size: updated.size, modifiedAt: updated.mtime.toISOString() });
    } catch {
      throw workError("WORKSPACE_FILE_SAVE_FAILED");
    }
  },
});

// 动态探测 VS Code 可执行文件路径 (跨平台 PATH / Windows 注册表 App Paths / macOS Spotlight)
async function findVSCodeExecutable(): Promise<string | null> {
  const { execFile } = await import("node:child_process");
  const { existsSync } = await import("node:fs");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);

  // 1. 优先查系统 PATH (跨平台)
  try {
    const isWin = process.platform === "win32";
    const lookupTool = isWin ? "where.exe" : "which";
    const commands = isWin ? ["code.cmd", "code.exe", "code"] : ["code"];
    for (const cmd of commands) {
      try {
        const { stdout } = await execFileAsync(lookupTool, [cmd], { timeout: 1500 });
        const firstLine = stdout.trim().split(/\r?\n/)[0]?.trim();
        if (firstLine && existsSync(firstLine)) return firstLine;
      } catch {
        // try next command
      }
    }
  } catch {
    // ignore
  }

  // 2. Windows 专属：动态查注册表 App Paths
  if (process.platform === "win32") {
    const regKeys = [
      "HKEY_CURRENT_USER\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Code.exe",
      "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Code.exe",
      "HKEY_LOCAL_MACHINE\\SOFTWARE\\Classes\\Applications\\Code.exe\\shell\\open\\command",
    ];
    for (const key of regKeys) {
      try {
        const { stdout } = await execFileAsync("reg.exe", ["query", key, "/ve"], { timeout: 1500 });
        const match = stdout.match(/REG_SZ\s+(?:"([^"]+)"|(\S+))/i);
        const resolvedPath = (match?.[1] || match?.[2] || "").trim();
        if (resolvedPath && existsSync(resolvedPath)) {
          return resolvedPath;
        }
      } catch {
        // try next reg key
      }
    }
  }

  // 3. macOS 专属：通过 Spotlight 搜索 Bundle ID
  if (process.platform === "darwin") {
    try {
      const { stdout } = await execFileAsync(
        "mdfind",
        ["kMDItemCFBundleIdentifier == 'com.microsoft.VSCode'"],
        { timeout: 2000 },
      );
      const firstLine = stdout.trim().split(/\r?\n/)[0]?.trim();
      if (firstLine && existsSync(firstLine)) {
        return firstLine;
      }
    } catch {
      // ignore
    }
  }

  return null;
}

// POST /work/workspace/open-in — 在本地 IDE 或系统工具中打开工作区
export const openInAppRoute = registerApiRoute("/work/workspace/open-in", {
  method: "POST",
  handler: async (c) => {
    const body = (await c.req.json()) as { app?: string; path?: string };
    const { app: appName = "vscode", path: targetPath } = body || {};
    if (!targetPath) {
      throw workError("VALIDATION_FAILED", { text: "未指定工作区路径" });
    }
    try {
      const { spawn } = await import("node:child_process");
      if (appName === "explorer") {
        if (process.platform === "win32") {
          spawn("explorer.exe", [targetPath], { detached: true, stdio: "ignore" });
        } else if (process.platform === "darwin") {
          spawn("open", [targetPath], { detached: true, stdio: "ignore" });
        } else {
          spawn("xdg-open", [targetPath], { detached: true, stdio: "ignore" });
        }
      } else if (appName === "terminal") {
        if (process.platform === "win32") {
          const child = spawn("cmd.exe", ["/c", "start", "wt.exe", "-d", targetPath], {
            detached: true,
            stdio: "ignore",
            shell: true,
          });
          child.on("error", () => {
            spawn("cmd.exe", ["/c", "start", "cmd.exe", "/K", `cd /d "${targetPath}"`], {
              detached: true,
              stdio: "ignore",
              shell: true,
            });
          });
        } else if (process.platform === "darwin") {
          spawn("open", ["-a", "Terminal", targetPath], { detached: true, stdio: "ignore" });
        } else {
          spawn("x-terminal-emulator", [], { cwd: targetPath, detached: true, stdio: "ignore" });
        }
      } else if (appName === "vscode") {
        const vscodeTarget = (await findVSCodeExecutable()) || "code";
        if (process.platform === "darwin" && vscodeTarget.endsWith(".app")) {
          const child = spawn("open", ["-a", vscodeTarget, targetPath], {
            detached: true,
            stdio: "ignore",
          });
          child.unref();
        } else {
          const child = spawn(vscodeTarget, [targetPath], {
            detached: true,
            stdio: "ignore",
            shell: true,
          });
          child.unref();
        }
      } else {
        throw workError("VALIDATION_FAILED", { text: `不支持的应用: ${appName}` });
      }
      return c.json({ ok: true });
    } catch (err) {
      throw workError("VALIDATION_FAILED", {
        text: err instanceof Error ? err.message : "启动应用失败",
      });
    }
  },
});

// GET /work/workspace/detected-ides — 检测当前系统已安装的各类本地 IDE 与系统工具
export const detectedIdesRoute = registerApiRoute("/work/workspace/detected-ides", {
  method: "GET",
  handler: async (c) => {
    try {
      const results: Array<{
        id: string;
        name: string;
        command: string;
        category: "ide" | "system";
      }> = [];

      const vscodePath = await findVSCodeExecutable();
      if (vscodePath) {
        results.push({
          id: "vscode",
          name: "Visual Studio Code",
          command: vscodePath,
          category: "ide",
        });
      }

      results.push({
        id: "terminal",
        name: "终端",
        command: "terminal",
        category: "system",
      });
      results.push({
        id: "explorer",
        name: "文件资源管理器",
        command: "explorer",
        category: "system",
      });

      return c.json(results);
    } catch {
      return c.json([
        { id: "vscode", name: "Visual Studio Code", command: "code", category: "ide" },
        { id: "terminal", name: "终端", command: "terminal", category: "system" },
        { id: "explorer", name: "文件资源管理器", command: "explorer", category: "system" },
      ]);
    }
  },
});
