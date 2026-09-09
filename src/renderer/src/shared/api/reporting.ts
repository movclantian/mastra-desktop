import { apiFetch } from "./client";

function resourceQuery(resourceId: string): string {
  return `resourceId=${encodeURIComponent(resourceId)}`;
}

export function reportState(threadId: string, resourceId: string, patch: unknown): void {
  void apiFetch(
    `/work/sessions/workbench/threads/${encodeURIComponent(threadId)}/workbench-state?${resourceQuery(resourceId)}`,
    { method: "PUT", body: patch as Record<string, unknown> },
  ).catch(() => undefined);
}

export function reportNotification(
  threadId: string,
  resourceId: string,
  notification: unknown,
): void {
  void apiFetch(
    `/work/sessions/workbench/threads/${encodeURIComponent(threadId)}/notification?${resourceQuery(resourceId)}`,
    { method: "POST", body: notification as Record<string, unknown> },
  ).catch(() => undefined);
}

export const reportWorkbenchState = reportState;
export const reportWorkbenchNotification = reportNotification;
