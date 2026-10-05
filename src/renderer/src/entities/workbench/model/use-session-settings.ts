/**
 * 会话设置层(替代旧 use-workbench-config 的会话部分):
 * - sessionDraft(modeId/permissionRules/agentSelection/modelSelection/searchSelection)
 *   存 zustand(带 localStorage 同步),「当前线程设置 + 新线程默认值」双语义照旧;
 * - setter = store 写 + threads 缓存乐观更新 + 服务端持久化,失败由 invalidate 拉回真相;
 * - useThreadSettingsAdoption:切换线程时从 thread.metadata 采纳会话设置。
 * providers 的编辑草稿与防抖保存在 settings 的 providers-section 组件层,不在此。
 */
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef } from "react";
import {
  saveProviderConfig,
  updateThread,
  updateThreadMode,
  updateThreadModel,
  updateThreadPermissions,
} from "../api/workbench-api";
import type { ProviderConfig, ReasoningEffort } from "./providers";
import { useAgentsQuery, useProviderConfigQuery } from "./queries/config";
import { useThreadsQuery } from "./queries/threads";
import { qk } from "./query-keys";
import {
  type PermissionRules,
  parseModeId,
  parsePermissionRules,
  type WorkModeId,
} from "./session";
import type {
  AgentProfile,
  ModelSelection,
  SearchSelection,
  ThreadMetadata,
  WorkThread,
} from "./types";
import { useWorkbenchStore } from "./workbench-store";

function patchThreadInCache(
  queryClient: ReturnType<typeof useQueryClient>,
  userId: string,
  threadId: string,
  updater: (thread: WorkThread) => WorkThread,
): void {
  queryClient.setQueryData<WorkThread[]>(qk.threads(userId), (current) =>
    current?.map((thread) => (thread.id === threadId ? updater(thread) : thread)),
  );
}

function threadModelSelection(
  metadata: ThreadMetadata,
  modeId: WorkModeId,
  providers: ProviderConfig[],
): ModelSelection | null {
  const id = metadata[`modeModelId_${modeId}`];
  if (typeof id !== "string") return null;
  const provider = providers.find((item) => id.startsWith(`${item.id}/`));
  if (!provider || provider.disabled) return null;
  const modelId = id.slice(`${provider.id}/`.length);
  const model = provider.enabledModels.find((item) => item.id === modelId);
  if (!model) return null;
  return {
    providerId: provider.id,
    modelId,
    modelName: model.name,
    reasoningEffort: (metadata.reasoningEffortByMode?.[modeId] ?? "off") as ReasoningEffort | "off",
  };
}
export interface SessionSettings {
  providers: ProviderConfig[];
  modelSelection: ModelSelection | null;
  setModelSelection: (selection: ModelSelection) => void;
  agents: AgentProfile[];
  agentSelection: AgentProfile;
  setAgentSelection: (profile: AgentProfile) => Promise<void>;
  refreshAgents: () => Promise<void>;
  modeId: WorkModeId;
  setModeId: (modeId: WorkModeId) => Promise<void>;
  permissionRules: PermissionRules;
  setPermissionRules: (rules: PermissionRules) => Promise<void>;
  refreshThreadSettings: () => Promise<void>;
  searchSelection: SearchSelection | null;
  setSearchSelection: (selection: SearchSelection | null) => void;
}

export function useSessionSettings(userId: string, activeThreadId: string | null): SessionSettings {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const threadsQuery = useThreadsQuery(userId);
  const agentsQuery = useAgentsQuery();
  const providerConfigQuery = useProviderConfigQuery();
  const threads = threadsQuery.data ?? [];
  const agents = agentsQuery.data ?? [];
  const providers = providerConfigQuery.data?.providers ?? [];

  const modeId = useWorkbenchStore((state) => state.modeId);
  const permissionRules = useWorkbenchStore((state) => state.permissionRules);
  const agentSelection = useWorkbenchStore((state) => state.agentSelection);
  const modelSelection = useWorkbenchStore((state) => state.modelSelection);
  const searchSelection = useWorkbenchStore((state) => state.searchSelection);
  const setModeIdDraft = useWorkbenchStore((state) => state.setModeIdDraft);
  const setPermissionRulesDraft = useWorkbenchStore((state) => state.setPermissionRulesDraft);
  const setAgentSelectionDraft = useWorkbenchStore((state) => state.setAgentSelectionDraft);
  const setModelSelectionDraft = useWorkbenchStore((state) => state.setModelSelectionDraft);
  const setSearchSelectionDraft = useWorkbenchStore((state) => state.setSearchSelectionDraft);

  // agents 数据到位后校验当前 agentSelection 仍在列表中(原 refreshAgents 的保持逻辑)
  useEffect(() => {
    if (agents.length === 0) return;
    const current = useWorkbenchStore.getState().agentSelection;
    if (agents.some((profile) => profile.id === current.id)) return;
    setAgentSelectionDraft(
      agents.find((profile) => profile.id === "default") ?? agents[0] ?? current,
    );
  }, [agents, setAgentSelectionDraft]);

  const activeThreadRef = useRef(activeThreadId);
  activeThreadRef.current = activeThreadId;

  const setModelSelection = useCallback(
    (selection: ModelSelection) => {
      if (!activeThreadId) {
        setModelSelectionDraft(selection);
        void saveProviderConfig({ modelSelection: selection }).catch(() => undefined);
        return;
      }
      void updateThreadModel(activeThreadId, userId, modeId, selection)
        .then((thread) => {
          patchThreadInCache(queryClient, userId, activeThreadId, () => thread);
          if (activeThreadRef.current === activeThreadId) setModelSelectionDraft(selection);
          void saveProviderConfig({ modelSelection: selection }).catch(() => undefined);
        })
        .catch(() => {
          void queryClient.invalidateQueries({ queryKey: qk.threads(userId) });
        });
    },
    [activeThreadId, modeId, queryClient, setModelSelectionDraft, userId],
  );

  const setAgentSelection = useCallback(
    async (profile: AgentProfile) => {
      setAgentSelectionDraft(profile);
      void navigate({ to: "/chat" });
      if (!activeThreadId) return;
      patchThreadInCache(queryClient, userId, activeThreadId, (thread) => ({
        ...thread,
        metadata: { ...thread.metadata, agentProfileId: profile.id },
      }));
      await updateThread(activeThreadId, userId, { metadata: { agentProfileId: profile.id } });
    },
    [activeThreadId, navigate, queryClient, setAgentSelectionDraft, userId],
  );

  const setModeId = useCallback(
    async (next: WorkModeId) => {
      if (!activeThreadId) {
        setModeIdDraft(next);
        return;
      }
      const thread = await updateThreadMode(activeThreadId, userId, next);
      patchThreadInCache(queryClient, userId, activeThreadId, () => thread);
      if (activeThreadRef.current === activeThreadId) {
        setModeIdDraft(next);
        setModelSelectionDraft(threadModelSelection(thread.metadata, next, providers));
      }
    },
    [activeThreadId, providers, queryClient, setModeIdDraft, setModelSelectionDraft, userId],
  );

  const setPermissionRules = useCallback(
    async (rules: PermissionRules) => {
      setPermissionRulesDraft(rules);
      if (!activeThreadId) return;
      await updateThreadPermissions(activeThreadId, userId, {
        categories: { ...rules.categories },
        tools: { ...rules.tools },
      });
      await queryClient.invalidateQueries({ queryKey: qk.threads(userId) });
    },
    [activeThreadId, queryClient, setPermissionRulesDraft, userId],
  );

  const refreshAgents = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: qk.agents() });
  }, [queryClient]);

  const setSearchSelection = useCallback(
    (selection: SearchSelection | null) => setSearchSelectionDraft(selection),
    [setSearchSelectionDraft],
  );

  const adoptedThreadRef = useRef<string | null>(null);

  const refreshThreadSettings = useCallback(async () => {
    adoptedThreadRef.current = null;
    await queryClient.invalidateQueries({ queryKey: qk.threads(userId) });
  }, [queryClient, userId]);

  // Re-adopt native model changes, including transitions initiated by the Session.
  useEffect(() => {
    if (!activeThreadId) {
      adoptedThreadRef.current = null;
      return;
    }
    const thread = threads.find((item) => item.id === activeThreadId);
    if (!thread || agents.length === 0 || providers.length === 0) return;
    const metadata = thread.metadata;
    const currentModeId = parseModeId(metadata.currentModeId);
    const selectionKey = JSON.stringify([
      activeThreadId,
      currentModeId,
      metadata[`modeModelId_${currentModeId}`],
      metadata.reasoningEffortByMode?.[currentModeId],
    ]);
    if (adoptedThreadRef.current === selectionKey) return;
    adoptedThreadRef.current = selectionKey;
    if (metadata.currentModeId !== undefined) setModeIdDraft(parseModeId(metadata.currentModeId));
    if (metadata.permissionRules !== undefined) {
      setPermissionRulesDraft(parsePermissionRules(metadata.permissionRules));
    }
    if (metadata.agentProfileId) {
      const profile = agents.find((item) => item.id === metadata.agentProfileId);
      if (profile) setAgentSelectionDraft(profile);
    }
    setModelSelectionDraft(
      threadModelSelection(metadata, parseModeId(metadata.currentModeId), providers),
    );
  }, [
    activeThreadId,
    agents,
    providers,
    setAgentSelectionDraft,
    setModeIdDraft,
    setModelSelectionDraft,
    setPermissionRulesDraft,
    threads,
  ]);

  return {
    providers,
    modelSelection,
    setModelSelection,
    agents,
    agentSelection,
    setAgentSelection,
    refreshAgents,
    modeId,
    setModeId,
    permissionRules,
    setPermissionRules,
    refreshThreadSettings,
    searchSelection,
    setSearchSelection,
  };
}
