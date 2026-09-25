import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { WORKSPACE_PATH_CONTEXT_KEY } from "../workspace";

const PLAN_DRAFT_ROOT = "plans";

function workspacePathFromContext(requestContext: { get: (key: string) => unknown }): string {
  const value = requestContext.get(WORKSPACE_PATH_CONTEXT_KEY);
  return typeof value === "string" && value.trim() ? resolve(value.trim()) : resolve(process.cwd());
}

function resolvePlanPath(workspacePath: string, requestedPath: string): string {
  const trimmed = requestedPath.trim();
  if (!trimmed || isAbsolute(trimmed)) throw new Error("计划文件必须是 workspace 内的相对路径");

  const planRoot = resolve(workspacePath, PLAN_DRAFT_ROOT);
  const target = trimmed.toLowerCase().startsWith(`${PLAN_DRAFT_ROOT.toLowerCase()}\\`)
    || trimmed.toLowerCase().startsWith(`${PLAN_DRAFT_ROOT.toLowerCase()}/`)
    ? resolve(workspacePath, trimmed)
    : resolve(planRoot, trimmed);
  const withinPlans = relative(planRoot, target);
  if (!withinPlans || withinPlans.startsWith("..") || isAbsolute(withinPlans)) {
    throw new Error("计划文件只能写入 workspace/plans/ 目录");
  }
  if (!target.toLowerCase().endsWith(".md")) {
    throw new Error("计划文件必须使用 .md 扩展名");
  }
  return target;
}

export const writePlanDraftTool = createTool({
  id: "write-plan-draft",
  description:
    "把完整的 Markdown 计划写入当前 workspace 的 plans/ 目录。Plan 模式唯一允许的写入能力;不能写入其他路径。",
  inputSchema: z.object({
    path: z.string().min(1).describe("workspace/plans/ 下的 Markdown 相对路径"),
    content: z.string().min(1).describe("完整的 Markdown 计划内容"),
  }),
  outputSchema: z.object({
    path: z.string(),
    byteSize: z.number().int().nonnegative(),
  }),
  execute: async ({ path, content }, { requestContext }) => {
    const workspaceRoot = await realpath(workspacePathFromContext(requestContext));
    const target = resolvePlanPath(workspaceRoot, path);
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

    // Create each parent only after validating the path it resolves to. A
    // recursive mkdir before checking a symlink could otherwise create
    // directories outside the workspace before rejecting the draft.
    const parentRelativeToPlans = relative(planRoot, dirname(target));
    let parentDirectory = resolvedPlanRoot;
    for (const segment of parentRelativeToPlans.split(/[\\/]/).filter(Boolean)) {
      const nextDirectory = resolve(parentDirectory, segment);
      await mkdir(nextDirectory).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
      const resolvedDirectory = await realpath(nextDirectory);
      const relativeToPlans = relative(resolvedPlanRoot, resolvedDirectory);
      if (relativeToPlans.startsWith("..") || isAbsolute(relativeToPlans)) {
        throw new Error("计划文件不能通过符号链接指向 plans/ 目录之外");
      }
      parentDirectory = resolvedDirectory;
    }

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
    // Keep temporary content in the validated plans root, not beside the
    // destination: replacing a nested parent with a junction must not redirect
    // draft bytes before the final destination-path check.
    const temporaryTarget = resolve(resolvedPlanRoot, `.${randomUUID()}.tmp`);
    const temporaryFile = await open(temporaryTarget, "wx");
    try {
      await temporaryFile.writeFile(content, "utf8");
      await temporaryFile.sync();
    } finally {
      await temporaryFile.close();
    }
    try {
      const currentParent = await realpath(parentDirectory);
      const relativeParent = relative(resolvedPlanRoot, currentParent);
      if (
        currentParent !== parentDirectory ||
        relativeParent.startsWith("..") ||
        isAbsolute(relativeParent)
      ) {
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
