/**
 * TanStack Query key 约定(数组工厂)。
 * 带 userId 的 key 在登出 clear() 后随下次登录重新拉取;
 * providerConfig/agents 等由后端按认证用户隐式区分,无需显式 userId。
 */
export const qk = {
  threads: (userId: string) => ["threads", userId] as const,
  providerConfig: () => ["provider-config"] as const,
  catalog: () => ["catalog"] as const,
  agents: () => ["agents"] as const,
  toolsConfig: () => ["tools-config"] as const,
  recentWorkspaces: (userId: string) => ["recent-workspaces", userId] as const,
  treeEntries: (threadId: string, path: string) => ["tree-entries", threadId, path] as const,
  threadChanges: (threadId: string) => ["thread-changes", threadId] as const,
  changeContent: (threadId: string, changeId: string, side: "before" | "after") =>
    ["change-content", threadId, changeId, side] as const,
  displayState: (threadId: string) => ["display-state", threadId] as const,
  threadSource: (threadId: string) => ["thread-source", threadId] as const,
  schedules: () => ["schedules"] as const,
  libraryContents: (userId: string) => ["library-contents", userId] as const,
  librarySettings: () => ["library-settings"] as const,
};
