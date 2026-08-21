/**
 * 线程 CRUD 路由。
 * 线程操作参考 docs/en/docs/memory/message-history.mdx
 * (listThreads / createThread / updateThread / deleteThread)。
 *
 * 多用户隔离:所有线程操作以 resourceId(用户 ID)为过滤条件;
 * 工作区绑定通过 thread.metadata.workspacePath 实现(首条消息时锁定)。
 */
import { existsSync, statSync } from "node:fs";
import { registerApiRoute } from "@mastra/core/server";
import { workBrowser } from "../../../agents";
import { workError } from "../../../errors";
import { workSessionHost } from "../../../harness";
import { getOwnedThread, getWorkMemory } from "./shared";
import type { ThreadMetadata } from "./types";

// GET /work/threads?resourceId=xxx — 列出用户全部线程
export const listThreadsRoute = registerApiRoute("/work/threads", {
  method: "GET",
  handler: async (c) => {
    const resourceId = c.req.query("resourceId");
    if (!resourceId) {
      throw workError("VALIDATION_RESOURCE_ID_REQUIRED");
    }
    const memory = await getWorkMemory();
    const result = await memory.listThreads({
      filter: { resourceId },
      perPage: false,
    });
    // Studio 直连/连接测试/工作记忆等路径产生的线程 metadata 可能为 null,
    // 统一归一化成对象 —— 侧边栏直接读 t.metadata.archivedAt 会炸掉整个 UI
    return c.json({
      threads: result.threads.map((thread) => ({ ...thread, metadata: thread.metadata ?? {} })),
    });
  },
});

// POST /work/threads — 创建线程 { resourceId, threadId?, title?, metadata? }
export const createThreadRoute = registerApiRoute("/work/threads", {
  method: "POST",
  handler: async (c) => {
    const body = (await c.req.json()) as {
      resourceId: string;
      threadId?: string;
      title?: string;
      metadata?: ThreadMetadata;
    };
    if (!body.resourceId) {
      throw workError("VALIDATION_RESOURCE_ID_REQUIRED");
    }
    const memory = await getWorkMemory();
    if (body.metadata?.draft) {
      // 新会话线程唯一:draft 线程必须"没有任何历史消息"才可复用,
      // 只看 draft 标记会把发过消息但未改名的线程误判为新线程。
      const { threads } = await memory.listThreads({
        filter: { resourceId: body.resourceId },
        perPage: false,
      });
      const candidates = threads.filter(
        (thread) => thread.metadata?.draft === true && !thread.metadata?.archivedAt,
      );
      for (const candidate of candidates) {
        const { messages } = await memory.recall({
          threadId: candidate.id,
          resourceId: body.resourceId,
          perPage: false,
        });
        if ((messages ?? []).length === 0) {
          // 草稿线程只是输入占位,不会继承目录归属。旧版本可能在发送前
          // 提前写过 workspacePath,这里在复用空草稿时清掉它。
          if (candidate.metadata?.workspacePath || candidate.metadata?.workspaceExplicit) {
            const metadata = Object.fromEntries(
              Object.entries(candidate.metadata ?? {}).filter(
                ([key]) => key !== "workspacePath" && key !== "workspaceExplicit",
              ),
            );
            const cleaned = await memory.updateThread({
              id: candidate.id,
              title: candidate.title,
              metadata,
            });
            return c.json({ thread: cleaned });
          }
          return c.json({ thread: candidate });
        }
        // 有消息的 draft 是残留标记(如自动生成标题失败/未触发改名),清除后继续
        await memory.updateThread({
          id: candidate.id,
          title: candidate.title,
          metadata: { ...candidate.metadata, draft: false },
        });
      }
    }
    const thread = await memory.createThread({
      threadId: body.threadId,
      resourceId: body.resourceId,
      title: body.title ?? "New Chat",
      metadata: body.metadata ?? {},
    });
    return c.json({ thread }, 201);
  },
});

// PATCH /work/threads/:threadId — 更新 { title?, metadata? }
export const updateThreadRoute = registerApiRoute("/work/threads/:threadId", {
  method: "PATCH",
  handler: async (c) => {
    const threadId = c.req.param("threadId");
    const body = (await c.req.json()) as {
      resourceId: string;
      title?: string;
      metadata?: ThreadMetadata;
    };
    if (!body.resourceId) {
      throw workError("VALIDATION_RESOURCE_ID_REQUIRED");
    }
    const memory = await getWorkMemory();
    const existing = await memory.getThreadById({ threadId });
    if (!existing || existing.resourceId !== body.resourceId) {
      throw workError("THREAD_NOT_FOUND");
    }
    if (body.metadata?.workspaceExplicit === true) {
      const workspacePath = body.metadata.workspacePath;
      let validDirectory = false;
      try {
        validDirectory =
          typeof workspacePath === "string" &&
          existsSync(workspacePath) &&
          statSync(workspacePath).isDirectory();
      } catch {
        validDirectory = false;
      }
      if (!validDirectory) {
        throw workError("WORKSPACE_PATH_REQUIRED");
      }
    }
    const thread = await memory.updateThread({
      id: threadId,
      title: body.title ?? existing.title,
      metadata: { ...existing.metadata, ...body.metadata },
    });
    return c.json({ thread });
  },
});

// DELETE /work/threads/:threadId — 删除线程
export const deleteThreadRoute = registerApiRoute("/work/threads/:threadId", {
  method: "DELETE",
  handler: async (c) => {
    const threadId = c.req.param("threadId");
    const resourceId = c.req.query("resourceId");
    if (!resourceId) throw workError("VALIDATION_RESOURCE_ID_REQUIRED");
    const memory = await getWorkMemory();
    if (!(await getOwnedThread(memory, threadId, resourceId))) {
      throw workError("THREAD_NOT_FOUND");
    }
    const session = workSessionHost.get(resourceId);
    if (session?.threadId === threadId) {
      workSessionHost.delete(resourceId);
    }
    if (workBrowser.hasThreadSession(threadId)) {
      await workBrowser.closeThreadSession(threadId);
    }
    await memory.deleteThread(threadId);
    // settled.mdx(@mastra/memory 1.27 起随 latest 发布):等待 deleteThread 触发的
    // 后台向量清理与仍在进行的观察记忆写入落盘,响应返回即代表线程已彻底清理。
    await memory.settled();
    return c.json({ ok: true });
  },
});
