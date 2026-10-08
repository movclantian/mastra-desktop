import { apiFetch } from "./client";

function resourceQuery(resourceId: string): string {
  return `resourceId=${encodeURIComponent(resourceId)}`;
}

/** Every producer cancels its superseded snapshot when its effect or thread ends. */
export function reportWorkbenchState(threadId: string, resourceId: string, patch: unknown) {
  const controller = new AbortController();
  void apiFetch(
    `/work/sessions/workbench/threads/${encodeURIComponent(threadId)}/workbench-state?${resourceQuery(resourceId)}`,
    { method: "PUT", body: patch as Record<string, unknown>, signal: controller.signal },
  ).catch(() => undefined);
  return () => controller.abort();
}
