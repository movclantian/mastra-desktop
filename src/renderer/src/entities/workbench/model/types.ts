import { i18n } from "@/shared/i18n";
import type { CredentialState } from "../../../../../shared/credential-contract";
import type { ReasoningEffort } from "./providers";
import type { PermissionRules } from "./session";

export interface WorkUser {
  id: string;
  name: string;
  email: string;
}

export const MAIN_VIEWS = ["chat", "agents", "skills", "library", "schedules", "settings"] as const;
export type MainView = (typeof MAIN_VIEWS)[number];
export const DEFAULT_MAIN_VIEW: MainView = "chat";

export function viewFromPath(pathname: string): MainView {
  const view = pathname.replace(/^\//, "").split("/")[0];
  return (MAIN_VIEWS as readonly string[]).includes(view) ? (view as MainView) : "chat";
}

export interface ThreadMetadata {
  agentProfileId?: string;
  workspacePath?: string;
  workspaceExplicit?: boolean;
  currentModeId?: string;
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
  contextUsage?: Record<string, unknown> | null;
  contextUsageVersion?: number;
  totalUsage?: Record<string, unknown> | null;
  isWorking?: boolean;
  activeRunId?: string | null;
  /** 克隆/分支溯源(memory.copyThread 自动写入,官方 clone-utilities) */
  clone?: {
    sourceThreadId: string;
    clonedAt?: string;
    lastMessageId?: string;
  };
}

/** 会话所有权迁移的目标账户候选(GET /work/users) */
export interface WorkUserOption {
  id: string;
  name: string;
  email: string;
  role: "admin" | "user";
}

export type ThreadTransferStatus =
  | "awaiting_confirmation"
  | "prepared"
  | "assets_moved"
  | "memory_moved"
  | "messages_rewritten"
  | "committed"
  | "failed"
  | "rejected"
  | "needs_reconciliation";

export interface ThreadTransferAuditEvent {
  action: string;
  actorResourceId: string;
  createdAt: string;
  threadTitle?: string;
}

export interface ThreadTransferHistoryItem {
  id: string;
  threadId: string;
  threadTitle: string;
  sourceResourceId: string;
  sourceName: string;
  targetResourceId: string;
  targetName: string;
  status: ThreadTransferStatus;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  events: ThreadTransferAuditEvent[];
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
  profession: i18n.t("chat:agents.generalAgentProfession"),
  description: i18n.t("chat:agents.defaultAgentDescription"),
  instructions: "",
  skills: [],
  members: [],
  workflow: undefined,
  tags: [i18n.t("common:default")],
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

export type WorkspacePanelMode = "docked" | "floating" | "fullscreen";

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
  tavily: CredentialState;
  firecrawl: CredentialState & { apiUrl: string };
  anysearch: CredentialState;
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
