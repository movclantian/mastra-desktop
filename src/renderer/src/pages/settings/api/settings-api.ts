import type { ToolsConfig } from "@/entities/workbench";
import { requestJson } from "@/shared/api";
import { i18n } from "@/shared/i18n";
import type { BrowserConfig } from "../../../../../shared/browser-contract";
import { searchCredentialPurpose } from "../../../../../shared/credential-contract";
import type {
  ProxyConfig,
  ProxyMode,
  ProxySetResult,
  ProxyTestResult,
} from "../../../../../shared/proxy-contract";

export type { BrowserConfig, ProxyConfig, ProxyMode, ProxyTestResult };

export function fetchBrowserConfig(): Promise<BrowserConfig> {
  return requestJson<BrowserConfig>(
    "/work/browser/config",
    {},
    i18n.t("settings:api.fetchBrowserFailed"),
  );
}

export function saveBrowserConfig(config: BrowserConfig): Promise<BrowserConfig> {
  return requestJson<BrowserConfig>(
    "/work/browser/config",
    { method: "POST", body: config },
    i18n.t("settings:api.saveBrowserFailed"),
  );
}

export function fetchSettingsTools(): Promise<ToolsConfig> {
  return requestJson<ToolsConfig>("/work/tools", {}, i18n.t("settings:api.fetchToolsFailed"));
}

export async function saveSettingsTools(
  config: ToolsConfig,
  secrets: Record<"tavily" | "firecrawl" | "anysearch", string>,
): Promise<ToolsConfig> {
  const next = { ...config };
  for (const engine of ["tavily", "firecrawl", "anysearch"] as const) {
    const value = secrets[engine].trim();
    if (!value) continue;
    const credential = await window.api.credentials.put({
      purpose: searchCredentialPurpose(engine),
      value,
    });
    if (engine === "tavily") next.tavily = credential;
    else if (engine === "firecrawl") {
      next.firecrawl = { ...credential, apiUrl: next.firecrawl.apiUrl };
    } else next.anysearch = credential;
  }
  await requestJson<void>(
    "/work/tools",
    {
      method: "POST",
      body: {
        tavily: next.tavily,
        firecrawl: { ...next.firecrawl, apiUrl: next.firecrawl.apiUrl.trim() },
        anysearch: next.anysearch,
      },
    },
    i18n.t("settings:api.saveToolsFailed"),
  );
  return next;
}

export interface StorageInfo {
  url: string;
  directory: string;
}

export function fetchStorageInfo(): Promise<StorageInfo> {
  return requestJson<StorageInfo>("/work/storage", {}, i18n.t("settings:api.fetchStorageFailed"));
}

export function fetchWorkspaceSettings<T>(): Promise<T> {
  return requestJson<T>("/work/workspace", {}, i18n.t("settings:api.fetchWorkspaceFailed"));
}

export function saveWorkspaceSettings<T extends Record<string, unknown>>(config: T): Promise<void> {
  return requestJson<void>(
    "/work/workspace",
    { method: "POST", body: { mode: config.mode, ...(config.url ? { url: config.url } : {}) } },
    i18n.t("settings:api.saveWorkspaceFailed"),
  );
}

export function fetchGuardrailsConfig<T>(): Promise<T> {
  return requestJson<T>("/work/guardrails", {}, i18n.t("settings:api.fetchGuardrailsFailed"));
}

export function fetchGuardrailsStatus<T>(): Promise<T> {
  return requestJson<T>(
    "/work/guardrails/status",
    {},
    i18n.t("settings:api.fetchGuardrailsStatusFailed"),
  );
}

export function saveGuardrailsConfig<T extends Record<string, unknown>>(config: T): Promise<void> {
  return requestJson<void>(
    "/work/guardrails",
    { method: "POST", body: config },
    i18n.t("settings:api.saveGuardrailsFailed"),
  );
}

export function fetchMemoryConfig<T>(): Promise<T> {
  return requestJson<T>("/work/memory", {}, i18n.t("settings:api.fetchMemoryFailed"));
}

export function saveMemoryConfig<T extends Record<string, unknown>>(config: T): Promise<void> {
  return requestJson<void>(
    "/work/memory",
    { method: "POST", body: config },
    i18n.t("settings:api.saveMemoryFailed"),
  );
}

export function fetchMemoryProfile<T>(): Promise<T> {
  return requestJson<T>(
    "/work/memory/profile",
    {},
    i18n.t("settings:api.fetchMemoryProfileFailed"),
  );
}

export function fetchThreadObservationalMemory<T>(
  threadId: string,
  resourceId: string,
): Promise<T> {
  const query = new URLSearchParams({ resourceId });
  return requestJson<T>(
    `/work/threads/${encodeURIComponent(threadId)}/observational-memory-config?${query}`,
    {},
    i18n.t("settings:api.fetchThreadObservationalMemoryFailed"),
  );
}

export function saveThreadObservationalMemory(
  threadId: string,
  resourceId: string,
  config: Record<string, unknown>,
): Promise<void> {
  return requestJson<void>(
    `/work/threads/${encodeURIComponent(threadId)}/observational-memory-config`,
    { method: "PUT", body: { resourceId, config } },
    i18n.t("settings:api.saveThreadObservationalMemoryFailed"),
  );
}

export function fetchUsage<T>(query: string): Promise<T> {
  return requestJson<T>(`/work/usage${query}`, {}, i18n.t("settings:api.fetchUsageFailed"));
}

export async function fetchProxySettings(): Promise<ProxyConfig> {
  return window.api.proxy.get();
}

export async function saveProxySettings(config: ProxyConfig): Promise<ProxySetResult> {
  return window.api.proxy.set(config);
}

export async function testProxyConnectivity(url?: string): Promise<ProxyTestResult> {
  return window.api.proxy.test(url);
}
