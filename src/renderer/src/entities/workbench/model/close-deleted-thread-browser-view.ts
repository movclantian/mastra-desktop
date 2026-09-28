type BrowserViewCloser = {
  close: (session: { resourceId: string; threadId: string }) => Promise<void>;
};

export async function closeDeletedThreadBrowserView(
  browserView: BrowserViewCloser | undefined,
  session: { resourceId: string; threadId: string },
): Promise<void> {
  if (!browserView) return;
  try {
    await browserView.close(session);
  } catch (error) {
    console.error("[browser] Failed to close deleted thread view", error);
  }
}
