/**
 * 配置域 Query:供应商配置 / 模型目录 / Agents / 工具配置。
 * 后端按认证用户隐式区分,无需显式 userId key。
 * providers 的编辑草稿与防抖保存在 settings 的 providers-section 组件层,
 * 保存成功后 setQueryData 更新缓存(不 invalidate,避免覆盖编辑)。
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { DesktopSettingsPatch } from "../../../../../../shared/window-contract";
import { fetchAgents, fetchProviderConfig, fetchToolsConfig } from "../../api/workbench-api";
import { loadModelCatalog } from "../providers";
import { qk } from "../query-keys";

export function useDesktopSettingsQuery() {
  return useQuery({
    queryKey: qk.desktopSettings(),
    queryFn: () => window.api.window.getSettings(),
    staleTime: Infinity,
  });
}

export function useUpdateDesktopSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patch: DesktopSettingsPatch) => window.api.window.updateSettings(patch),
    onSuccess: (settings) => queryClient.setQueryData(qk.desktopSettings(), settings),
  });
}

export function useProviderConfigQuery() {
  return useQuery({
    queryKey: qk.providerConfig(),
    queryFn: fetchProviderConfig,
    staleTime: Infinity,
  });
}

export function useCatalogQuery() {
  return useQuery({
    queryKey: qk.catalog(),
    queryFn: loadModelCatalog,
    staleTime: Infinity,
    retry: 0,
  });
}

export function useAgentsQuery() {
  return useQuery({
    queryKey: qk.agents(),
    queryFn: fetchAgents,
    staleTime: Infinity,
  });
}

export function useToolsConfigQuery() {
  return useQuery({
    queryKey: qk.toolsConfig(),
    queryFn: fetchToolsConfig,
  });
}
