/**
 * 工作区域 Query:近期目录 / 文件树 / 代码变更 / 变更内容。
 * 轮询类 query 由调用方传 refetchInterval + enabled(替代手写 setInterval)。
 */
import { useQuery } from "@tanstack/react-query";
import { fetchChanges, fetchRecentWorkspaces } from "../../api/workbench-api";

import { qk } from "../query-keys";

export function useRecentWorkspacesQuery(userId: string) {
  return useQuery({
    queryKey: qk.recentWorkspaces(userId),
    queryFn: () => fetchRecentWorkspaces(),
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
