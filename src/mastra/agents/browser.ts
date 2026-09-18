/** Resource-scoped browser configuration and lifecycle. */
import { AgentBrowser } from "@mastra/agent-browser";
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

const BROWSER_CONFIG_KEY = "browser";

export type WorkBrowser = AgentBrowser | StagehandBrowser | FirecrawlBrowser;

export const DEFAULT_BROWSER_CONFIG: BrowserConfig = {
  provider: "agent",
  scope: "thread",
  headless: true,
  viewport: { width: 1280, height: 720 },
  timeout: 30_000,
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

async function createBrowser(config: BrowserConfig, resourceId?: string): Promise<WorkBrowser> {
  if (config.provider === "agent") return new AgentBrowser(commonOptions(config));
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

export async function getBrowserForResource(resourceId = "default"): Promise<WorkBrowser> {
  const existing = browsers.get(resourceId);
  if (existing) return existing;
  const pending = browserPromises.get(resourceId);
  if (pending) return pending;
  const creation = createBrowser(await getBrowserConfig(resourceId), resourceId);
  browserPromises.set(resourceId, creation);
  try {
    const browser = await creation;
    browsers.set(resourceId, browser);
    return browser;
  } finally {
    if (browserPromises.get(resourceId) === creation) browserPromises.delete(resourceId);
  }
}

export async function getBrowserForRequest(requestContext?: { get: (key: string) => unknown }) {
  const resourceId = requestContext?.get(MASTRA_RESOURCE_ID_KEY);
  return getBrowserForResource(
    typeof resourceId === "string" && resourceId ? resourceId : "default",
  );
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
}

export async function closeAllBrowsers(): Promise<void> {
  const pending = [...browserPromises.values()];
  const created = await Promise.allSettled(pending);
  const current = [
    ...browsers.values(),
    ...created.flatMap((result) => (result.status === "fulfilled" ? [result.value] : [])),
  ];
  browsers.clear();
  browserPromises.clear();
  await Promise.allSettled([...new Set(current)].map((browser) => browser.close()));
}
