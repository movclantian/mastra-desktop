import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { WORKSPACE_PATH_CONTEXT_KEY } from "../workspace";

const PLAN_DRAFT_ROOT = "plans";

function workspacePathFromContext(requestContext: { get: (key: string) => unknown }): string {
  const value = requestContext.get(WORKSPACE_PATH_CONTEXT_KEY);
  return typeof value === "string" && value.trim() ? resolve(value.trim()) : resolve(process.cwd());
}

function resolvePlanFilename(requestedPath: string): string {
  const trimmed = requestedPath.trim();
  if (!trimmed || isAbsolute(trimmed)) throw new Error("计划文件必须是 workspace 内的相对路径");

  const filename = trimmed.replace(/^plans[\\/]/i, "");
  if (/[\\/:]/.test(filename)) {
    throw new Error("计划文件必须直接位于 workspace/plans/ 目录下");
  }
  if (!filename.toLowerCase().endsWith(".md")) {
    throw new Error("计划文件必须使用 .md 扩展名");
  }
  return filename;
}

/**
 * Plan 模式是只读模式,官方 mastra_workspace_write_file 不在它的工具表里
 * (permissions.ts:PLAN_TOOL_NAMES),所以计划草稿需要自己的写入边界。
 *
 * 这里没有复用 LocalFilesystem.writeFile:它的 assertPathContained 在 realpath
 * 抛 ENOENT 时直接放行(workspace/filesystem 的包含性校验只认已存在的目标),
 * 因此 plans/ 下一个指向工作区外的悬空符号链接会被 fs.writeFile 跟随。下面的
 * 独占临时文件 + 原子 rename 正是替换掉该叶子链接而不是跟随它。
 */
export const writePlanDraftTool = createTool({
  id: "write-plan-draft",
  description:
    "把完整的 Markdown 计划写入当前 workspace 的 plans/ 根目录。Plan 模式唯一允许的写入能力;不能写入其他路径。",
  inputSchema: z.object({
    path: z.string().min(1).describe("workspace/plans/ 根目录下的 Markdown 文件名"),
    content: z.string().min(1).describe("完整的 Markdown 计划内容"),
  }),
  outputSchema: z.object({
    path: z.string(),
    byteSize: z.number().int().nonnegative(),
  }),
  execute: async ({ path, content }, { requestContext }) => {
    const workspacePath = workspacePathFromContext(requestContext);
    const workspaceRoot = await realpath(workspacePath);
    const filename = resolvePlanFilename(path);
    const planRoot = resolve(workspaceRoot, PLAN_DRAFT_ROOT);
    await mkdir(planRoot).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    const resolvedPlanRoot = await realpath(planRoot);
    const planRootRelativeToWorkspace = relative(workspaceRoot, resolvedPlanRoot);
    if (
      planRootRelativeToWorkspace.toLowerCase() !== PLAN_DRAFT_ROOT.toLowerCase() ||
      isAbsolute(planRootRelativeToWorkspace)
    ) {
      throw new Error("计划目录不能通过符号链接重定向");
    }
    // Build both paths from the verified canonical directory. Replacing the
    // lexical workspace/plans entry after validation cannot redirect rename.
    const target = resolve(resolvedPlanRoot, filename);

    // `realpath` alone misses dangling symlinks. Reject an existing link, then
    // write to a fresh sibling and atomically rename it into place. Rename
    // replaces a raced-in leaf symlink itself instead of following its target.
    const targetEntry = await lstat(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (targetEntry?.isSymbolicLink()) {
      throw new Error("计划文件不能是符号链接");
    }

    const bytes = Buffer.byteLength(content, "utf8");
    // Drafts stay at the plans root so a replaceable nested parent cannot
    // redirect the final rename outside the approved directory.
    const temporaryTarget = resolve(resolvedPlanRoot, `.${randomUUID()}.tmp`);
    const temporaryFile = await open(temporaryTarget, "wx");
    try {
      try {
        await temporaryFile.writeFile(content, "utf8");
        await temporaryFile.sync();
      } finally {
        await temporaryFile.close();
      }
      const currentWorkspaceRoot = await realpath(workspacePathFromContext(requestContext));
      if (currentWorkspaceRoot !== workspaceRoot) {
        throw new Error("工作区目录在写入期间发生变化，已拒绝保存");
      }
      const currentPlanRoot = await realpath(planRoot);
      if (currentPlanRoot !== resolvedPlanRoot) {
        throw new Error("计划目录在写入期间发生变化，已拒绝保存");
      }
      const currentTarget = await lstat(target).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (currentTarget?.isSymbolicLink()) {
        throw new Error("计划文件不能是符号链接");
      }
      await rename(temporaryTarget, target);
    } finally {
      await unlink(temporaryTarget).catch(() => undefined);
    }
    return { path: target, byteSize: bytes };
  },
});
