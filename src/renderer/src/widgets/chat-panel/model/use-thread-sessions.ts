import { toAISdkMessages } from "@mastra/ai-sdk/ui";
import {
  type AgentControllerSubscription,
  isKnownAgentControllerEvent,
  type KnownAgentControllerEvent,
} from "@mastra/client-js";
import { mastraDBMessageToSignal } from "@mastra/core/signals";
import { useQueryClient } from "@tanstack/react-query";
import { DefaultChatTransport, type FileUIPart, isToolUIPart, readUIMessageStream } from "ai";
import * as React from "react";
import { toast } from "sonner";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { qk, type WorkThread } from "@/entities/workbench";
import { getWorkbenchClientSession, MASTRA_SERVER_URL, requestJson } from "@/shared/api";
import { i18n } from "@/shared/i18n";
import { apiError, readErrorPayload } from "@/shared/lib";
import {
  type ConnectionState,
  createSessionConnection,
  fetchSessionStream,
  isConnectionError,
  waitForSessionDelay,
} from "./session-connection";
import {
  type MessageQueueAction,
  mergeToolPart,
  type QueuedRequest,
  type WorkMessageMetadata,
  type WorkUIMessage,
} from "./types";

type NativeDisplayState = Extract<
  KnownAgentControllerEvent,
  { type: "display_state_changed" }
>["displayState"];
type ObservedRun = { workflowId: string; runId: string } | { messageId: string };
const runMessageId = (run: ObservedRun) =>
  "messageId" in run ? run.messageId : `workflow-${run.runId}`;

export class ToolInteractionUnavailableError extends Error {}
interface SessionView {
  queuedRequests: QueuedRequest[];
  messages: WorkUIMessage[];
  status: "ready" | "submitted" | "streaming" | "error";
  connection: ConnectionState;
  connectionError?: string;
  runError?: string;
  native?: NativeDisplayState;
}
interface MessageInput {
  text?: string;
  files?: FileUIPart[];
  metadata?: WorkMessageMetadata;
  messageId?: string;
  options?: Record<string, unknown>;
  prepareFiles?: () => Promise<FileUIPart[]>;
}
type MessageUpdate = WorkUIMessage[] | ((messages: WorkUIMessage[]) => WorkUIMessage[]);
const emptyStore = createStore<SessionView>(() => ({
  messages: [],
  status: "ready",
  queuedRequests: [],
  connection: "disconnected",
}));

function createThreadSession(
  userId: string,
  threadId: string,
  buildBody: () => Record<string, unknown>,
  onBusy: (busy: boolean) => void,
  onSettled: () => void,
  isDeleting: () => boolean,
) {
  const store = createStore<SessionView>(() => ({
    messages: [],
    status: "ready",
    queuedRequests: [],
    connection: "connecting",
  }));
  const client = getWorkbenchClientSession(userId, threadId);
  let disposed = false;
  let observationSignal: AbortSignal | undefined;
  let interruptObservation: ((error: unknown) => void) | undefined;
  let runObserver: AbortController | undefined;
  let runTarget: ObservedRun | undefined;
  const stopRunObserver = () => {
    runObserver?.abort();
    runObserver = undefined;
  };
  let commandPending = false;
  let runRunning = false;
  let awaitingRun = false;
  let failed = false;
  let revision = 0;
  let refreshRevision = 0;
  let queueRevision = 0;
  let librarySources: unknown[] = [];
  const pendingMessages = new Map<string, WorkUIMessage>();
  let submittedMessageId: string | undefined;
  const setQueue = (requests: QueuedRequest[]) =>
    store.setState(({ messages }) => ({
      queuedRequests: requests.filter(
        (request) => !messages.some((message) => message.id === request.id),
      ),
    }));
  const setMessages = (update: MessageUpdate) =>
    store.setState(({ messages }) => {
      const next = [...(typeof update === "function" ? update(messages) : update)];
      for (const pending of pendingMessages.values()) {
        if (next.some((message) => message.id === pending.id)) continue;
        const at = Date.parse(pending.metadata?.createdAt ?? "");
        const index = next.findIndex(
          (message) => Date.parse(message.metadata?.createdAt ?? "") > at,
        );
        next.splice(index < 0 ? next.length : index, 0, pending);
      }
      return { messages: next };
    });
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
    store.setState({ runError: detail.split("\n")[0] });
    toast.error(i18n.t("chat:messages.turnFailed", { detail }));
  };
  const applyMessage = (current: NativeDisplayState["currentMessage"], isRunning: boolean) => {
    // The controller retains its last snapshot after agent_end; history owns completed messages.
    if (!isRunning) return;
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
          const previous = next[index];
          const tools = new Map(
            previous?.parts.filter(isToolUIPart).map((part) => [part.toolCallId, part]),
          );
          const parts: WorkUIMessage["parts"] = ui.parts.map((part, partIndex) => {
            if (isToolUIPart(part)) return mergeToolPart(tools.get(part.toolCallId), part);
            // DB-message conversion marks reasoning as done; the live trailing part is still streaming.
            if (part.type === "reasoning")
              return {
                ...part,
                state:
                  isRunning && partIndex === ui.parts.length - 1
                    ? ("streaming" as const)
                    : ("done" as const),
              };
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
          const updated = {
            ...ui,
            metadata: {
              ...previous?.metadata,
              ...ui.metadata,
              createdAt: new Date(current.createdAt).toISOString(),
            },
            parts,
          };
          if (index < 0) next.push(updated);
          else next[index] = updated;
        }
        return next;
      });
    }
  };
  const applyDisplay = (native: NativeDisplayState) => {
    if (native.isRunning) awaitingRun = false;
    revision++;
    store.setState({ native });
    applyMessage(native.currentMessage, native.isRunning);
    setStatus(
      failed
        ? "error"
        : native.isRunning || runRunning
          ? "streaming"
          : commandPending || awaitingRun
            ? "submitted"
            : "ready",
    );
  };
  const refresh = async (signal = observationSignal) => {
    const requestRevision = ++refreshRevision;
    const startedAt = revision;
    const queueStartedAt = queueRevision;
    const messagesAtStart = new Map(
      store.getState().messages.map((message) => [message.id, message]),
    );
    const payload = await requestJson<{
      displayState: NativeDisplayState & {
        queuedRequests: QueuedRequest[];
        activeWorkflow: { workflowId: string; runId: string } | null;
        activeMediaGeneration: { messageId: string } | null;
      };
      messages: WorkUIMessage[];
    }>(
      `/work/sessions/workbench/threads/${encodeURIComponent(threadId)}/display-state?resourceId=${encodeURIComponent(userId)}&includeMessages=true`,
      { signal: AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]) },
    );
    signal?.throwIfAborted();
    if (disposed || signal !== observationSignal || requestRevision !== refreshRevision) return;
    if (payload.displayState.activeWorkflow || payload.displayState.activeMediaGeneration)
      failed = false;
    for (const message of payload.messages) pendingMessages.delete(message.id);
    const submittedIndex = payload.messages.findIndex(
      (message) => message.id === submittedMessageId,
    );
    if (
      submittedIndex >= 0 &&
      !payload.displayState.isRunning &&
      payload.messages.slice(submittedIndex + 1).some((message) => message.role === "assistant")
    )
      awaitingRun = false;
    const target =
      payload.displayState.activeMediaGeneration ??
      payload.displayState.activeWorkflow ??
      runTarget;
    if (target && signal && !runObserver) followConversationRun(target, signal);
    if (queueStartedAt === queueRevision) {
      setQueue(payload.displayState.queuedRequests);
    }
    if (startedAt === revision) {
      setMessages((current) => {
        const target = runTarget;
        const live =
          runObserver && target
            ? current.find((message) => message.id === runMessageId(target))
            : undefined;
        return live && !payload.messages.some((message) => message.id === live.id)
          ? [...payload.messages, live]
          : payload.messages;
      });
      applyDisplay(payload.displayState);
    } else {
      // Keep newer live rows, not idle resume preludes absent from persisted history.
      setMessages((current) => {
        const native = store.getState().native;
        const ids = new Set(payload.messages.map((message) => message.id));
        const live = current.filter(
          (message) =>
            (native?.isRunning &&
              (message.id === native.currentMessage?.id ||
                message !== messagesAtStart.get(message.id))) ||
            (runObserver &&
              runTarget &&
              message.id === runMessageId(runTarget) &&
              (!ids.has(message.id) || message !== messagesAtStart.get(message.id))),
        );
        const liveById = new Map(live.map((message) => [message.id, message]));
        return [
          ...payload.messages.map((message) => liveById.get(message.id) ?? message),
          ...live.filter((message) => !ids.has(message.id)),
        ];
      });
    }
    return payload.displayState;
  };
  const refreshQueue = async () => {
    if (disposed || isDeleting()) return;
    const signal = observationSignal;
    const startedAt = ++queueRevision;
    const payload = await requestJson<{ requests: QueuedRequest[] }>(
      `/work/threads/${encodeURIComponent(threadId)}/message-queue`,
      { signal },
    );
    signal?.throwIfAborted();
    if (!disposed && startedAt === queueRevision) setQueue(payload.requests);
  };
  const queueRefreshFailed = (error: unknown) => {
    if (!disposed && !isDeleting() && !(error instanceof Error && error.name === "AbortError"))
      toast.error(i18n.t("chat:prompt.queueSyncFailed"), {
        description: error instanceof Error ? error.message : String(error),
      });
  };
  const reconcile = () => {
    const signal = observationSignal;
    const interrupt = interruptObservation;
    void refresh(signal)
      .then(() => {
        if (!disposed && !signal?.aborted) onSettled();
      })
      .catch((error) => {
        if (disposed || signal?.aborted) return;
        if (isConnectionError(error)) interrupt?.(error);
        else fail(error);
      });
  };
  const connection = createSessionConnection({
    online: () => navigator.onLine,
    onState: (state, error) => {
      store.setState({
        connection: state,
        connectionError: error instanceof Error ? error.message : undefined,
      });
    },
    observe: async (lifetime, connected) => {
      stopRunObserver();
      const attempt = new AbortController();
      const signal = AbortSignal.any([lifetime, attempt.signal]);
      observationSignal = signal;
      interruptObservation = (error) => attempt.abort(error);
      let subscription: AgentControllerSubscription | undefined;
      const timer = setTimeout(
        () => attempt.abort(new DOMException("Connection timed out", "TimeoutError")),
        30_000,
      );
      const closed = new Promise<never>((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      void closed.catch(() => undefined);
      try {
        subscription = await getWorkbenchClientSession(userId, threadId, {
          abortSignal: signal,
          fetch: fetchSessionStream,
        }).subscribe({
          // The product owns both initial and later retries so connection state is observable.
          reconnect: false,
          onError: (error) =>
            attempt.abort(
              new TypeError(error instanceof Error ? error.message : "Session stream ended"),
            ),
          onEvent: (event) => {
            if (disposed || signal.aborted) return;
            if (!isKnownAgentControllerEvent(event)) return;
            if (event.type === "message_start") {
              revision++;
              applyMessage(
                { ...event.message, createdAt: new Date(event.message.createdAt).toISOString() },
                true,
              );
              const message = store
                .getState()
                .messages.find((item) => item.id === event.message.id);
              if (message?.role === "user") {
                pendingMessages.set(message.id, message);
                submittedMessageId = message.id;
                queueRevision++;
                store.setState(({ queuedRequests }) => ({
                  queuedRequests: queuedRequests.filter((item) => item.id !== message.id),
                  runError: undefined,
                }));
                failed = false;
                awaitingRun = true;
                setStatus(store.getState().native?.isRunning ? "streaming" : "submitted");
              }
            }
            if (event.type === "follow_up_queued") void refreshQueue().catch(queueRefreshFailed);
            if (event.type === "agent_start") {
              failed = false;
              awaitingRun = false;
              store.setState({ runError: undefined });
              setStatus("streaming");
            }
            if (event.type === "display_state_changed") applyDisplay(event.displayState);
            else if (event.type === "agent_end") {
              awaitingRun = false;
              reconcile();
            } else if (
              [
                "tool_approval_required",
                "tool_suspended",
                "tool_suspension_cancelled",
                "task_updated",
                "goal_evaluation",
                "thread_title_updated",
                "om_thread_title_updated",
              ].includes(event.type)
            )
              onSettled();
            else if (event.type === "error" && !event.retryable)
              fail(new Error(event.error.message));
          },
        });
        signal.throwIfAborted();
        await refresh(signal);
        signal.throwIfAborted();
        clearTimeout(timer);
        connected();
        onSettled();
        await closed;
      } finally {
        clearTimeout(timer);
        attempt.abort();
        subscription?.unsubscribe();
        if (observationSignal === signal) {
          stopRunObserver();
        }
      }
    },
  });
  const connect = () => {
    if (isDeleting())
      return Promise.reject(new DOMException("Thread deletion in progress", "AbortError"));
    disposed = false;
    return connection.connect();
  };
  const request = async (command: () => Promise<unknown>) => {
    let submitted = false;
    failed = false;
    commandPending = true;
    store.setState({ runError: undefined });
    // Connecting and its initial idle snapshot are part of the pending command.
    setStatus("submitted");
    try {
      await connect();
      if (disposed) throw new DOMException("Session disposed", "AbortError");
      awaitingRun = true;
      submitted = true;
      await command();
      commandPending = false;
      const native = store.getState().native;
      setStatus(
        failed
          ? "error"
          : native?.isRunning || runRunning
            ? "streaming"
            : awaitingRun
              ? "submitted"
              : "ready",
      );
    } catch (error) {
      commandPending = false;
      awaitingRun = false;
      if (error instanceof ToolInteractionUnavailableError) {
        setStatus(store.getState().native?.isRunning || runRunning ? "streaming" : "ready");
        reconcile();
      } else if (error instanceof DOMException && error.name === "AbortError") {
        setStatus(store.getState().native?.isRunning || runRunning ? "streaming" : "ready");
      } else {
        fail(error);
        if (submitted && isConnectionError(error)) reconcile();
      }
      throw error;
    }
  };
  const messageOptions = (input?: MessageInput) => {
    const body = input?.options ?? buildBody();
    return {
      ...body,
      clientMessageId: input?.metadata?.clientMessageId,
      skillNames: input?.metadata?.skillNames,
      fileReferences: input?.metadata?.fileReferences,
      goal: input?.metadata?.goal,
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
  function followConversationRun(target: ObservedRun, parent: AbortSignal) {
    runObserver?.abort();
    const observer = new AbortController();
    runObserver = observer;
    runTarget = target;
    runRunning = true;
    awaitingRun = false;
    const signal = AbortSignal.any([parent, observer.signal]);
    void (async () => {
      if ("messageId" in target) {
        // Observe the saved message with ordinary GETs. Never resubmit a paid request here.
        while (!signal.aborted) {
          const display = await refresh();
          signal.throwIfAborted();
          if (display && display.activeMediaGeneration?.messageId !== target.messageId) break;
          await waitForSessionDelay(2_000, signal);
        }
      } else {
        const runPath = `/work/sessions/workbench/threads/${encodeURIComponent(threadId)}/workflows/${encodeURIComponent(target.workflowId)}/runs/${encodeURIComponent(target.runId)}`;
        const api = `${MASTRA_SERVER_URL}${runPath}/stream?resourceId=${encodeURIComponent(userId)}`;
        const transport = new DefaultChatTransport({
          api,
          credentials: "include",
          prepareReconnectToStreamRequest: () => ({ api }),
          fetch: async (url, init) => {
            const response = await fetchSessionStream(url, init);
            if (!response.ok)
              throw Object.assign(
                apiError(
                  await readErrorPayload(response, "Workflow observation failed"),
                  "Workflow observation failed",
                ),
                { status: response.status },
              );
            return response;
          },
        });
        const stream = await transport.reconnectToStream({ chatId: threadId, abortSignal: signal });
        if (!stream) throw new TypeError("Workflow stream unavailable");
        setStatus("streaming");
        let finished = false;
        const checked = stream.pipeThrough(
          new TransformStream({
            transform(chunk, controller) {
              if (chunk.type === "finish") finished = true;
              controller.enqueue(chunk);
            },
          }),
        );
        for await (const message of readUIMessageStream<WorkUIMessage>({
          stream: checked,
          terminateOnError: true,
        })) {
          if (signal.aborted || disposed) return;
          revision++;
          setMessages((messages) => {
            const index = messages.findIndex((item) => item.id === message.id);
            return index < 0
              ? [...messages, message]
              : messages.map((item, i) =>
                  i === index
                    ? { ...message, metadata: { ...item.metadata, ...message.metadata } }
                    : item,
                );
          });
        }
        signal.throwIfAborted();
        if (!finished) throw new TypeError("Workflow stream ended before completion");
      }
      signal.throwIfAborted();
      runTarget = undefined;
      runObserver = undefined;
      runRunning = false;
      observer.abort();
      reconcile();
    })().catch((error) => {
      if (signal.aborted || disposed) return;
      if (isConnectionError(error)) interruptObservation?.(error);
      else {
        observer.abort();
        runTarget = undefined;
        runObserver = undefined;
        runRunning = false;
        fail(error);
        onSettled();
      }
    });
  }
  const observeAcceptedRun = (response: unknown) => {
    if (!response || typeof response !== "object") return;
    let target: ObservedRun;
    if (
      "mediaGeneration" in response &&
      response.mediaGeneration &&
      typeof response.mediaGeneration === "object" &&
      "messageId" in response.mediaGeneration &&
      typeof response.mediaGeneration.messageId === "string"
    ) {
      target = { messageId: response.mediaGeneration.messageId };
    } else if (
      "workflowId" in response &&
      "runId" in response &&
      typeof response.workflowId === "string" &&
      typeof response.runId === "string"
    ) {
      target = { workflowId: response.workflowId, runId: response.runId };
    } else return;
    runTarget = target;
    awaitingRun = false;
    if (observationSignal && !observationSignal.aborted && !disposed)
      followConversationRun(target, observationSignal);
    reconcile();
  };
  const streamWorkflow = async (path: string, body: Record<string, unknown>) => {
    // Submission happens exactly once. Recovery uses GET on this accepted run.
    observeAcceptedRun(await requestJson(path, { method: "POST", body }));
  };
  const rewrite = async (messageId: string, action: "edit" | "regenerate", content?: string) => {
    // Ignore repeated clicks before React has rendered the disabled action.
    if (commandPending || runRunning) return;
    return request(async () => {
      const current = store.getState().messages;
      const targetIndex = current.findIndex((message) => message.id === messageId);
      const start =
        action === "edit"
          ? targetIndex
          : current.slice(0, targetIndex).findLastIndex((message) => message.role === "user");
      const removed = new Set(start < 0 ? [] : current.slice(start).map((message) => message.id));
      const path = `/work/threads/${encodeURIComponent(threadId)}/messages/${encodeURIComponent(messageId)}/rewrite`;
      const body = { action, content, options: messageOptions() };
      const response = await requestJson(path, { method: "POST", body });
      setMessages((messages) => messages.filter((message) => !removed.has(message.id)));
      observeAcceptedRun(response);
      await refresh();
    });
  };
  return {
    store,
    hasPendingMessages: () => pendingMessages.size > 0,
    connect,
    reconnect: () => {
      if (isDeleting())
        return Promise.reject(new DOMException("Thread deletion in progress", "AbortError"));
      disposed = false;
      return connection.reconnect();
    },
    disconnect: connection.disconnect,
    refresh,
    setMessages,
    async send(input: MessageInput) {
      librarySources = [];
      if (input.messageId && pendingMessages.has(input.messageId)) await refresh();
      if (input.messageId && !pendingMessages.has(input.messageId))
        return rewrite(input.messageId, "edit", input.text ?? "");
      const id = input.messageId ?? input.metadata?.clientMessageId ?? crypto.randomUUID();
      const metadata = {
        ...input.metadata,
        clientMessageId: id,
        createdAt: new Date().toISOString(),
      };
      pendingMessages.set(id, {
        id,
        role: "user",
        metadata,
        parts: [{ type: "text", text: input.text ?? "" }, ...(input.files ?? [])],
      });
      submittedMessageId = id;
      revision++;
      setMessages((messages) => messages);
      return request(async () => {
        const files = input.prepareFiles ? await input.prepareFiles() : input.files;
        const options = messageOptions({
          ...input,
          files,
          metadata: { ...input.metadata, clientMessageId: id },
        });
        await client.sendMessage(input.text ?? "", requestOptions(options));
        await refresh();
      });
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
    async enqueue(input: MessageInput) {
      const options = messageOptions(input);
      await connect();
      const startedAt = ++queueRevision;
      const payload = await requestJson<{ requests: QueuedRequest[] }>(
        `/work/threads/${encodeURIComponent(threadId)}/message-queue`,
        { method: "POST", body: { text: input.text ?? "", options } },
      );
      // POST ACK carries the queue; newer SSE reconciliation takes precedence if dispatch raced it.
      if (!disposed && startedAt === queueRevision) setQueue(payload.requests);
    },
    async queueAction(id: string, action: MessageQueueAction) {
      await connect();
      try {
        await requestJson(
          `/work/threads/${encodeURIComponent(threadId)}/message-queue/${encodeURIComponent(id)}`,
          {
            method: "POST",
            body: action,
          },
        );
      } finally {
        // Never remove a row optimistically: cancellation can lose to execution.
        await refreshQueue().catch(queueRefreshFailed);
      }
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
        if (!result.ok) {
          if (
            ["not_pending", "stale_tool_call", "no_pending_suspension"].includes(
              result.reason ?? "",
            )
          )
            throw new ToolInteractionUnavailableError(result.reason);
          throw new Error(result.reason);
        }
      });
    },
    dispose() {
      disposed = true;
      connection.disconnect();
      runObserver?.abort();
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
  const queryClient = useQueryClient();
  const sessions = React.useMemo(() => new Map<string, ThreadSession>(), [userId]);
  React.useEffect(
    () =>
      queryClient.getMutationCache().subscribe((event) => {
        if (event.type !== "updated") return;
        const key = event.mutation.options.mutationKey;
        if (key?.[0] !== qk.deleteThread(userId)[0] || key[1] !== userId) return;
        const threadId = event.mutation.state.variables;
        if (typeof threadId !== "string") return;
        const session = sessions.get(threadId);
        if (!session) return;
        if (event.action.type === "pending") session.dispose();
        else if (event.action.type === "success" || event.action.type === "error") {
          const threads = queryClient.getQueryData<WorkThread[]>(qk.threads(userId));
          if (
            event.action.type === "success" ||
            (threads && !threads.some((thread) => thread.id === threadId))
          ) {
            session.dispose();
            sessions.delete(threadId);
          } else void session.reconnect().catch(() => undefined);
        }
      }),
    [queryClient, sessions, userId],
  );
  const callbacks = React.useRef({ buildBody, onBusy, onSettled });
  callbacks.current = { buildBody, onBusy, onSettled };
  React.useEffect(() => {
    const online = () => {
      for (const session of sessions.values()) void session.reconnect().catch(() => undefined);
    };
    const offline = () => {
      for (const session of sessions.values()) session.disconnect();
    };
    window.addEventListener("online", online);
    window.addEventListener("offline", offline);
    return () => {
      window.removeEventListener("online", online);
      window.removeEventListener("offline", offline);
    };
  }, [sessions]);
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
          () =>
            queryClient.isMutating({
              mutationKey: qk.deleteThread(userId),
              exact: true,
              predicate: (mutation) => mutation.state.variables === threadId,
            }) > 0,
        );
        sessions.set(threadId, session);
      }
      return session;
    },
    [queryClient, sessions, userId],
  );
  const retainActive = React.useCallback(
    (activeThreadId: string | null) => {
      for (const [threadId, session] of sessions) {
        const status = session.store.getState().status;
        if (
          threadId !== activeThreadId &&
          status !== "submitted" &&
          status !== "streaming" &&
          !session.hasPendingMessages() &&
          session.store.getState().queuedRequests.length === 0
        ) {
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
