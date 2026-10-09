import { apiFetch, requestJson } from "@/shared/api";

export interface InlineCompletionRequest {
  threadId: string;
  resourceId: string;
  path: string;
  language: string;
  prefix: string;
  beforeContext: string;
  afterContext: string;
  signal?: AbortSignal;
}

export async function fetchInlineCompletion({
  threadId,
  resourceId,
  signal,
  ...body
}: InlineCompletionRequest): Promise<{ text?: unknown } | null> {
  const response = await apiFetch(
    `/work/workspace/threads/${encodeURIComponent(threadId)}/inline-completion?resourceId=${encodeURIComponent(resourceId)}`,
    { method: "POST", body: { ...body, resourceId }, signal },
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
  signal?: AbortSignal;
}

export async function requestInlineEdit({
  threadId,
  resourceId,
  signal,
  ...body
}: InlineEditRequest): Promise<{ text?: unknown; error?: unknown }> {
  return requestJson<{ text: string }>(
    `/work/workspace/threads/${encodeURIComponent(threadId)}/inline-edit?resourceId=${encodeURIComponent(resourceId)}`,
    { method: "POST", body: { ...body, resourceId }, signal },
  );
}
