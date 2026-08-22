/**
 * 工作区路由:读写用户可配置的 Workspace 参数(数据库 app_config 表,保存后实时生效),
 * 近期绑定目录列表与线程工作区文件树。
 * Workspace 主体(文件系统/沙箱/搜索/LSP/Skills)见 src/mastra/workspace/index.ts。
 */
import { type Dirent, readdirSync } from "node:fs";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { type ContextWithMastra, registerApiRoute } from "@mastra/core/server";
import { workError } from "../../errors";
import {
  getWorkspaceConfig,
  implicitThreadWorkspacePath,
  listRecentWorkspaces,
  saveWorkspaceConfig,
  type WorkspaceUserConfig,
} from "../../workspace";
import { getWorkMemory } from "./threads";
import { getOwnedThread, isTrustedLocalRequest } from "./threads/shared";
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

// GET /work/threads/:threadId/tree?path=<相对路径> — 线程工作区文件树(单层按需拉取)
// 仅显式绑定的线程可浏览(隐式目录是 Agent 内部工作区,sidebar 不展示)
type TreeEntry = { hidden: boolean; name: string; path: string; type: "file" | "dir" };

const MAX_EDITABLE_FILE_BYTES = 2 * 1024 * 1024;

async function ownedWorkspace(c: ContextWithMastra) {
  if (!isTrustedLocalRequest(c)) return null;
  const threadId = c.req.param("threadId");
  const resourceId = c.req.query("resourceId");
  if (!threadId || !resourceId) return null;
  const memory = await getWorkMemory();
  const thread = await getOwnedThread(memory, threadId, resourceId);
  const metadata = thread?.metadata as ThreadMetadata | undefined;
  const wsPath = metadata?.workspacePath || implicitThreadWorkspacePath(threadId);
  if (!wsPath) return null;
  try {
    await mkdir(wsPath, { recursive: true });
    return { root: await realpath(resolve(wsPath)), threadId };
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

    return c.json({ ok: true, entry: { name: basename(target), path: relativePath, type } }, 201);
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
      if (content.includes(0)) {
        throw workError("WORKSPACE_FILE_BINARY", { details: { size: fileInfo.size } });
      }
      return c.json({
        path: relativePath,
        name: basename(target),
        content: content.toString("utf8"),
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
    try {
      const fileInfo = await stat(target);
      if (!fileInfo.isFile()) throw workError("WORKSPACE_FILE_NOT_EDITABLE");
      await writeFile(target, body.content, "utf8");
      const updated = await stat(target);
      return c.json({ ok: true, size: updated.size, modifiedAt: updated.mtime.toISOString() });
    } catch {
      throw workError("WORKSPACE_FILE_SAVE_FAILED");
    }
  },
});

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
      } else {
        const ideCommands: Record<string, string[]> = {
          trae: ["trae", "trae.cmd"],
          vscode: ["code", "code.cmd"],
          antigravity: ["antigravity", "antigravity.cmd", "agy", "agy.cmd"],
          cursor: ["cursor", "cursor.cmd"],
        };
        const candidates = ideCommands[appName] || [appName];
        const cmd = candidates[0];
        const child = spawn(cmd, [targetPath], {
          detached: true,
          stdio: "ignore",
          shell: true,
        });
        child.unref();
      }
      return c.json({ ok: true });
    } catch (err: any) {
      throw workError("VALIDATION_FAILED", { text: err?.message || "启动应用失败" });
    }
  },
});

// GET /work/workspace/detected-ides — 检测当前系统已安装的各类本地 IDE 与系统工具
export const detectedIdesRoute = registerApiRoute("/work/workspace/detected-ides", {
  method: "GET",
  handler: async (c) => {
    try {
      const { execFile } = await import("node:child_process");
      const { existsSync } = await import("node:fs");
      const { promisify } = await import("node:util");
      const os = await import("node:os");
      const path = await import("node:path");

      const execFileAsync = promisify(execFile);

      const IDE_REGISTRY = [
        {
          id: "trae",
          name: "TraeCode CN",
          commands: ["trae", "trae.cmd"],
          windowsPaths: [
            path.join(process.env.LOCALAPPDATA || "", "Programs", "Trae", "Trae.exe"),
            "D:\\Trae CN\\bin\\trae.cmd",
            "D:\\Trae CN\\Trae.exe",
            "C:\\Program Files\\Trae\\Trae.exe",
          ],
          macPaths: ["/Applications/Trae.app"],
        },
        {
          id: "vscode",
          name: "Visual Studio Code",
          commands: ["code", "code.cmd"],
          windowsPaths: [
            path.join(
              process.env.LOCALAPPDATA || "",
              "Programs",
              "Microsoft VS Code",
              "bin",
              "code.cmd",
            ),
            path.join(process.env.LOCALAPPDATA || "", "Programs", "Microsoft VS Code", "Code.exe"),
            "C:\\Program Files\\Microsoft VS Code\\bin\\code.cmd",
            "D:\\Microsoft VS Code\\bin\\code.cmd",
          ],
          macPaths: ["/Applications/Visual Studio Code.app"],
          linuxPaths: ["/usr/bin/code", "/snap/bin/code"],
        },
        {
          id: "antigravity",
          name: "Antigravity",
          commands: ["agy", "agy.cmd", "antigravity", "antigravity.cmd"],
          windowsPaths: [
            path.join(process.env.LOCALAPPDATA || "", "agy", "bin", "agy.exe"),
            path.join(process.env.LOCALAPPDATA || "", "Programs", "Antigravity", "Antigravity.exe"),
          ],
          macPaths: [
            "/Applications/Antigravity.app",
            path.join(os.homedir(), ".agy", "bin", "agy"),
          ],
        },
        {
          id: "cursor",
          name: "Cursor",
          commands: ["cursor", "cursor.cmd"],
          windowsPaths: [
            path.join(process.env.LOCALAPPDATA || "", "Programs", "cursor", "Cursor.exe"),
            path.join(
              process.env.LOCALAPPDATA || "",
              "Programs",
              "cursor",
              "resources",
              "app",
              "bin",
              "cursor.cmd",
            ),
          ],
          macPaths: ["/Applications/Cursor.app"],
        },
        {
          id: "windsurf",
          name: "Windsurf",
          commands: ["windsurf", "windsurf.cmd"],
          windowsPaths: [
            path.join(process.env.LOCALAPPDATA || "", "Programs", "Windsurf", "Windsurf.exe"),
            path.join(
              process.env.LOCALAPPDATA || "",
              "Programs",
              "Windsurf",
              "bin",
              "windsurf.cmd",
            ),
          ],
          macPaths: ["/Applications/Windsurf.app"],
        },
        {
          id: "vscode-insiders",
          name: "VS Code Insiders",
          commands: ["code-insiders", "code-insiders.cmd"],
          windowsPaths: [
            path.join(
              process.env.LOCALAPPDATA || "",
              "Programs",
              "Microsoft VS Code Insiders",
              "bin",
              "code-insiders.cmd",
            ),
          ],
          macPaths: ["/Applications/Visual Studio Code - Insiders.app"],
        },
        {
          id: "webstorm",
          name: "WebStorm",
          commands: ["webstorm", "webstorm64.exe", "webstorm.cmd"],
          macPaths: ["/Applications/WebStorm.app"],
        },
        {
          id: "idea",
          name: "IntelliJ IDEA",
          commands: ["idea", "idea64.exe", "idea.cmd"],
          macPaths: ["/Applications/IntelliJ IDEA.app", "/Applications/IntelliJ IDEA CE.app"],
        },
        {
          id: "pycharm",
          name: "PyCharm",
          commands: ["pycharm", "pycharm64.exe", "pycharm.cmd"],
          macPaths: ["/Applications/PyCharm.app", "/Applications/PyCharm CE.app"],
        },
        {
          id: "sublime",
          name: "Sublime Text",
          commands: ["subl", "sublime_text"],
          macPaths: ["/Applications/Sublime Text.app"],
        },
        {
          id: "positron",
          name: "Positron",
          commands: ["positron", "positron.cmd"],
          windowsPaths: [
            path.join(process.env.LOCALAPPDATA || "", "Programs", "Positron", "Positron.exe"),
          ],
          macPaths: ["/Applications/Positron.app"],
        },
      ];

      const results: Array<{
        id: string;
        name: string;
        command: string;
        category: "ide" | "system";
      }> = [];

      await Promise.all(
        IDE_REGISTRY.map(async (candidate) => {
          const platformPaths =
            process.platform === "win32"
              ? candidate.windowsPaths
              : process.platform === "darwin"
                ? candidate.macPaths
                : candidate.linuxPaths;

          if (platformPaths?.some((p) => p && existsSync(p))) {
            results.push({
              id: candidate.id,
              name: candidate.name,
              command: candidate.commands[0],
              category: "ide",
            });
            return;
          }

          const lookupTool = process.platform === "win32" ? "where.exe" : "which";
          for (const cmd of candidate.commands) {
            try {
              await execFileAsync(lookupTool, [cmd], { timeout: 1500 });
              results.push({
                id: candidate.id,
                name: candidate.name,
                command: cmd,
                category: "ide",
              });
              return;
            } catch {
              // try next command
            }
          }
        }),
      );

      const orderMap = new Map(IDE_REGISTRY.map((item, idx) => [item.id, idx]));
      results.sort((a, b) => (orderMap.get(a.id) ?? 999) - (orderMap.get(b.id) ?? 999));

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
