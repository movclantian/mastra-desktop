import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchAgents,
  fetchProviderConfig,
  fetchToolsConfig,
  saveProviderConfig,
  updateThread,
  updateThreadMode,
  updateThreadModel,
  updateThreadPermissions,
} from "../api/workbench-api";
import {
  type CatalogProvider,
  loadModelCatalog,
  type ProviderConfig,
  type ReasoningEffort,
} from "./providers";
import {
  DEFAULT_MODE_ID,
  DEFAULT_PERMISSION_RULES,
  type PermissionRules,
  parseModeId,
  parsePermissionRules,
  type WorkModeId,
} from "./session";
import {
  MODE_KEY,
  PERMISSION_RULES_KEY,
  readJson,
  SEARCH_SELECTION_KEY,
  userStorageKey,
} from "./storage";
import type { MainView } from "./types";
import {
  type AgentProfile,
  DEFAULT_AGENT_PROFILE,
  type ModelSelection,
  type SearchSelection,
  type ToolsConfig,
  type WorkThread,
  type WorkUser,
} from "./types";

export interface WorkbenchConfigOptions {
  user: WorkUser;
  activeThreadId: string | null;
  setActiveView: (view: MainView) => void;
  threads: WorkThread[];
  refreshThreads: () => Promise<void>;
  updateThreadLocal: (threadId: string, updater: (thread: WorkThread) => WorkThread) => void;
}

export interface WorkbenchConfigState {
  providers: ProviderConfig[];
  setProviders: (providers: ProviderConfig[]) => void;
  providersLoaded: boolean;
  catalog: CatalogProvider[];
  catalogStatus: "loading" | "ready" | "error";
  modelSelection: ModelSelection | null;
  setModelSelection: (selection: ModelSelection | null) => void;
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
  toolsConfig: ToolsConfig | null;
  refreshToolsConfig: () => Promise<void>;
}

export function useWorkbenchConfig({
  user,
  activeThreadId,
  setActiveView,
  threads,
  refreshThreads,
  updateThreadLocal,
}: WorkbenchConfigOptions): WorkbenchConfigState {
  const [providers, setProvidersState] = useState<ProviderConfig[]>([]);
  const [modelSelection, setModelSelectionState] = useState<ModelSelection | null>(null);
  const [agents, setAgents] = useState<AgentProfile[]>([]);
  const [agentSelection, setAgentSelectionState] = useState<AgentProfile>(DEFAULT_AGENT_PROFILE);
  const [providersLoaded, setProvidersLoaded] = useState(false);
  const [searchSelection, setSearchSelectionState] = useState<SearchSelection | null>(() =>
    readJson<SearchSelection | null>(userStorageKey(SEARCH_SELECTION_KEY, user.id), null),
  );
  const [modeId, setModeIdState] = useState<WorkModeId>(() =>
    parseModeId(readJson<string>(userStorageKey(MODE_KEY, user.id), DEFAULT_MODE_ID)),
  );
  const [permissionRules, setPermissionRulesState] = useState<PermissionRules>(() =>
    parsePermissionRules(
      readJson<unknown>(userStorageKey(PERMISSION_RULES_KEY, user.id), DEFAULT_PERMISSION_RULES),
    ),
  );
  const [toolsConfig, setToolsConfig] = useState<ToolsConfig | null>(null);
  const [catalog, setCatalog] = useState<CatalogProvider[]>([]);
  const [catalogStatus, setCatalogStatus] = useState<"loading" | "ready" | "error">("loading");
  const adoptedThreadRef = useRef<string | null>(null);

  useEffect(() => {
    localStorage.setItem(
      userStorageKey(SEARCH_SELECTION_KEY, user.id),
      JSON.stringify(searchSelection),
    );
  }, [searchSelection, user.id]);

  useEffect(() => {
    localStorage.setItem(userStorageKey(MODE_KEY, user.id), JSON.stringify(modeId));
  }, [modeId, user.id]);

  useEffect(() => {
    localStorage.setItem(
      userStorageKey(PERMISSION_RULES_KEY, user.id),
      JSON.stringify(permissionRules),
    );
  }, [permissionRules, user.id]);

  useEffect(() => {
    loadModelCatalog()
      .then((nextCatalog) => {
        setCatalog(nextCatalog);
        setCatalogStatus("ready");
      })
      .catch(() => {
        setCatalog([]);
        setCatalogStatus("error");
      });
  }, []);

  const refreshAgents = useCallback(async () => {
    try {
      const next = await fetchAgents();
      setAgents(next);
      setAgentSelectionState(
        (current) =>
          next.find((profile) => profile.id === current.id) ??
          next.find((profile) => profile.id === DEFAULT_AGENT_PROFILE.id) ??
          DEFAULT_AGENT_PROFILE,
      );
    } catch {
      setAgents([]);
    }
  }, []);

  useEffect(() => {
    void refreshAgents();
  }, [refreshAgents]);

  useEffect(() => {
    fetchProviderConfig()
      .then((config) => {
        setProvidersState(config.providers);
        setModelSelectionState(config.modelSelection);
      })
      .catch(() => undefined)
      .finally(() => setProvidersLoaded(true));
  }, []);

  useEffect(() => {
    if (!providersLoaded) return;
    const timer = window.setTimeout(() => {
      void saveProviderConfig({ providers }).catch(() => undefined);
    }, 800);
    return () => window.clearTimeout(timer);
  }, [providers, providersLoaded]);

  const setProviders = useCallback((next: ProviderConfig[]) => setProvidersState(next), []);

  const setModelSelection = useCallback(
    (selection: ModelSelection | null) => {
      setModelSelectionState(selection);
      void saveProviderConfig({ modelSelection: selection }).catch(() => undefined);
      if (!activeThreadId) return;
      updateThreadLocal(activeThreadId, (thread) => {
        const modelSelectionByMode = { ...thread.metadata.modelSelectionByMode };
        if (selection) modelSelectionByMode[modeId] = selection;
        else delete modelSelectionByMode[modeId];
        return { ...thread, metadata: { ...thread.metadata, modelSelectionByMode } };
      });
      void updateThreadModel(activeThreadId, user.id, modeId, selection).catch(() => undefined);
    },
    [activeThreadId, modeId, updateThreadLocal, user.id],
  );

  const setSearchSelection = useCallback(
    (selection: SearchSelection | null) => setSearchSelectionState(selection),
    [],
  );

  const setAgentSelection = useCallback(
    async (profile: AgentProfile) => {
      setAgentSelectionState(profile);
      setActiveView("chat");
      if (!activeThreadId) return;
      const metadata = { agentProfileId: profile.id };
      updateThreadLocal(activeThreadId, (thread) => ({
        ...thread,
        metadata: { ...thread.metadata, ...metadata },
      }));
      await updateThread(activeThreadId, user.id, { metadata });
    },
    [activeThreadId, setActiveView, updateThreadLocal, user.id],
  );

  const refreshToolsConfig = useCallback(async () => {
    try {
      setToolsConfig(await fetchToolsConfig());
    } catch {
      setToolsConfig(null);
    }
  }, []);

  useEffect(() => {
    void refreshToolsConfig();
  }, [refreshToolsConfig]);

  const setModeId = useCallback(
    async (next: WorkModeId) => {
      setModeIdState(next);
      if (!activeThreadId) return;
      const thread = threads.find((item) => item.id === activeThreadId);
      const snapshot = thread?.metadata.modelSelectionByMode?.[next];
      if (snapshot && providers.some((provider) => provider.id === snapshot.providerId)) {
        setModelSelectionState({
          providerId: snapshot.providerId,
          modelId: snapshot.modelId,
          modelName: snapshot.modelName,
          reasoningEffort: snapshot.reasoningEffort as ReasoningEffort | "off",
        });
      }
      await updateThreadMode(activeThreadId, user.id, next);
    },
    [activeThreadId, providers, threads, user.id],
  );

  const setPermissionRules = useCallback(
    async (rules: PermissionRules) => {
      setPermissionRulesState(rules);
      if (!activeThreadId) return;
      await updateThreadPermissions(activeThreadId, user.id, {
        categories: { ...rules.categories },
        tools: { ...rules.tools },
      });
      await refreshThreads();
    },
    [activeThreadId, refreshThreads, user.id],
  );

  const refreshThreadSettings = useCallback(async () => {
    adoptedThreadRef.current = null;
    await refreshThreads();
  }, [refreshThreads]);

  useEffect(() => {
    if (!activeThreadId) {
      adoptedThreadRef.current = null;
      return;
    }
    if (adoptedThreadRef.current === activeThreadId || !providersLoaded) return;
    const thread = threads.find((item) => item.id === activeThreadId);
    if (!thread || agents.length === 0) return;
    adoptedThreadRef.current = activeThreadId;
    const metadata = thread.metadata;
    if (metadata.modeId !== undefined) setModeIdState(parseModeId(metadata.modeId));
    if (metadata.permissionRules !== undefined) {
      setPermissionRulesState(parsePermissionRules(metadata.permissionRules));
    }
    if (metadata.agentProfileId) {
      const profile = agents.find((item) => item.id === metadata.agentProfileId);
      if (profile) setAgentSelectionState(profile);
    }
    const snapshot = metadata.modelSelectionByMode?.[parseModeId(metadata.modeId)];
    if (snapshot && providers.some((provider) => provider.id === snapshot.providerId)) {
      setModelSelectionState({
        providerId: snapshot.providerId,
        modelId: snapshot.modelId,
        modelName: snapshot.modelName,
        reasoningEffort: snapshot.reasoningEffort as ReasoningEffort | "off",
      });
    }
  }, [activeThreadId, agents, providers, providersLoaded, threads]);

  return {
    providers,
    setProviders,
    providersLoaded,
    catalog,
    catalogStatus,
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
    toolsConfig,
    refreshToolsConfig,
  };
}
