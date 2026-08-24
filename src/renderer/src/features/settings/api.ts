import { requestJson } from "@/api/client";
import type { ToolsConfig } from "@/features/workbench/types";

export function fetchSettingsTools(): Promise<ToolsConfig> {
  return requestJson<ToolsConfig>("/work/tools", {}, "加载工具配置失败");
}

export function saveSettingsTools(config: ToolsConfig): Promise<void> {
  return requestJson<void>(
    "/work/tools",
    {
      method: "POST",
      body: {
        tavily: { apiKey: config.tavily.apiKey.trim() },
        firecrawl: {
          apiKey: config.firecrawl.apiKey.trim(),
          apiUrl: config.firecrawl.apiUrl.trim(),
        },
        anysearch: { apiKey: config.anysearch.apiKey.trim() },
      },
    },
    "保存工具配置失败",
  );
}

export interface StorageInfo {
  url: string;
  directory: string;
}

export function fetchStorageInfo(): Promise<StorageInfo> {
  return requestJson<StorageInfo>("/work/storage", {}, "加载存储信息失败");
}

export function fetchWorkspaceSettings<T>(): Promise<T> {
  return requestJson<T>("/work/workspace", {}, "加载工作区配置失败");
}

export function saveWorkspaceSettings<T extends Record<string, unknown>>(config: T): Promise<void> {
  return requestJson<void>(
    "/work/workspace",
    { method: "POST", body: config },
    "保存工作区配置失败",
  );
}

export function fetchGuardrailsConfig<T>(): Promise<T> {
  return requestJson<T>("/work/guardrails", {}, "加载护栏配置失败");
}

export function fetchGuardrailsStatus<T>(): Promise<T> {
  return requestJson<T>("/work/guardrails/status", {}, "加载护栏状态失败");
}

export function saveGuardrailsConfig<T extends Record<string, unknown>>(config: T): Promise<void> {
  return requestJson<void>(
    "/work/guardrails",
    { method: "POST", body: config },
    "保存护栏配置失败",
  );
}

export function fetchMemoryConfig<T>(): Promise<T> {
  return requestJson<T>("/work/memory", {}, "加载记忆配置失败");
}

export function saveMemoryConfig<T extends Record<string, unknown>>(config: T): Promise<void> {
  return requestJson<void>("/work/memory", { method: "POST", body: config }, "保存记忆配置失败");
}

export function fetchThreadObservationalMemory<T>(
  threadId: string,
  resourceId: string,
): Promise<T> {
  const query = new URLSearchParams({ resourceId });
  return requestJson<T>(
    `/work/threads/${encodeURIComponent(threadId)}/observational-memory-config?${query}`,
    {},
    "加载线程观察记忆配置失败",
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
    "保存线程观察记忆配置失败",
  );
}

export function fetchThreadSubagentModels<T>(
  threadId: string,
  resourceId: string,
  signal?: AbortSignal,
): Promise<T> {
  const query = new URLSearchParams({ resourceId });
  return requestJson<T>(
    `/work/sessions/workbench/threads/${encodeURIComponent(threadId)}/subagent-models?${query}`,
    signal ? { signal } : {},
    "加载线程子 Agent 模型失败",
  );
}

export function saveThreadSubagentModel(
  threadId: string,
  resourceId: string,
  agentType: string,
  modelId: string | null,
): Promise<void> {
  const query = new URLSearchParams({ resourceId });
  return requestJson<void>(
    `/work/sessions/workbench/threads/${encodeURIComponent(threadId)}/subagent-models?${query}`,
    { method: "PATCH", body: { agentType, modelId } },
    "保存线程子 Agent 模型失败",
  );
}

export function rebuildMemoryIndex<T>(): Promise<T> {
  return requestJson<T>("/work/memory/reindex", { method: "POST" }, "重建记忆索引失败");
}

export function fetchUsage<T>(query: string): Promise<T> {
  return requestJson<T>(`/work/usage${query}`, {}, "加载用量统计失败");
}
