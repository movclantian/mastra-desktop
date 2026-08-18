import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { registerApiRoute } from "@mastra/core/server";
import type { MemoryUserConfig } from "../../memory/overview";
import { getStorageDirectory, getStorageUrl } from "../../storage";

/**
 * MastraWork 工作台 API 路由。
 * 写法参考 docs/en/docs/server/custom-api-routes.mdx(registerApiRoute)。
 * 线程操作参考 docs/en/docs/memory/message-history.mdx
 * (listThreads / createThread / updateThread / deleteThread)。
 *
 * 多用户隔离:所有线程操作以 resourceId(用户 ID)为过滤条件;
 * 工作区隔离通过 thread.metadata.workspaceId 实现。
 */

type ThreadMetadata = {
  workspaceId?: string;
  pinned?: boolean;
  archivedAt?: string | null;
};

async function getWorkMemory() {
  const { mastra } = await import("../../index/index");
  const agent = mastra.getAgentById("mastra-work-agent");
  const memory = await agent.getMemory();
  if (!memory) {
    throw new Error("Agent memory is not configured");
  }
  return memory;
}

// GET /api/work/threads?resourceId=xxx — 列出用户全部线程
export const listThreadsRoute = registerApiRoute("/api/work/threads", {
  method: "GET",
  handler: async (c) => {
    const resourceId = c.req.query("resourceId");
    if (!resourceId) {
      return c.json({ error: "resourceId is required" }, 400);
    }
    const memory = await getWorkMemory();
    const result = await memory.listThreads({
      filter: { resourceId },
      perPage: false,
    });
    return c.json({ threads: result.threads });
  },
});

// POST /api/work/threads — 创建线程 { resourceId, threadId?, title?, metadata? }
export const createThreadRoute = registerApiRoute("/api/work/threads", {
  method: "POST",
  handler: async (c) => {
    const body = (await c.req.json()) as {
      resourceId: string;
      threadId?: string;
      title?: string;
      metadata?: ThreadMetadata;
    };
    if (!body.resourceId) {
      return c.json({ error: "resourceId is required" }, 400);
    }
    const memory = await getWorkMemory();
    const thread = await memory.createThread({
      threadId: body.threadId,
      resourceId: body.resourceId,
      title: body.title ?? "New Chat",
      metadata: body.metadata ?? {},
    });
    return c.json({ thread }, 201);
  },
});

// PATCH /api/work/threads/:threadId — 更新 { title?, metadata? }
export const updateThreadRoute = registerApiRoute("/api/work/threads/:threadId", {
  method: "PATCH",
  handler: async (c) => {
    const threadId = c.req.param("threadId");
    const body = (await c.req.json()) as {
      resourceId: string;
      title?: string;
      metadata?: ThreadMetadata;
    };
    if (!body.resourceId) {
      return c.json({ error: "resourceId is required" }, 400);
    }
    const memory = await getWorkMemory();
    const existing = await memory.getThreadById({ threadId });
    if (!existing) {
      return c.json({ error: "Thread not found" }, 404);
    }
    const thread = await memory.updateThread({
      id: threadId,
      title: body.title ?? existing.title,
      metadata: { ...existing.metadata, ...body.metadata },
    });
    return c.json({ thread });
  },
});

// DELETE /api/work/threads/:threadId — 删除线程
export const deleteThreadRoute = registerApiRoute("/api/work/threads/:threadId", {
  method: "DELETE",
  handler: async (c) => {
    const threadId = c.req.param("threadId");
    const memory = await getWorkMemory();
    await memory.deleteThread(threadId);
    return c.json({ ok: true });
  },
});

// GET /api/work/threads/:threadId/messages — 拉取线程消息历史(recall)
export const threadMessagesRoute = registerApiRoute("/api/work/threads/:threadId/messages", {
  method: "GET",
  handler: async (c) => {
    const threadId = c.req.param("threadId");
    const memory = await getWorkMemory();
    const { messages } = await memory.recall({ threadId, perPage: false });
    // 转为轻量 UI 消息格式:text parts 足以还原对话
    const uiMessages = (messages ?? [])
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({
        id: m.id,
        role: m.role,
        parts: (m.content.parts ?? [])
          .filter((p): p is { type: "text"; text: string } => p.type === "text")
          .map((p) => ({ type: "text" as const, text: p.text })),
      }));
    return c.json({ messages: uiMessages });
  },
});

// GET /api/work/providers/catalog — 服务端代理 models.dev 目录(渲染进程 CSP 禁止直连外网)
// 内存缓存 1 小时,对齐 docs/en/models/index.mdx 的每小时自动刷新策略
const MODELS_DEV_API = "https://models.dev/api.json";
let catalogCache: { fetchedAt: number; body: unknown } | null = null;
const CATALOG_TTL_MS = 60 * 60 * 1000;

export const modelsCatalogRoute = registerApiRoute("/api/work/providers/catalog", {
  method: "GET",
  handler: async (c) => {
    if (catalogCache && Date.now() - catalogCache.fetchedAt < CATALOG_TTL_MS) {
      return c.json(catalogCache.body);
    }
    try {
      const response = await fetch(MODELS_DEV_API);
      if (!response.ok) {
        return c.json({ error: `Upstream ${response.status}` }, 502);
      }
      const body = await response.json();
      catalogCache = { fetchedAt: Date.now(), body };
      return c.json(body);
    } catch (error) {
      return c.json({ error: (error as Error).message }, 500);
    }
  },
});

// POST /api/work/providers/models — 服务端代理拉取供应商模型列表(规避 CORS)
// body: { type: 'openai-compatible' | 'openai-responses' | 'anthropic' | 'gemini', url, apiKey }
export const listProviderModelsRoute = registerApiRoute("/api/work/providers/models", {
  method: "POST",
  handler: async (c) => {
    const { type, url, apiKey } = (await c.req.json()) as {
      type: string;
      url: string;
      apiKey: string;
    };
    try {
      let endpoint = url;
      const headers: Record<string, string> = {};
      if (type === "anthropic") {
        endpoint = `${url.replace(/\/$/, "")}/models`;
        headers["x-api-key"] = apiKey;
        headers["anthropic-version"] = "2023-06-01";
      } else if (type === "gemini") {
        endpoint = `${url.replace(/\/$/, "")}/models?key=${apiKey}`;
      } else {
        endpoint = `${url.replace(/\/$/, "")}/models`;
        headers.Authorization = `Bearer ${apiKey}`;
      }
      const response = await fetch(endpoint, { headers });
      if (!response.ok) {
        return c.json({ error: `Upstream ${response.status}` }, 502);
      }
      const data = (await response.json()) as {
        data?: { id: string; display_name?: string }[];
        models?: { name: string; displayName?: string }[];
      };
      // OpenAI 兼容 / Anthropic: { data: [{ id }] }; Gemini: { models: [{ name: "models/xxx" }] }
      const models = data.data
        ? data.data.map((m) => ({ id: m.id, name: m.display_name ?? m.id }))
        : (data.models ?? []).map((m) => ({
            id: m.name.replace(/^models\//, ""),
            name: m.displayName ?? m.name.replace(/^models\//, ""),
          }));
      return c.json({ models });
    } catch (error) {
      return c.json({ error: (error as Error).message }, 500);
    }
  },
});

// GET /api/work/storage — 存储信息
export const storageInfoRoute = registerApiRoute("/api/work/storage", {
  method: "GET",
  handler: async (c) => {
    return c.json({
      url: getStorageUrl(),
      directory: getStorageDirectory(),
    });
  },
});

// POST /api/work/storage/location — 更改存储位置(写入 storage-location.json,重启生效)
export const storageLocationRoute = registerApiRoute("/api/work/storage/location", {
  method: "POST",
  handler: async (c) => {
    const { directory } = (await c.req.json()) as { directory: string };
    if (!directory) {
      return c.json({ error: "directory is required" }, 400);
    }
    const normalized = directory.replace(/[\\/]+$/, "");
    await writeFile(
      join(process.cwd(), "storage-location.json"),
      JSON.stringify({ url: `file:${join(normalized, "mastra.db").replace(/\\/g, "/")}` }, null, 2),
      "utf-8",
    );
    return c.json({ ok: true, url: `file:${join(normalized, "mastra.db").replace(/\\/g, "/")}` });
  },
});

// GET /api/work/memory — 读取当前记忆配置
// POST /api/work/memory — 写入记忆配置(memory-config.json,重启生效)
export const memoryConfigRoute = registerApiRoute("/api/work/memory", {
  method: "GET",
  handler: async (c) => {
    const { getMemoryConfig } = await import("../../memory/overview");
    return c.json(getMemoryConfig());
  },
});

export const saveMemoryConfigRoute = registerApiRoute("/api/work/memory", {
  method: "POST",
  handler: async (c) => {
    const config = (await c.req.json()) as MemoryUserConfig;
    await writeFile(
      join(process.cwd(), "memory-config.json"),
      JSON.stringify(config, null, 2),
      "utf-8",
    );
    return c.json({ ok: true });
  },
});

export const workRoutes = [
  listThreadsRoute,
  createThreadRoute,
  updateThreadRoute,
  deleteThreadRoute,
  threadMessagesRoute,
  modelsCatalogRoute,
  listProviderModelsRoute,
  storageInfoRoute,
  storageLocationRoute,
  memoryConfigRoute,
  saveMemoryConfigRoute,
];
