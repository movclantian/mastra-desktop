import { type ClientOptions, MastraClient } from "@mastra/client-js";
import { i18n } from "@/shared/i18n";
import { apiError, readErrorPayload, type WorkErrorPayload } from "@/shared/lib";
import { type BrowserConfig, BrowserConfigSchema } from "../../../../shared/browser-contract";

export const MASTRA_SERVER_URL = import.meta.env.VITE_MASTRA_SERVER_URL ?? "http://localhost:4111";

const mastraClient = new MastraClient({
  baseUrl: MASTRA_SERVER_URL,
  retries: 0,
  credentials: "include",
});

export function getWorkbenchClientSession(
  resourceId: string,
  threadId: string,
  options?: Pick<ClientOptions, "abortSignal" | "fetch">,
) {
  const client = options
    ? new MastraClient({
        baseUrl: MASTRA_SERVER_URL,
        retries: 0,
        credentials: "include",
        ...options,
      })
    : mastraClient;
  return client
    .getAgentController("workbench")
    .session(resourceId, JSON.stringify(["workbench", threadId]));
}

export type ApiRequestInit = Omit<RequestInit, "body"> & {
  body?: BodyInit | Record<string, unknown> | null;
};

function resolveUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  return `${MASTRA_SERVER_URL}${path.startsWith("/") ? path : `/${path}`}`;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function serializeBody(body: ApiRequestInit["body"]): BodyInit | undefined {
  if (body === null || body === undefined) return undefined;
  if (isPlainRecord(body)) {
    return JSON.stringify(body);
  }
  return body as BodyInit;
}

export async function apiFetch(path: string, init: ApiRequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  const body = serializeBody(init.body);
  if (body && isPlainRecord(init.body)) {
    headers.set("Content-Type", "application/json");
  }
  return fetch(resolveUrl(path), { ...init, headers, body });
}

export async function requestJson<T>(
  path: string,
  init: ApiRequestInit = {},
  fallback?: string,
): Promise<T> {
  const fallbackMessage = fallback ?? i18n.t("common:requestFailed");
  const response = await apiFetch(path, init);
  if (!response.ok) {
    const payload = await readErrorPayload(response, fallbackMessage);
    throw Object.assign(apiError(payload, fallbackMessage), { status: response.status });
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

async function applyBrowserConfig(resourceId: string, value: unknown): Promise<BrowserConfig> {
  const config = BrowserConfigSchema.parse(value);
  const { provider, scope, timeout, homeUrl } = config;
  await window.api?.browserView?.configure({
    resourceId,
    provider,
    scope,
    timeout,
    homeUrl,
  });
  return config;
}

export function browserConfigQueryOptions(resourceId: string) {
  return {
    queryKey: ["browser-config", resourceId] as const,
    queryFn: async () => applyBrowserConfig(resourceId, await requestJson("/work/browser/config")),
    staleTime: Infinity,
  };
}

export async function saveBrowserConfig(
  resourceId: string,
  config: BrowserConfig,
): Promise<BrowserConfig> {
  const saved = await requestJson("/work/browser/config", { method: "POST", body: config });
  return applyBrowserConfig(resourceId, saved);
}

export async function requestText(
  path: string,
  init: ApiRequestInit = {},
  fallback?: string,
): Promise<string> {
  const fallbackMessage = fallback ?? i18n.t("common:requestFailed");
  const response = await apiFetch(path, init);
  if (!response.ok) {
    const payload = await readErrorPayload(response, fallbackMessage);
    throw apiError(payload, fallbackMessage);
  }
  return response.text();
}

export function isApiError(value: unknown): value is Error & WorkErrorPayload {
  return value instanceof Error && ("code" in value || "domain" in value || "category" in value);
}
