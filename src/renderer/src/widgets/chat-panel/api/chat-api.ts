import type { FileUIPart } from "ai";
import { apiFetch, MASTRA_SERVER_URL, requestJson } from "@/shared/api";
import type {
  BackgroundTaskState,
  LibraryFilePart,
  MessageFileReference,
  WorkDisplayState,
  WorkUIMessage,
} from "../model/types";

function resourceQuery(resourceId: string): string {
  return `resourceId=${encodeURIComponent(resourceId)}`;
}

export interface ChatLibraryAssetOption {
  id: string;
  filename: string;
  mediaType: string;
  byteSize: number;
  url: string;
}

export function fetchChatSkills<T>(): Promise<T[]> {
  return requestJson<{ skills?: T[] }>("/work/skills", {}, "加载技能失败").then(
    (payload) => payload.skills ?? [],
  );
}

export function fetchChatLibraryAssets(resourceId: string): Promise<ChatLibraryAssetOption[]> {
  const query = resourceQuery(resourceId);
  return requestJson<{
    assets?: Array<Omit<ChatLibraryAssetOption, "url">>;
  }>(`/work/library/assets?${query}`, {}, "加载资料库文件失败").then((payload) =>
    (payload.assets ?? []).map((asset) => ({
      ...asset,
      url: `${MASTRA_SERVER_URL}/work/library/assets/${encodeURIComponent(asset.id)}/content?${query}`,
    })),
  );
}

export async function fetchChatAssetBlob(url: string): Promise<Blob> {
  const response = await apiFetch(url);
  if (!response.ok) throw new Error("附件加载失败");
  return response.blob();
}

export async function uploadChatAttachments(
  files: FileUIPart[],
  userId: string,
  threadId: string,
): Promise<LibraryFilePart[]> {
  const isPersisted = (file: FileUIPart) =>
    /\/work\/library\/assets\/[^/]+\/content/.test(file.url);
  const pending = files.filter((file) => !isPersisted(file));
  if (pending.length === 0) return files as LibraryFilePart[];
  const form = new FormData();
  form.set("resourceId", userId);
  form.set("threadId", threadId);
  for (const file of pending) {
    const source =
      "file" in file && file.file instanceof File ? file.file : await fetchChatAssetBlob(file.url);
    form.append("files", source, file.filename ?? "未命名附件");
  }
  const payload = await requestJson<{
    assets?: Array<{ id: string; filename: string; mediaType: string; byteSize: number }>;
  }>("/work/library/assets", { method: "POST", body: form }, "附件保存失败");
  if (!payload.assets) throw new Error("附件上传结果不完整");
  let uploadedIndex = 0;
  return files.map((file) => {
    if (isPersisted(file)) return file as LibraryFilePart;
    const asset = payload.assets?.[uploadedIndex++];
    if (!asset) throw new Error("附件上传结果不完整");
    return {
      type: "file",
      byteSize: asset.byteSize,
      filename: asset.filename,
      mediaType: asset.mediaType,
      url: `${MASTRA_SERVER_URL}/work/library/assets/${encodeURIComponent(asset.id)}/content?${resourceQuery(userId)}`,
    } as LibraryFilePart;
  });
}

export async function fetchThreadMessages(
  threadId: string,
  resourceId: string,
): Promise<{ messages: WorkUIMessage[] }> {
  const messages: WorkUIMessage[] = [];
  const orderBy = encodeURIComponent(JSON.stringify({ field: "createdAt", direction: "ASC" }));
  for (let page = 0; ; page += 1) {
    const result = await requestJson<{ uiMessages: WorkUIMessage[]; hasMore: boolean }>(
      `/api/memory/threads/${encodeURIComponent(threadId)}/messages?${resourceQuery(resourceId)}&agentId=mastra-work-agent&page=${page}&perPage=100&orderBy=${orderBy}`,
      {},
      "加载消息失败",
    );
    messages.push(...result.uiMessages);
    if (!result.hasMore) return { messages };
  }
}

export type DisplayStatePayload = Omit<WorkDisplayState, "suspendedRuns"> & {
  suspendedRuns?: unknown;
  backgroundTasks?: BackgroundTaskState[];
  workflowRuns?: WorkDisplayState["workflowRuns"];
};

export async function fetchDisplayState(
  threadId: string,
  resourceId: string,
): Promise<{ displayState?: DisplayStatePayload }> {
  return requestJson(
    `/work/sessions/workbench/threads/${encodeURIComponent(threadId)}/display-state?${resourceQuery(resourceId)}`,
    {},
    "加载会话状态失败",
  );
}

export async function abortThread(threadId: string, resourceId: string): Promise<void> {
  await requestJson(
    `/work/sessions/workbench/threads/${encodeURIComponent(threadId)}/abort?${resourceQuery(resourceId)}`,
    { method: "POST" },
    "停止任务失败",
  );
}

export async function runWorkflowAction(
  threadId: string,
  resourceId: string,
  workflowId: string,
  runId: string,
  action: string,
  resumeData?: unknown,
): Promise<Response> {
  const endpoint = `${[
    MASTRA_SERVER_URL,
    "work/sessions/workbench/threads",
    encodeURIComponent(threadId),
    "workflows",
    encodeURIComponent(workflowId),
    "runs",
    encodeURIComponent(runId),
    action,
  ].join("/")}?${resourceQuery(resourceId)}`;
  return apiFetch(endpoint, {
    method: "POST",
    ...(action === "resume" ? { body: { resumeData } } : {}),
  });
}

export async function runBackgroundTaskAction(
  taskId: string,
  action: string,
  resumeData?: unknown,
): Promise<Response> {
  return apiFetch(`/work/background-tasks/${encodeURIComponent(taskId)}/${action}`, {
    method: "POST",
    ...(action === "resume" ? { body: { resumeData } } : {}),
  });
}

export async function grantToolCategory(
  threadId: string,
  resourceId: string,
  category: string,
): Promise<void> {
  await requestJson(
    `/work/sessions/workbench/threads/${encodeURIComponent(threadId)}/grants?${resourceQuery(resourceId)}`,
    { method: "POST", body: { category } },
    "无法授予当前会话权限",
  );
}

export async function enqueueFollowUp(
  threadId: string,
  resourceId: string,
  body: {
    content: string;
    model?: unknown;
    reasoningEffort?: unknown;
    webSearch?: unknown;
    agentProfileId: string;
    metadata: { skillNames: string[]; fileReferences: MessageFileReference[] };
  },
): Promise<{ queued: true }> {
  const payload = await requestJson<{ queued?: boolean }>(
    `/work/sessions/workbench/threads/${encodeURIComponent(threadId)}/follow-up?${resourceQuery(resourceId)}`,
    { method: "POST", body },
    "排队消息未被 Agent 接受",
  );
  if (!payload.queued) throw new Error("排队消息未被 Agent 接受");
  return { queued: true };
}
