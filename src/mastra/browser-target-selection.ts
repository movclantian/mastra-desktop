import type { BrowserManager } from "agent-browser";
import type { Page } from "playwright-core";

const pageTargetIds = new WeakMap<Page, string>();

export function clearNativeElectronPageSelection(manager: BrowserManager): void {
  const internals = manager as unknown as { pages: Page[]; activePageIndex: number };
  internals.pages = [];
  internals.activePageIndex = 0;
}

async function getPageTargetId(page: Page): Promise<string> {
  const cached = pageTargetIds.get(page);
  if (cached) return cached;
  const cdp = await page.context().newCDPSession(page);
  try {
    const { targetInfo } = await cdp.send("Target.getTargetInfo");
    if (!targetInfo?.targetId) throw new Error("CDP did not return a page target ID");
    pageTargetIds.set(page, targetInfo.targetId);
    return targetInfo.targetId;
  } finally {
    await cdp.detach().catch(() => undefined);
  }
}

/** Restrict an AgentBrowser manager to exactly one verified Electron WebContents target. */
export async function selectNativeElectronPage(
  manager: BrowserManager,
  expectedTargetId: string,
): Promise<void> {
  clearNativeElectronPageSelection(manager);
  const browser = manager.getBrowser();
  if (!browser?.isConnected()) throw new Error("Agent browser CDP connection is unavailable");
  const pages = browser
    .contexts()
    .flatMap((context) => context.pages())
    .filter((page) => !page.isClosed());
  const identified = await Promise.allSettled(
    pages.map(async (page) => ({ page, targetId: await getPageTargetId(page) })),
  );
  if (identified.some((result) => result.status === "rejected")) {
    throw new Error("Could not verify every page target in the Electron CDP connection");
  }
  const matches = identified.flatMap((result) =>
    result.status === "fulfilled" && result.value.targetId === expectedTargetId
      ? [result.value.page]
      : [],
  );
  if (matches.length !== 1) {
    throw new Error(
      matches.length === 0
        ? "The thread's native browser tab is not present in the Electron CDP connection"
        : "The thread's native browser target is ambiguous",
    );
  }

  const internals = manager as unknown as { pages: Page[]; activePageIndex: number };
  // BrowserManager has no public page-filter API. Keep its CDP browser/context intact,
  // but narrow the Agent-visible active-page projection to this one owned target.
  internals.pages = matches;
  internals.activePageIndex = 0;
}
