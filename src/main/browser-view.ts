import { type BrowserWindow, WebContentsView } from "electron";
import { randomUUID } from "node:crypto";
import {
  BrowserNavigateRequestSchema,
  NATIVE_BROWSER_VIEW_CHANNELS,
  type BrowserState,
  NativeBrowserBoundsSchema,
  NativeBrowserActionSchema,
  NativeBrowserEventSchema,
  NativeBrowserNavigateSchema,
  NativeBrowserSessionSchema,
  type NativeBrowserBounds,
  type NativeBrowserEvent,
  type NativeBrowserSession,
} from "../shared/browser-contract";

type BrowserViewFactory = () => WebContentsView;

interface NativeTab {
  id: string;
  view: WebContentsView;
  url: string;
  title: string;
}

interface NativeSession {
  key: string;
  session: NativeBrowserSession;
  tabs: NativeTab[];
  activeTabIndex: number;
  bounds: NativeBrowserBounds;
}

const EMPTY_BOUNDS = { x: 0, y: 0, width: 0, height: 0 };
const ABOUT_BLANK = "about:blank";
const MAX_TAB_TITLE_LENGTH = 1_024;

function normalizeTabTitle(title: string | null | undefined): string {
  const value = title?.trim() || "New tab";
  return value.length <= MAX_TAB_TITLE_LENGTH
    ? value
    : `${value.slice(0, MAX_TAB_TITLE_LENGTH - 1)}…`;
}

function sessionKey(session: NativeBrowserSession): string {
  return `${session.resourceId}:${session.threadId}`;
}

function isWebUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Owns the human-visible browser surface. The page is a real Electron
 * WebContentsView; no screenshot, base64 frame or pointer replay is involved.
 */
export class NativeBrowserViewManager {
  private readonly sessions = new Map<string, NativeSession>();
  private readonly ensurePromises = new Map<string, Promise<NativeSession>>();
  private readonly createView: BrowserViewFactory;

  constructor(
    private readonly window: BrowserWindow,
    createView?: BrowserViewFactory,
  ) {
    this.createView =
      createView ??
      (() =>
        new WebContentsView({
          webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
          },
        }));
  }

  async ensure(rawSession: unknown): Promise<BrowserState> {
    const session = NativeBrowserSessionSchema.parse(rawSession);
    const key = sessionKey(session);
    const current = this.sessions.get(key);
    if (current) {
      this.applyBounds(current);
      return this.state(current);
    }

    const pending = this.ensurePromises.get(key);
    if (pending) return this.state(await pending);

    const creation = (async () => {
      const created: NativeSession = {
        key,
        session,
        tabs: [],
        activeTabIndex: 0,
        bounds: { ...session, ...EMPTY_BOUNDS },
      };
      this.sessions.set(created.key, created);
      await this.createTab(created, ABOUT_BLANK);
      this.applyBounds(created);
      this.emitState(created);
      return created;
    })();
    this.ensurePromises.set(key, creation);
    try {
      return this.state(await creation);
    } finally {
      if (this.ensurePromises.get(key) === creation) this.ensurePromises.delete(key);
    }
  }

  async setBounds(rawBounds: unknown): Promise<void> {
    const bounds = NativeBrowserBoundsSchema.parse(rawBounds);
    const current = this.sessions.get(sessionKey(bounds));
    if (!current) return;
    current.bounds = bounds;
    this.applyBounds(current);
  }

  async navigate(rawRequest: unknown): Promise<BrowserState> {
    const request = NativeBrowserNavigateSchema.parse(rawRequest);
    const current = await this.getOrCreate({
      resourceId: request.resourceId,
      threadId: request.threadId,
    });
    const tab = this.activeTab(current);
    tab.url = request.url;
    this.emitState(current);
    // loadURL resolves only after the navigation finishes. Returning that
    // promise made the renderer disable the address bar for the whole network
    // round-trip, unlike a normal browser. Native WebContentsView renders the
    // request immediately; loading/error state is reported by events below.
    void tab.view.webContents.loadURL(request.url).catch((error: unknown) => {
      this.emitEvent({
        type: "error",
        ...current.session,
        message: error instanceof Error ? error.message : String(error),
      });
    });
    return this.state(current);
  }

  async action(rawRequest: unknown): Promise<BrowserState> {
    const parsed = NativeBrowserActionSchema.parse(rawRequest);
    const request = parsed.request;
    const session = NativeBrowserSessionSchema.parse({
      resourceId: parsed.resourceId,
      threadId: parsed.threadId,
    });
    const current = await this.getOrCreate(session);

    switch (request.action) {
      case "back":
        if (this.activeTab(current).view.webContents.navigationHistory.canGoBack()) {
          this.activeTab(current).view.webContents.navigationHistory.goBack();
        }
        break;
      case "forward":
        if (this.activeTab(current).view.webContents.navigationHistory.canGoForward()) {
          this.activeTab(current).view.webContents.navigationHistory.goForward();
        }
        break;
      case "reload":
        this.activeTab(current).view.webContents.reload();
        break;
      case "new-tab":
        await this.createTab(current, request.url ?? ABOUT_BLANK);
        break;
      case "switch-tab":
        if (request.index < current.tabs.length) {
          current.activeTabIndex = request.index;
          this.applyBounds(current);
          this.emitState(current);
        }
        break;
      case "close-tab":
        await this.closeTab(current, request.index);
        break;
      case "reset-tabs":
        await this.resetTabs(current);
        break;
    }

    this.emitState(current);
    return this.state(current);
  }

  getState(rawSession: unknown): BrowserState | null {
    const session = NativeBrowserSessionSchema.parse(rawSession);
    const current = this.sessions.get(sessionKey(session));
    if (!current || !current.tabs[current.activeTabIndex]) return null;
    return this.state(current);
  }

  getActiveTargetId(rawSession: unknown): string | null {
    const session = NativeBrowserSessionSchema.parse(rawSession);
    const current = this.sessions.get(sessionKey(session));
    const tab = current?.tabs[current.activeTabIndex];
    if (!tab || tab.view.webContents.isDestroyed()) return null;
    return tab.view.webContents.getOrCreateDevToolsTargetId();
  }

  async close(rawSession: unknown): Promise<void> {
    const session = NativeBrowserSessionSchema.parse(rawSession);
    const key = sessionKey(session);
    const current = this.sessions.get(key);
    if (!current) return;
    this.sessions.delete(key);
    this.ensurePromises.delete(key);
    for (const tab of current.tabs) {
      this.window.contentView.removeChildView(tab.view);
      if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
    }
  }

  dispose(): void {
    for (const current of this.sessions.values()) {
      for (const tab of current.tabs) {
        this.window.contentView.removeChildView(tab.view);
        if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
      }
    }
    this.sessions.clear();
    this.ensurePromises.clear();
  }

  private async getOrCreate(session: NativeBrowserSession): Promise<NativeSession> {
    await this.ensure(session);
    return this.sessions.get(sessionKey(session)) as NativeSession;
  }

  private activeTab(current: NativeSession): NativeTab {
    const tab = current.tabs[current.activeTabIndex];
    if (!tab) throw new Error("native browser has no active tab");
    return tab;
  }

  private async createTab(current: NativeSession, url: string): Promise<void> {
    const view = this.createView();
    const tab: NativeTab = {
      id: randomUUID(),
      view,
      url: ABOUT_BLANK,
      title: "New tab",
    };
    current.tabs.push(tab);
    current.activeTabIndex = current.tabs.length - 1;
    this.window.contentView.addChildView(view);
    this.attachTabEvents(current, tab);
    this.applyBounds(current);
    if (url !== ABOUT_BLANK) {
      const normalized = BrowserNavigateRequestSchema.parse({ url }).url;
      tab.url = normalized;
      void view.webContents.loadURL(normalized).catch((error: unknown) => {
        this.emitEvent({
          type: "error",
          ...current.session,
          message: error instanceof Error ? error.message : String(error),
        });
      });
    } else {
      void view.webContents.loadURL(ABOUT_BLANK).catch((error: unknown) => {
        this.emitEvent({
          type: "error",
          ...current.session,
          message: error instanceof Error ? error.message : String(error),
        });
      });
    }
    this.emitState(current);
  }

  private attachTabEvents(current: NativeSession, tab: NativeTab): void {
    const emit = () => {
      tab.url = tab.view.webContents.getURL() || ABOUT_BLANK;
      tab.title = normalizeTabTitle(tab.view.webContents.getTitle());
      this.emitState(current);
    };
    tab.view.webContents.on("did-start-loading", () =>
      this.emitEvent({ type: "loading", ...current.session, loading: true }),
    );
    tab.view.webContents.on("did-stop-loading", () => {
      emit();
      this.emitEvent({ type: "loading", ...current.session, loading: false });
    });
    tab.view.webContents.on("did-navigate", emit);
    tab.view.webContents.on("did-navigate-in-page", emit);
    tab.view.webContents.on("page-title-updated", (_event, title) => {
      tab.title = normalizeTabTitle(title);
      this.emitEvent({ type: "title", ...current.session, title: tab.title });
      this.emitState(current);
    });
    tab.view.webContents.on(
      "did-fail-load",
      (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        if (!isMainFrame || errorCode === -3) return;
        this.emitEvent({
          type: "error",
          ...current.session,
          message: `${errorDescription || "Page failed to load"}: ${validatedURL}`.slice(0, 4_096),
        });
      },
    );
    tab.view.webContents.on("render-process-gone", (_event, details) => {
      if (details.reason === "clean-exit" || this.window.isDestroyed()) return;
      this.emitEvent({
        type: "error",
        ...current.session,
        message: `Browser page process exited (${details.reason}, exit code ${details.exitCode})`,
      });
    });
    tab.view.webContents.setWindowOpenHandler(({ url }) => {
      if (isWebUrl(url)) {
        void this.createTab(current, url).catch((error: unknown) => {
          this.emitEvent({
            type: "error",
            ...current.session,
            message: error instanceof Error ? error.message : String(error),
          });
        });
      }
      return { action: "deny" };
    });
  }

  private async closeTab(current: NativeSession, index: number): Promise<void> {
    if (index < 0 || index >= current.tabs.length) return;
    const [removed] = current.tabs.splice(index, 1);
    this.window.contentView.removeChildView(removed.view);
    if (!removed.view.webContents.isDestroyed()) removed.view.webContents.close();
    if (current.tabs.length === 0) {
      await this.createTab(current, ABOUT_BLANK);
      return;
    }
    current.activeTabIndex = Math.min(current.activeTabIndex, current.tabs.length - 1);
    this.applyBounds(current);
  }

  private async resetTabs(current: NativeSession): Promise<void> {
    for (const tab of current.tabs) {
      this.window.contentView.removeChildView(tab.view);
      if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
    }
    current.tabs = [];
    current.activeTabIndex = 0;
    await this.createTab(current, ABOUT_BLANK);
  }

  private applyBounds(current: NativeSession): void {
    const active = this.activeTab(current);
    for (const tab of current.tabs) {
      tab.view.setBounds(
        tab === active
          ? {
              x: current.bounds.x,
              y: current.bounds.y,
              width: current.bounds.width,
              height: current.bounds.height,
            }
          : EMPTY_BOUNDS,
      );
    }
  }

  private state(current: NativeSession): BrowserState {
    return {
      active: current.tabs.length > 0,
      status: "ready",
      currentUrl: this.activeTab(current).url === ABOUT_BLANK ? null : this.activeTab(current).url,
      tabs: current.tabs.map((tab) => ({ url: tab.url, title: tab.title })),
      activeTabIndex: current.activeTabIndex,
    };
  }

  private emitState(current: NativeSession): void {
    const event: NativeBrowserEvent = {
      type: "state",
      ...current.session,
      state: this.state(current),
    };
    this.emitEvent(event);
  }

  private emitEvent(rawEvent: NativeBrowserEvent): void {
    const result = NativeBrowserEventSchema.safeParse(rawEvent);
    if (!result.success) {
      console.error("[native-browser] dropped invalid event", result.error.issues);
      return;
    }
    const event = result.data;
    if (!this.window.isDestroyed() && !this.window.webContents.isDestroyed()) {
      this.window.webContents.send(NATIVE_BROWSER_VIEW_CHANNELS.event, event);
    }
  }
}
