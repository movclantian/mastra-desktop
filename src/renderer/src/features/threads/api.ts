import { requestJson } from "@/api/client";
import type { MessageSearchHit, ModelSelection, WorkThread } from "@/features/workbench/types";

const MEMORY_AGENT_ID = "mastra-work-agent";

function resourceQuery(resourceId: string): string {
  return `resourceId=${encodeURIComponent(resourceId)}`;
}

export async function fetchThreads(resourceId: string): Promise<WorkThread[]> {
  const payload = await requestJson<{ threads?: WorkThread[] }>(
    `/work/threads?${resourceQuery(resourceId)}`,
    {},
    "加载任务列表失败",
  );
  return Array.isArray(payload.threads) ? payload.threads : [];
}

export async function createThreadRequest(
  resourceId: string,
  body: Record<string, unknown>,
): Promise<WorkThread> {
  const payload = await requestJson<{ thread?: WorkThread }>(
    "/work/threads",
    { method: "POST", body: { ...body, resourceId } },
    "创建任务失败",
  );
  if (!payload.thread) throw new Error("创建任务失败：服务端未返回任务");
  return payload.thread;
}

export async function updateThread(
  threadId: string,
  resourceId: string,
  body: Record<string, unknown>,
): Promise<void> {
  await requestJson(
    `/work/threads/${encodeURIComponent(threadId)}?${resourceQuery(resourceId)}`,
    { method: "PATCH", body },
    "更新任务失败",
  );
}

export async function deleteThreadRequest(threadId: string, resourceId: string): Promise<void> {
  await requestJson(
    `/work/threads/${encodeURIComponent(threadId)}?${resourceQuery(resourceId)}`,
    { method: "DELETE" },
    "删除任务失败",
  );
}

export async function updateThreadModel(
  threadId: string,
  resourceId: string,
  modeId: string,
  selection: ModelSelection | null,
): Promise<void> {
  await requestJson(
    `/work/sessions/workbench/threads/${encodeURIComponent(threadId)}/model?${resourceQuery(resourceId)}`,
    { method: "PATCH", body: { selection, modeId } },
    "保存模型选择失败",
  );
}

export async function updateThreadMode(
  threadId: string,
  resourceId: string,
  modeId: string,
): Promise<void> {
  await requestJson(
    `/work/sessions/workbench/threads/${encodeURIComponent(threadId)}/mode?${resourceQuery(resourceId)}`,
    { method: "PATCH", body: { modeId } },
    "保存会话模式失败",
  );
}

export async function updateThreadPermissions(
  threadId: string,
  resourceId: string,
  rules: {
    categories: Partial<Record<string, string>>;
    tools: Partial<Record<string, string>>;
  },
): Promise<void> {
  await requestJson(
    `/work/sessions/workbench/threads/${encodeURIComponent(threadId)}/permissions?${resourceQuery(resourceId)}`,
    { method: "PATCH", body: rules },
    "保存工具审批规则失败",
  );
}

export async function generateThreadTitle(
  threadId: string,
  resourceId: string,
): Promise<string | null> {
  const payload = await requestJson<{ title?: string }>(
    `/work/threads/${encodeURIComponent(threadId)}/generate-title`,
    { method: "POST", body: { resourceId, force: true } },
    "生成任务标题失败",
  );
  return typeof payload.title === "string" ? payload.title : null;
}

export async function cloneThreadRequest(
  threadId: string,
  resourceId: string,
  selection?: { messageIds?: string[] },
): Promise<WorkThread | null> {
  const payload = await requestJson<{ thread?: WorkThread }>(
    `/work/threads/${encodeURIComponent(threadId)}/clone`,
    {
      method: "POST",
      body: {
        resourceId,
        ...(selection?.messageIds
          ? { options: { messageFilter: { messageIds: selection.messageIds } } }
          : {}),
      },
    },
    "复制任务失败",
  );
  return payload.thread ?? null;
}

export async function searchMemory(resourceId: string, query: string): Promise<MessageSearchHit[]> {
  const params = new URLSearchParams({
    agentId: MEMORY_AGENT_ID,
    resourceId,
    searchQuery: query,
    limit: "20",
  });
  const payload = await requestJson<{
    results?: Array<{
      id?: string;
      threadId?: string;
      threadTitle?: string;
      role?: string;
      content?: string;
      createdAt?: string;
    }>;
    searchType?: string;
  }>(`/api/memory/search?${params.toString()}`, {}, "搜索历史消息失败");
  const semantic = payload.searchType === "semantic";
  return (payload.results ?? []).flatMap((result) => {
    if (
      typeof result.id !== "string" ||
      typeof result.threadId !== "string" ||
      typeof result.content !== "string" ||
      typeof result.createdAt !== "string"
    ) {
      return [];
    }
    return [
      {
        threadId: result.threadId,
        threadTitle: result.threadTitle || result.threadId,
        messageId: result.id,
        role: result.role || "assistant",
        text: result.content,
        createdAt: result.createdAt,
        semantic,
      },
    ];
  });
}
