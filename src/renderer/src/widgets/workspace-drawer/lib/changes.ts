import type { WorkspaceFileChange } from "@/entities/workbench";

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  css: "css",
  html: "html",
  js: "javascript",
  jsx: "javascript",
  json: "json",
  md: "markdown",
  mdx: "markdown",
  py: "python",
  ts: "typescript",
  tsx: "typescript",
};

export function changeLanguage(path: string): string {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  return LANGUAGE_BY_EXTENSION[extension] ?? "text";
}

import { i18n } from "@/shared/i18n";

export function changeLabel(change: WorkspaceFileChange, t?: (key: string) => string): string {
  if (t) {
    if (change.kind === "created") return t("workspace:changeCreated");
    if (change.kind === "deleted") return t("workspace:changeDeleted");
    return t("workspace:changeModified");
  }
  if (change.kind === "created") return i18n.t("workspace:changeCreated");
  if (change.kind === "deleted") return i18n.t("workspace:changeDeleted");
  return i18n.t("workspace:changeModified");
}

export interface WorkspaceChangeGroup {
  path: string;
  changes: WorkspaceFileChange[];
}

export function groupWorkspaceChanges(changes: WorkspaceFileChange[]): WorkspaceChangeGroup[] {
  const groups = new Map<string, WorkspaceChangeGroup>();
  for (const change of changes) {
    const group = groups.get(change.path);
    if (group) group.changes.push(change);
    else groups.set(change.path, { path: change.path, changes: [change] });
  }
  return [...groups.values()];
}
