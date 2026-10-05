/**
 * 产品任务/工作流面板的持久化快照；原生 Session 事件触发刷新，
 * 独立运行的工作流仍定期读取状态。
 * 命令式读取(如 resume 前的过期预检)用 fetchDisplayStateQuery。
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { qk } from "@/entities/workbench/model/query-keys";
import { fetchDisplayState } from "../api/chat-api";

export interface DisplayStateQueryOptions {
  refetchInterval?: number;
  enabled?: boolean;
}

export function useDisplayStateQuery(
  userId: string,
  threadId: string | null,
  options?: DisplayStateQueryOptions,
) {
  return useQuery({
    queryKey: qk.displayState(threadId ?? "none"),
    queryFn: () => fetchDisplayState(threadId as string, userId),
    enabled: Boolean(threadId) && (options?.enabled ?? true),
    refetchInterval: options?.refetchInterval,
  });
}

/** 命令式取一次最新 display-state(保证拿到服务端真相,不经缓存;引用稳定可入 deps) */
export function useFetchDisplayStateQuery() {
  const queryClient = useQueryClient();
  return useCallback(
    async (userId: string, threadId: string) =>
      queryClient.fetchQuery({
        queryKey: qk.displayState(threadId),
        queryFn: () => fetchDisplayState(threadId, userId),
        staleTime: 0,
      }),
    [queryClient],
  );
}
