import type { FileUIPart } from "ai";
import type { CatalogProvider, ProviderConfig, ReasoningEffort } from "./providers";
import type { PermissionRules, WorkModeId } from "./session";
import type { TerminalSessionInfo } from "./terminal";

export interface WorkUser {
  id: string;
  name: string;
  email: string;
}

export const MAIN_VIEWS = ["chat", "agents", "skills", "library"] as const;
export type MainView = (typeof MAIN_VIEWS)[number];
export const DEFAULT_MAIN_VIEW: MainView = "chat";

export interface ThreadMetadata {
  agentProfileId?: string;
  workspacePath?: string;
  workspaceExplicit?: boolean;
  modeId?: string;
  permissionRules?: PermissionRules;
  modelSelectionByMode?: Record<
    string,
    {
      providerId: string;
      modelId: string;
      modelName: string;
      reasoningEffort: string;
    }
  >;
  pinned?: boolean;
  archivedAt?: string | null;
  draft?: boolean;
  compactedAt?: string | null;
  compaction?: {
    summary: string;
    extracted?: Record<string, unknown>;
    extractionFailures?: Array<{ slug: string; error: string }>;
    inputTokens?: number;
    outputTokens?: number;
    estimatedContextTokens?: number;
    deletedMessages?: number;
    compactedAt: string;
  };
  contextUsage?: Record<string, unknown>;
  isWorking?: boolean;
  activeRunId?: string | null;
}

export interface WorkThread {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  metadata: ThreadMetadata;
}

export interface RecentWorkspace {
  path: string;
  lastUsedAt: string;
}

export interface TreeEntry {
  hidden?: boolean;
  name: string;
  path: string;
  type: "file" | "dir";
}

export type WorkspaceChangeKind = "created" | "modified" | "deleted";

export interface WorkspaceChangeSnapshot {
  objectId: string;
  sha256: string;
  byteSize: number;
  contentType: string;
  encoding: string;
  chunkSize: number;
  chunkCount: number;
}

export interface WorkspaceFileChange {
  id: string;
  path: string;
  kind: WorkspaceChangeKind;
  before: WorkspaceChangeSnapshot | null;
  after: WorkspaceChangeSnapshot | null;
  toolName: string;
  toolCallId?: string;
  createdAt: string;
}

export function dirName(path: string): string {
  const trimmed = path.replaceAll("\\", "/").replace(/\/+$/, "");
  const name = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  return name || trimmed || path;
}

export interface ModelSelection {
  providerId: string;
  modelId: string;
  modelName: string;
  reasoningEffort: ReasoningEffort | "off";
}

export interface AgentMemberDefinition {
  id: string;
  name: string;
  profession: string;
  description: string;
  instructions: string;
  skills: string[];
  memoryScope: "thread" | "resource";
}

export interface AgentWorkflowDefinition {
  strategy: "supervisor" | "handoff" | "workflow" | "council";
  steps: Array<{
    id: string;
    memberId?: string;
    kind?: "agent" | "approval" | "branch" | "loop";
    prompt?: string;
    retries?: number;
    condition?: { operator: "contains" | "equals" | "not_contains"; value: string };
    branch?: { onTrueMemberId: string; onFalseMemberId: string };
    loop?: { mode: "until" | "while" | "foreach"; maxIterations: number; concurrency?: number };
    approval?: { title: string; description: string };
  }>;
  synthesis: boolean;
}

export interface AgentProfile {
  id: string;
  type: "agent" | "team";
  name: string;
  displayName: string;
  profession: string;
  description: string;
  instructions: string;
  skills: string[];
  members: AgentMemberDefinition[];
  workflow?: AgentWorkflowDefinition;
  categoryId?: string;
  tags: string[];
  quickPrompts: string[];
  avatar?: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export const DEFAULT_AGENT_PROFILE: AgentProfile = {
  id: "mastra-work-agent",
  type: "agent",
  name: "MastraWork",
  displayName: "MastraWork",
  profession: "通用工作 Agent",
  description: "默认工作 Agent",
  instructions: "",
  skills: [],
  members: [],
  workflow: undefined,
  tags: ["默认"],
  quickPrompts: [],
  enabled: true,
  createdAt: "",
  updatedAt: "",
};

export interface MessageSearchHit {
  threadId: string;
  threadTitle: string;
  messageId: string;
  role: string;
  text: string;
  createdAt: string;
  semantic: boolean;
}

export interface PendingJump {
  threadId: string;
  messageId: string;
}

export type PanelTabKind = "files" | "terminal" | "changes" | "browser" | "welcome";

export interface LocalPanelTab {
  id: string;
  kind: "files" | "terminal" | "changes";
  title: string;
}

export type ActivePanelTab =
  | { kind: "welcome"; id?: string }
  | { kind: "files" | "terminal" | "changes"; id: string }
  | { kind: "browser"; index: number };

export interface TerminalRequest {
  id: number;
  command?: string;
  filePath?: string;
}

export interface BrowserRequest {
  id: number;
  threadId: string | null;
  url: string;
  newTab?: boolean;
}

export const SEARCH_ENGINES = ["provider", "tavily", "firecrawl", "anysearch"] as const;
export type SearchEngine = (typeof SEARCH_ENGINES)[number];

export const SEARCH_DEPTHS = ["fast", "balanced", "deep"] as const;
export type SearchDepth = (typeof SEARCH_DEPTHS)[number];

export interface SearchSelection {
  engine: SearchEngine;
  depth: SearchDepth;
}

export interface ToolsConfig {
  tavily: { apiKey: string };
  firecrawl: { apiKey: string; apiUrl: string };
  anysearch: { apiKey: string };
}

export interface WorkbenchStatePatch {
  editor?: {
    workspacePath?: string;
    openPath?: string;
    dirty?: boolean;
    selectedPath?: string;
  };
  terminal?: {
    open: boolean;
    sessionCount: number;
    activeTitle?: string;
    activeStatus?: "connecting" | "ready" | "exited" | "error";
    lastCommand?: string;
    lastExitCode?: number;
  };
  workbench?: {
    workspacePanelOpen: boolean;
    workspacePanelTab?: string;
    terminalPanelOpen: boolean;
    libraryOpen: boolean;
  };
}

export interface WorkbenchValue {
  user: WorkUser;
  threads: WorkThread[];
  threadsLoading: boolean;
  refreshThreads: () => Promise<void>;
  createThread: (title?: string) => Promise<WorkThread | null>;
  renameThread: (threadId: string, title: string) => Promise<void>;
  generateThreadTitle: (threadId: string) => Promise<string | null>;
  deleteThread: (threadId: string) => Promise<void>;
  pinThread: (threadId: string, pinned: boolean) => Promise<void>;
  archiveThread: (threadId: string, archived: boolean) => Promise<void>;
  searchMessages: (query: string) => Promise<MessageSearchHit[]>;
  recentWorkspaces: RecentWorkspace[];
  refreshRecentWorkspaces: () => Promise<void>;
  fetchTreeEntries: (threadId: string, path?: string) => Promise<TreeEntry[]>;
  fetchThreadChanges: (threadId: string) => Promise<WorkspaceFileChange[]>;
  fetchThreadChangeContent: (
    threadId: string,
    changeId: string,
    side: "before" | "after",
  ) => Promise<{ content: string; binary: boolean; metadata: WorkspaceChangeSnapshot } | null>;
  activeThreadId: string | null;
  setActiveThreadId: (id: string | null) => void;
  pendingJump: PendingJump | null;
  setPendingJump: (jump: PendingJump | null) => void;
  providers: ProviderConfig[];
  setProviders: (providers: ProviderConfig[]) => void;
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
  settingsOpen: boolean;
  setSettingsOpen: (open: boolean) => void;
  settingsSection: string;
  setSettingsSection: (section: string) => void;
  openSettings: (section?: string) => void;
  busyThreadIds: Record<string, boolean>;
  setThreadBusy: (threadId: string, busy: boolean) => void;
  isThreadBusy: (threadId: string) => boolean;
  agentBusy: boolean;
  setAgentBusy: (busy: boolean) => void;
  activeView: MainView;
  setActiveView: (view: MainView) => void;
  activeSkill: unknown | null;
  setActiveSkill: (skill: unknown | null) => void;
  pendingPrompt: string | null;
  setPendingPrompt: (prompt: string | null) => void;
  pendingLibraryFiles: Array<FileUIPart & { byteSize?: number }>;
  queueLibraryFiles: (files: Array<FileUIPart & { byteSize?: number }>) => void;
  clearPendingLibraryFiles: () => void;
  workspacePanelOpen: boolean;
  setWorkspacePanelOpen: (open: boolean) => void;
  panelTabs: LocalPanelTab[];
  activePanelTab: ActivePanelTab;
  activatePanelTab: (tab: ActivePanelTab) => void;
  addPanelTab: (kind: "files" | "terminal" | "changes") => string;
  closePanelTab: (id: string) => void;
  openWorkspacePanel: (kind?: PanelTabKind) => void;
  terminalPanelOpen: boolean;
  setTerminalPanelOpen: (open: boolean) => void;
  promptMinWidth: number;
  reportPromptMinWidth: (width: number) => void;
  reportTerminalSession: (id: string, info: TerminalSessionInfo | null) => void;
  terminalRequest: TerminalRequest | null;
  requestTerminalCommand: (request: Omit<TerminalRequest, "id">) => void;
  browserRequest: BrowserRequest | null;
  openBrowserUrl: (url: string) => void;
}
