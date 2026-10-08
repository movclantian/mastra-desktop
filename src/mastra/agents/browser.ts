import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
/** Resource-scoped browser configuration and lifecycle. */
import {
  AgentBrowser,
  type AgentBrowserConfig,
  type ClickInput,
  type DragInput,
  type EvaluateInput,
  type GotoInput,
  type HoverInput,
  type PressInput,
  type ScrollInput,
  type SelectInput,
  type SnapshotInput,
  type TabsInput,
  type TypeInput,
  type WaitInput,
} from "@mastra/agent-browser";
import { FirecrawlBrowser } from "@mastra/browser-firecrawl";
import type {
  BrowserTabState,
  BrowserToolError,
  BrowserState as MastraBrowserState,
  ScreencastOptions,
  ScreencastStream,
} from "@mastra/core/browser";
import { createTool } from "@mastra/core/tools";
import {
  type BrowserConfig,
  BrowserConfigSchema,
  BrowserStateSchema,
  DEFAULT_BROWSER_CONFIG,
  NativeBrowserAgentCommandRequestSchema,
  NativeBrowserAgentCommandResponseSchema,
  type NativeBrowserAgentOperation,
} from "../../shared/browser-contract";
import { browserCredentialPurpose } from "../../shared/credential-contract";
import { deleteCredential, resolveCredential } from "../credential-broker";
import { contentObjectReference, putContentObject } from "../storage/content-objects";
import { getAppConfig, setAppConfig, userIdFromContext } from "../storage/database";
import { WORKSPACE_THREAD_ID_CONTEXT_KEY } from "../workspace/workspace-manager";

const BROWSER_CONFIG_KEY = "browser";

export type WorkBrowser = NativeElectronAgentBrowser | FirecrawlBrowser;

/** Resolve and merge browser tools only when a workbench thread can bind them to its page. */
export async function mergeBrowserToolsForThread<T extends object>(
  tools: T,
  threadId: unknown,
  resolveBrowser: () => Promise<Pick<WorkBrowser, "getTools">>,
): Promise<T> {
  if (typeof threadId !== "string" || !threadId.trim()) return tools;
  const browser = await resolveBrowser();
  const browserTools = browser.getTools();
  // createTool supplies the public, organized context before we bind the page.
  // Replacing Tool.execute directly intercepts the framework's internal flat context.
  for (const [name, tool] of Object.entries(browserTools)) {
    const execute = tool.execute;
    if (!execute) continue;
    browserTools[name] = createTool({
      ...tool,
      execute: async (input, context) => {
        const result = await execute(input, {
          ...context,
          agent: context?.agent ? { ...context.agent, threadId } : undefined,
        });
        if (
          name !== "browser_screenshot" ||
          !result ||
          typeof result !== "object" ||
          !("base64" in result) ||
          typeof result.base64 !== "string"
        )
          return result;
        const { base64, ...metadata } = result;
        const userId = userIdFromContext(context?.requestContext);
        if (!userId) throw new Error("Screenshot storage requires an authenticated user");
        const image = await putContentObject(Buffer.from(base64, "base64"), {
          userId,
          threadId,
          kind: "screenshot",
          contentType: "image/png",
          encoding: "binary",
        });
        return {
          ...metadata,
          imageUrl: `mastra-image:///${encodeURIComponent(userId)}/${encodeURIComponent(threadId)}/${image.objectId}`,
          contentObject: contentObjectReference(image),
        };
      },
      ...(name === "browser_screenshot"
        ? {
            toModelOutput: (output: unknown) => {
              if (!output || typeof output !== "object" || !("imageUrl" in output))
                return tool.toModelOutput?.(output);
              return {
                type: "content",
                value: [{ type: "image-url", url: output.imageUrl, mediaType: "image/png" }],
              };
            },
          }
        : {}),
    });
  }
  Object.assign(tools, browserTools);
  return tools;
}

export async function getBrowserConfig(resourceId?: string): Promise<BrowserConfig> {
  const raw = await getAppConfig(BROWSER_CONFIG_KEY, resourceId);
  if (!raw) return DEFAULT_BROWSER_CONFIG;
  try {
    return BrowserConfigSchema.parse(JSON.parse(raw));
  } catch {
    return DEFAULT_BROWSER_CONFIG;
  }
}

export async function saveBrowserConfig(
  value: unknown,
  resourceId?: string,
): Promise<BrowserConfig> {
  const next = BrowserConfigSchema.parse(value);
  const current = await getBrowserConfig(resourceId);
  if (next.firecrawl.credential.hasCredential) {
    await resolveCredential(
      next.firecrawl.credential.credentialRef,
      browserCredentialPurpose("firecrawl"),
    );
  }
  await setAppConfig(BROWSER_CONFIG_KEY, JSON.stringify(next, null, 2), resourceId);
  const oldCredential = current.firecrawl.credential;
  const newCredential = next.firecrawl.credential;
  if (
    oldCredential.hasCredential &&
    (!newCredential.hasCredential || oldCredential.credentialRef !== newCredential.credentialRef)
  ) {
    await deleteCredential(
      oldCredential.credentialRef,
      browserCredentialPurpose("firecrawl"),
    ).catch(() => undefined);
  }
  await replaceBrowserForResource(resourceId);
  return next;
}

function commonOptions(config: BrowserConfig) {
  return {
    scope: config.scope,
    viewport: "window" as const,
    timeout: config.timeout,
    screencast: {
      format: "jpeg" as const,
      quality: 80,
      maxWidth: 1280,
      maxHeight: 720,
      everyNthFrame: 1,
    },
  };
}

const HAS_NATIVE_BROWSER_AGENT_BRIDGE = Boolean(
  process.env.MASTRA_NATIVE_BROWSER_AGENT_BROKER_PATH?.trim(),
);

class NativeElectronAgentBrowser extends AgentBrowser {
  private readonly operationTimeout: number;
  private readonly knownThreads = new Set<string>();
  private readonly states = new Map<string, MastraBrowserState>();

  constructor(
    options: AgentBrowserConfig,
    private readonly resourceId: string,
    threadId: string,
  ) {
    super({ ...options, scope: "shared" });
    this.operationTimeout = options.timeout ?? 30_000;
    this.setCurrentThread(threadId);
    this.status = "ready";
  }

  override getTools() {
    const tools = super.getTools();
    // The Electron window owns its lifetime; the Agent can only change tabs within
    // the already-bound, visible thread session.
    delete tools.browser_close;
    delete tools.browser_dialog;
    return tools;
  }

  override async ensureReady(): Promise<void> {
    // A desktop browser session is renderer-owned; never launch an invisible Chromium fallback.
    this.status = "ready";
  }

  protected override async doLaunch(): Promise<void> {
    this.status = "ready";
  }

  protected override async doClose(): Promise<void> {
    // The Electron view manager owns the page lifecycle.
    this.status = "ready";
  }

  protected override isRemoteThreadBrowser(): boolean {
    return true;
  }

  override hasThreadSession(threadId: string): boolean {
    return this.knownThreads.has(threadId);
  }

  override async closeThreadSession(threadId: string): Promise<void> {
    this.knownThreads.delete(threadId);
    this.states.delete(threadId);
  }

  override async getBrowserState(threadId?: string): Promise<MastraBrowserState | null> {
    const id = this.threadId(threadId);
    if (!id) return null;
    const result = await this.command<{ state: unknown; visible: boolean }>(id, "state");
    if (!result.state) {
      this.knownThreads.delete(id);
      this.states.delete(id);
      return null;
    }
    if (!result.visible) {
      this.knownThreads.delete(id);
      this.states.delete(id);
      return null;
    }
    const parsed = BrowserStateSchema.parse(result.state);
    const state: MastraBrowserState = {
      tabs: parsed.tabs,
      activeTabIndex: parsed.activeTabIndex,
      ...(parsed.closeReason ? { closeReason: parsed.closeReason } : {}),
      ...(parsed.activeUrlChangeSource
        ? { activeUrlChangeSource: parsed.activeUrlChangeSource }
        : {}),
    };
    this.knownThreads.add(id);
    this.states.set(id, state);
    return state;
  }

  override async getCurrentUrl(threadId?: string): Promise<string | null> {
    const state = await this.getBrowserState(threadId);
    return state?.tabs[state.activeTabIndex]?.url ?? null;
  }

  override async getTabState(threadId?: string): Promise<BrowserTabState[]> {
    return (await this.getBrowserState(threadId))?.tabs ?? [];
  }

  override async getActiveTabIndex(threadId?: string): Promise<number> {
    return (await this.getBrowserState(threadId))?.activeTabIndex ?? 0;
  }

  protected override getBrowserStateForThread(threadId?: string): MastraBrowserState | null {
    const id = this.threadId(threadId);
    return id ? (this.states.get(id) ?? null) : null;
  }

  override goto(input: GotoInput, threadId?: string) {
    return this.invoke("goto", input, threadId, "Goto");
  }

  override snapshot(input: SnapshotInput, threadId?: string) {
    return this.invoke("snapshot", input, threadId, "Snapshot");
  }

  override screenshot(input: Parameters<AgentBrowser["screenshot"]>[0], threadId?: string) {
    return this.invoke("screenshot", input, threadId, "Screenshot");
  }

  override click(input: ClickInput, threadId?: string) {
    return this.invoke("click", input, threadId, "Click");
  }

  override type(input: TypeInput, threadId?: string) {
    return this.invoke("type", input, threadId, "Type");
  }

  override press(input: PressInput, threadId?: string) {
    return this.invoke("press", input, threadId, "Press");
  }

  override select(input: SelectInput, threadId?: string) {
    return this.invoke("select", input, threadId, "Select");
  }

  override scroll(input: ScrollInput, threadId?: string) {
    return this.invoke("scroll", input, threadId, "Scroll");
  }

  override hover(input: HoverInput, threadId?: string) {
    return this.invoke("hover", input, threadId, "Hover");
  }

  override back(threadId?: string) {
    return this.invoke("back", {}, threadId, "Back");
  }

  override wait(input: WaitInput, threadId?: string) {
    return this.invoke("wait", input, threadId, "Wait");
  }

  override drag(input: DragInput, threadId?: string) {
    return this.invoke("drag", input, threadId, "Drag");
  }

  override evaluate(input: EvaluateInput, threadId?: string) {
    return this.invoke("evaluate", input, threadId, "Evaluate");
  }

  override tabs(input: TabsInput, threadId?: string) {
    return this.invoke("tabs", input, threadId, "Tabs");
  }

  override async startScreencast(_options?: ScreencastOptions): Promise<ScreencastStream> {
    throw new Error(
      "The desktop browser is rendered by its native Electron view; screenshot streaming is disabled.",
    );
  }

  private threadId(threadId?: string): string | null {
    const id = threadId ?? this.getCurrentThread();
    return id.trim() ? id : null;
  }

  private async command<T>(
    threadId: string,
    operation: NativeBrowserAgentOperation,
    input?: Record<string, unknown>,
  ): Promise<T> {
    return executeNativeBrowserCommand<T>({ resourceId: this.resourceId, threadId }, operation, {
      timeout: this.operationTimeout,
      ...input,
    });
  }

  private async invoke<K extends Exclude<NativeBrowserAgentOperation, "state">>(
    operation: K,
    input: object,
    threadId: string | undefined,
    label: string,
  ): Promise<Awaited<ReturnType<AgentBrowser[K]>> | BrowserToolError> {
    const id = this.threadId(threadId);
    if (!id) return this.createError("browser_error", "Browser operation requires a bound thread.");
    try {
      await this.ensureReady();
      return await this.command<Awaited<ReturnType<AgentBrowser[K]>>>(
        id,
        operation,
        input as Record<string, unknown>,
      );
    } catch (error) {
      return this.createErrorFromException(error, label);
    }
  }
}

async function createBrowser(
  config: BrowserConfig,
  resourceId?: string,
  threadId?: string,
): Promise<WorkBrowser> {
  if (config.provider === "agent") {
    const options = commonOptions(config);
    if (!HAS_NATIVE_BROWSER_AGENT_BRIDGE || !threadId) {
      throw new Error("Native Agent browser requires an Electron bridge and a bound thread");
    }
    return new NativeElectronAgentBrowser(options, resourceId || "default", threadId);
  }
  const credential = config.firecrawl.credential;
  if (!credential.hasCredential) throw new Error("Firecrawl credential is required");
  const apiKey = await resolveCredential(
    credential.credentialRef,
    browserCredentialPurpose("firecrawl"),
  );
  return new FirecrawlBrowser({
    ...commonOptions(config),
    apiKey,
    ...(config.firecrawl.apiUrl ? { apiUrl: config.firecrawl.apiUrl } : {}),
    firecrawl: {
      ttl: config.firecrawl.ttl,
      activityTtl: config.firecrawl.activityTtl,
      streamWebView: config.firecrawl.streamWebView,
    },
  });
}

const browsers = new Map<string, WorkBrowser>();
const browserPromises = new Map<string, Promise<WorkBrowser>>();
const threadBrowsers = new Map<string, Map<string, WorkBrowser>>();
const threadBrowserPromises = new Map<string, Map<string, Promise<WorkBrowser>>>();

export async function getBrowserForResource(resourceId = "default"): Promise<WorkBrowser> {
  const key = resourceId;
  const existing = browsers.get(key);
  if (existing) return existing;
  const pending = browserPromises.get(key);
  if (pending) return pending;
  const creation = createBrowser(await getBrowserConfig(resourceId), resourceId);
  browserPromises.set(key, creation);
  try {
    const browser = await creation;
    browsers.set(key, browser);
    return browser;
  } finally {
    if (browserPromises.get(key) === creation) browserPromises.delete(key);
  }
}

export async function getBrowserForThread(
  resourceId: string,
  threadId: string,
): Promise<WorkBrowser> {
  const config = await getBrowserConfig(resourceId);
  if (config.provider !== "agent") {
    return getBrowserForResource(resourceId);
  }

  let resourceBrowsers = threadBrowsers.get(resourceId);
  if (!resourceBrowsers) {
    resourceBrowsers = new Map();
    threadBrowsers.set(resourceId, resourceBrowsers);
  }
  const existing = resourceBrowsers.get(threadId);
  if (existing) return existing;

  let resourcePromises = threadBrowserPromises.get(resourceId);
  if (!resourcePromises) {
    resourcePromises = new Map();
    threadBrowserPromises.set(resourceId, resourcePromises);
  }
  const pending = resourcePromises.get(threadId);
  if (pending) return pending;

  const creation = createBrowser(config, resourceId, threadId);
  resourcePromises.set(threadId, creation);
  try {
    const browser = await creation;
    resourceBrowsers.set(threadId, browser);
    return browser;
  } finally {
    if (resourcePromises.get(threadId) === creation) resourcePromises.delete(threadId);
    if (resourcePromises.size === 0) threadBrowserPromises.delete(resourceId);
  }
}

export async function getBrowserForRequest(requestContext?: { get: (key: string) => unknown }) {
  const resourceId = userIdFromContext(requestContext);
  const threadId = requestContext?.get(WORKSPACE_THREAD_ID_CONTEXT_KEY);
  const effectiveResourceId = resourceId ?? "default";
  if ((await getBrowserConfig(effectiveResourceId)).provider === "agent") {
    if (typeof threadId !== "string" || !threadId.trim()) {
      throw new Error("Native Agent browser requires a bound thread");
    }
    return getBrowserForThread(effectiveResourceId, threadId);
  }
  return getBrowserForResource(effectiveResourceId);
}

export async function closeBrowserThreadSessions(
  resourceId: string,
  threadId: string,
): Promise<void> {
  const threadBrowser = threadBrowsers.get(resourceId)?.get(threadId);
  threadBrowsers.get(resourceId)?.delete(threadId);
  if (threadBrowsers.get(resourceId)?.size === 0) threadBrowsers.delete(resourceId);
  if (threadBrowser) await threadBrowser.close().catch(() => undefined);
  const browser = browsers.get(resourceId);
  if (browser?.hasThreadSession(threadId)) await browser.closeThreadSession(threadId);
}

async function replaceBrowserForResource(resourceId = "default"): Promise<void> {
  const old = browsers.get(resourceId);
  browsers.delete(resourceId);
  const pending = browserPromises.get(resourceId);
  if (pending) {
    const created = await pending.catch(() => undefined);
    if (created) {
      browsers.delete(resourceId);
      await created.close().catch(() => undefined);
    }
  }
  if (old) await old.close().catch(() => undefined);
  const oldThreadBrowsers = [...(threadBrowsers.get(resourceId)?.values() ?? [])];
  threadBrowsers.delete(resourceId);
  const pendingThreadBrowsers = [...(threadBrowserPromises.get(resourceId)?.values() ?? [])];
  threadBrowserPromises.delete(resourceId);
  const createdThreadBrowsers = await Promise.allSettled(pendingThreadBrowsers);
  await Promise.allSettled(
    [
      ...oldThreadBrowsers,
      ...createdThreadBrowsers.flatMap((result) =>
        result.status === "fulfilled" ? [result.value] : [],
      ),
    ].map((browser) => browser.close()),
  );
}

export async function closeAllBrowsers(): Promise<void> {
  const pending = [...browserPromises.values()];
  const created = await Promise.allSettled(pending);
  const pendingThread = [...threadBrowserPromises.values()].flatMap((entries) => [
    ...entries.values(),
  ]);
  const createdThread = await Promise.allSettled(pendingThread);
  const current = [
    ...browsers.values(),
    ...created.flatMap((result) => (result.status === "fulfilled" ? [result.value] : [])),
    ...[...threadBrowsers.values()].flatMap((entries) => [...entries.values()]),
    ...createdThread.flatMap((result) => (result.status === "fulfilled" ? [result.value] : [])),
  ];
  browsers.clear();
  browserPromises.clear();
  threadBrowsers.clear();
  threadBrowserPromises.clear();
  await Promise.allSettled([...new Set(current)].map((browser) => browser.close()));
}

const endpoint = process.env.MASTRA_NATIVE_BROWSER_AGENT_BROKER_PATH?.trim();
const token = process.env.MASTRA_NATIVE_BROWSER_AGENT_BROKER_TOKEN?.trim();
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

async function executeNativeBrowserCommand<T = unknown>(
  session: { resourceId: string; threadId: string },
  operation: NativeBrowserAgentOperation,
  input?: Record<string, unknown>,
): Promise<T> {
  if (!endpoint || !token) throw new Error("Native browser command bridge is unavailable");
  const requestId = randomUUID();
  const request = NativeBrowserAgentCommandRequestSchema.parse({
    ...session,
    requestId,
    token,
    operation,
    ...(input ? { input } : {}),
  });
  const payload = `${JSON.stringify(request)}\n`;
  if (Buffer.byteLength(payload) > MAX_REQUEST_BYTES) {
    throw new Error("Native browser command request is too large");
  }

  return new Promise<T>((resolve, reject) => {
    const socket = createConnection(endpoint);
    let response = "";
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    socket.setEncoding("utf8");
    socket.setTimeout(305_000, () => socket.destroy(new Error("Native browser command timed out")));
    socket.once("connect", () => socket.write(payload));
    socket.on("data", (chunk: string) => {
      response += chunk;
      if (Buffer.byteLength(response) > MAX_RESPONSE_BYTES) {
        socket.destroy(new Error("Native browser command response is too large"));
        return;
      }
      const newline = response.indexOf("\n");
      if (newline < 0) return;
      socket.end();
      try {
        const result = NativeBrowserAgentCommandResponseSchema.parse(
          JSON.parse(response.slice(0, newline)),
        );
        if (result.requestId && result.requestId !== requestId) {
          fail(new Error("Native browser command returned a mismatched request ID"));
          return;
        }
        if (!result.ok) {
          const hint =
            result.error === "session_not_found"
              ? "The browser session has not been opened or was closed. Use browser_goto with the target URL or take a new browser_snapshot to initialize it."
              : result.error === "session_not_visible"
                ? "Bring the desktop app to the foreground and open the Browser panel in this task's thread, then retry. Native browser automation requires that thread's page to be visible."
                : result.error === "document_changed"
                  ? "The page navigated during the operation. Take a fresh snapshot and retry."
                  : result.error === "stale_ref"
                    ? "Take a new browser snapshot to refresh element references."
                    : result.error === "tab_limit_reached"
                      ? "The browser has reached its 100-tab limit. Close a tab before opening another."
                      : "";
          fail(
            new Error(
              `Native browser ${operation} failed (${result.error}${hint ? `; ${hint}` : ""}; requestId=${requestId})`,
            ),
          );
          return;
        }
        if (result.requestId !== requestId) {
          fail(new Error("Native browser command returned a mismatched request ID"));
          return;
        }
        settled = true;
        resolve(result.result as T);
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.once("error", fail);
    socket.once("close", () => {
      if (!settled) fail(new Error("Native browser command bridge closed before responding"));
    });
  });
}
