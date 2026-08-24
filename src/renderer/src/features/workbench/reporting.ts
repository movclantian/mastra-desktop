import { reportNotification, reportState } from "@/api/workbench-reporting";
import type { WorkbenchStatePatch } from "./types";

const WORKBENCH_STATE_REPORT_DELAY = 400;
const pendingStateReports = new Map<string, ReturnType<typeof setTimeout>>();

export function reportWorkbenchState(
  threadId: string | null,
  resourceId: string,
  patch: WorkbenchStatePatch,
): void {
  if (!threadId) return;
  const key = `${resourceId}:${threadId}:${Object.keys(patch).join(",")}`;
  const pending = pendingStateReports.get(key);
  if (pending) clearTimeout(pending);
  pendingStateReports.set(
    key,
    setTimeout(() => {
      pendingStateReports.delete(key);
      reportState(threadId, resourceId, patch);
    }, WORKBENCH_STATE_REPORT_DELAY),
  );
}

export function reportWorkbenchNotification(
  threadId: string | null,
  resourceId: string,
  notification: {
    source: string;
    kind: string;
    summary: string;
    priority?: "low" | "medium" | "high" | "urgent";
    payload?: unknown;
    dedupeKey?: string;
  },
): void {
  if (!threadId) return;
  reportNotification(threadId, resourceId, notification);
}
