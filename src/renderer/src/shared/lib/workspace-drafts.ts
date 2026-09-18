import { i18n } from "@/shared/i18n";

const dirtyThreads = new Map<string, Set<string>>();

export function setWorkspaceDraftState(threadId: string, ownerId: string, dirty: boolean): void {
  const owners = dirtyThreads.get(threadId) ?? new Set<string>();
  if (dirty) owners.add(ownerId);
  else owners.delete(ownerId);
  if (owners.size > 0) dirtyThreads.set(threadId, owners);
  else dirtyThreads.delete(threadId);
}

export function confirmWorkspaceDraftSwitch(
  currentThreadId: string | null,
  nextThreadId: string | null,
): boolean {
  if (!currentThreadId || currentThreadId === nextThreadId || !dirtyThreads.has(currentThreadId)) {
    return true;
  }
  return window.confirm(i18n.t("workspace:unsavedSwitchConfirm"));
}

export function hasWorkspaceDrafts(): boolean {
  return dirtyThreads.size > 0;
}

export function confirmWorkspaceDraftClose(threadId: string | null, ownerId: string): boolean {
  return (
    !threadId ||
    !dirtyThreads.get(threadId)?.has(ownerId) ||
    window.confirm(i18n.t("workspace:unsavedCloseConfirm"))
  );
}
