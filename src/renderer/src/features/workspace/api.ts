import { apiFetch, MASTRA_SERVER_URL, requestJson } from "@/api/client";
import type {
  RecentWorkspace,
  TreeEntry,
  WorkspaceChangeSnapshot,
  WorkspaceFileChange,
} from "@/features/workbench/types";

function resourceQuery(resourceId: string): string {
  return `resourceId=${encodeURIComponent(resourceId)}`;
}

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
