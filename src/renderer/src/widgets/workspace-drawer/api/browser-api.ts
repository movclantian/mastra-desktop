import { apiFetch, MASTRA_SERVER_URL } from "@/shared/api";
import { i18n } from "@/shared/i18n";
import {
  type BrowserAction,
  BrowserActionRequestSchema,
  type BrowserKeyboardBatchRequest,
  BrowserKeyboardBatchRequestSchema,
  type BrowserKeyboardRequest,
  type BrowserMouseRequest,
  BrowserMouseRequestSchema,
  BrowserNavigateRequestSchema,
  type BrowserResponse,
  BrowserResponseSchema,
  type BrowserState,
  BrowserStateSchema,
} from "../../../../../shared/browser-contract";

export type {
  BrowserAction,
  BrowserKeyboardBatchRequest,
  BrowserKeyboardRequest,
  BrowserResponse,
  BrowserState,
};

export function browserResourceUrl(threadId: string, resourceId: string, suffix = ""): string {
  return `${MASTRA_SERVER_URL}/work/threads/${encodeURIComponent(threadId)}/browser${suffix}?resourceId=${encodeURIComponent(resourceId)}`;
}

export async function fetchBrowserState(
  threadId: string,
  resourceId: string,
): Promise<BrowserState | null> {
  const response = await apiFetch(browserResourceUrl(threadId, resourceId));
  if (!response.ok) return null;
  return BrowserStateSchema.parse(await response.json());
}

function browserScreencastUrl(threadId: string, resourceId: string): string {
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
  const request = BrowserNavigateRequestSchema.parse({ url });
  const response = await apiFetch(browserResourceUrl(threadId, resourceId, "/navigate"), {
    method: "POST",
    body: request,
  });
  const payload = BrowserResponseSchema.parse(await response.json().catch(() => ({})));
  if (!response.ok)
    throw new Error(payload.message || payload.error || i18n.t("workspace:navigateFailed"));
  return payload;
}

export async function browserAction(
  threadId: string,
  resourceId: string,
  action: BrowserAction,
  index?: number,
  url?: string,
): Promise<BrowserResponse> {
  const request = BrowserActionRequestSchema.parse({
    action,
    ...(index === undefined ? {} : { index }),
    ...(url ? { url } : {}),
  });
  const response = await apiFetch(browserResourceUrl(threadId, resourceId, "/action"), {
    method: "POST",
    body: request,
  });
  const payload = BrowserResponseSchema.parse(await response.json().catch(() => ({})));
  if (!response.ok)
    throw new Error(payload.message || payload.error || i18n.t("workspace:browserOpFailed"));
  return payload;
}

export function sendBrowserMouse(
  threadId: string,
  resourceId: string,
  body: BrowserMouseRequest,
): Promise<Response> {
  return apiFetch(browserResourceUrl(threadId, resourceId, "/mouse"), {
    method: "POST",
    body: BrowserMouseRequestSchema.parse(body),
  }).then(assertBrowserResponse);
}

export function sendBrowserKeyboardBatch(
  threadId: string,
  resourceId: string,
  body: BrowserKeyboardBatchRequest,
): Promise<Response> {
  return apiFetch(browserResourceUrl(threadId, resourceId, "/keyboard/batch"), {
    method: "POST",
    body: BrowserKeyboardBatchRequestSchema.parse(body),
  }).then(assertBrowserResponse);
}

async function assertBrowserResponse(response: Response): Promise<Response> {
  if (response.ok) return response;
  const payload = BrowserResponseSchema.safeParse(
    await response
      .clone()
      .json()
      .catch(() => ({})),
  );
  throw new Error(
    payload.success && (payload.data.message || payload.data.error)
      ? payload.data.message || payload.data.error
      : i18n.t("workspace:browserOpFailed"),
  );
}

export function closeBrowser(threadId: string, resourceId: string): Promise<Response> {
  return apiFetch(browserResourceUrl(threadId, resourceId), { method: "DELETE" });
}
