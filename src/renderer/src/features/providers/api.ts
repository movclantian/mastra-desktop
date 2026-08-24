import { requestJson } from "@/api/client";
import type { ModelSelection, ToolsConfig } from "@/features/workbench/types";
import type { ProviderConfig } from "./types";

export async function fetchProviderConfig(): Promise<{
  providers: ProviderConfig[];
  modelSelection: ModelSelection | null;
}> {
  const payload = await requestJson<{
    providers?: ProviderConfig[];
    modelSelection?: ModelSelection | null;
  }>("/work/providers/config", {}, "加载模型供应商配置失败");
  return { providers: payload.providers ?? [], modelSelection: payload.modelSelection ?? null };
}

export async function saveProviderConfig(config: {
  providers?: ProviderConfig[];
  modelSelection?: ModelSelection | null;
}): Promise<void> {
  await requestJson(
    "/work/providers/config",
    { method: "POST", body: config },
    "保存模型供应商配置失败",
  );
}

export async function fetchToolsConfig(): Promise<ToolsConfig> {
  return requestJson<ToolsConfig>("/work/tools", {}, "加载工具配置失败");
}
