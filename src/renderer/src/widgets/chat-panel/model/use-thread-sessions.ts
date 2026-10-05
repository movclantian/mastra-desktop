import { toAISdkMessages } from "@mastra/ai-sdk/ui";
import {
  type AgentControllerSubscription,
  isKnownAgentControllerEvent,
  type KnownAgentControllerEvent,
} from "@mastra/client-js";
import { mastraDBMessageToSignal } from "@mastra/core/signals";
import { DefaultChatTransport, type FileUIPart, readUIMessageStream } from "ai";
import * as React from "react";
import { toast } from "sonner";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { getWorkbenchClientSession, MASTRA_SERVER_URL, requestJson } from "@/shared/api";
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
  const client = getWorkbenchClientSession(userId, threadId);
  let subscription: AgentControllerSubscription | undefined;
  let connecting: Promise<void> | undefined;
  let disposed = false;
  let commandPending = false;
  let workflowStreaming = false;
  let awaitingRun = false;
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
    awaitingRun = false;
    setStatus("error");
    const detail = error instanceof Error ? error.message : String(error);
    toast.error(i18n.t("chat:messages.turnFailed", { detail }));
  };
  const applyDisplay = (native: NativeDisplayState) => {
    if (native.isRunning) awaitingRun = false;
    revision++;
    store.setState({ native });
    const current = native.currentMessage;
    const signal =
      current?.role === "signal"
        ? mastraDBMessageToSignal({ ...current, createdAt: new Date(current.createdAt) })
        : undefined;
    if (
      current &&
      (current.role === "assistant" || current.role === "user" || signal?.type === "user")
    ) {
      const stored = signal?.toDBMessage() ?? current;
      const metadata: Record<string, unknown> = { ...stored.content.metadata, ...signal?.metadata };
      const message = {
        ...stored,
        content: { ...stored.content, metadata },
        createdAt: new Date(current.createdAt),
        role: current.role === "signal" ? ("user" as const) : current.role,
      };
      const converted = toAISdkMessages([message], { version: "v7" }) as WorkUIMessage[];
      const filenames = new Map(
        typeof signal?.contents === "object"
          ? signal.contents.flatMap((part) =>
              part.type === "file" && typeof part.data === "string" && part.filename
                ? [[part.data, part.filename] as const]
                : [],
            )
          : [],
      );
      if (message.role === "user") {
        const sources = message.content.metadata.librarySources;
        librarySources = Array.isArray(sources) ? sources : [];
      }
      setMessages((messages) => {
        const next = [...messages];
        for (const ui of converted) {
          const index = next.findIndex((item) => item.id === ui.id);
          // Final persisted messages contain stop/error metadata absent from display snapshots.
          if (!native.isRunning && index >= 0) continue;
          const previous = next[index];
          const parts = ui.parts.map((part) => {
            if (part.type !== "file" || part.filename) return part;
            const filename = filenames.get(part.url);
            if (filename) return { ...part, filename };
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
      failed
        ? "error"
        : native.isRunning || workflowStreaming
          ? "streaming"
          : commandPending || awaitingRun
            ? "submitted"
            : "ready",
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
          else if (event.type === "agent_end") {
            awaitingRun = false;
            void refresh().then(onSettled).catch(fail);
          } else if (
            [
              "tool_approval_required",
              "tool_suspended",
              "tool_suspension_cancelled",
              "task_updated",
              "goal_evaluation",
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
  const request = async (command: () => Promise<unknown>) => {
    try {
      await connect();
      failed = false;
      commandPending = true;
      awaitingRun = true;
      setStatus("submitted");
      await command();
      commandPending = false;
      const native = store.getState().native;
      setStatus(
        failed ? "error" : native?.isRunning ? "streaming" : awaitingRun ? "submitted" : "ready",
      );
    } catch (error) {
      commandPending = false;
      fail(error);
      throw error;
    }
  };
  const messageOptions = (input?: MessageInput) => {
    const { runWorkflow: _runWorkflow, ...body } = buildBody();
    return {
      ...body,
      ...input?.metadata,
      ...(input?.files
        ? {
            files: input.files.map(({ url, mediaType, filename }) => ({
              url,
              mediaType,
              filename,
            })),
          }
        : {}),
    };
  };
  const requestOptions = (options: Record<string, unknown>) => ({
    requestContext: { "mastra-work:message-options": options },
  });
  const streamWorkflow = async (path: string, body: Record<string, unknown>) => {
    const transport = new DefaultChatTransport({
      api: `${MASTRA_SERVER_URL}${path}`,
      credentials: "include",
      prepareSendMessagesRequest: () => ({ body }),
    });
    workflowStreaming = true;
    awaitingRun = false;
    try {
      const stream = await transport.sendMessages({
        chatId: threadId,
        trigger: "submit-message",
        messages: [],
        messageId: undefined,
        abortSignal: undefined,
      });
      await refresh();
      onSettled();
      setStatus("streaming");
      for await (const message of readUIMessageStream<WorkUIMessage>({
        stream,
        terminateOnError: true,
      })) {
        revision++;
        setMessages((messages) => [...messages.filter((item) => item.id !== message.id), message]);
      }
    } finally {
      workflowStreaming = false;
      awaitingRun = false;
      await refresh();
      onSettled();
    }
  };
  const rewrite = (messageId: string, action: "edit" | "regenerate", content?: string) =>
    request(async () => {
      const current = store.getState().messages;
      const targetIndex = current.findIndex((message) => message.id === messageId);
      const start =
        action === "edit"
          ? targetIndex
          : current.slice(0, targetIndex).findLastIndex((message) => message.role === "user");
      const removed = new Set(start < 0 ? [] : current.slice(start).map((message) => message.id));
      const path = `/work/threads/${encodeURIComponent(threadId)}/messages/${encodeURIComponent(messageId)}/rewrite`;
      const body = { action, content, options: messageOptions() };
      if (buildBody().runWorkflow === true) {
        await streamWorkflow(path, body);
      } else {
        await requestJson(path, { method: "POST", body });
        setMessages((messages) => messages.filter((message) => !removed.has(message.id)));
      }
      await refresh();
    });
  return {
    store,
    connect,
    refresh,
    setMessages,
    async send(input: MessageInput) {
      librarySources = [];
      if (input.messageId) return rewrite(input.messageId, "edit", input.text ?? "");
      return request(() =>
        buildBody().runWorkflow === true
          ? streamWorkflow(
              `/work/sessions/workbench/threads/${encodeURIComponent(threadId)}/team-runs`,
              {
                content: input.text?.trim() || "请处理附带的资料。",
                options: messageOptions(input),
              },
            )
          : client.sendMessage(input.text ?? "", requestOptions(messageOptions(input))),
      );
    },
    workflowAction(
      workflowId: string,
      runId: string,
      action: "resume" | "rerun",
      resumeData: unknown,
      label?: string,
    ) {
      return request(() =>
        streamWorkflow(
          `/work/sessions/workbench/threads/${encodeURIComponent(threadId)}/workflows/${encodeURIComponent(workflowId)}/runs/${encodeURIComponent(runId)}/${action}?resourceId=${encodeURIComponent(userId)}`,
          { resumeData, label },
        ),
      );
    },
    async regenerate({ messageId }: { messageId: string }) {
      librarySources = [];
      return rewrite(messageId, "regenerate");
    },
    steer(input: MessageInput) {
      librarySources = [];
      return request(() => client.steer(input.text ?? "", requestOptions(messageOptions(input))));
    },
    respond(
      toolCallId: string,
      response: { approved: boolean; reason?: string } | { resumeData: unknown },
    ) {
      return request(async () => {
        const options = messageOptions();
        if ("approved" in response && !response.approved && response.reason?.trim()) {
          await requestJson(
            `/work/sessions/workbench/threads/${encodeURIComponent(threadId)}/tool-decline?resourceId=${encodeURIComponent(userId)}`,
            {
              method: "POST",
              body: { toolCallId, reason: response.reason.trim(), options },
            },
          );
          return;
        }
        const result =
          "approved" in response
            ? await client.approveTool(toolCallId, response.approved, requestOptions(options))
            : await client.respondToToolSuspension(
                toolCallId,
                response.resumeData as Parameters<typeof client.respondToToolSuspension>[1],
                requestOptions(options),
              );
        if (!result.ok) throw new Error(result.reason);
      });
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
