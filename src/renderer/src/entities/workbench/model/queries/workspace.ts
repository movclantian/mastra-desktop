/**
 * 工作区域 Query:近期目录 / 文件树 / 代码变更 / 变更内容。
 * 轮询类 query 由调用方传 refetchInterval + enabled(替代手写 setInterval)。
 */
import { useQuery } from "@tanstack/react-query";
import {
  fetchChangeContent,
  fetchChanges,
  fetchRecentWorkspaces,
  fetchTree,
} from "../../api/workbench-api";
import { qk } from "../query-keys";

export function useRecentWorkspacesQuery(userId: string) {
  return useQuery({
    queryKey: qk.recentWorkspaces(userId),
    queryFn: () => fetchRecentWorkspaces(),
  });
}

export function useTreeEntriesQuery(
  userId: string,
  threadId: string | null,
  path = "",
  options?: { enabled?: boolean },
) {
  return useQuery({
    queryKey: qk.treeEntries(threadId ?? "none", path),
    queryFn: () => fetchTree(threadId as string, userId, path),
    enabled: Boolean(threadId) && (options?.enabled ?? true),
    staleTime: 10_000,
  });
}

export function useThreadChangesQuery(
  userId: string,
  threadId: string | null,
  options?: { refetchInterval?: number | false; enabled?: boolean },
) {
  return useQuery({
    queryKey: qk.threadChanges(threadId ?? "none"),
    queryFn: () => fetchChanges(threadId as string, userId),
    enabled: Boolean(threadId) && (options?.enabled ?? true),
    refetchInterval: options?.refetchInterval,
  });
}

export function useChangeContentQuery(
  userId: string,
  threadId: string | null,
  changeId: string | null,
  side: "before" | "after",
) {
  return useQuery({
    queryKey: qk.changeContent(threadId ?? "none", changeId ?? "none", side),
    queryFn: () => fetchChangeContent(threadId as string, changeId as string, userId, side),
    enabled: Boolean(threadId && changeId),
    staleTime: Infinity,
  });
}
