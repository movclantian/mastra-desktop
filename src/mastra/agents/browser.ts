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
import type {
  BrowserState as MastraBrowserState,
  BrowserTabState,
  BrowserToolError,
  ScreencastOptions,
  ScreencastStream,
} from "@mastra/core/browser";
import { FirecrawlBrowser } from "@mastra/browser-firecrawl";
import { MASTRA_RESOURCE_ID_KEY } from "@mastra/core/request-context";
import {
  type ModelConfiguration,
  STAGEHAND_MODEL_PROVIDERS,
  StagehandBrowser,
} from "@mastra/stagehand";
import { chromium } from "playwright-core";
import {
  type BrowserConfig,
  BrowserConfigSchema,
  BrowserStateSchema,
  type NativeBrowserAgentOperation,
} from "../../shared/browser-contract";
import { browserCredentialPurpose } from "../../shared/credential-contract";
import { deleteCredential, resolveCredential } from "../credential-broker";
import { inferGatewayProtocol, normalizeGatewayBaseUrl } from "../models/create-model";
import { getProvidersConfig, resolveProviderCredential } from "../models/providers";
import { getAppConfig, setAppConfig } from "../storage";
import { executeNativeBrowserCommand } from "../native-browser-target";
import { WORKSPACE_THREAD_ID_CONTEXT_KEY } from "../workspace";

const BROWSER_CONFIG_KEY = "browser";

export type WorkBrowser = AgentBrowser | StagehandBrowser | FirecrawlBrowser;

/** Resolve and merge browser tools only when a workbench thread can bind them to its page. */
export async function mergeBrowserToolsForThread<T extends object>(
  tools: T,
  threadId: unknown,
  resolveBrowser: () => Promise<Pick<WorkBrowser, "getTools">>,
): Promise<T> {
  if (typeof threadId !== "string" || !threadId.trim()) return tools;
  const browser = await resolveBrowser();
  Object.assign(tools, browser.getTools());
  return tools;
}

export const DEFAULT_BROWSER_CONFIG: BrowserConfig = {
  provider: "agent",
  scope: "thread",
  headless: true,
  viewport: { width: 1280, height: 720 },
  timeout: 30_000,
  homeUrl: "",
  stagehand: {
    providerId: "",
    modelId: "",
  },
  firecrawl: {
    apiUrl: "",
    ttl: 600,
    activityTtl: 60,
    streamWebView: false,
    credential: { hasCredential: false },
  },
};

function resolveBundledChromium(): string | undefined {
  try {
    return chromium.executablePath() || undefined;
  } catch {
    return undefined;
  }
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
    executablePath: resolveBundledChromium(),
    scope: config.scope,
    headless: config.headless,
    viewport: config.viewport,
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
const IS_DESKTOP_RUNTIME = process.env.MASTRA_DESKTOP_RUNTIME === "true";

export class NativeElectronAgentBrowser extends AgentBrowser {
  private readonly knownThreads = new Set<string>();
  private readonly states = new Map<string, MastraBrowserState>();

  constructor(
    options: AgentBrowserConfig,
    private readonly resourceId: string,
    threadId: string,
  ) {
    super({ ...options, scope: "shared" });
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
      ...(parsed.activeUrlChangeSource ? { activeUrlChangeSource: parsed.activeUrlChangeSource } : {}),
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
    return id ? this.states.get(id) ?? null : null;
  }

  override goto(input: GotoInput, threadId?: string) {
    return this.invoke<Awaited<ReturnType<AgentBrowser["goto"]>>>("goto", input, threadId, "Goto");
  }

  override snapshot(input: SnapshotInput, threadId?: string) {
    return this.invoke<Awaited<ReturnType<AgentBrowser["snapshot"]>>>("snapshot", input, threadId, "Snapshot");
  }

  override screenshot(input: Parameters<AgentBrowser["screenshot"]>[0], threadId?: string) {
    return this.invoke<Awaited<ReturnType<AgentBrowser["screenshot"]>>>("screenshot", input, threadId, "Screenshot");
  }

  override click(input: ClickInput, threadId?: string) {
    return this.invoke<Awaited<ReturnType<AgentBrowser["click"]>>>("click", input, threadId, "Click");
  }

  override type(input: TypeInput, threadId?: string) {
    return this.invoke<Awaited<ReturnType<AgentBrowser["type"]>>>("type", input, threadId, "Type");
  }

  override press(input: PressInput, threadId?: string) {
    return this.invoke<Awaited<ReturnType<AgentBrowser["press"]>>>("press", input, threadId, "Press");
  }

  override select(input: SelectInput, threadId?: string) {
    return this.invoke<Awaited<ReturnType<AgentBrowser["select"]>>>("select", input, threadId, "Select");
  }

  override scroll(input: ScrollInput, threadId?: string) {
    return this.invoke<Awaited<ReturnType<AgentBrowser["scroll"]>>>("scroll", input, threadId, "Scroll");
  }

  override hover(input: HoverInput, threadId?: string) {
    return this.invoke<Awaited<ReturnType<AgentBrowser["hover"]>>>("hover", input, threadId, "Hover");
  }

  override back(threadId?: string) {
    return this.invoke<Awaited<ReturnType<AgentBrowser["back"]>>>("back", {}, threadId, "Back");
  }

  override wait(input: WaitInput, threadId?: string) {
    return this.invoke<Awaited<ReturnType<AgentBrowser["wait"]>>>("wait", input, threadId, "Wait");
  }

  override drag(input: DragInput, threadId?: string) {
    return this.invoke<Awaited<ReturnType<AgentBrowser["drag"]>>>("drag", input, threadId, "Drag");
  }

  override evaluate(input: EvaluateInput, threadId?: string) {
    return this.invoke<Awaited<ReturnType<AgentBrowser["evaluate"]>>>("evaluate", input, threadId, "Evaluate");
  }

  override tabs(input: TabsInput, threadId?: string) {
    return this.invoke<Awaited<ReturnType<AgentBrowser["tabs"]>>>("tabs", input, threadId, "Tabs");
  }

  override async startScreencast(_options?: ScreencastOptions): Promise<ScreencastStream> {
    throw new Error("The desktop browser is rendered by its native Electron view; screenshot streaming is disabled.");
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
    return executeNativeBrowserCommand<T>({ resourceId: this.resourceId, threadId }, operation, input);
  }

  private async invoke<T>(
    operation: NativeBrowserAgentOperation,
    input: object,
    threadId: string | undefined,
    label: string,
  ): Promise<T | BrowserToolError> {
    const id = this.threadId(threadId);
    if (!id) return this.createError("browser_error", "Browser operation requires a bound thread.");
    try {
      await this.ensureReady();
      return await this.command<T>(id, operation, input as Record<string, unknown>);
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
    if (!HAS_NATIVE_BROWSER_AGENT_BRIDGE) {
      if (IS_DESKTOP_RUNTIME) {
        throw new Error("Native Electron browser command bridge is unavailable; refusing a hidden browser fallback.");
      }
      return new AgentBrowser(options);
    }
    if (!threadId) {
      throw new Error("Native Agent browser requires a bound thread");
    }
    return new NativeElectronAgentBrowser(options, resourceId || "default", threadId);
  }
  if (config.provider === "stagehand") {
    const provider = (await getProvidersConfig(resourceId)).providers.find(
      (candidate) => candidate.id === config.stagehand.providerId,
    );
    if (
      !provider ||
      provider.disabled ||
      !provider.enabledModels.some((model) => model.id === config.stagehand.modelId)
    ) {
      throw new Error("Stagehand provider or model is not available");
    }
    const protocol = provider.protocol ?? inferGatewayProtocol(provider.registryId ?? "");
    if (!protocol) throw new Error("Stagehand provider protocol is not supported");
    const modelProvider = provider.registryId
      ? STAGEHAND_MODEL_PROVIDERS.find((candidate) => candidate === provider.registryId)
      : protocol === "gemini"
        ? "google"
        : protocol;
    if (!modelProvider) throw new Error("Stagehand provider is not supported");
    const baseURL = normalizeGatewayBaseUrl(provider.baseUrl, protocol);
    return new StagehandBrowser({
      ...commonOptions(config),
      model: {
        modelName: `${modelProvider}/${config.stagehand.modelId}`,
        apiKey: await resolveProviderCredential(provider),
        ...(baseURL ? { baseURL } : {}),
        ...(protocol === "openai"
          ? { openaiEndpointFormat: provider.useResponses ? "responses" : "chat" }
          : {}),
      } satisfies ModelConfiguration,
    });
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
  if (
    config.provider !== "agent" ||
    (!HAS_NATIVE_BROWSER_AGENT_BRIDGE && !IS_DESKTOP_RUNTIME)
  ) {
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
  const resourceId = requestContext?.get(MASTRA_RESOURCE_ID_KEY);
  const threadId = requestContext?.get(WORKSPACE_THREAD_ID_CONTEXT_KEY);
  const effectiveResourceId =
    typeof resourceId === "string" && resourceId ? resourceId : "default";
  if (
    (HAS_NATIVE_BROWSER_AGENT_BRIDGE || IS_DESKTOP_RUNTIME) &&
    (await getBrowserConfig(effectiveResourceId)).provider === "agent"
  ) {
    if (typeof threadId !== "string" || !threadId.trim()) {
      throw new Error("Native Agent browser requires a bound thread");
    }
    return getBrowserForThread(effectiveResourceId, threadId);
  }
  return getBrowserForResource(effectiveResourceId);
}

export async function withBrowserThreadTarget<T>(
  _browser: WorkBrowser,
  _threadId: string,
  operation: () => Promise<T>,
): Promise<T> {
  return operation();
}

export async function closeBrowserThreadSessions(resourceId: string, threadId: string): Promise<void> {
  const threadBrowser = threadBrowsers.get(resourceId)?.get(threadId);
  threadBrowsers.get(resourceId)?.delete(threadId);
  if (threadBrowsers.get(resourceId)?.size === 0) threadBrowsers.delete(resourceId);
  if (threadBrowser) await threadBrowser.close().catch(() => undefined);
  const browser = browsers.get(resourceId);
  if (browser?.hasThreadSession(threadId)) await browser.closeThreadSession(threadId);
}

export async function replaceBrowserForResource(resourceId = "default"): Promise<void> {
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
  const pendingThread = [...threadBrowserPromises.values()].flatMap((entries) => [...entries.values()]);
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
