import type { ToolsConfig } from "@/entities/workbench";
import { requestJson } from "@/shared/api";
import { i18n } from "@/shared/i18n";
import type { ComputerConfig, ComputerProbe } from "../../../../../shared/computer-contract";
import { searchCredentialPurpose } from "../../../../../shared/credential-contract";
import type {
  ProxyConfig,
  ProxyMode,
  ProxySetResult,
  ProxyTestResult,
} from "../../../../../shared/proxy-contract";

export type { ProxyConfig, ProxyMode, ProxyTestResult };

export function fetchComputerConfig() {
  return requestJson<ComputerConfig>("/work/computer", {}, i18n.t("settings:computer.loadFailed"));
}

export function saveComputerConfig(config: ComputerConfig) {
  return requestJson<ComputerConfig>(
    "/work/computer",
    { method: "POST", body: { config } },
    i18n.t("settings:computer.saveFailed"),
  );
}

export function probeComputer(config: ComputerConfig) {
  return requestJson<ComputerProbe>(
    "/work/computer/probe",
    { method: "POST", body: { config } },
    i18n.t("settings:computer.probeFailed"),
  );
}

export function disconnectComputer() {
  return requestJson<{ ok: boolean }>(
    "/work/computer/disconnect",
    { method: "POST", body: {} },
    i18n.t("settings:computer.disconnectFailed"),
  );
}

export async function saveSettingsTools(
  config: ToolsConfig,
  secrets: Record<"tavily" | "firecrawl", string>,
): Promise<ToolsConfig> {
  const next = { ...config };
  for (const engine of ["tavily", "firecrawl"] as const) {
    const value = secrets[engine].trim();
    if (!value) continue;
    const credential = await window.api.credentials.put({
      purpose: searchCredentialPurpose(engine),
      value,
    });
    if (engine === "tavily") next.tavily = credential;
    else if (engine === "firecrawl") {
      next.firecrawl = { ...credential, apiUrl: next.firecrawl.apiUrl };
    }
  }
  await requestJson<void>(
    "/work/tools",
    {
      method: "POST",
      body: {
        tavily: next.tavily,
        firecrawl: { ...next.firecrawl, apiUrl: next.firecrawl.apiUrl.trim() },
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
    { method: "POST", body: config },
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
