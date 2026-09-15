/**
 * Resume requests are scoped to an individual tool interaction in one thread.
 * The key includes the thread so a pending call cannot lock another thread.
 */
export function approvalResumeKey(threadId: string, interactionKey: string): string {
  return `${threadId}:${interactionKey}`;
}

export function isInteractionBusy(
  busyKeys: ReadonlySet<string>,
  threadId: string | null,
  interactionKey: string,
): boolean {
  return threadId !== null && busyKeys.has(approvalResumeKey(threadId, interactionKey));
}
