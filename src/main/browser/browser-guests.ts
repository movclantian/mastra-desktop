import { randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";
import {
  type BrowserWindow,
  session as electronSession,
  type WebContents,
  type WebPreferences,
  webContents,
} from "electron";
import {
  BrowserNavigateRequestSchema,
  type BrowserState,
  MAX_NATIVE_BROWSER_TABS,
  NATIVE_BROWSER_VIEW_CHANNELS,
  NativeBrowserActionSchema,
  type NativeBrowserAgentOperation,
  NativeBrowserAgentOperationSchema,
  NativeBrowserBindGuestSchema,
  type NativeBrowserBounds,
  NativeBrowserBoundsSchema,
  type NativeBrowserConfig,
  NativeBrowserConfigSchema,
  type NativeBrowserEvent,
  NativeBrowserEventSchema,
  NativeBrowserNavigateSchema,
  type NativeBrowserSession,
  NativeBrowserSessionSchema,
  type NativeBrowserSurface,
} from "../../shared/browser-contract";
import { NativeBrowserAgentCommandError } from "./agent-command-broker";

class NativeBrowserAgentOperationTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NativeBrowserAgentOperationTimeoutError";
  }
}

interface NativeTab {
  id: string;
  contents?: WebContents;
  url: string;
  title: string;
  refs: Set<string>;
  nextAgentRefIndex: number;
  documentGeneration: number;
}

interface NativeAgentDragData {
  items: Array<{ mimeType: string; data: string; title?: string; baseURL?: string }>;
  dragOperationsMask: number;
}

interface NativeSession {
  key: string;
  session: NativeBrowserSession;
  tabs: NativeTab[];
  activeTabIndex: number;
  bounds: NativeBrowserBounds;
  partition: string;
  agentGeneration: number;
  operationQueue: Promise<void>;
}

const EMPTY_BOUNDS = { x: 0, y: 0, width: 0, height: 0 };
const ABOUT_BLANK = "about:blank";
const MAX_TAB_TITLE_LENGTH = 1_024;
const MAX_AGENT_SNAPSHOT_LENGTH = 48_000;
const MAX_AGENT_PAGE_TEXT_LENGTH = 8_000;
const MAX_AGENT_EVALUATE_BYTES = 512 * 1024;

function pageScript<T>(contents: WebContents, fn: { toString(): string }, args: unknown[]) {
  return contents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`) as Promise<T>;
}

function collectAgentSnapshot(
  interactiveOnly: boolean,
  refStartIndex: number,
  maxSnapshotLength: number,
  maxPageTextLength: number,
) {
  const attribute = "data-mastrawork-agent-ref";
  document.querySelectorAll(`[${attribute}]`).forEach((element) => {
    element.removeAttribute(attribute);
  });
  const selector = interactiveOnly
    ? 'a[href],button,input,textarea,select,[role="button"],[role="link"],[role="textbox"],[role="searchbox"],[role="checkbox"],[role="radio"],[role="combobox"],[contenteditable="true"]'
    : 'a[href],button,input,textarea,select,[role],h1,h2,h3,h4,h5,h6,img,summary,[contenteditable="true"]';
  const elementLines: string[] = [];
  const refs: string[] = [];
  const elements = Array.from(document.querySelectorAll(selector)).slice(0, 200);
  for (const element of elements) {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    if (
      rect.width <= 0 ||
      rect.height <= 0 ||
      style.display === "none" ||
      style.visibility === "hidden" ||
      element.closest('[aria-hidden="true"]')
    ) {
      continue;
    }
    const tag = element.tagName.toLowerCase();
    const inputType = tag === "input" ? (element.getAttribute("type") || "text").toLowerCase() : "";
    const role =
      element.getAttribute("role") ||
      (tag === "a"
        ? "link"
        : tag === "button" || tag === "summary"
          ? "button"
          : tag === "textarea" || element.getAttribute("contenteditable") === "true"
            ? "textbox"
            : tag === "select"
              ? "combobox"
              : tag === "input"
                ? inputType === "search"
                  ? "searchbox"
                  : inputType === "checkbox" || inputType === "radio"
                    ? inputType
                    : ["button", "submit", "reset"].includes(inputType)
                      ? "button"
                      : "textbox"
                : /^h[1-6]$/.test(tag)
                  ? "heading"
                  : tag === "img"
                    ? "img"
                    : "text");
    const labelledBy = (element.getAttribute("aria-labelledby") || "")
      .split(/\s+/)
      .filter(Boolean)
      .map((id) => document.getElementById(id)?.textContent || "")
      .join(" ");
    const labels =
      "labels" in element
        ? Array.from((element as HTMLInputElement).labels || [])
            .map((label) => label.textContent || "")
            .join(" ")
        : "";
    const isSelect = element instanceof HTMLSelectElement;
    const isValueButton =
      element instanceof HTMLInputElement && ["button", "submit", "reset"].includes(inputType);
    const name = (
      labelledBy ||
      element.getAttribute("aria-label") ||
      labels ||
      element.getAttribute("alt") ||
      element.getAttribute("placeholder") ||
      element.getAttribute("title") ||
      (isValueButton ? String((element as HTMLInputElement).value || "") : "") ||
      element.textContent ||
      ""
    )
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 240);
    const ref = `e${refStartIndex + refs.length}`;
    const value =
      element instanceof HTMLInputElement && inputType !== "password"
        ? element.value
        : element instanceof HTMLTextAreaElement
          ? element.value
          : isSelect
            ? element.value
            : "";
    const valueDescription = value ? ` [value=${JSON.stringify(value.slice(0, 240))}]` : "";
    const line = `- ${role}${name ? ` ${JSON.stringify(name)}` : ""}${valueDescription} [ref=${ref}]`;
    if (elementLines.join("\n").length + line.length > maxSnapshotLength - maxPageTextLength) {
      break;
    }
    element.setAttribute(attribute, ref);
    refs.push(ref);
    elementLines.push(line);
  }
  let pageText = "";
  if (!interactiveOnly && document.body) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const textParts: string[] = [];
    let textLength = 0;
    let node = walker.nextNode();
    while (node && textLength < maxPageTextLength) {
      const rawText = node.textContent?.replace(/\s+/g, " ").trim() || "";
      const parent = node.parentElement;
      if (
        rawText &&
        parent &&
        !parent.closest("script,style,noscript,template,svg,[hidden],[aria-hidden='true']")
      ) {
        const style = getComputedStyle(parent);
        const rect = parent.getBoundingClientRect();
        if (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          rect.width > 0 &&
          rect.height > 0
        ) {
          const part = rawText.slice(0, 512);
          const separatorLength = textParts.length ? 1 : 0;
          const available = maxPageTextLength - textLength - separatorLength;
          if (available > 0) {
            const boundedPart = part.slice(0, available);
            textParts.push(boundedPart);
            textLength += separatorLength + boundedPart.length;
          }
        }
      }
      node = walker.nextNode();
    }
    pageText = textParts.join("\n");
  }
  const sections = [
    ...(!interactiveOnly && pageText ? [`Page text:\n${pageText}`] : []),
    `Elements:\n${elementLines.join("\n")}`,
  ];
  return {
    title: document.title.slice(0, 1_024),
    url: location.href.slice(0, 8_192),
    snapshot: sections.join("\n\n").slice(0, maxSnapshotLength),
    refs,
    elementCount: refs.length,
    scrollY: Math.max(0, window.scrollY || 0),
    scrollHeight: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0),
    viewportHeight: Math.max(window.innerHeight, 1),
  };
}

function readAgentElement(ref: string) {
  const element = document.querySelector<HTMLElement>(`[data-mastrawork-agent-ref="${ref}"]`);
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  return {
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    tag: element.tagName.toLowerCase(),
  };
}

function readAgentDragElement(ref: string | null, selector: string | null) {
  let element: HTMLElement | null = null;
  try {
    element = ref
      ? document.querySelector<HTMLElement>(`[data-mastrawork-agent-ref="${ref}"]`)
      : selector
        ? document.querySelector<HTMLElement>(selector)
        : null;
  } catch {
    return null;
  }
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

function beginAgentDragObservation() {
  const key = "__mastraworkAgentDragObservation";
  const target = window as Window & {
    __mastraworkAgentDragObservation?: { events: string[]; listener: EventListener };
  };
  const events = ["dragstart", "dragenter", "dragover", "drop", "dragend"];
  const state: {
    events: string[];
    listener: EventListener;
  } = {
    events: [],
    listener: () => undefined,
  };
  state.listener = (event: Event) => state.events.push(event.type);
  for (const eventName of events) window.addEventListener(eventName, state.listener);
  target[key] = state;
}

function finishAgentDragObservation() {
  const key = "__mastraworkAgentDragObservation";
  const target = window as Window & {
    __mastraworkAgentDragObservation?: { events: string[]; listener: EventListener };
  };
  const state = target[key];
  if (!state) return [];
  for (const eventName of ["dragstart", "dragenter", "dragover", "drop", "dragend"])
    window.removeEventListener(eventName, state.listener);
  delete target[key];
  return state.events;
}

function focusAgentElement(ref: string) {
  const element = document.querySelector<HTMLElement>(`[data-mastrawork-agent-ref="${ref}"]`);
  if (!element) return false;
  element.focus();
  return document.activeElement === element;
}

function setAgentElementValue(ref: string, value: string) {
  const element = document.querySelector<HTMLElement>(`[data-mastrawork-agent-ref="${ref}"]`);
  if (!element) return null;
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    const prototype = Object.getPrototypeOf(element);
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    setter?.call(element, value);
    element.dispatchEvent(
      new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }),
    );
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return element.value;
  }
  if (element.isContentEditable) {
    element.textContent = value;
    element.dispatchEvent(
      new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }),
    );
    return element.textContent;
  }
  return null;
}

function selectAgentOption(
  ref: string,
  selection: { value?: string; label?: string; index?: number },
) {
  const element = document.querySelector<HTMLSelectElement>(`[data-mastrawork-agent-ref="${ref}"]`);
  if (element?.tagName !== "SELECT") return null;
  const option =
    selection.index !== undefined
      ? element.options[selection.index]
      : Array.from(element.options).find((candidate) =>
          selection.value !== undefined
            ? candidate.value === selection.value
            : candidate.label === selection.label,
        );
  if (!option) return null;
  if (element.multiple) option.selected = true;
  else element.value = option.value;
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
  return Array.from(element.selectedOptions).map((candidate) => candidate.value);
}

function readAgentScroll() {
  const root = document.documentElement;
  const max = Math.max(root.scrollHeight - window.innerHeight, 0);
  const y = Math.max(window.scrollY || 0, 0);
  return { x: Math.max(window.scrollX || 0, 0), y, max, atTop: y <= 0, atBottom: y >= max };
}

function testAgentRef(ref: string, state: string) {
  const element = document.querySelector<HTMLElement>(`[data-mastrawork-agent-ref="${ref}"]`);
  if (state === "detached") return !element?.isConnected;
  if (state === "hidden") return !element || element.getBoundingClientRect().width <= 0;
  if (state === "attached") return Boolean(element?.isConnected);
  return Boolean(
    element &&
      element.getBoundingClientRect().width > 0 &&
      getComputedStyle(element).visibility !== "hidden",
  );
}

function normalizeTabTitle(title: string | null | undefined): string {
  const value = title?.trim() || "New tab";
  return value.length <= MAX_TAB_TITLE_LENGTH
    ? value
    : `${value.slice(0, MAX_TAB_TITLE_LENGTH - 1)}…`;
}

function isWebUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/** Manages isolated Electron guests; the renderer owns their DOM composition. */
export class NativeBrowserGuestManager {
  private readonly sessions = new Map<string, NativeSession>();
  private readonly configs = new Map<string, NativeBrowserConfig>();
  private readonly unboundGuests = new Set<WebContents>();
  private readonly surfaceChanges = new EventEmitter();

  constructor(
    private readonly window: BrowserWindow,
    private proxy: Electron.ProxyConfig,
  ) {
    window.webContents.on("will-attach-webview", (event, preferences, params) => {
      if (!this.secureGuest(preferences, params)) event.preventDefault();
    });
    window.webContents.on("did-attach-webview", (_event, guest) => {
      if (guest.getType() !== "webview" || guest.hostWebContents !== window.webContents) {
        guest.close({ waitForBeforeUnload: false });
        return;
      }
      this.unboundGuests.add(guest);
      guest.setWindowOpenHandler(() => ({ action: "deny" }));
      const timer = setTimeout(() => {
        if (this.unboundGuests.delete(guest) && !guest.isDestroyed())
          guest.close({ waitForBeforeUnload: false });
      }, 15_000);
      guest.once("destroyed", () => {
        clearTimeout(timer);
        this.unboundGuests.delete(guest);
      });
    });
  }

  async setProxy(proxy: Electron.ProxyConfig): Promise<void> {
    this.proxy = proxy;
    await Promise.all(
      [...this.sessions.values()].map((current) =>
        electronSession.fromPartition(current.partition).setProxy(proxy),
      ),
    );
  }

  configure(rawConfig: unknown): void {
    const config = NativeBrowserConfigSchema.parse(rawConfig);
    const previous = this.configs.get(config.resourceId);
    if (previous && (previous.scope !== config.scope || previous.provider !== config.provider)) {
      for (const current of this.sessions.values()) {
        if (current.session.resourceId === config.resourceId) this.close(current.session);
      }
    }
    this.configs.set(config.resourceId, config);
    this.emitSurfaces();
  }

  private sessionKey(session: NativeBrowserSession): string {
    const scope = this.configs.get(session.resourceId)?.scope;
    return JSON.stringify([session.resourceId, scope === "shared" ? null : session.threadId]);
  }

  private homeUrl(current: NativeSession): string {
    return this.configs.get(current.session.resourceId)?.homeUrl || ABOUT_BLANK;
  }

  getSurfaces(): NativeBrowserSurface[] {
    return [...this.sessions.values()].map((current) => ({
      ...current.session,
      partition: current.partition,
      bounds: current.bounds,
      activeTabId: current.tabs[current.activeTabIndex]?.id ?? null,
      tabs: current.tabs.map(({ id, title }) => ({ id, title })),
    }));
  }

  private emitSurfaces(): void {
    if (!this.window.isDestroyed() && !this.window.webContents.isDestroyed())
      this.window.webContents.send(NATIVE_BROWSER_VIEW_CHANNELS.surfaces, this.getSurfaces());
    this.surfaceChanges.emit("change");
  }

  private secureGuest(preferences: WebPreferences, params: Record<string, string>): boolean {
    const current = [...this.sessions.values()].find((s) => s.partition === params.partition);
    const tab = current?.tabs.find((t) => params.src === `about:blank#${t.id}` && !t.contents);
    if (!current || !tab) return false;
    delete params.preload;
    delete params.webpreferences;
    delete preferences.preload;
    Object.assign(preferences, {
      partition: current.partition,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      navigateOnDragDrop: false,
    });
    return true;
  }

  bindGuest(rawRequest: unknown): void {
    const { tabId, guestId } = NativeBrowserBindGuestSchema.parse(rawRequest);
    const current = [...this.sessions.values()].find((s) => s.tabs.some((t) => t.id === tabId));
    const tab = current?.tabs.find((t) => t.id === tabId);
    const guest = webContents.fromId(guestId);
    if (
      !current ||
      !tab ||
      !guest ||
      guest.isDestroyed() ||
      !this.unboundGuests.has(guest) ||
      tab.contents ||
      guest.getType() !== "webview" ||
      guest.hostWebContents !== this.window.webContents ||
      guest.session !== electronSession.fromPartition(current.partition) ||
      guest.getURL() !== `about:blank#${tabId}`
    ) {
      throw new Error("Invalid browser guest binding");
    }
    this.unboundGuests.delete(guest);
    tab.contents = guest;
    this.attachTabEvents(current, tab);
    guest.once("destroyed", () => {
      if (this.sessions.get(current.key) !== current || !current.tabs.includes(tab)) return;
      this.invalidateAgentCommands(current, false);
      current.tabs = current.tabs.filter((t) => t !== tab);
      current.activeTabIndex = Math.max(
        0,
        Math.min(current.activeTabIndex, current.tabs.length - 1),
      );
      this.emitState(current);
    });
    if (tab.url !== ABOUT_BLANK) this.loadTab(current, tab, tab.url);
    this.emitState(current);
  }

  private loadTab(current: NativeSession, tab: NativeTab, url: string): void {
    tab.url = url;
    if (!tab.contents || tab.contents.isDestroyed()) return;
    void tab.contents.loadURL(url).catch((error: unknown) => {
      this.emitEvent({
        type: "error",
        ...current.session,
        message: (error instanceof Error ? error.message : String(error)).slice(0, 4096),
      });
    });
  }

  async ensure(rawSession: unknown): Promise<BrowserState> {
    const session = NativeBrowserSessionSchema.parse(rawSession);
    const current = this.getOrCreate(session);
    return this.enqueueAgentCommand(current, async () => {
      if (current.tabs.length === 0) await this.createTab(current, this.homeUrl(current));
      this.emitSurfaces();
      return this.state(current);
    });
  }

  async setBounds(rawBounds: unknown): Promise<void> {
    const bounds = NativeBrowserBoundsSchema.parse(rawBounds);
    if (this.configs.get(bounds.resourceId)?.provider !== "agent") return;
    const session = { resourceId: bounds.resourceId, threadId: bounds.threadId };
    const current =
      this.sessions.get(this.sessionKey(session)) ??
      (bounds.width > 0 && bounds.height > 0 ? this.getOrCreate(session) : undefined);
    if (!current) return;
    const wasVisible = current.bounds.width > 0 && current.bounds.height > 0;
    const willBeHidden = bounds.width <= 0 || bounds.height <= 0;
    if (wasVisible && willBeHidden) {
      // Hidden pages invalidate in-flight automation before the next command.
      this.invalidateAgentCommands(current, true);
      current.bounds = bounds;
      await this.enqueueAgentCommand(current, async () => this.emitSurfaces());
      return;
    }
    current.bounds = bounds;
    this.emitSurfaces();
  }

  async navigate(rawRequest: unknown): Promise<BrowserState> {
    const request = NativeBrowserNavigateSchema.parse(rawRequest);
    const current = this.getOrCreate({
      resourceId: request.resourceId,
      threadId: request.threadId,
    });
    this.invalidateAgentCommands(current, true);
    return this.enqueueAgentCommand(current, async () => {
      if (current.tabs.length === 0) {
        await this.createTab(current, request.url);
        return this.state(current);
      }
      const tab = this.activeTab(current);
      tab.url = request.url;
      this.emitState(current);
      // Navigation remains asynchronous; load events report progress.
      this.loadTab(current, tab, request.url);
      return this.state(current);
    });
  }

  async action(rawRequest: unknown): Promise<BrowserState> {
    const parsed = NativeBrowserActionSchema.parse(rawRequest);
    const request = parsed.request;
    const session = NativeBrowserSessionSchema.parse({
      resourceId: parsed.resourceId,
      threadId: parsed.threadId,
    });
    const current = this.getOrCreate(session);
    this.invalidateAgentCommands(current, true);

    return this.enqueueAgentCommand(current, async () => {
      if (
        current.tabs.length === 0 &&
        request.action !== "new-tab" &&
        request.action !== "reset-tabs"
      )
        return this.state(current);
      switch (request.action) {
        case "back":
          if (this.contents(this.activeTab(current)).navigationHistory.canGoBack()) {
            this.contents(this.activeTab(current)).navigationHistory.goBack();
          }
          break;
        case "forward":
          if (this.contents(this.activeTab(current)).navigationHistory.canGoForward()) {
            this.contents(this.activeTab(current)).navigationHistory.goForward();
          }
          break;
        case "reload":
          this.contents(this.activeTab(current)).reload();
          break;
        case "new-tab":
          await this.createTab(current, request.url ?? this.homeUrl(current));
          break;
        case "switch-tab": {
          const index = parsed.tabId
            ? current.tabs.findIndex((tab) => tab.id === parsed.tabId)
            : request.index;
          if (index >= 0 && index < current.tabs.length) {
            current.activeTabIndex = index;
            this.invalidateAgentRefs(current);
            this.emitSurfaces();
            this.emitState(current);
          }
          break;
        }
        case "close-tab": {
          const index = parsed.tabId
            ? current.tabs.findIndex((tab) => tab.id === parsed.tabId)
            : request.index;
          await this.closeTab(current, index);
          break;
        }
        case "reset-tabs":
          await this.resetTabs(current);
          break;
      }

      this.emitState(current);
      return this.state(current);
    });
  }

  getState(rawSession: unknown): BrowserState | null {
    const session = NativeBrowserSessionSchema.parse(rawSession);
    const current = this.sessions.get(this.sessionKey(session));
    if (!current?.tabs[current.activeTabIndex]) return null;
    return this.state(current);
  }

  executeAgentCommand(
    rawSession: unknown,
    rawOperation: unknown,
    rawInput?: Record<string, unknown>,
  ): Promise<unknown> {
    const session = NativeBrowserSessionSchema.parse(rawSession);
    const operation = NativeBrowserAgentOperationSchema.parse(rawOperation);
    const current =
      this.sessions.get(this.sessionKey(session)) ??
      (operation === "goto" ? this.getOrCreate(session) : undefined);
    if (!current) {
      if (operation === "state") return Promise.resolve({ state: null, visible: false });
      throw new NativeBrowserAgentCommandError("session_not_found");
    }
    if (operation === "state") {
      return Promise.resolve({
        state: this.state(current),
        visible: this.isActiveViewVisible(current),
      });
    }
    const input = rawInput ?? {};
    let timeout: number;
    try {
      timeout = this.numberInput(
        input.timeout,
        this.configs.get(current.session.resourceId)?.timeout ?? 30_000,
        1,
        300_000,
      );
    } catch {
      return Promise.reject(new NativeBrowserAgentCommandError("operation_failed"));
    }
    const deadline = Date.now() + timeout;
    return this.enqueueAgentCommand(current, async () => {
      if (operation === "goto" && current.tabs.length === 0) {
        BrowserNavigateRequestSchema.parse({ url: input.url });
        await this.createTab(current, ABOUT_BLANK);
      }
      if (!this.isActiveViewVisible(current) || current.bounds.threadId !== session.threadId) {
        this.emitEvent({ type: "activate", ...session });
        const signal = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
        while (!this.isActiveViewVisible(current) || current.bounds.threadId !== session.threadId) {
          if (this.sessions.get(current.key) !== current)
            throw new NativeBrowserAgentCommandError("session_not_found");
          try {
            await once(this.surfaceChanges, "change", { signal });
          } catch {
            throw new NativeBrowserAgentCommandError("session_not_visible");
          }
        }
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new NativeBrowserAgentCommandError("operation_failed");
      try {
        return await this.withTimeout(
          this.executeAgentOperation(current, operation, input),
          remaining,
          "Native browser operation timed out",
        );
      } catch (error) {
        if (error instanceof NativeBrowserAgentOperationTimeoutError) {
          // A timed-out page script may still settle later. Invalidate its refs
          // and generation before releasing the queue so it cannot report
          // success or race the next action on this tab.
          this.invalidateAgentCommands(current, true);
          throw new NativeBrowserAgentCommandError("operation_failed");
        }
        throw error;
      }
    });
  }

  private enqueueAgentCommand<T>(current: NativeSession, operation: () => Promise<T>): Promise<T> {
    const queued = current.operationQueue.then(operation, operation);
    current.operationQueue = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  }

  private isActiveViewVisible(current: NativeSession): boolean {
    if (
      this.window.isDestroyed() ||
      !this.window.isVisible() ||
      this.window.isMinimized() ||
      current.bounds.width <= 0 ||
      current.bounds.height <= 0
    ) {
      return false;
    }
    const tab = current.tabs[current.activeTabIndex];
    return Boolean(tab?.contents && !tab.contents.isDestroyed());
  }

  private requireVisibleAgentTab(current: NativeSession): NativeTab {
    if (!this.isActiveViewVisible(current)) {
      throw new NativeBrowserAgentCommandError("session_not_visible");
    }
    const tab = current.tabs[current.activeTabIndex];
    if (!tab) throw new NativeBrowserAgentCommandError("session_not_found");
    return tab;
  }

  private assertAgentTarget(current: NativeSession, tab: NativeTab, generation: number): void {
    if (
      this.sessions.get(current.key) !== current ||
      current.agentGeneration !== generation ||
      this.contents(tab).isDestroyed() ||
      !this.isTabStillActive(current, tab)
    ) {
      throw new NativeBrowserAgentCommandError("session_not_visible");
    }
  }

  private invalidateAgentCommands(current: NativeSession, stopLoading: boolean): void {
    current.agentGeneration += 1;
    this.invalidateAgentRefs(current);
    if (stopLoading) {
      const active = current.tabs[current.activeTabIndex];
      if (active?.contents && !active.contents.isDestroyed() && active.contents.isLoading()) {
        this.contents(active).stop();
      }
    }
  }

  private requireAgentRef(tab: NativeTab, rawRef: unknown): string {
    if (typeof rawRef !== "string" || !/^e\d{1,16}$/.test(rawRef) || !tab.refs.has(rawRef)) {
      throw new NativeBrowserAgentCommandError("stale_ref");
    }
    return rawRef;
  }

  private async executeAgentOperation(
    current: NativeSession,
    operation: NativeBrowserAgentOperation,
    input: Record<string, unknown>,
  ): Promise<unknown> {
    try {
      const tab = this.requireVisibleAgentTab(current);
      const contents = this.contents(tab);
      const generation = current.agentGeneration;
      let documentGeneration = tab.documentGeneration;
      const assertCurrent = (allowDocumentNavigation = false) => {
        this.assertAgentTarget(current, tab, generation);
        if (tab.documentGeneration !== documentGeneration) {
          if (!allowDocumentNavigation) {
            throw new NativeBrowserAgentCommandError("document_changed");
          }
          documentGeneration = tab.documentGeneration;
        }
      };
      const timeout = this.numberInput(
        input.timeout,
        this.configs.get(current.session.resourceId)?.timeout ?? 30_000,
        1,
        300_000,
      );
      const currentUrl = () => contents.getURL() || ABOUT_BLANK;
      const title = () => normalizeTabTitle(contents.getTitle());
      const hint = (text: string) => text;

      switch (operation) {
        case "goto": {
          const url = BrowserNavigateRequestSchema.parse({
            url: this.stringInput(input.url, 8_192),
          }).url;
          assertCurrent();
          try {
            await this.withTimeout(contents.loadURL(url), timeout, "Browser navigation timed out");
          } catch (error) {
            if (!contents.isDestroyed() && contents.isLoading()) contents.stop();
            throw error;
          }
          assertCurrent(true);
          return {
            success: true,
            url: currentUrl(),
            title: title(),
            hint: hint("Take a snapshot to see interactive elements and get refs."),
          };
        }
        case "snapshot": {
          const result = await pageScript<ReturnType<typeof collectAgentSnapshot>>(
            contents,
            collectAgentSnapshot,
            [
              input.interactiveOnly !== false,
              tab.nextAgentRefIndex,
              MAX_AGENT_SNAPSHOT_LENGTH,
              MAX_AGENT_PAGE_TEXT_LENGTH,
            ],
          );
          assertCurrent();
          tab.refs = new Set(result.refs);
          tab.nextAgentRefIndex += result.refs.length;
          const scroll =
            result.scrollY <= 0 && result.scrollHeight > result.viewportHeight
              ? "TOP - more content below"
              : result.scrollY + result.viewportHeight >= result.scrollHeight
                ? "BOTTOM of page"
                : `${Math.floor((result.scrollY / Math.max(result.scrollHeight - result.viewportHeight, 1)) * 100)}% down`;
          return {
            success: true,
            snapshot: result.snapshot.slice(0, MAX_AGENT_SNAPSHOT_LENGTH),
            url: result.url,
            title: result.title,
            elementCount: result.elementCount,
            scroll,
            ...(result.elementCount === 0
              ? {
                  hint: "No interactive elements found. Try scrolling or setting interactiveOnly:false.",
                }
              : {}),
          };
        }
        case "screenshot": {
          assertCurrent();
          let image = await contents.capturePage();
          assertCurrent();
          const size = image.getSize();
          const scale = Math.min(
            1,
            1_600 / Math.max(size.width, 1),
            1_200 / Math.max(size.height, 1),
          );
          if (scale < 1) {
            image = image.resize({
              width: Math.max(1, Math.round(size.width * scale)),
              height: Math.max(1, Math.round(size.height * scale)),
            });
          }
          return {
            base64: image.toPNG().toString("base64"),
            url: currentUrl(),
            title: title(),
            viewport: image.getSize(),
          };
        }
        case "click": {
          const ref = this.requireAgentRef(tab, input.ref);
          const rect = await pageScript<ReturnType<typeof readAgentElement> | null>(
            contents,
            readAgentElement,
            [ref],
          );
          assertCurrent();
          if (!rect) throw new NativeBrowserAgentCommandError("stale_ref");
          const waitForLoad =
            typeof input.waitUntil === "string"
              ? this.waitForStopLoading(contents, timeout)
              : undefined;
          contents.focus();
          const button =
            input.button === "right" || input.button === "middle" ? input.button : "left";
          const clickCount = this.numberInput(input.clickCount, 1, 1, 3);
          const modifiers = this.modifiersInput(input.modifiers);
          const modifierMask = modifiers.reduce(
            (mask, modifier) => mask | ({ alt: 1, control: 2, meta: 4, shift: 8 }[modifier] ?? 0),
            0,
          );
          const x = rect.x + rect.width / 2;
          const y = rect.y + rect.height / 2;
          const debuggerSession = contents.debugger;
          const attachedHere = !debuggerSession.isAttached();
          let mouseDown = false;
          try {
            if (attachedHere) debuggerSession.attach("1.3");
            await debuggerSession.sendCommand("Input.dispatchMouseEvent", {
              type: "mouseMoved",
              x,
              y,
              modifiers: modifierMask,
            });
            assertCurrent();
            await debuggerSession.sendCommand("Input.dispatchMouseEvent", {
              type: "mousePressed",
              x,
              y,
              button,
              buttons: button === "left" ? 1 : button === "right" ? 2 : 4,
              clickCount,
              modifiers: modifierMask,
            });
            mouseDown = true;
            assertCurrent();
            await debuggerSession.sendCommand("Input.dispatchMouseEvent", {
              type: "mouseReleased",
              x,
              y,
              button,
              buttons: 0,
              clickCount,
              modifiers: modifierMask,
            });
            mouseDown = false;
          } finally {
            if (mouseDown && debuggerSession.isAttached()) {
              await debuggerSession
                .sendCommand("Input.dispatchMouseEvent", {
                  type: "mouseReleased",
                  x,
                  y,
                  button,
                  buttons: 0,
                  clickCount,
                  modifiers: modifierMask,
                })
                .catch(() => undefined);
            }
            if (attachedHere && debuggerSession.isAttached()) debuggerSession.detach();
          }
          if (waitForLoad) {
            const stopped = await waitForLoad;
            assertCurrent(true);
            if (!stopped) throw new Error("Timed out waiting for the page to stop loading");
          }
          return {
            success: true,
            url: currentUrl(),
            hint: hint("Take a new snapshot to see updated page state and get fresh refs."),
          };
        }
        case "type": {
          const ref = this.requireAgentRef(tab, input.ref);
          const text = this.stringInput(input.text, 16_384);
          const focused = await pageScript<boolean>(contents, focusAgentElement, [ref]);
          assertCurrent();
          if (!focused) throw new NativeBrowserAgentCommandError("stale_ref");
          if (input.clear === true) {
            assertCurrent();
            const cleared = await pageScript<string | null>(contents, setAgentElementValue, [
              ref,
              "",
            ]);
            assertCurrent();
            if (cleared === null) throw new Error("Element is not a text field");
          }
          assertCurrent();
          contents.focus();
          contents.insertText(text);
          const value = (await contents.executeJavaScript(
            `(() => { const element = document.querySelector('[data-mastrawork-agent-ref="${ref}"]'); return element && "value" in element ? String(element.value) : (element?.textContent || ""); })()`,
          )) as string;
          assertCurrent();
          return {
            success: true,
            value: String(value ?? text).slice(0, 16_384),
            url: currentUrl(),
            hint: hint("Take a new snapshot if you need to interact with more elements."),
          };
        }
        case "press": {
          const key = this.stringInput(input.key, 128);
          const parts = key
            .split("+")
            .map((part) => part.trim())
            .filter(Boolean);
          const keyName = parts.at(-1) || key;
          const modifiers = this.modifiersInput(parts.slice(0, -1));
          const keyCode = this.electronKeyCode(keyName);
          assertCurrent();
          contents.focus();
          await contents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
          await contents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
          assertCurrent(true);
          if (typeof input.waitUntil === "string") {
            const stopped = await this.waitForStopLoading(contents, timeout);
            assertCurrent(true);
            if (!stopped) throw new Error("Timed out waiting for the page to stop loading");
          }
          return {
            success: true,
            url: currentUrl(),
            hint: hint("Take a new snapshot if the page may have changed."),
          };
        }
        case "select": {
          const ref = this.requireAgentRef(tab, input.ref);
          const selection = {
            ...(typeof input.value === "string" ? { value: input.value } : {}),
            ...(typeof input.label === "string" ? { label: input.label } : {}),
            ...(typeof input.index === "number" ? { index: input.index } : {}),
          };
          const selected = await pageScript<string[] | null>(contents, selectAgentOption, [
            ref,
            selection,
          ]);
          assertCurrent(true);
          if (!selected) throw new Error("Element is not a select field or option was not found");
          return {
            success: true,
            selected,
            url: currentUrl(),
            hint: hint("Selection complete. Take a snapshot if you need to continue."),
          };
        }
        case "scroll": {
          if (typeof input.ref === "string") {
            const ref = this.requireAgentRef(tab, input.ref);
            assertCurrent();
            await pageScript(
              contents,
              (targetRef: string) => {
                document
                  .querySelector<HTMLElement>(`[data-mastrawork-agent-ref="${targetRef}"]`)
                  ?.scrollIntoView({ block: "center" });
              },
              [ref],
            );
            assertCurrent();
          } else {
            const amount = this.numberInput(input.amount, 300, 1, 10_000);
            const direction = input.direction;
            const delta = {
              x: direction === "left" ? -amount : direction === "right" ? amount : 0,
              y: direction === "up" ? -amount : direction === "down" ? amount : 0,
            };
            assertCurrent();
            await pageScript(contents, (x: number, y: number) => window.scrollBy(x, y), [
              delta.x,
              delta.y,
            ]);
            assertCurrent();
          }
          const scroll = await pageScript<ReturnType<typeof readAgentScroll>>(
            contents,
            readAgentScroll,
            [],
          );
          assertCurrent();
          const message =
            scroll.atTop && !scroll.atBottom
              ? "TOP - more content below"
              : scroll.atBottom
                ? "BOTTOM of page"
                : `${Math.floor((scroll.y / Math.max(scroll.max, 1)) * 100)}% down`;
          return {
            success: true,
            position: { x: scroll.x, y: scroll.y },
            scroll: message,
            hint: hint("Take a new snapshot to see elements in the new viewport."),
          };
        }
        case "hover": {
          const ref = this.requireAgentRef(tab, input.ref);
          const rect = await pageScript<ReturnType<typeof readAgentElement> | null>(
            contents,
            readAgentElement,
            [ref],
          );
          assertCurrent();
          if (!rect) throw new NativeBrowserAgentCommandError("stale_ref");
          contents.focus();
          await contents.sendInputEvent({
            type: "mouseMove",
            x: rect.x + rect.width / 2,
            y: rect.y + rect.height / 2,
          });
          return {
            success: true,
            url: currentUrl(),
            hint: hint(
              "Take a new snapshot to see any hover-triggered elements (dropdowns, tooltips).",
            ),
          };
        }
        case "back": {
          const history = contents.navigationHistory;
          assertCurrent();
          if (history.canGoBack()) {
            const navigated = this.waitForNavigation(contents, timeout);
            history.goBack();
            if (!(await navigated))
              throw new Error("Timed out waiting for the previous page to load");
            assertCurrent(true);
          }
          return {
            success: true,
            url: currentUrl(),
            title: title(),
            hint: hint("Take a new snapshot to see the previous page."),
          };
        }
        case "wait": {
          const ref =
            typeof input.ref === "string" ? this.requireAgentRef(tab, input.ref) : undefined;
          const state = typeof input.state === "string" ? input.state : "visible";
          const deadline = Date.now() + timeout;
          if (!ref) {
            await new Promise((resolve) => setTimeout(resolve, timeout));
            assertCurrent();
          } else {
            let ready = false;
            while (Date.now() < deadline) {
              assertCurrent();
              ready = await pageScript<boolean>(contents, testAgentRef, [ref, state]);
              assertCurrent();
              if (ready) break;
              await new Promise((resolve) => setTimeout(resolve, 100));
            }
            if (!ready) throw new Error(`Timed out waiting for ${state} element ${ref}`);
          }
          return { success: true, hint: `Wait complete. Take a snapshot to see current state.` };
        }
        case "drag": {
          const sourceRef =
            typeof input.sourceRef === "string" ? this.requireAgentRef(tab, input.sourceRef) : null;
          const sourceSelector =
            typeof input.sourceSelector === "string"
              ? this.stringInput(input.sourceSelector, 2_048)
              : null;
          const targetRef =
            typeof input.targetRef === "string" ? this.requireAgentRef(tab, input.targetRef) : null;
          const targetSelector =
            typeof input.targetSelector === "string"
              ? this.stringInput(input.targetSelector, 2_048)
              : null;
          if (!sourceRef && !sourceSelector) throw new Error("Missing sourceRef or sourceSelector");
          if (!targetRef && !targetSelector) throw new Error("Missing targetRef or targetSelector");
          const readTarget = (ref: string | null, selector: string | null) =>
            pageScript<ReturnType<typeof readAgentDragElement> | null>(
              contents,
              readAgentDragElement,
              [ref, selector],
            );
          const source = await readTarget(sourceRef, sourceSelector);
          const target = await readTarget(targetRef, targetSelector);
          assertCurrent();
          if (!source || !target) throw new Error("Drag source or target was not found or visible");
          const sx = source.x + source.width / 2;
          const sy = source.y + source.height / 2;
          const tx = target.x + target.width / 2;
          const ty = target.y + target.height / 2;
          assertCurrent();
          contents.focus();
          await pageScript(contents, beginAgentDragObservation, []);
          let observedEvents: string[] = [];
          const debuggerSession = contents.debugger;
          const attachedHere = !debuggerSession.isAttached();
          let interceptEnabled = false;
          let mouseDown = false;
          let lastX = sx;
          let lastY = sy;
          let resolveDragData: (data: NativeAgentDragData) => void = () => undefined;
          const interceptedDrag = new Promise<NativeAgentDragData>((resolve) => {
            resolveDragData = resolve;
          });
          const onDebuggerMessage = (
            _event: Electron.Event,
            method: string,
            params: { data?: NativeAgentDragData },
          ) => {
            const data = params.data;
            if (method === "Input.dragIntercepted" && data) resolveDragData(data);
          };
          try {
            if (attachedHere) debuggerSession.attach("1.3");
            debuggerSession.on("message", onDebuggerMessage);
            await debuggerSession.sendCommand("Input.setInterceptDrags", { enabled: true });
            interceptEnabled = true;
            assertCurrent();
            await debuggerSession.sendCommand("Input.dispatchMouseEvent", {
              type: "mouseMoved",
              x: sx,
              y: sy,
            });
            assertCurrent();
            await debuggerSession.sendCommand("Input.dispatchMouseEvent", {
              type: "mousePressed",
              x: sx,
              y: sy,
              button: "left",
              buttons: 1,
              clickCount: 1,
            });
            mouseDown = true;
            assertCurrent();

            const distance = Math.hypot(tx - sx, ty - sy);
            const steps = Math.min(24, Math.max(4, Math.ceil(distance / 32)));
            let dragData: NativeAgentDragData | undefined;
            for (let step = 1; step <= steps; step += 1) {
              assertCurrent();
              const progress = step / steps;
              lastX = sx + (tx - sx) * progress;
              lastY = sy + (ty - sy) * progress;
              if (!dragData) {
                await debuggerSession.sendCommand("Input.dispatchMouseEvent", {
                  type: "mouseMoved",
                  x: lastX,
                  y: lastY,
                  button: "left",
                  buttons: 1,
                });
                assertCurrent();
                dragData =
                  (await Promise.race([
                    interceptedDrag,
                    new Promise<null>((resolve) => setTimeout(() => resolve(null), 16)),
                  ])) ?? undefined;
                if (dragData) {
                  await debuggerSession.sendCommand("Input.setInterceptDrags", {
                    enabled: false,
                  });
                  interceptEnabled = false;
                  assertCurrent();
                  await debuggerSession.sendCommand("Input.dispatchDragEvent", {
                    type: "dragEnter",
                    x: lastX,
                    y: lastY,
                    data: dragData,
                  });
                  assertCurrent();
                }
              } else {
                assertCurrent();
                await debuggerSession.sendCommand("Input.dispatchDragEvent", {
                  type: "dragOver",
                  x: lastX,
                  y: lastY,
                  data: dragData,
                });
                assertCurrent();
              }
            }
            if (!dragData) {
              dragData = await this.withTimeout(
                interceptedDrag,
                Math.min(timeout, 3_000),
                "Timed out waiting for Chromium to intercept a native drag",
              );
              await debuggerSession.sendCommand("Input.setInterceptDrags", { enabled: false });
              interceptEnabled = false;
              assertCurrent();
              await debuggerSession.sendCommand("Input.dispatchDragEvent", {
                type: "dragEnter",
                x: lastX,
                y: lastY,
                data: dragData,
              });
              assertCurrent();
            }

            assertCurrent();
            await debuggerSession.sendCommand("Input.dispatchDragEvent", {
              type: "dragOver",
              x: tx,
              y: ty,
              data: dragData,
            });
            assertCurrent();
            await debuggerSession.sendCommand("Input.dispatchDragEvent", {
              type: "drop",
              x: tx,
              y: ty,
              data: dragData,
            });
            assertCurrent(true);
            if (mouseDown) {
              await debuggerSession.sendCommand("Input.dispatchMouseEvent", {
                type: "mouseReleased",
                x: tx,
                y: ty,
                button: "left",
                buttons: 0,
                clickCount: 1,
              });
              mouseDown = false;
            }
            await new Promise((resolve) => setTimeout(resolve, 50));
          } finally {
            if (interceptEnabled && debuggerSession.isAttached()) {
              await debuggerSession
                .sendCommand("Input.setInterceptDrags", { enabled: false })
                .catch(() => undefined);
            }
            if (mouseDown && debuggerSession.isAttached()) {
              await debuggerSession
                .sendCommand("Input.dispatchMouseEvent", {
                  type: "mouseReleased",
                  x: lastX,
                  y: lastY,
                  button: "left",
                  buttons: 0,
                  clickCount: 1,
                })
                .catch(() => undefined);
            }
            debuggerSession.removeListener("message", onDebuggerMessage);
            if (attachedHere && debuggerSession.isAttached()) {
              debuggerSession.detach();
            }
            if (!contents.isDestroyed()) {
              observedEvents = await pageScript<string[]>(
                contents,
                finishAgentDragObservation,
                [],
              ).catch(() => []);
            }
          }
          assertCurrent();
          const requiredEvents = ["dragstart", "dragenter", "dragover", "drop", "dragend"];
          // Chromium's CDP drop path may finish the HTML drag lifecycle without
          // exposing a DOM mouseup. The button release is still sent above; a
          // successful drop is determined by the drag lifecycle, not mouseup.
          const missingEvents = requiredEvents.filter((event) => !observedEvents.includes(event));
          if (missingEvents.length)
            throw new Error(`Page did not complete drag: ${missingEvents.join(", ")}`);
          return {
            success: true,
            url: currentUrl(),
            observedEvents,
            hint: hint("Drag input completed. Check the target page state to confirm its effect."),
          };
        }
        case "evaluate": {
          const script = this.stringInput(input.script, 16_384);
          assertCurrent();
          const result = await contents.executeJavaScript(script);
          assertCurrent();
          const resultBytes = Buffer.byteLength(JSON.stringify(result) ?? "null");
          if (resultBytes > MAX_AGENT_EVALUATE_BYTES) {
            throw new NativeBrowserAgentCommandError("response_too_large");
          }
          return {
            success: true,
            result: result === undefined ? null : result,
            hint: hint("JavaScript executed. Take a snapshot if the page may have changed."),
          };
        }
        case "tabs": {
          return await this.executeAgentTabs(current, input);
        }
        case "state":
          return { state: this.state(current), visible: this.isActiveViewVisible(current) };
      }
    } catch (error) {
      if (error instanceof NativeBrowserAgentCommandError) throw error;
      throw new NativeBrowserAgentCommandError("operation_failed");
    }
  }

  private async executeAgentTabs(
    current: NativeSession,
    input: Record<string, unknown>,
  ): Promise<unknown> {
    const action = input.action;
    switch (action) {
      case "list":
        return {
          success: true,
          tabs: current.tabs.map((tab, index) => ({
            index,
            url: tab.url,
            title: tab.title,
            active: index === current.activeTabIndex,
          })),
          hint: 'Use browser_tabs with action:"switch" and index to change tabs.',
        };
      case "new": {
        const index = current.tabs.length;
        const url =
          typeof input.url === "string"
            ? BrowserNavigateRequestSchema.parse({ url: input.url }).url
            : ABOUT_BLANK;
        await this.createTab(current, url);
        return {
          success: true,
          index,
          url,
          title: "New tab",
          hint: "New tab opened. Take a snapshot to see its content.",
        };
      }
      case "switch": {
        const index = this.numberInput(input.index, -1, 0, Math.max(current.tabs.length - 1, 0));
        if (!Number.isInteger(index) || index >= current.tabs.length)
          throw new Error("Tab index is out of range");
        current.activeTabIndex = index;
        this.invalidateAgentRefs(current);
        this.emitState(current);
        const tab = this.activeTab(current);
        return {
          success: true,
          index,
          url: tab.url,
          title: tab.title,
          hint: "Tab switched. Take a snapshot to see its content.",
        };
      }
      case "close": {
        const index = this.numberInput(
          input.index,
          current.activeTabIndex,
          0,
          Math.max(current.tabs.length - 1, 0),
        );
        if (!Number.isInteger(index) || index >= current.tabs.length)
          throw new Error("Tab index is out of range");
        await this.closeTab(current, index);
        return {
          success: true,
          remaining: current.tabs.length,
          hint: "Tab closed. Take a snapshot to see the current tab.",
        };
      }
      default:
        throw new Error("Unsupported browser tab action");
    }
  }

  private isTabStillActive(current: NativeSession, tab: NativeTab): boolean {
    return current.tabs[current.activeTabIndex] === tab && this.isActiveViewVisible(current);
  }

  private invalidateAgentRefs(current: NativeSession): void {
    for (const tab of current.tabs) tab.refs.clear();
  }

  private stringInput(value: unknown, maxLength: number): string {
    if (typeof value !== "string" || value.length > maxLength)
      throw new Error("Invalid string input");
    return value;
  }

  private numberInput(value: unknown, fallback: number, min: number, max: number): number {
    if (value === undefined) return fallback;
    if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
      throw new Error("Invalid numeric input");
    }
    return value;
  }

  private modifiersInput(value: unknown): Array<"shift" | "control" | "alt" | "meta"> {
    if (!Array.isArray(value)) return [];
    const modifiers: Record<string, "shift" | "control" | "alt" | "meta"> = {
      shift: "shift",
      control: "control",
      ctrl: "control",
      alt: "alt",
      option: "alt",
      meta: "meta",
      command: "meta",
    };
    return value.flatMap((modifier) => {
      if (typeof modifier !== "string") return [];
      const normalized = modifiers[modifier.toLowerCase()];
      return normalized ? [normalized] : [];
    });
  }

  private electronKeyCode(key: string): string {
    const known: Record<string, string> = {
      Enter: "ENTER",
      Return: "ENTER",
      Tab: "TAB",
      Escape: "ESC",
      Backspace: "BACKSPACE",
      Delete: "DELETE",
      ArrowUp: "UP",
      ArrowDown: "DOWN",
      ArrowLeft: "LEFT",
      ArrowRight: "RIGHT",
      Home: "HOME",
      End: "END",
      PageUp: "PAGEUP",
      PageDown: "PAGEDOWN",
      Space: "SPACE",
    };
    return known[key] ?? key.toUpperCase();
  }

  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    message: string,
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new NativeBrowserAgentOperationTimeoutError(message)),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private waitForStopLoading(contents: WebContents, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout>;
      const done = (stopped: boolean) => {
        clearTimeout(timer);
        contents.removeListener("did-stop-loading", onStopped);
        resolve(stopped);
      };
      const onStopped = () => done(true);
      timer = setTimeout(() => done(false), timeoutMs);
      contents.once("did-stop-loading", onStopped);
    });
  }

  private waitForNavigation(contents: WebContents, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout>;
      const done = (navigated: boolean) => {
        clearTimeout(timer);
        contents.removeListener("did-stop-loading", onLoaded);
        contents.removeListener("did-navigate-in-page", onInPageNavigation);
        resolve(navigated);
      };
      const onLoaded = () => done(true);
      const onInPageNavigation = () => done(true);
      timer = setTimeout(() => done(false), timeoutMs);
      contents.once("did-stop-loading", onLoaded);
      contents.once("did-navigate-in-page", onInPageNavigation);
    });
  }

  close(rawSession: unknown): void {
    const session = NativeBrowserSessionSchema.parse(rawSession);
    const key = this.sessionKey(session);
    const current = this.sessions.get(key);
    if (!current) return;
    this.sessions.delete(key);
    this.invalidateAgentCommands(current, true);
    this.disposeTabs(current);
    this.emitState(current);
  }

  dispose(): void {
    for (const current of [...this.sessions.values()]) this.close(current.session);
    for (const guest of this.unboundGuests) {
      if (!guest.isDestroyed()) guest.close({ waitForBeforeUnload: false });
    }
    this.unboundGuests.clear();
  }

  private getOrCreate(session: NativeBrowserSession): NativeSession {
    const key = this.sessionKey(session);
    const current = this.sessions.get(key);
    if (current) return current;
    const config = this.configs.get(session.resourceId);
    if (config?.provider !== "agent") throw new Error("Native browser is not configured");
    const partition = `mastra-browser-${randomUUID()}`;
    const isolated = electronSession.fromPartition(partition);
    isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    isolated.setPermissionCheckHandler(() => false);
    const created: NativeSession = {
      key,
      session,
      partition,
      tabs: [],
      activeTabIndex: 0,
      bounds: { ...session, ...EMPTY_BOUNDS },
      agentGeneration: 0,
      operationQueue: Promise.resolve(),
    };
    this.sessions.set(key, created);
    return created;
  }

  private activeTab(current: NativeSession): NativeTab {
    const tab = current.tabs[current.activeTabIndex];
    if (!tab) throw new Error("Native browser has no active tab");
    return tab;
  }

  private contents(tab: NativeTab): WebContents {
    if (!tab.contents || tab.contents.isDestroyed())
      throw new NativeBrowserAgentCommandError("session_not_visible");
    return tab.contents;
  }

  private async createTab(current: NativeSession, url: string): Promise<void> {
    if (current.tabs.length >= MAX_NATIVE_BROWSER_TABS)
      throw new NativeBrowserAgentCommandError("tab_limit_reached");
    const normalized = url === ABOUT_BLANK ? url : BrowserNavigateRequestSchema.parse({ url }).url;
    await electronSession.fromPartition(current.partition).setProxy(this.proxy);
    if (this.sessions.get(current.key) !== current)
      throw new NativeBrowserAgentCommandError("session_not_found");
    current.tabs.push({
      id: randomUUID(),
      url: normalized,
      title: "New tab",
      refs: new Set(),
      nextAgentRefIndex: 1,
      documentGeneration: 0,
    });
    current.activeTabIndex = current.tabs.length - 1;
    this.invalidateAgentRefs(current);
    this.emitState(current);
  }

  private disposeTabs(current: NativeSession): void {
    const tabs = current.tabs.splice(0);
    current.activeTabIndex = 0;
    for (const tab of tabs) {
      if (tab.contents && !tab.contents.isDestroyed())
        tab.contents.close({ waitForBeforeUnload: false });
    }
  }

  private attachTabEvents(current: NativeSession, tab: NativeTab): void {
    const contents = this.contents(tab);
    // Guest keyboard events do not bubble into the host DOM.
    contents.on("before-input-event", (event, input) => {
      const modifier = process.platform === "darwin" ? input.meta : input.control;
      if (
        input.type !== "keyDown" ||
        !modifier ||
        input.alt ||
        input.shift ||
        input.key.toLowerCase() !== "k"
      )
        return;
      event.preventDefault();
      this.window.webContents.focus();
      this.window.webContents.sendInputEvent({
        type: "keyDown",
        keyCode: "K",
        modifiers: [process.platform === "darwin" ? "meta" : "control"],
      });
    });
    contents.on("will-navigate", (event, url) => {
      if (url !== ABOUT_BLANK && !isWebUrl(url)) event.preventDefault();
    });
    contents.on("will-redirect", (event, url) => {
      if (!isWebUrl(url)) event.preventDefault();
    });
    contents.on("will-frame-navigate", (event) => {
      if (event.url !== ABOUT_BLANK && !isWebUrl(event.url)) event.preventDefault();
    });

    const emit = () => {
      this.invalidateAgentRefs(current);
      tab.url = this.contents(tab).getURL() || ABOUT_BLANK;
      tab.title = normalizeTabTitle(this.contents(tab).getTitle());
      this.emitState(current);
    };
    this.contents(tab).on("did-start-loading", () =>
      this.emitEvent({ type: "loading", ...current.session, loading: true }),
    );
    this.contents(tab).on("did-start-navigation", (_event, _url, _inPlace, isMainFrame) => {
      if (!isMainFrame) return;
      tab.documentGeneration += 1;
      tab.refs.clear();
    });
    this.contents(tab).on("did-stop-loading", () => {
      emit();
      this.emitEvent({ type: "loading", ...current.session, loading: false });
    });
    this.contents(tab).on("did-navigate", emit);
    this.contents(tab).on("did-navigate-in-page", () => {
      tab.documentGeneration += 1;
      emit();
    });
    this.contents(tab).on("page-title-updated", (_event, title) => {
      tab.title = normalizeTabTitle(title);
      this.emitEvent({ type: "title", ...current.session, title: tab.title });
      this.emitState(current);
    });
    this.contents(tab).on(
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
    this.contents(tab).on("render-process-gone", (_event, details) => {
      if (details.reason === "clean-exit" || this.window.isDestroyed()) return;
      this.emitEvent({
        type: "error",
        ...current.session,
        message: `Browser page process exited (${details.reason}, exit code ${details.exitCode})`,
      });
    });
    this.contents(tab).setWindowOpenHandler(({ url }) => {
      if (isWebUrl(url)) {
        void this.enqueueAgentCommand(current, () => this.createTab(current, url)).catch(
          (error: unknown) => {
            this.emitEvent({
              type: "error",
              ...current.session,
              message: error instanceof Error ? error.message : String(error),
            });
          },
        );
      }
      return { action: "deny" };
    });
  }

  private async closeTab(current: NativeSession, index: number): Promise<void> {
    if (index < 0 || index >= current.tabs.length) return;
    const [removed] = current.tabs.splice(index, 1);
    this.invalidateAgentRefs(current);
    if (removed.contents && !removed.contents.isDestroyed())
      removed.contents.close({ waitForBeforeUnload: false });
    current.activeTabIndex = Math.max(
      0,
      current.activeTabIndex - (index <= current.activeTabIndex ? 1 : 0),
    );
    this.emitState(current);
  }

  private async resetTabs(current: NativeSession): Promise<void> {
    this.disposeTabs(current);
    await this.createTab(current, this.homeUrl(current));
  }

  private state(current: NativeSession): BrowserState {
    const active = current.tabs[current.activeTabIndex];
    return {
      active: Boolean(active),
      status: active ? (active.contents ? "ready" : "starting") : "closed",
      currentUrl: active && active.url !== ABOUT_BLANK ? active.url : null,
      tabs: current.tabs.map((tab) => ({ id: tab.id, url: tab.url, title: tab.title })),
      activeTabIndex: current.activeTabIndex,
    };
  }

  private emitState(current: NativeSession): void {
    this.emitSurfaces();
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
