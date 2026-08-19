import { type Dirent, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { registerApiRoute } from "@mastra/core/server";
import type { WorkspaceUserConfig } from "../../workspace";
import { getWorkMemory } from "./threads";
import { getOwnedThread } from "./threads/shared";
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
type TreeEntry = { name: string; path: string; type: "file" | "dir" };

export const threadTreeRoute = registerApiRoute("/work/threads/:threadId/tree", {
  method: "GET",
  handler: async (c) => {
    const threadId = c.req.param("threadId");
    const resourceId = c.req.query("resourceId");
    if (!resourceId) return c.json({ error: "resourceId is required" }, 400);
    const memory = await getWorkMemory();
    const thread = await getOwnedThread(memory, threadId, resourceId);
    const metadata = thread?.metadata as ThreadMetadata | undefined;
    if (!metadata?.workspacePath || metadata.workspaceExplicit !== true) {
      return c.json({ error: "Thread has no browsable workspace" }, 404);
    }
    // 相对路径防逃逸:resolve 后必须仍在工作区内
    const root = resolve(metadata.workspacePath);
    const target = resolve(root, c.req.query("path") ?? ".");
    if (target !== root && !target.startsWith(`${root}\\`) && !target.startsWith(`${root}/`)) {
      return c.json({ error: "Path escapes workspace" }, 400);
    }
    let dirents: Dirent[];
    try {
      dirents = readdirSync(target, { withFileTypes: true });
    } catch {
      return c.json({ error: "Directory not readable" }, 404);
    }
    const entries: TreeEntry[] = dirents
      .filter((d) => !d.name.startsWith("."))
      .map((d) => ({
        name: d.name,
        // 返回相对工作区根的 POSIX 风格路径,FileTree 组件直接消费
        path: join(target, d.name).slice(root.length).replaceAll("\\", "/").replace(/^\//, ""),
        type: d.isDirectory() ? ("dir" as const) : ("file" as const),
      }))
      .sort((a, b) =>
        a.type !== b.type ? (a.type === "dir" ? -1 : 1) : a.name.localeCompare(b.name),
      );
    return c.json({ entries, root: basename(root), rootPath: root });
  },
});
