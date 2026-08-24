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
import { workBrowser } from "../../agents";
import { ensureProfileAgentsRegistered, getAgentProfile } from "../../agents/custom";
import { workError } from "../../errors";
import { workSessionHost } from "../../harness";
import { deleteThreadWorkspace } from "../../workspace";
import { removeObservationalMemoryReferences } from "./compact";
import { getOwnedThread, getWorkMemory, getWorkMemoryForThread } from "./shared";
import type { ThreadMetadata } from "./types";

function parsePage(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const page = Number(value);
  if (!Number.isInteger(page) || page < 0) {
    throw workError("VALIDATION_FAILED", { text: "page must be a non-negative integer" });
  }
  return page;
}

function parsePerPage(value: string | undefined): number | false | undefined {
  if (value === undefined) return undefined;
  if (value === "false") return false;
  const perPage = Number(value);
  if (!Number.isInteger(perPage) || perPage < 1 || perPage > 500) {
    throw workError("VALIDATION_FAILED", { text: "perPage must be 1..500 or false" });
  }
  return perPage;
}

function parseMetadata(value: string | undefined): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw workError("VALIDATION_FAILED", { text: "metadata must be a JSON object" });
  }
}

// GET /work/threads?resourceId=xxx — 列出用户全部线程
export const listThreadsRoute = registerApiRoute("/work/threads", {
  method: "GET",
  handler: async (c) => {
    const resourceId = c.req.query("resourceId");
    if (!resourceId) {
      throw workError("VALIDATION_RESOURCE_ID_REQUIRED");
    }
    const memory = await getWorkMemory(c.get("requestContext"));
    const orderField = c.req.query("orderBy");
    const direction = c.req.query("direction");
    if (direction && !orderField) {
      throw workError("VALIDATION_FAILED", { text: "direction requires orderBy" });
    }
    if (orderField && orderField !== "createdAt" && orderField !== "updatedAt") {
      throw workError("VALIDATION_FAILED", { text: "orderBy must be createdAt or updatedAt" });
    }
    if (direction && direction !== "ASC" && direction !== "DESC") {
      throw workError("VALIDATION_FAILED", { text: "direction must be ASC or DESC" });
    }
    const page = parsePage(c.req.query("page"));
    const perPage = parsePerPage(c.req.query("perPage"));
    const result = await memory.listThreads({
      filter: { resourceId, metadata: parseMetadata(c.req.query("metadata")) },
      ...(page !== undefined ? { page } : {}),
      ...(perPage !== undefined ? { perPage } : { perPage: false }),
      ...(orderField
        ? {
            orderBy: {
              field: orderField as "createdAt" | "updatedAt",
              ...(direction ? { direction: direction as "ASC" | "DESC" } : {}),
            },
          }
        : {}),
    });
    // Studio 直连/连接测试/工作记忆等路径产生的线程 metadata 可能为 null,
    // 统一归一化成对象并结合底层 agent 状态探测线程是否在后台活跃运行中
    const threads = await Promise.all(
      result.threads.map(async (thread) => {
        const metadata = (thread.metadata ?? {}) as Record<string, unknown>;
        const profile = await getAgentProfile(
          typeof metadata.agentProfileId === "string" ? metadata.agentProfileId : undefined,
        );
        const agent = (await ensureProfileAgentsRegistered(c.get("mastra"), profile)).profile;
        const activeRunId = agent.getActiveThreadRunId({ resourceId, threadId: thread.id }) ?? null;
        return {
          ...thread,
          metadata: {
            ...metadata,
            ...(activeRunId ? { activeRunId, isWorking: true } : {}),
          },
        };
      }),
    );
    return c.json({ ...result, threads });
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
    const memory = await getWorkMemory(c.get("requestContext"));
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
    const memory = await getWorkMemoryForThread(c.get("requestContext"), threadId, body.resourceId);
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
    const memory = await getWorkMemoryForThread(c.get("requestContext"), threadId, resourceId);
    const thread = await getOwnedThread(memory, threadId, resourceId);
    if (!thread) {
      throw workError("THREAD_NOT_FOUND");
    }
    const session = workSessionHost.get(resourceId);
    if (session?.threadId === threadId) {
      workSessionHost.delete(resourceId);
    }
    if (workBrowser.hasThreadSession(threadId)) {
      await workBrowser.closeThreadSession(threadId);
    }
    // 物理清理本地工作区目录及释放 Workspace 内存实例
    await deleteThreadWorkspace(threadId, thread.metadata);

    await memory.settled();
    const { messages } = await memory.recall({
      threadId,
      resourceId,
      perPage: false,
    });
    let restoreObservations: (() => Promise<void>) | undefined;
    try {
      restoreObservations = await removeObservationalMemoryReferences(
        memory,
        threadId,
        resourceId,
        (messages ?? []).map((message) => message.id),
      );
      await memory.deleteThread(threadId);
    } catch (error) {
      await restoreObservations?.();
      throw error;
    }
    // settled.mdx(@mastra/memory 1.27 起随 latest 发布):等待 deleteThread 触发的
    // 后台向量清理与仍在进行的观察记忆写入落盘,响应返回即代表线程已彻底清理。
    await memory.settled();
    return c.json({ ok: true });
  },
});
