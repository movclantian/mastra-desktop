/**
 * 会话展示状态(display-state)Query:chat-panel 在 busy 时以 1200ms 轮询
 * 驱动任务/工作流面板(替代手写 setInterval + refreshRequestRef 防陈旧)。
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
