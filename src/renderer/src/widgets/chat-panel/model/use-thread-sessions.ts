import { toAISdkMessages } from "@mastra/ai-sdk/ui";
import {
  type AgentControllerSubscription,
  isKnownAgentControllerEvent,
  type KnownAgentControllerEvent,
  MastraClient,
} from "@mastra/client-js";
import type { FileUIPart } from "ai";
import * as React from "react";
import { toast } from "sonner";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { MASTRA_SERVER_URL, requestJson } from "@/shared/api";
import { i18n } from "@/shared/i18n";
import type { WorkMessageMetadata, WorkUIMessage } from "./types";

type NativeDisplayState = Extract<
  KnownAgentControllerEvent,
  { type: "display_state_changed" }
>["displayState"];
interface SessionView {
  messages: WorkUIMessage[];
  status: "ready" | "submitted" | "streaming" | "error";
  native?: NativeDisplayState;
}
interface MessageInput {
  text?: string;
  files?: FileUIPart[];
  metadata?: WorkMessageMetadata;
  messageId?: string;
}
type MessageUpdate = WorkUIMessage[] | ((messages: WorkUIMessage[]) => WorkUIMessage[]);
const emptyStore = createStore<SessionView>(() => ({ messages: [], status: "ready" }));

function createThreadSession(
  userId: string,
  threadId: string,
  buildBody: () => Record<string, unknown>,
  onBusy: (busy: boolean) => void,
  onSettled: () => void,
) {
  const store = createStore<SessionView>(() => ({ messages: [], status: "ready" }));
  const client = new MastraClient({
    baseUrl: MASTRA_SERVER_URL,
    retries: 0,
    credentials: "include",
  })
    .getAgentController("workbench")
    .session(userId, JSON.stringify(["workbench", threadId]));
  let subscription: AgentControllerSubscription | undefined;
  let connecting: Promise<void> | undefined;
  let disposed = false;
  let commandPending = false;
  let failed = false;
  let revision = 0;
  let librarySources: unknown[] = [];
  const setMessages = (update: MessageUpdate) =>
    store.setState(({ messages }) => ({
      messages: typeof update === "function" ? update(messages) : update,
    }));
  const setStatus = (status: SessionView["status"]) => {
    if (store.getState().status === status) return;
    store.setState({ status });
    onBusy(status === "submitted" || status === "streaming");
  };
  const fail = (error: unknown) => {
    if (disposed) return;
    failed = true;
    setStatus("error");
    const detail = error instanceof Error ? error.message : String(error);
    toast.error(i18n.t("chat:messages.turnFailed", { detail }));
  };
  const applyDisplay = (native: NativeDisplayState) => {
    revision++;
    store.setState({ native });
    const current = native.currentMessage;
    if (
      current &&
      (current.role === "assistant" ||
        current.role === "user" ||
        (current.role === "signal" && current.type === "user"))
    ) {
      const message = {
        ...current,
        createdAt: new Date(current.createdAt),
        role: current.role === "signal" ? ("user" as const) : current.role,
      };
      const converted = toAISdkMessages([message], { version: "v7" }) as WorkUIMessage[];
      setMessages((messages) => {
        const next = [...messages];
        for (const ui of converted) {
          const index = next.findIndex((item) => item.id === ui.id);
          // Final persisted messages contain stop/error metadata absent from display snapshots.
          if (!native.isRunning && index >= 0) continue;
          const previous = next[index];
          const parts = ui.parts.map((part) => {
            if (part.type !== "file" || part.filename) return part;
            const original = previous?.parts.find(
              (item) => item.type === "file" && item.url === part.url,
            );
            return original?.type === "file" ? { ...part, filename: original.filename } : part;
          });
          // Product references are added by history projection, beyond the native converter.
          for (const part of previous?.parts ?? []) {
            if (
              part.type.startsWith("data-") &&
              !(part.type === "data-library-sources" && librarySources.length) &&
              !parts.some((nextPart) => nextPart.type === part.type)
            )
              parts.push(part);
          }
          if (ui.role === "assistant" && librarySources.length)
            parts.push({ type: "data-library-sources", data: librarySources });
          const updated = { ...ui, metadata: { ...previous?.metadata, ...ui.metadata }, parts };
          if (index < 0) next.push(updated);
          else next[index] = updated;
        }
        return next;
      });
    }
    setStatus(
      failed ? "error" : native.isRunning ? "streaming" : commandPending ? "submitted" : "ready",
    );
  };
  const refresh = async () => {
    const startedAt = revision;
    const payload = await requestJson<{
      displayState: NativeDisplayState;
      messages: WorkUIMessage[];
    }>(
      `/work/sessions/workbench/threads/${encodeURIComponent(threadId)}/display-state?resourceId=${encodeURIComponent(userId)}&includeMessages=true`,
    );
    if (disposed) return;
    if (startedAt === revision) {
      setMessages(payload.messages);
      applyDisplay(payload.displayState);
    } else {
      // Preserve live updates received while the history request was in flight.
      setMessages((current) => {
        const native = store.getState().native;
        const live = native?.isRunning
          ? current.find((message) => message.id === native.currentMessage?.id)
          : undefined;
        const ids = new Set(payload.messages.map((message) => message.id));
        return [
          ...payload.messages.map((message) => (message.id === live?.id ? live : message)),
          ...current.filter((message) => !ids.has(message.id)),
        ];
      });
    }
  };
  const connect = (): Promise<void> => {
    disposed = false;
    if (subscription) return Promise.resolve();
    if (connecting) return connecting;
    connecting = (async () => {
      await refresh();
      if (disposed) return;
      const next = await client.subscribe({
        reconnect: true,
        onReconnect: () => {
          failed = false;
          void refresh().then(onSettled).catch(fail);
        },
        onError: (error) => {
          subscription = undefined;
          fail(error);
        },
        onEvent: (event) => {
          if (disposed || !isKnownAgentControllerEvent(event)) return;
          if (event.type === "display_state_changed") applyDisplay(event.displayState);
          else if (event.type === "agent_end") void refresh().then(onSettled).catch(fail);
          else if (
            [
              "tool_approval_required",
              "tool_suspended",
              "tool_suspension_cancelled",
              "task_updated",
            ].includes(event.type)
          )
            onSettled();
          else if (event.type === "error" && !event.retryable) fail(new Error(event.error.message));
        },
      });
      if (disposed) next.unsubscribe();
      else {
        subscription = next;
        await refresh();
      }
    })()
      .catch((error) => {
        fail(error);
        throw error;
      })
      .finally(() => {
        connecting = undefined;
      });
    return connecting;
  };
  const request = async (body: Record<string, unknown>) => {
    try {
      await connect();
      failed = false;
      commandPending = true;
      setStatus("submitted");
      const previousMessageId = store.getState().native?.currentMessage?.id;
      const response = await requestJson<{ ok: boolean; librarySources?: unknown[] }>(
        "/chat/mastra-work-agent",
        {
          method: "POST",
          body: { ...buildBody(), ...body, id: threadId },
        },
      );
      commandPending = false;
      librarySources = response.librarySources ?? [];
      const native = store.getState().native;
      setStatus(failed ? "error" : native?.isRunning ? "streaming" : "ready");
      if (
        librarySources.length &&
        native?.currentMessage?.role === "assistant" &&
        native.currentMessage.id !== previousMessageId
      ) {
        const messageId = native.currentMessage.id;
        setMessages((messages) =>
          messages.map((message) =>
            message.id === messageId
              ? {
                  ...message,
                  parts: [
                    ...message.parts.filter((part) => part.type !== "data-library-sources"),
                    { type: "data-library-sources", data: librarySources },
                  ],
                }
              : message,
          ),
        );
      }
    } catch (error) {
      commandPending = false;
      fail(error);
      throw error;
    }
  };
  return {
    store,
    connect,
    refresh,
    setMessages,
    async send(input?: MessageInput, options?: { body?: Record<string, unknown> }) {
      await connect();
      librarySources = [];
      let message: WorkUIMessage | undefined;
      if (input) {
        message = {
          id: input.messageId ?? crypto.randomUUID(),
          role: "user",
          metadata: input.metadata,
          parts: [
            ...(input.text ? [{ type: "text" as const, text: input.text }] : []),
            ...(input.files ?? []),
          ],
        };
        const nextMessage = message;
        setMessages((messages) => {
          const index = messages.findIndex((item) => item.id === nextMessage.id);
          return [...(index < 0 ? messages : messages.slice(0, index)), nextMessage];
        });
      }
      return request({
        trigger: "submit-message",
        messageId: input?.messageId,
        messages: message ? [message] : [],
        ...options?.body,
      });
    },
    async regenerate({ messageId }: { messageId: string }) {
      await connect();
      librarySources = [];
      setMessages((messages) => {
        const index = messages.findIndex((message) => message.id === messageId);
        return index < 0 ? messages : messages.slice(0, index);
      });
      return request({ trigger: "regenerate-message", messageId, messages: [] });
    },
    dispose() {
      disposed = true;
      subscription?.unsubscribe();
      subscription = undefined;
    },
  };
}

export type ThreadSession = ReturnType<typeof createThreadSession>;

/** Native Session subscriptions remain attached to running threads when the selected tab changes. */
export function useThreadSessions(
  userId: string,
  buildBody: (threadId: string) => Record<string, unknown>,
  onBusy: (threadId: string, busy: boolean) => void,
  onSettled: (threadId: string) => void,
) {
  const sessions = React.useMemo(() => new Map<string, ThreadSession>(), [userId]);
  const callbacks = React.useRef({ buildBody, onBusy, onSettled });
  callbacks.current = { buildBody, onBusy, onSettled };
  React.useEffect(
    () => () => {
      for (const session of sessions.values()) session.dispose();
    },
    [sessions],
  );
  const getThreadSession = React.useCallback(
    (threadId: string) => {
      let session = sessions.get(threadId);
      if (!session) {
        session = createThreadSession(
          userId,
          threadId,
          () => callbacks.current.buildBody(threadId),
          (busy) => callbacks.current.onBusy(threadId, busy),
          () => callbacks.current.onSettled(threadId),
        );
        sessions.set(threadId, session);
      }
      return session;
    },
    [sessions, userId],
  );
  const retainActive = React.useCallback(
    (activeThreadId: string | null) => {
      for (const [threadId, session] of sessions) {
        const status = session.store.getState().status;
        if (threadId !== activeThreadId && status !== "submitted" && status !== "streaming") {
          session.dispose();
          sessions.delete(threadId);
        }
      }
    },
    [sessions],
  );
  return { getThreadSession, retainActive };
}

export function useSessionView(session: ThreadSession | null) {
  const snapshot = useStore(session?.store ?? emptyStore);
  React.useEffect(() => {
    if (session) void session.connect().catch(() => undefined);
  }, [session]);
  const setMessages = React.useCallback(
    (update: MessageUpdate) => session?.setMessages(update),
    [session],
  );
  return { ...snapshot, setMessages };
}
