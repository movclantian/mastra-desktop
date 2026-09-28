/** Resource-scoped browser configuration and lifecycle. */
import { AgentBrowser, type AgentBrowserConfig } from "@mastra/agent-browser";
import { FirecrawlBrowser } from "@mastra/browser-firecrawl";
import { MASTRA_RESOURCE_ID_KEY } from "@mastra/core/request-context";
import {
  type ModelConfiguration,
  STAGEHAND_MODEL_PROVIDERS,
  StagehandBrowser,
} from "@mastra/stagehand";
import { chromium } from "playwright-core";
import { type BrowserConfig, BrowserConfigSchema } from "../../shared/browser-contract";
import { browserCredentialPurpose } from "../../shared/credential-contract";
import { deleteCredential, resolveCredential } from "../credential-broker";
import { inferGatewayProtocol, normalizeGatewayBaseUrl } from "../models/create-model";
import { getProvidersConfig, resolveProviderCredential } from "../models/providers";
import { getAppConfig, setAppConfig } from "../storage";
import { getNativeBrowserTargetId } from "../native-browser-target";
import {
  clearNativeElectronPageSelection,
  selectNativeElectronPage,
} from "../browser-target-selection";
import { withNativeBrowserTargetLock } from "../native-browser-target-lock";
import { WORKSPACE_THREAD_ID_CONTEXT_KEY } from "../workspace";

const BROWSER_CONFIG_KEY = "browser";

export type WorkBrowser = AgentBrowser | StagehandBrowser | FirecrawlBrowser;

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

const DESKTOP_ELECTRON_CDP_URL = process.env.MASTRA_ELECTRON_CDP_URL?.trim();

class DesktopAgentBrowser extends AgentBrowser {
  private activeThreadId: string | null = null;

  constructor(
    options: AgentBrowserConfig,
    private readonly resolveTargetId: (threadId: string) => Promise<string>,
  ) {
    super(options);
  }

  override getTools() {
    const tools = super.getTools();
    // Tabs are owned by NativeBrowserViewManager; don't create/close untracked CDP pages.
    delete tools.browser_tabs;
    delete tools.browser_close;
    for (const tool of Object.values(tools)) {
      const executable = tool as typeof tool & {
        execute: (input: unknown, context: { agent?: { threadId?: string } }) => Promise<unknown>;
      };
      const execute = executable.execute;
      executable.execute = (input, context) => {
        const threadId = context.agent?.threadId;
        if (!threadId) return Promise.reject(new Error("Agent browser requires a bound thread"));
        return this.withActiveTarget(threadId, () => execute.call(executable, input, context));
      };
    }
    return tools;
  }

  override setCurrentThread(threadId?: string): void {
    super.setCurrentThread(threadId);
    this.activeThreadId = threadId || null;
  }

  override async ensureReady(): Promise<void> {
    await super.ensureReady();
    if (this.activeThreadId) await this.bindActiveTarget(this.activeThreadId);
  }

  async withActiveTarget<T>(threadId: string, operation: () => Promise<T>): Promise<T> {
    return withNativeBrowserTargetLock(
      this,
      threadId,
      async () => {
        this.setCurrentThread(threadId);
        await this.ensureReady();
      },
      operation,
    );
  }

  protected override async doLaunch(): Promise<void> {
    await super.doLaunch();
    try {
      if (!this.sharedManager) throw new Error("Agent browser CDP manager was not created");
      if (!this.activeThreadId) throw new Error("Agent browser launch has no thread binding");
      await this.bindActiveTarget(this.activeThreadId);
    } catch (error) {
      await super.doClose().catch(() => undefined);
      throw error;
    }
  }

  private async bindActiveTarget(threadId: string): Promise<void> {
    const manager = this.sharedManager;
    if (!manager) throw new Error("Agent browser CDP manager was not created");
    try {
      const targetId = await this.resolveTargetId(threadId);
      await selectNativeElectronPage(manager, targetId);
    } catch (error) {
      clearNativeElectronPageSelection(manager);
      throw error;
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
    if (!DESKTOP_ELECTRON_CDP_URL) return new AgentBrowser(options);
    if (!threadId) {
      throw new Error("Native Agent browser requires a resourceId and threadId binding");
    }

    const { executablePath: _executablePath, ...cdpOptions } = options;

    return new DesktopAgentBrowser({
      ...cdpOptions,
      cdpUrl: DESKTOP_ELECTRON_CDP_URL,
      // CDP points at the desktop browser; do not launch another Chromium.
      scope: "shared",
    }, (activeThreadId) =>
      getNativeBrowserTargetId({ resourceId: resourceId || "default", threadId: activeThreadId }),
    );
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
  if (config.provider !== "agent" || !DESKTOP_ELECTRON_CDP_URL) {
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
  if (DESKTOP_ELECTRON_CDP_URL && (await getBrowserConfig(effectiveResourceId)).provider === "agent") {
    if (typeof threadId !== "string" || !threadId.trim()) {
      throw new Error("Native Agent browser requires a bound thread");
    }
    return getBrowserForThread(effectiveResourceId, threadId);
  }
  return getBrowserForResource(effectiveResourceId);
}

export async function withBrowserThreadTarget<T>(
  browser: WorkBrowser,
  threadId: string,
  operation: () => Promise<T>,
): Promise<T> {
  return browser instanceof DesktopAgentBrowser
    ? browser.withActiveTarget(threadId, operation)
    : operation();
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
