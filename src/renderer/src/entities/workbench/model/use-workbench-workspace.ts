import { useCallback, useEffect, useState } from "react";
import {
  fetchChangeContent,
  fetchChanges,
  fetchRecentWorkspaces,
  fetchTree,
} from "../api/workbench-api";
import type {
  RecentWorkspace,
  TreeEntry,
  WorkspaceChangeSnapshot,
  WorkspaceFileChange,
} from "./types";

export interface WorkbenchWorkspaceState {
  recentWorkspaces: RecentWorkspace[];
  refreshRecentWorkspaces: () => Promise<void>;
  fetchTreeEntries: (threadId: string, path?: string) => Promise<TreeEntry[]>;
  fetchThreadChanges: (threadId: string) => Promise<WorkspaceFileChange[]>;
  fetchThreadChangeContent: (
    threadId: string,
    changeId: string,
    side: "before" | "after",
  ) => Promise<{ content: string; binary: boolean; metadata: WorkspaceChangeSnapshot } | null>;
}

export function useWorkbenchWorkspace(resourceId: string): WorkbenchWorkspaceState {
  const [recentWorkspaces, setRecentWorkspaces] = useState<RecentWorkspace[]>([]);

  const refreshRecentWorkspaces = useCallback(async () => {
    try {
      setRecentWorkspaces(await fetchRecentWorkspaces());
    } catch {
      // 目录选择器仍然可以在读取失败时手动选择目录。
    }
  }, []);

  useEffect(() => {
    void refreshRecentWorkspaces();
  }, [refreshRecentWorkspaces]);

  const fetchTreeEntries = useCallback(
    async (threadId: string, path?: string) => {
      try {
        return await fetchTree(threadId, resourceId, path);
      } catch {
        return [];
      }
    },
    [resourceId],
  );

  const fetchThreadChanges = useCallback(
    async (threadId: string) => {
      try {
        return await fetchChanges(threadId, resourceId);
      } catch {
        return [];
      }
    },
    [resourceId],
  );

  const fetchThreadChangeContent = useCallback(
    async (threadId: string, changeId: string, side: "before" | "after") => {
      try {
        return await fetchChangeContent(threadId, changeId, resourceId, side);
      } catch {
        return null;
      }
    },
    [resourceId],
  );

  return {
    recentWorkspaces,
    refreshRecentWorkspaces,
    fetchTreeEntries,
    fetchThreadChanges,
    fetchThreadChangeContent,
  };
}
