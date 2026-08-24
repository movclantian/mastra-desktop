import { apiFetch } from "@/api/client";

interface EditorModelSelection {
  providerId: string;
  modelId: string;
}

export interface InlineCompletionRequest {
  threadId: string;
  resourceId: string;
  path: string;
  language: string;
  prefix: string;
  beforeContext: string;
  afterContext: string;
  modelSelection?: EditorModelSelection;
  signal?: AbortSignal;
}

export async function fetchInlineCompletion({
  threadId,
  resourceId,
  signal,
  ...body
}: InlineCompletionRequest): Promise<{ text?: unknown } | null> {
  const response = await apiFetch(
    `/work/threads/${encodeURIComponent(threadId)}/inline-completion?resourceId=${encodeURIComponent(resourceId)}`,
    { method: "POST", body, signal },
  );
  if (!response.ok) return null;
  return (await response.json().catch(() => null)) as { text?: unknown } | null;
}

export interface InlineEditRequest {
  threadId: string;
  resourceId: string;
  path: string;
  language: string;
  selectedText: string;
  beforeContext: string;
  afterContext: string;
  instruction: string;
  modelSelection?: EditorModelSelection;
  signal?: AbortSignal;
}

export async function requestInlineEdit({
  threadId,
  resourceId,
  signal,
  ...body
}: InlineEditRequest): Promise<{ text?: unknown; error?: unknown }> {
  const response = await apiFetch(
    `/work/threads/${encodeURIComponent(threadId)}/inline-edit?resourceId=${encodeURIComponent(resourceId)}`,
    { method: "POST", body, signal },
  );
  const payload = (await response.json().catch(() => null)) as {
    text?: unknown;
    error?: unknown;
  } | null;
  if (!response.ok) {
    throw new Error(typeof payload?.error === "string" ? payload.error : "内联修改请求失败");
  }
  return payload ?? {};
}
