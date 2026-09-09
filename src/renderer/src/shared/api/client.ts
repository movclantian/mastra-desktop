import { apiError, readErrorPayload, type WorkErrorPayload } from "@/shared/lib";

export const MASTRA_SERVER_URL = import.meta.env.VITE_MASTRA_SERVER_URL ?? "http://localhost:4111";

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
  fallback = "请求失败",
): Promise<T> {
  const response = await apiFetch(path, init);
  if (!response.ok) {
    const payload = await readErrorPayload(response, fallback);
    throw apiError(payload, fallback);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export async function requestText(
  path: string,
  init: ApiRequestInit = {},
  fallback = "请求失败",
): Promise<string> {
  const response = await apiFetch(path, init);
  if (!response.ok) {
    const payload = await readErrorPayload(response, fallback);
    throw apiError(payload, fallback);
  }
  return response.text();
}

export function isApiError(value: unknown): value is Error & WorkErrorPayload {
  return value instanceof Error && ("code" in value || "domain" in value || "category" in value);
}
