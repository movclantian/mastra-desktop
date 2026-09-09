import { apiFetch, MASTRA_SERVER_URL } from "@/shared/api";

export interface BrowserState {
  active: boolean;
  status: string;
  currentUrl: string | null;
  tabs: Array<{ url: string; title?: string }>;
  activeTabIndex: number;
}

export interface BrowserResponse {
  error?: string;
  message?: string;
  state?: BrowserState;
}

export function browserResourceUrl(threadId: string, resourceId: string, suffix = ""): string {
  return `${MASTRA_SERVER_URL}/work/threads/${encodeURIComponent(threadId)}/browser${suffix}?resourceId=${encodeURIComponent(resourceId)}`;
}

export async function fetchBrowserState(
  threadId: string,
  resourceId: string,
): Promise<BrowserState | null> {
  const response = await apiFetch(browserResourceUrl(threadId, resourceId));
  if (!response.ok) return null;
  return (await response.json()) as BrowserState;
}

export function browserScreencastUrl(threadId: string, resourceId: string): string {
  return browserResourceUrl(threadId, resourceId, "/screencast");
}

export function connectBrowserScreencast(
  threadId: string,
  resourceId: string,
  signal: AbortSignal,
): Promise<Response> {
  return apiFetch(browserScreencastUrl(threadId, resourceId), { signal });
}

export async function navigateBrowser(
  threadId: string,
  resourceId: string,
  url: string,
): Promise<BrowserResponse> {
  const response = await apiFetch(browserResourceUrl(threadId, resourceId, "/navigate"), {
    method: "POST",
    body: { url },
  });
  const payload = (await response.json().catch(() => ({}))) as BrowserResponse;
  if (!response.ok) throw new Error(payload.message || payload.error || "网页导航失败");
  return payload;
}

export async function browserAction(
  threadId: string,
  resourceId: string,
  action: string,
  index?: number,
  url?: string,
): Promise<BrowserResponse> {
  const response = await apiFetch(browserResourceUrl(threadId, resourceId, "/action"), {
    method: "POST",
    body: { action, index, ...(url ? { url } : {}) },
  });
  const payload = (await response.json().catch(() => ({}))) as BrowserResponse;
  if (!response.ok) throw new Error(payload.message || payload.error || "浏览器操作失败");
  return payload;
}

export function sendBrowserMouse(
  threadId: string,
  resourceId: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return apiFetch(browserResourceUrl(threadId, resourceId, "/mouse"), {
    method: "POST",
    body,
  });
}

export function sendBrowserKeyboard(
  threadId: string,
  resourceId: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return apiFetch(browserResourceUrl(threadId, resourceId, "/keyboard"), {
    method: "POST",
    body,
  });
}

export function closeBrowser(threadId: string, resourceId: string): Promise<Response> {
  return apiFetch(browserResourceUrl(threadId, resourceId), { method: "DELETE" });
}
