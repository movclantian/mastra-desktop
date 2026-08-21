import { type Dirent, readdirSync } from "node:fs";
import { readFile, realpath, stat, writeFile } from "node:fs/promises";
import { basename, extname, join, relative, resolve } from "node:path";
import { type ContextWithMastra, registerApiRoute } from "@mastra/core/server";
import { getThreadWorkspace, getWorkspaceConfig, type WorkspaceUserConfig } from "../../workspace";
import { getWorkMemory } from "./threads";
import { getOwnedThread, isTrustedLocalRequest } from "./threads/shared";
import type { ThreadMetadata } from "./threads/types";

/**
 * 工作区路由:读写用户可配置的 Workspace 参数(数据库 app_config 表,重启生效),
 * 近期绑定目录列表与线程工作区文件树。
 * Workspace 主体(文件系统/沙箱/搜索/LSP/Skills)见 src/mastra/workspace/index.ts。
 */

// GET /work/workspace — 读取当前工作区配置
export const workspaceConfigRoute = registerApiRoute("/work/workspace", {
  method: "GET",
  handler: async (c) => {
    const { getWorkspaceConfig } = await import("../../workspace");
    return c.json(await getWorkspaceConfig());
  },
});

// POST /work/workspace — 写入工作区配置
export const saveWorkspaceConfigRoute = registerApiRoute("/work/workspace", {
  method: "POST",
  handler: async (c) => {
    const config = (await c.req.json()) as WorkspaceUserConfig;
    const { saveWorkspaceConfig } = await import("../../workspace");
    await saveWorkspaceConfig(config);
    return c.json({ ok: true });
  },
});

// GET /work/workspace/recent — 近期显式绑定的工作区目录(promptInput 选择器)
export const recentWorkspacesRoute = registerApiRoute("/work/workspace/recent", {
  method: "GET",
  handler: async (c) => {
    const { listRecentWorkspaces } = await import("../../workspace");
    return c.json({ recent: await listRecentWorkspaces() });
  },
});

// GET /work/threads/:threadId/tree?path=<相对路径> — 线程工作区文件树(单层按需拉取)
// 仅显式绑定的线程可浏览(隐式目录是 Agent 内部工作区,sidebar 不展示)
type TreeEntry = { hidden: boolean; name: string; path: string; type: "file" | "dir" };

const MAX_EDITABLE_FILE_BYTES = 2 * 1024 * 1024;

async function ownedWorkspace(c: ContextWithMastra, explicitOnly = true) {
  if (!isTrustedLocalRequest(c)) return null;
  const threadId = c.req.param("threadId");
  const resourceId = c.req.query("resourceId");
  if (!threadId || !resourceId) return null;
  const memory = await getWorkMemory();
  const thread = await getOwnedThread(memory, threadId, resourceId);
  const metadata = thread?.metadata as ThreadMetadata | undefined;
  if (!metadata?.workspacePath || (explicitOnly && metadata.workspaceExplicit !== true))
    return null;
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
      return c.json({ error: "Thread has no browsable workspace" }, 404);
    }
    const { root } = workspace;
    const target = await containedExistingPath(root, c.req.query("path"));
    if (!target) return c.json({ error: "Path escapes workspace" }, 400);
    let dirents: Dirent[];
    try {
      dirents = readdirSync(target, { withFileTypes: true });
    } catch {
      return c.json({ error: "Directory not readable" }, 404);
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

// GET /work/threads/:threadId/file?path=<相对路径> — 编辑器读取 UTF-8 文本
export const threadFileRoute = registerApiRoute("/work/threads/:threadId/file", {
  method: "GET",
  handler: async (c) => {
    const workspace = await ownedWorkspace(c);
    if (!workspace) return c.json({ error: "Thread has no browsable workspace" }, 404);
    const relativePath = c.req.query("path");
    const target = await containedExistingPath(workspace.root, relativePath);
    if (!target || !relativePath) return c.json({ error: "Invalid file path" }, 400);
    try {
      const fileInfo = await stat(target);
      if (!fileInfo.isFile()) return c.json({ error: "Path is not a file" }, 400);
      if (fileInfo.size > MAX_EDITABLE_FILE_BYTES) {
        return c.json({ error: "File is too large to edit", size: fileInfo.size }, 413);
      }
      const content = await readFile(target);
      if (content.includes(0)) {
        return c.json({ error: "Binary files cannot be edited", size: fileInfo.size }, 415);
      }
      return c.json({
        path: relativePath,
        name: basename(target),
        content: content.toString("utf8"),
        size: fileInfo.size,
        modifiedAt: fileInfo.mtime.toISOString(),
      });
    } catch {
      return c.json({ error: "File not readable" }, 404);
    }
  },
});

// PUT /work/threads/:threadId/file?path=<相对路径> — 保存编辑器全文
export const saveThreadFileRoute = registerApiRoute("/work/threads/:threadId/file", {
  method: "PUT",
  handler: async (c) => {
    const workspace = await ownedWorkspace(c);
    if (!workspace) return c.json({ error: "Thread has no browsable workspace" }, 404);
    if ((await getWorkspaceConfig()).readOnly) {
      return c.json({ error: "Workspace is read-only" }, 403);
    }
    const relativePath = c.req.query("path");
    const target = await containedExistingPath(workspace.root, relativePath);
    if (!target || !relativePath) return c.json({ error: "Invalid file path" }, 400);
    const body = (await c.req.json()) as { content?: unknown };
    if (typeof body.content !== "string") return c.json({ error: "content is required" }, 400);
    if (Buffer.byteLength(body.content, "utf8") > MAX_EDITABLE_FILE_BYTES) {
      return c.json({ error: "File is too large to save" }, 413);
    }
    try {
      const fileInfo = await stat(target);
      if (!fileInfo.isFile()) return c.json({ error: "Path is not a file" }, 400);
      await writeFile(target, body.content, "utf8");
      const updated = await stat(target);
      return c.json({ ok: true, size: updated.size, modifiedAt: updated.mtime.toISOString() });
    } catch {
      return c.json({ error: "File could not be saved" }, 400);
    }
  },
});

// POST /work/threads/:threadId/command — 在线程 LocalSandbox 中流式执行用户命令
export const threadCommandRoute = registerApiRoute("/work/threads/:threadId/command", {
  method: "POST",
  handler: async (c) => {
    const workspace = await ownedWorkspace(c, false);
    if (!workspace) return c.json({ error: "Thread has no browsable workspace" }, 404);
    const body = (await c.req.json()) as { command?: string; filePath?: string };
    const command = body.command?.trim();
    const targetFile = body.filePath
      ? await containedExistingPath(workspace.root, body.filePath)
      : null;
    if (!command && !targetFile) return c.json({ error: "command or filePath is required" }, 400);
    if (body.filePath && !targetFile) return c.json({ error: "Path escapes workspace" }, 400);
    const sandbox = getThreadWorkspace(workspace.root).sandbox;
    if (!sandbox?.executeCommand) return c.json({ error: "Workspace sandbox is disabled" }, 409);
    const executeCommand = sandbox.executeCommand.bind(sandbox);

    const encoder = new TextEncoder();
    const abortController = new AbortController();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (value: unknown) =>
          controller.enqueue(encoder.encode(`${JSON.stringify(value)}\n`));
        const powershell = join(
          process.env.SystemRoot || "C:\\Windows",
          "System32",
          "WindowsPowerShell",
          "v1.0",
          "powershell.exe",
        );
        let executable: string;
        let args: string[];
        let displayCommand: string;
        let executionEnv: NodeJS.ProcessEnv | undefined;
        if (targetFile && body.filePath) {
          const extension = extname(targetFile).toLowerCase();
          displayCommand = `run ${body.filePath}`;
          if ([".js", ".mjs", ".cjs"].includes(extension)) {
            executable = process.execPath;
            args = [targetFile];
            executionEnv = { ELECTRON_RUN_AS_NODE: "1" };
          } else if ([".ts", ".mts", ".cts"].includes(extension)) {
            executable = process.execPath;
            args = ["--experimental-strip-types", targetFile];
            executionEnv = { ELECTRON_RUN_AS_NODE: "1" };
          } else if (extension === ".py") {
            executable = process.platform === "win32" ? "python.exe" : "python3";
            args = [targetFile];
          } else if (extension === ".ps1" && process.platform === "win32") {
            executable = powershell;
            args = ["-NoLogo", "-NoProfile", "-File", targetFile];
          } else if (extension === ".sh" && process.platform !== "win32") {
            executable = "/bin/sh";
            args = [targetFile];
          } else {
            send({
              type: "error",
              error: `Unsupported runnable file: ${extension || "no extension"}`,
            });
            controller.close();
            return;
          }
        } else {
          displayCommand = command ?? "";
          executable = process.platform === "win32" ? powershell : "/bin/sh";
          args =
            process.platform === "win32"
              ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", displayCommand]
              : ["-lc", displayCommand];
        }
        send({ type: "start", command: displayCommand });
        void executeCommand(executable, args, {
          abortSignal: abortController.signal,
          env: executionEnv,
          maxRetainedBytes: 1024 * 1024,
          onStdout: (data) => send({ type: "stdout", data }),
          onStderr: (data) => send({ type: "stderr", data }),
        })
          .then((result) => {
            send({
              type: "exit",
              exitCode: result.exitCode,
              executionTimeMs: result.executionTimeMs,
              timedOut: result.timedOut,
              killed: result.killed,
            });
            controller.close();
          })
          .catch((error) => {
            send({ type: "error", error: error instanceof Error ? error.message : String(error) });
            controller.close();
          });
      },
      cancel() {
        abortController.abort();
      },
    });
    return new Response(stream, {
      headers: { "Cache-Control": "no-cache", "Content-Type": "application/x-ndjson" },
    });
  },
});
