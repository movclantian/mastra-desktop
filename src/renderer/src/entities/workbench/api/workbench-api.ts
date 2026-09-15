import { toast } from "sonner";
import { apiFetch, MASTRA_SERVER_URL, requestJson } from "@/shared/api";
import { toastError } from "@/shared/lib";
import type { ProviderConfig } from "../model/providers";
import type {
  AgentProfile,
  MessageSearchHit,
  ModelSelection,
  RecentWorkspace,
  ToolsConfig,
  TreeEntry,
  WorkspaceChangeSnapshot,
  WorkspaceFileChange,
  WorkThread,
} from "../model/types";

function resourceQuery(resourceId: string): string {
  return `resourceId=${encodeURIComponent(resourceId)}`;
}

// ---- Threads API -------------------------------------------------------------

const MEMORY_AGENT_ID = "mastra-work-agent";

type MemoryThread = Omit<WorkThread, "title" | "metadata"> & {
  title?: string;
  metadata?: WorkThread["metadata"] | null;
};
function workThread(thread: MemoryThread): WorkThread {
  return { ...thread, title: thread.title?.trim() || "New Chat", metadata: thread.metadata ?? {} };
}

export async function fetchThreads(resourceId: string): Promise<WorkThread[]> {
  const threads: WorkThread[] = [];
  for (let page = 0; ; page += 1) {
    const payload = await requestJson<{ threads: MemoryThread[]; hasMore: boolean }>(
      `/api/memory/threads?${resourceQuery(resourceId)}&agentId=${MEMORY_AGENT_ID}&page=${page}&perPage=100`,
      {},
      "加载任务列表失败",
    );
    threads.push(...payload.threads.map(workThread));
    if (!payload.hasMore) return threads;
  }
}

export async function createThreadRequest(
  resourceId: string,
  body: Record<string, unknown>,
): Promise<WorkThread> {
  if ((body.metadata as { draft?: boolean } | undefined)?.draft) {
    const drafts = (await fetchThreads(resourceId)).filter(
      (thread) => thread.metadata.draft && !thread.metadata.archivedAt,
    );
    for (const draft of drafts) {
      const history = await requestJson<{ messages: unknown[] }>(
        `/api/memory/threads/${encodeURIComponent(draft.id)}/messages?agentId=${MEMORY_AGENT_ID}&${resourceQuery(resourceId)}&perPage=1`,
        {},
        "读取草稿失败",
      );
      if (history.messages.length === 0) return draft;
    }
  }
  return workThread(
    await requestJson<MemoryThread>(
      `/api/memory/threads?agentId=${MEMORY_AGENT_ID}`,
      { method: "POST", body: { ...body, resourceId } },
      "创建任务失败",
    ),
  );
}

export async function updateThread(
  threadId: string,
  resourceId: string,
  body: Record<string, unknown>,
): Promise<void> {
  const path = `/api/memory/threads/${encodeURIComponent(threadId)}?agentId=${MEMORY_AGENT_ID}&${resourceQuery(resourceId)}`;
  const current = await requestJson<MemoryThread>(path, {}, "读取任务失败");
  await requestJson(
    path,
    {
      method: "PATCH",
      body: {
        ...body,
        resourceId,
        ...(body.metadata
          ? { metadata: { ...current.metadata, ...(body.metadata as Record<string, unknown>) } }
          : {}),
      },
    },
    "更新任务失败",
  );
}

export async function deleteThreadRequest(threadId: string, resourceId: string): Promise<void> {
  await requestJson(
    `/api/memory/threads/${encodeURIComponent(threadId)}?agentId=${MEMORY_AGENT_ID}&${resourceQuery(resourceId)}`,
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
    { method: "POST", body: { resourceId } },
    "生成任务标题失败",
  );
  return typeof payload.title === "string" ? payload.title : null;
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

// ---- Providers & Tools API ---------------------------------------------------

export async function fetchProviderConfig(): Promise<{
  providers: ProviderConfig[];
  modelSelection: ModelSelection | null;
}> {
  const payload = await requestJson<{
    providers?: ProviderConfig[];
    modelSelection?: ModelSelection | null;
  }>("/work/providers/config", {}, "加载模型供应商配置失败");
  return { providers: payload.providers ?? [], modelSelection: payload.modelSelection ?? null };
}

export async function saveProviderConfig(config: {
  providers?: ProviderConfig[];
  modelSelection?: ModelSelection | null;
}): Promise<void> {
  await requestJson(
    "/work/providers/config",
    { method: "POST", body: config },
    "保存模型供应商配置失败",
  );
}

export async function fetchToolsConfig(): Promise<ToolsConfig> {
  return requestJson<ToolsConfig>("/work/tools", {}, "加载工具配置失败");
}

// ---- Agents API --------------------------------------------------------------

export async function fetchAgents(): Promise<AgentProfile[]> {
  const payload = await requestJson<{ agents?: AgentProfile[] }>(
    "/work/agents",
    {},
    "加载专家失败",
  );
  return Array.isArray(payload.agents) ? payload.agents : [];
}

export interface AgentAssistDraft {
  displayName?: unknown;
  profession?: unknown;
  description?: unknown;
  instructions?: unknown;
  members?: unknown;
  workflow?: { strategy?: unknown; steps?: unknown };
}

export async function generateAgentAssist(
  type: "agent" | "team",
  description: string,
): Promise<AgentAssistDraft> {
  const payload = await requestJson<{ draft: AgentAssistDraft }>(
    "/work/agents/assist",
    {
      method: "POST",
      body: { type, description },
    },
    "AI 创建失败",
  );
  return payload.draft;
}

export async function saveAgent(payload: Record<string, unknown>): Promise<AgentProfile | null> {
  const result = await requestJson<{ agent?: AgentProfile }>(
    "/work/agents",
    { method: "POST", body: payload },
    "保存 Agent 失败",
  );
  return result.agent ?? null;
}

export async function deleteAgent(id: string): Promise<void> {
  await requestJson<void>(
    `/work/agents/${encodeURIComponent(id)}`,
    { method: "DELETE" },
    "删除 Agent 失败",
  );
}

// ---- Workspace API -----------------------------------------------------------

export async function fetchRecentWorkspaces(): Promise<RecentWorkspace[]> {
  const payload = await requestJson<{ recent?: RecentWorkspace[] }>(
    "/work/workspace/recent",
    {},
    "加载最近工作区失败",
  );
  return Array.isArray(payload.recent) ? payload.recent : [];
}

export async function fetchTree(
  threadId: string,
  resourceId: string,
  path = "",
): Promise<TreeEntry[]> {
  const query = new URLSearchParams({ resourceId });
  if (path) query.set("path", path);
  const payload = await requestJson<{ entries?: TreeEntry[] }>(
    `/work/threads/${encodeURIComponent(threadId)}/tree?${query}`,
    {},
    "加载工作区文件树失败",
  );
  return Array.isArray(payload.entries) ? payload.entries : [];
}

export async function fetchChanges(
  threadId: string,
  resourceId: string,
): Promise<WorkspaceFileChange[]> {
  const payload = await requestJson<{ changes?: WorkspaceFileChange[] }>(
    `/work/threads/${encodeURIComponent(threadId)}/changes?${resourceQuery(resourceId)}`,
    {},
    "加载工作区变更失败",
  );
  return Array.isArray(payload.changes) ? payload.changes : [];
}

export async function fetchChangeContent(
  threadId: string,
  changeId: string,
  resourceId: string,
  side: "before" | "after",
): Promise<{ content: string; binary: boolean; metadata: WorkspaceChangeSnapshot } | null> {
  const params = new URLSearchParams({ resourceId, side });
  const response = await apiFetch(
    `/work/threads/${encodeURIComponent(threadId)}/changes/${encodeURIComponent(changeId)}/content?${params}`,
  );
  if (response.status === 404) return null;
  if (!response.ok) throw new Error("加载工作区变更内容失败");
  return (await response.json()) as {
    content: string;
    binary: boolean;
    metadata: WorkspaceChangeSnapshot;
  };
}

export interface WorkspaceFileResponse {
  path: string;
  name: string;
  content: string;
  isBinary?: boolean;
  mimeType?: string;
  size: number;
  modifiedAt?: string;
}

export async function fetchWorkspaceFile(
  threadId: string,
  resourceId: string,
  path: string,
): Promise<WorkspaceFileResponse> {
  const payload = await requestJson<WorkspaceFileResponse & { error?: string }>(
    `/work/threads/${encodeURIComponent(threadId)}/file?${new URLSearchParams({ resourceId, path })}`,
    {},
    "文件读取失败",
  );
  return payload;
}

export function workspaceRawFileUrl(threadId: string, resourceId: string, path: string): string {
  return `${MASTRA_SERVER_URL}/work/threads/${encodeURIComponent(threadId)}/raw?${new URLSearchParams({ resourceId, path })}`;
}

export async function createWorkspaceEntry(
  threadId: string,
  resourceId: string,
  path: string,
  type: "file" | "dir",
): Promise<void> {
  await requestJson(
    `/work/threads/${encodeURIComponent(threadId)}/tree?${new URLSearchParams({ resourceId })}`,
    { method: "POST", body: { path, type } },
    type === "dir" ? "新建文件夹失败" : "添加文件失败",
  );
}

export async function saveWorkspaceFile(
  threadId: string,
  resourceId: string,
  path: string,
  content: string,
): Promise<void> {
  await requestJson(
    `/work/threads/${encodeURIComponent(threadId)}/file?${new URLSearchParams({ resourceId, path })}`,
    { method: "PUT", body: { content } },
    "保存失败",
  );
}

export async function openPathInApp(
  appId: string,
  targetPath: string,
  appName: string,
): Promise<void> {
  try {
    if (window.api?.workspace?.openInApp) {
      const result = await window.api.workspace.openInApp(appId, targetPath);
      if (result && !result.ok && result.error) {
        throw new Error(result.error);
      }
    } else {
      const response = await apiFetch(`${MASTRA_SERVER_URL}/work/workspace/open-in`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ app: appId, path: targetPath }),
      });
      if (!response.ok) {
        const payload = (await response.json()) as { error?: string; message?: string };
        throw new Error(payload.error || payload.message || "启动应用失败");
      }
    }
    toast.success(`已在 ${appName} 中打开工作区`);
  } catch (error) {
    toastError(error, `在 ${appName} 中打开失败`);
  }
}
