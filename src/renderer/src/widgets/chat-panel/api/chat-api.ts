import type { FileUIPart } from "ai";
import { apiFetch, MASTRA_SERVER_URL, requestJson } from "@/shared/api";
import { i18n } from "@/shared/i18n";
import { apiError, readErrorPayload } from "@/shared/lib";
import type { PromptAttachment } from "@/shared/ui/ai-elements/prompt-input";
import type {
  BackgroundTaskState,
  LibraryFilePart,
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
    "/work/plugins/skills",
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
  if (!response.ok)
    throw Object.assign(new Error(i18n.t("chat:api.loadAttachmentFailed")), {
      status: response.status,
    });
  return response.blob();
}

export const chatAssetId = (url: string) => {
  const parsed = new URL(url, MASTRA_SERVER_URL);
  if (parsed.origin !== new URL(MASTRA_SERVER_URL).origin) return null;
  return parsed.pathname.match(/^\/work\/library\/assets\/([^/]+)\/content$/)?.[1] ?? null;
};

/** Each chip starts immediately; only transport/temporary HTTP errors retry once. */
export async function uploadChatAttachment(
  file: PromptAttachment,
  userId: string,
  draftId: string,
  signal: AbortSignal,
): Promise<LibraryFilePart & { draftId: string; localPath?: string }> {
  const assetId = !file.localPath ? chatAssetId(file.url) : null;
  let body: FormData | { path: string; draftId: string } | { draftId: string };
  if (assetId) body = { draftId };
  else if (file.localPath) body = { path: file.localPath, draftId };
  else {
    const source = file.file ?? (await fetchChatAssetBlob(file.url));
    const form = new FormData();
    form.set("draftId", draftId);
    form.append("files", source, file.filename ?? i18n.t("chat:messages.untitledAttachment"));
    body = form;
  }
  const endpoint = assetId
    ? `/work/library/assets/${assetId}/reference`
    : file.localPath
      ? "/work/library/local"
      : "/work/library/assets";
  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      response = await apiFetch(endpoint, {
        method: "POST",
        body,
        signal,
      });
    } catch (error) {
      if (attempt === 0 && error instanceof TypeError && !signal.aborted) continue;
      throw error;
    }
    if (!response.ok) {
      if (attempt === 0 && [408, 429, 500, 502, 503, 504].includes(response.status)) {
        await response.body?.cancel();
        continue;
      }
      throw apiError(
        await readErrorPayload(response, i18n.t("chat:api.saveAttachmentFailed")),
        i18n.t("chat:api.saveAttachmentFailed"),
      );
    }
    type UploadedAsset = {
      id: string;
      filename: string;
      mediaType: string;
      byteSize: number;
      localPath?: string | null;
    };
    const payload = (await response.json()) as { assets?: UploadedAsset[]; asset?: UploadedAsset };
    const asset = assetId ? payload.asset : payload.assets?.[0];
    if (!asset) throw new Error(i18n.t("chat:api.attachmentIncomplete"));
    return {
      type: "file",
      draftId,
      localPath: asset.localPath ?? undefined,
      byteSize: asset.byteSize,
      filename: asset.filename,
      mediaType: asset.mediaType,
      url: `${MASTRA_SERVER_URL}/work/library/assets/${encodeURIComponent(asset.id)}/content?${resourceQuery(userId)}`,
    };
  }
}

/** Sending binds ready assets to the destination thread; bytes have already been uploaded. */
export async function referenceChatAttachments(
  files: FileUIPart[],
  threadId: string,
): Promise<LibraryFilePart[]> {
  for (const file of files) {
    const assetId = chatAssetId(file.url);
    if (!assetId) throw new Error(i18n.t("chat:prompt.attachmentsNotReady"));
    await requestJson(`/work/library/assets/${assetId}/reference`, {
      method: "POST",
      body: {
        threadId,
        ...("draftId" in file && typeof file.draftId === "string" ? { draftId: file.draftId } : {}),
      },
    });
  }
  return files.map(({ type, url, mediaType, filename, ...file }) => ({
    type,
    url,
    mediaType,
    filename,
    ...("byteSize" in file && typeof file.byteSize === "number" ? { byteSize: file.byteSize } : {}),
  }));
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
