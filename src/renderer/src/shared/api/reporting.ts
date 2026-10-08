import { apiFetch } from "./client";

function resourceQuery(resourceId: string): string {
  return `resourceId=${encodeURIComponent(resourceId)}`;
}

export function reportWorkbenchState(threadId: string, resourceId: string, patch: unknown): void {
  void apiFetch(
    `/work/sessions/workbench/threads/${encodeURIComponent(threadId)}/workbench-state?${resourceQuery(resourceId)}`,
    { method: "PUT", body: patch as Record<string, unknown> },
  ).catch(() => undefined);
}
