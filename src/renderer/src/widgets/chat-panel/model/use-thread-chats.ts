import { Chat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import * as React from "react";
import { toast } from "sonner";
import { apiFetch, MASTRA_SERVER_URL } from "@/shared/api";
import { isTransientStreamError, STREAM_RECONNECT_LIMIT, streamErrorMessage } from "../lib/display";
import type { WorkUIMessage } from "../model/types";

// ---------------------------------------------------------------------------
// 每线程一个 Chat 实例的自定义 Hook。
//
// 只用一个 useChat 服务全部线程会串台:A 还在流式时切到 B,A 的 delta 会继续写进
// 同一个 Chat,于是 A 的回复出现在 B 的列表里,连带 `[messages.length, status]`
// 那个 effect 也会拿 A 的结束事件去拉 B 的挂起交互。
//
// 传 `id` 能让 useChat 在 id 变化时换新实例(@ai-sdk/react 的 shouldRecreateChat),
// 串台就没了 —— 但 AI SDK **没有** id → Chat 的全局注册表(v5 起 ChatStore 已移除),
// 旧实例会被丢弃,切回来看不到仍在进行的输出。所以注册表由我们自己持有:
// 切走的线程留在自己的实例里继续流,切回来直接接上实时输出。
// ---------------------------------------------------------------------------

export interface ThreadChats {
  /** 取(或惰性创建)指定线程的 Chat 实例 */
  getThreadChat: (threadId: string) => Chat<WorkUIMessage>;
  /** 回收闲置实例:只保留当前线程与仍在流式的线程 */
  retainActive: (activeThreadId: string | null) => void;
}

export function useThreadChats(
  userId: string,
  buildRequestBody: (threadId: string) => Record<string, unknown>,
  onThreadBusyChange?: (threadId: string, isBusy: boolean) => void,
): ThreadChats {
  const chatsRef = React.useRef(new Map<string, Chat<WorkUIMessage>>());
  const reconnectAttemptsRef = React.useRef(new Map<string, number>());
  const reconnectTimersRef = React.useRef(new Map<string, number>());
  const buildRequestBodyRef = React.useRef(buildRequestBody);
  buildRequestBodyRef.current = buildRequestBody;
  const onThreadBusyChangeRef = React.useRef(onThreadBusyChange);
  onThreadBusyChangeRef.current = onThreadBusyChange;

  React.useEffect(
    () => () => {
      for (const timer of reconnectTimersRef.current.values()) window.clearTimeout(timer);
      reconnectTimersRef.current.clear();
    },
    [],
  );

  const getThreadChat = React.useCallback(
    (threadId: string) => {
      const existing = chatsRef.current.get(threadId);
      if (existing) return existing;
      let chat!: Chat<WorkUIMessage>;
      chat = new Chat<WorkUIMessage>({
        id: threadId,
        transport: new DefaultChatTransport<WorkUIMessage>({
          api: `${MASTRA_SERVER_URL}/chat/mastra-work-agent`,
          prepareReconnectToStreamRequest: () => ({
            api: `${MASTRA_SERVER_URL}/work/sessions/workbench/threads/${encodeURIComponent(threadId)}/stream?resourceId=${encodeURIComponent(userId)}`,
          }),
          prepareSendMessagesRequest: ({ messages, body, trigger, messageId, id }) => {
            // 自定义 prepareSendMessagesRequest 会**整体替换**默认 body,所以
            // trigger / messageId 必须显式带上 —— 否则 regenerate() 到了服务端
            // 不再是 'regenerate-message',toAISdkStream 就不会把待重生成的
            // 那条助手消息从输入里切掉(见 @mastra/ai-sdk 的 messagesToSend)。
            // Memory 历史由服务端加载;官方 AI SDK UI 集成只发送本次请求的
            // 最新消息,避免浏览器时间戳与数据库历史排序冲突。
            // 逐次调用传入的 body(如 resume 的 runId/resumeData)优先于公共字段。
            reconnectAttemptsRef.current.delete(threadId);
            const reconnectTimer = reconnectTimersRef.current.get(threadId);
            if (reconnectTimer !== undefined) {
              window.clearTimeout(reconnectTimer);
              reconnectTimersRef.current.delete(threadId);
            }
            onThreadBusyChangeRef.current?.(threadId, true);
            const payload: Record<string, unknown> = {
              ...buildRequestBodyRef.current(threadId),
              ...body,
              id,
              trigger,
              messageId,
              messages: messages.length > 0 ? [messages[messages.length - 1]] : [],
            };
            return { body: payload };
          },
        }),
        onFinish: ({ isError }) => {
          if (!isError) {
            reconnectAttemptsRef.current.delete(threadId);
            const timer = reconnectTimersRef.current.get(threadId);
            if (timer !== undefined) {
              window.clearTimeout(timer);
              reconnectTimersRef.current.delete(threadId);
            }
            onThreadBusyChangeRef.current?.(threadId, false);
          }
        },
        onError: (error) => {
          const detail = streamErrorMessage(error);
          if (!isTransientStreamError(error)) {
            onThreadBusyChangeRef.current?.(threadId, false);
            toast.error(`本轮生成失败：${detail}`);
            return;
          }

          const attempt = (reconnectAttemptsRef.current.get(threadId) ?? 0) + 1;
          reconnectAttemptsRef.current.set(threadId, attempt);
          if (attempt > STREAM_RECONNECT_LIMIT) {
            onThreadBusyChangeRef.current?.(threadId, false);
            toast.error(`流式响应中断：${detail}`);
            return;
          }

          const delay = attempt * 800;
          const previousTimer = reconnectTimersRef.current.get(threadId);
          if (previousTimer !== undefined) window.clearTimeout(previousTimer);
          const timer = window.setTimeout(() => {
            reconnectTimersRef.current.delete(threadId);
            void chat
              .resumeStream()
              .then(async () => {
                if (chat.status !== "ready") return;
                const response = await apiFetch(
                  `${MASTRA_SERVER_URL}/work/sessions/workbench/threads/${encodeURIComponent(threadId)}/display-state?resourceId=${encodeURIComponent(userId)}`,
                );
                const payload = (await response.json().catch(() => ({}))) as {
                  displayState?: { activeRunId?: string | null };
                };
                if (!payload.displayState?.activeRunId) {
                  reconnectAttemptsRef.current.delete(threadId);
                  onThreadBusyChangeRef.current?.(threadId, false);
                  toast.error(`流式响应中断：${detail}`);
                }
              })
              .catch(() => {
                onThreadBusyChangeRef.current?.(threadId, false);
              });
          }, delay);
          reconnectTimersRef.current.set(threadId, timer);
        },
      });
      chatsRef.current.set(threadId, chat);
      return chat;
    },
    [userId],
  );

  const retainActive = React.useCallback((activeThreadId: string | null) => {
    // 回收:只保留当前线程与仍在流式的线程,否则每访问一条线程就永久多留一份消息数组
    for (const [threadId, chat] of chatsRef.current) {
      const busy = chat.status === "submitted" || chat.status === "streaming";
      if (threadId !== activeThreadId && !busy) {
        chatsRef.current.delete(threadId);
      }
    }
  }, []);

  return { getThreadChat, retainActive };
}

/** 占位实例:没有激活线程时也必须调用 useChat(Hook 规则) */
export function usePlaceholderChat(): Chat<WorkUIMessage> {
  return React.useMemo(
    () => new Chat<WorkUIMessage>({ id: "no-thread", transport: new DefaultChatTransport() }),
    [],
  );
}
