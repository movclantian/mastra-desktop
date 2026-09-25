import { toast } from "sonner";
import { apiFetch, MASTRA_SERVER_URL, requestJson } from "@/shared/api";
import { i18n } from "@/shared/i18n";
import { toastError } from "@/shared/lib";
import type { WorkspaceApp } from "../../../../../shared/workspace-contract";
import type { ProviderConfig } from "../model/providers";
import type {
  AgentProfile,
  MessageSearchHit,
  ModelSelection,
  RecentWorkspace,
  ToolsConfig,
  TreeEntry,
  ThreadTransferHistoryItem,
  ThreadTransferStatus,
  WorkspaceChangeSnapshot,
  WorkspaceFileChange,
  WorkThread,
  WorkUserOption,
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
      i18n.t("sidebar:fetchThreadsFailed"),
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
        i18n.t("sidebar:readDraftFailed"),
      );
      if (history.messages.length === 0) return draft;
    }
  }
  return workThread(
    await requestJson<MemoryThread>(
      `/api/memory/threads?agentId=${MEMORY_AGENT_ID}`,
      { method: "POST", body: { ...body, resourceId } },
      i18n.t("sidebar:createThreadFailed"),
    ),
  );
}

export async function updateThread(
  threadId: string,
  resourceId: string,
  body: Record<string, unknown>,
): Promise<void> {
  const path = `/api/memory/threads/${encodeURIComponent(threadId)}?agentId=${MEMORY_AGENT_ID}&${resourceQuery(resourceId)}`;
  const current = await requestJson<MemoryThread>(path, {}, i18n.t("sidebar:readThreadFailed"));
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
    i18n.t("sidebar:updateThreadFailed"),
  );
}

export async function deleteThreadRequest(threadId: string, resourceId: string): Promise<void> {
  await requestJson(
    `/api/memory/threads/${encodeURIComponent(threadId)}?agentId=${MEMORY_AGENT_ID}&${resourceQuery(resourceId)}`,
    { method: "DELETE" },
    i18n.t("sidebar:deleteThreadFailed"),
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
    i18n.t("sidebar:saveModelFailed"),
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
    i18n.t("sidebar:saveModeFailed"),
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
    i18n.t("sidebar:savePermissionsFailed"),
  );
}

export async function generateThreadTitle(
  threadId: string,
  resourceId: string,
): Promise<string | null> {
  const payload = await requestJson<{ title?: string }>(
    `/work/threads/${encodeURIComponent(threadId)}/generate-title`,
    { method: "POST", body: { resourceId } },
    i18n.t("sidebar:generateTitleFailed"),
  );
  return typeof payload.title === "string" ? payload.title : null;
}

/** 克隆/分叉会话(官方 memory.copyThread):带 upToMessageId 时仅复制截至该消息(含)的历史 */
export async function cloneThreadRequest(
  threadId: string,
  resourceId: string,
  options?: { upToMessageId?: string },
): Promise<WorkThread> {
  const payload = await requestJson<{ thread: MemoryThread }>(
    `/work/threads/${encodeURIComponent(threadId)}/clone`,
    {
      method: "POST",
      body: {
        resourceId,
        ...(options?.upToMessageId ? { upToMessageId: options.upToMessageId } : {}),
      },
    },
    i18n.t("sidebar:cloneFailed"),
  );
  return workThread(payload.thread);
}

/** 分支会话的来源线程(官方 isClone / getSourceThread),非分支或来源已删除返回 null */
export async function fetchThreadSource(
  threadId: string,
  resourceId: string,
): Promise<{ id: string; title: string } | null> {
  const payload = await requestJson<{ source?: { id?: string; title?: string } | null }>(
    `/work/threads/${encodeURIComponent(threadId)}/source?${resourceQuery(resourceId)}`,
    {},
    i18n.t("sidebar:readSourceFailed"),
  );
  const source = payload.source;
  return typeof source?.id === "string" && typeof source.title === "string"
    ? { id: source.id, title: source.title }
    : null;
}

export interface ThreadSummaryResult {
  summary: string;
  todos: string[];
  usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | null;
}

/** 生成本次对话纪要与核心待办(官方 memory.summarizeThread + Extractor) */
export async function summarizeThreadRequest(
  threadId: string,
  resourceId: string,
  model?: unknown,
): Promise<ThreadSummaryResult> {
  return requestJson<ThreadSummaryResult>(
    `/work/threads/${encodeURIComponent(threadId)}/summarize`,
    { method: "POST", body: { resourceId, ...(model !== undefined ? { model } : {}) } },
    i18n.t("sidebar:summarizeThreadFailed"),
  );
}

/** 会话所有权迁移(官方 memory.updateThreadResourceId):线程及全部消息转移给目标账户 */
export async function transferThreadRequest(
  threadId: string,
  targetResourceId: string,
): Promise<{ id: string; status: ThreadTransferStatus }> {
  const payload = await requestJson<{
    transfer: { id: string; status: ThreadTransferStatus };
  }>(
    `/work/threads/${encodeURIComponent(threadId)}/transfer`,
    { method: "POST", body: { targetResourceId } },
    i18n.t("sidebar:transferThreadFailed"),
  );
  return payload.transfer;
}

/** 注册账户列表(会话迁移目标候选) */
export async function fetchWorkUsers(): Promise<WorkUserOption[]> {
  const payload = await requestJson<{ users?: WorkUserOption[] }>(
    "/work/users",
    {},
    i18n.t("sidebar:loadAccountsFailed"),
  );
  return Array.isArray(payload.users) ? payload.users : [];
}

export async function fetchThreadTransferHistory(): Promise<ThreadTransferHistoryItem[]> {
  const payload = await requestJson<{ transfers?: ThreadTransferHistoryItem[] }>(
    "/work/thread-transfers",
    {},
    i18n.t("sidebar:transferHistoryFailed"),
  );
  return Array.isArray(payload.transfers) ? payload.transfers : [];
}

export async function decideThreadTransferRequest(
  transferId: string,
  decision: "accept" | "reject",
): Promise<{ status: string; threadId?: string }> {
  return requestJson(
    `/work/thread-transfers/${encodeURIComponent(transferId)}/decision`,
    { method: "POST", body: { decision } },
    i18n.t("sidebar:transferDecisionFailed"),
  );
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
  }>(`/work/threads/search?${params.toString()}`, {}, i18n.t("sidebar:searchMessagesFailed"));
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
  }>("/work/providers/config", {}, i18n.t("settings:api.fetchProvidersFailed"));
  return { providers: payload.providers ?? [], modelSelection: payload.modelSelection ?? null };
}

export async function saveProviderConfig(config: {
  providers?: ProviderConfig[];
  modelSelection?: ModelSelection | null;
}): Promise<void> {
  await requestJson(
    "/work/providers/config",
    { method: "POST", body: config },
    i18n.t("settings:api.saveProvidersFailed"),
  );
}

export async function fetchToolsConfig(): Promise<ToolsConfig> {
  return requestJson<ToolsConfig>("/work/tools", {}, i18n.t("settings:api.fetchToolsFailed"));
}

// ---- Agents API --------------------------------------------------------------

export async function fetchAgents(): Promise<AgentProfile[]> {
  const payload = await requestJson<{ agents?: AgentProfile[] }>(
    "/work/agents",
    {},
    i18n.t("agentHub:fetchAgentsFailed"),
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
    i18n.t("agentHub:aiCreateFailed"),
  );
  return payload.draft;
}

export async function saveAgent(payload: Record<string, unknown>): Promise<AgentProfile | null> {
  const result = await requestJson<{ agent?: AgentProfile }>(
    "/work/agents",
    { method: "POST", body: payload },
    i18n.t("agentHub:saveFailed"),
  );
  return result.agent ?? null;
}

export async function deleteAgent(id: string): Promise<void> {
  await requestJson<void>(
    `/work/agents/${encodeURIComponent(id)}`,
    { method: "DELETE" },
    i18n.t("agentHub:deleteFailed"),
  );
}

// ---- Workspace API -----------------------------------------------------------

export async function fetchRecentWorkspaces(): Promise<RecentWorkspace[]> {
  const payload = await requestJson<{ recent?: RecentWorkspace[] }>(
    "/work/workspace/recent",
    {},
    i18n.t("workspace:fetchRecentWorkspacesFailed"),
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
    i18n.t("workspace:fetchTreeFailed"),
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
    i18n.t("workspace:fetchChangesFailed"),
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
  if (!response.ok) throw new Error(i18n.t("workspace:fetchDiffFailed"));
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
    i18n.t("workspace:readFileFailed"),
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
    type === "dir" ? i18n.t("workspace:createDirFailed") : i18n.t("workspace:createFileFailed"),
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
    i18n.t("workspace:saveFailed"),
  );
}

export async function openPathInApp(
  appId: WorkspaceApp,
  targetPath: string,
  appName: string,
): Promise<void> {
  try {
    const result = await window.api.workspace.openInApp(appId, targetPath);
    if (!result.ok && result.error) {
      throw new Error(result.error);
    }
    toast.success(i18n.t("workspace:openedToast", { name: appName }));
  } catch (error) {
    toastError(error, i18n.t("workspace:openFailedToast", { name: appName }));
  }
}
