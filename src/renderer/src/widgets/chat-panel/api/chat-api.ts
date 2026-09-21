import type { FileUIPart } from "ai";
import { apiFetch, MASTRA_SERVER_URL, requestJson } from "@/shared/api";
import { i18n } from "@/shared/i18n";
import type {
  BackgroundTaskState,
  LibraryFilePart,
  MessageFileReference,
  MessageReaction,
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
  return requestJson<{ skills?: T[] }>(
    "/work/skills",
    {},
    i18n.t("chat:api.loadSkillsFailed"),
  ).then((payload) =>
    (payload.skills ?? []).filter(
      (skill) => (skill as T & { enabled?: boolean }).enabled !== false,
    ),
  );
}

export function fetchChatLibraryAssets(resourceId: string): Promise<ChatLibraryAssetOption[]> {
  const query = resourceQuery(resourceId);
  return requestJson<{
    assets?: Array<Omit<ChatLibraryAssetOption, "url">>;
  }>(`/work/library/assets?${query}`, {}, i18n.t("chat:api.loadLibraryAssetsFailed")).then(
    (payload) =>
      (payload.assets ?? []).map((asset) => ({
        ...asset,
        url: `${MASTRA_SERVER_URL}/work/library/assets/${encodeURIComponent(asset.id)}/content?${query}`,
      })),
  );
}

export async function fetchChatAssetBlob(url: string): Promise<Blob> {
  const response = await apiFetch(url);
  if (!response.ok) throw new Error(i18n.t("chat:api.loadAttachmentFailed"));
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
  // Text-like/document uploads should remain attached to this thread while also
  // becoming discoverable in the long-term library. The server promotes only
  // formats it can actually extract and index; media keeps session-only semantics.
  form.set("promoteToLibrary", "true");
  for (const file of pending) {
    const source =
      "file" in file && file.file instanceof File ? file.file : await fetchChatAssetBlob(file.url);
    form.append("files", source, file.filename ?? i18n.t("chat:messages.untitledAttachment"));
  }
  const payload = await requestJson<{
    assets?: Array<{ id: string; filename: string; mediaType: string; byteSize: number }>;
  }>(
    "/work/library/assets",
    { method: "POST", body: form },
    i18n.t("chat:api.saveAttachmentFailed"),
  );
  if (!payload.assets) throw new Error(i18n.t("chat:api.attachmentIncomplete"));
  let uploadedIndex = 0;
  return files.map((file) => {
    if (isPersisted(file)) return file as LibraryFilePart;
    const asset = payload.assets?.[uploadedIndex++];
    if (!asset) throw new Error(i18n.t("chat:api.attachmentIncomplete"));
    return {
      type: "file",
      byteSize: asset.byteSize,
      filename: asset.filename,
      mediaType: asset.mediaType,
      url: `${MASTRA_SERVER_URL}/work/library/assets/${encodeURIComponent(asset.id)}/content?${resourceQuery(userId)}`,
    } as LibraryFilePart;
  });
}

export interface ThreadMessagesPage {
  /** 本页消息,服务端 workbenchMessages 已按时间正序返回 */
  messages: WorkUIMessage[];
  /** 是否还有更早的历史(DESC 分页:hasMore 指向更旧的页) */
  hasMore: boolean;
}

/**
 * 单页拉取线程消息(官方 message-scroller-load-history 分页模式)。
 * 服务端按 createdAt DESC 分页取页,再由 workbenchMessages 转成时间正序的 UI 数组
 * (page 0 = 最新一页,hasMore 指向更旧的页)。因此这里不能再 reverse；向上滚动
 * 加载时直接前置插入(prepend),preserveScrollOnPrepend 保持阅读位置。
 */
export function fetchThreadMessagesPage(
  threadId: string,
  resourceId: string,
  page: number,
  perPage = 50,
): Promise<ThreadMessagesPage> {
  return requestJson<{ uiMessages: WorkUIMessage[]; hasMore: boolean }>(
    `/work/threads/${encodeURIComponent(threadId)}/messages/page?${resourceQuery(resourceId)}&page=${page}&perPage=${perPage}`,
    {},
    i18n.t("chat:api.loadMessagesFailed"),
  ).then((result) => ({
    messages: result.uiMessages,
    hasMore: result.hasMore,
  }));
}

/** 切换消息表情反应(服务端持久化到消息 metadata.reactions) */
export async function toggleThreadMessageReaction(
  threadId: string,
  resourceId: string,
  messageId: string,
  emoji: string,
): Promise<{ reactions: MessageReaction[] }> {
  const payload = await requestJson<{ reactions?: MessageReaction[] }>(
    `/work/threads/${encodeURIComponent(threadId)}/messages/${encodeURIComponent(messageId)}/reactions`,
    { method: "POST", body: { resourceId, emoji } },
    i18n.t("chat:api.saveReactionFailed"),
  );
  return { reactions: payload.reactions ?? [] };
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
    i18n.t("chat:api.loadSessionStateFailed"),
  );
}

export async function abortThread(threadId: string, resourceId: string): Promise<void> {
  await requestJson(
    `/work/sessions/workbench/threads/${encodeURIComponent(threadId)}/abort?${resourceQuery(resourceId)}`,
    { method: "POST" },
    i18n.t("chat:api.stopTaskFailed"),
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
    i18n.t("chat:api.grantPermissionFailed"),
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
    i18n.t("chat:api.queueNotAccepted"),
  );
  if (!payload.queued) throw new Error(i18n.t("chat:api.queueNotAccepted"));
  return { queued: true };
}
