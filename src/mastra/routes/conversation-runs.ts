import { randomUUID } from "node:crypto";
import type { MastraDBMessage } from "@mastra/core/agent";
import type { ContextWithMastra } from "@mastra/core/server";
import { type MediaGenerationState, mediaGenerationStateSchema } from "../../shared/agent-contract";
import { WORK_MESSAGE_OPTIONS_CONTEXT_KEY, workMessageMetadataSchema } from "../agents/processors";
import { errorText, workError } from "../errors";
import { publishDesktopNotification } from "../harness/signals";
import { resolveModelSelection } from "../models/providers";
import { appStorage } from "../storage/database";
import { generateMedia, mediaInputFromMessage } from "../tools/media-generation";
import type { SessionRouteResult } from "./session-context";

type RunningConversation = {
  messageId?: string;
  controller?: AbortController;
  completion?: Promise<void>;
  canceled?: boolean;
};
const runningThreads = new Map<string, RunningConversation>();
const threadKey = (resourceId: string, threadId: string) => JSON.stringify([resourceId, threadId]);

export function activeThreadMediaGeneration(resourceId: string, threadId: string) {
  const messageId = runningThreads.get(threadKey(resourceId, threadId))?.messageId;
  return messageId ? { messageId } : null;
}

/** An interrupted request is terminal; reading history must never repeat a paid generation. */
export async function reconcileMediaMessages(
  session: SessionRouteResult,
  messages: MastraDBMessage[],
) {
  if (runningThreads.has(threadKey(session.resourceId, session.threadId))) return;
  const pending = messages.filter(
    (message) =>
      mediaGenerationStateSchema.safeParse(message.content.metadata?.mediaGeneration).data
        ?.status === "generating",
  );
  if (!pending.length) return;
  const storage = await appStorage.getStore("memory");
  if (!storage) throw new Error("Memory storage is not configured");
  // A generation may have settled after history was read. Never overwrite its saved result.
  const latest = await storage.listMessagesById({
    messageIds: pending.map((message) => message.id),
  });
  const saved = new Map(latest.messages.map((message) => [message.id, message]));
  const updates: MastraDBMessage[] = [];
  for (const message of pending) {
    const current = saved.get(message.id);
    if (!current) continue;
    message.content = current.content;
    const metadata = message.content.metadata;
    const media = mediaGenerationStateSchema.safeParse(metadata?.mediaGeneration).data;
    if (media?.status !== "generating") continue;
    const state: MediaGenerationState = {
      kind: media.kind,
      status: "failed",
      error: "上次生成已中断，请点击重新生成。",
    };
    message.content = {
      ...message.content,
      parts: [{ type: "text", text: JSON.stringify(state) }],
      metadata: { ...metadata, mediaGeneration: state },
    };
    updates.push(message);
  }
  if (updates.length) {
    await session.memory.saveMessages({ messages: updates });
    await session.memory.settled();
  }
}

export function assertNoActiveConversationRun(resourceId: string, threadId: string) {
  if (runningThreads.has(threadKey(resourceId, threadId)))
    throw workError("SESSION_MESSAGE_REJECTED", { text: "请先完成或取消当前图片或视频生成" });
}

export async function cancelConversationRuns(session: SessionRouteResult) {
  const running = runningThreads.get(threadKey(session.resourceId, session.threadId));
  if (running) {
    running.canceled = true;
    running.controller?.abort();
    await running.completion;
  }
}

/** Drain media generation and its final message writes before closing storage. */
export async function drainConversationRuns() {
  for (const running of runningThreads.values()) {
    running.canceled = true;
    running.controller?.abort();
  }
  await Promise.all([...runningThreads.values()].map((run) => run.completion));
}

export async function startConversationRun(
  c: ContextWithMastra,
  result: SessionRouteResult,
  content: string,
) {
  const { resourceId, threadId } = result;
  await assertNoActiveConversationRun(resourceId, threadId);
  const key = threadKey(resourceId, threadId);
  if (runningThreads.has(key) || result.controllerSession.displayState.get().isRunning)
    throw workError("SESSION_MESSAGE_REJECTED");
  const running: RunningConversation = {};
  runningThreads.set(key, running);
  try {
    const options = workMessageMetadataSchema.parse(
      c.get("requestContext").get(WORK_MESSAGE_OPTIONS_CONTEXT_KEY) ?? {},
    );
    const model = result.controllerSession.model.get();
    const selection = await resolveModelSelection(model, resourceId);
    if (!selection) throw workError("MODEL_NOT_CONFIGURED");
    if (selection.model.kind === "language")
      throw workError("VALIDATION_FAILED", { text: "此入口仅用于图片或视频生成" });
    const mediaInput = mediaInputFromMessage(model, selection.model.kind, content, [
      ...(options.files ?? []),
      ...(options.fileReferences ?? []),
    ]);
    await result.memory.saveMessages({
      messages: [
        {
          id: options.clientMessageId ?? randomUUID(),
          role: "user",
          createdAt: new Date(),
          threadId,
          resourceId,
          content: {
            format: 2,
            parts: [
              { type: "text", text: content },
              ...(options.files ?? []).map((file) => ({
                type: "file" as const,
                data: file.url,
                mimeType: file.mediaType,
                filename: file.filename,
              })),
            ],
            metadata: {
              clientMessageId: options.clientMessageId,
              skillNames: options.skillNames,
              fileReferences: options.fileReferences,
            },
          },
        },
      ],
    });
    if (result.thread.metadata?.draft === true) {
      await result.controllerSession.thread.rename({
        title: content.trim().replace(/\s+/g, " ").slice(0, 60),
        pin: false,
      });
      await result.controllerSession.thread.setSetting({ key: "draft", value: false });
    }
    const message: MastraDBMessage = {
      id: randomUUID(),
      role: "assistant",
      createdAt: new Date(),
      threadId,
      resourceId,
      content: { format: 2, parts: [] },
    };
    const save = async (state: MediaGenerationState) => {
      // Small file references are useful to a later chat agent; binary data stays on disk.
      message.content.parts = [{ type: "text", text: JSON.stringify(state) }];
      message.content.metadata = { ...message.content.metadata, mediaGeneration: state };
      await result.memory.saveMessages({ messages: [message] });
      await result.memory.settled();
    };
    const controller = new AbortController();
    Object.assign(running, { messageId: message.id, controller });
    await save({ kind: mediaInput.kind, status: "generating" });
    const completion = (async () => {
      let state: MediaGenerationState;
      try {
        if (running.canceled) {
          state = { kind: mediaInput.kind, status: "canceled" };
        } else {
          // Image/video requests are non-streaming. Only the finished files enter chat history.
          const output = await generateMedia(mediaInput, {
            requestContext: c.get("requestContext"),
            abortSignal: controller.signal,
          });
          state = running.canceled
            ? { kind: mediaInput.kind, status: "canceled" }
            : { kind: mediaInput.kind, status: "complete", result: output };
        }
      } catch (error) {
        state = {
          kind: mediaInput.kind,
          status: running.canceled ? "canceled" : "failed",
          error: running.canceled ? undefined : errorText(error),
        };
      }
      await save(state);
      if (state.status === "complete")
        publishDesktopNotification({
          id: message.id,
          resourceId,
          threadId,
          kind: "task",
          title: "Mastra",
          body: "",
        });
    })().finally(() => runningThreads.delete(key));
    running.completion = completion;
    void completion.catch((error) =>
      c.get("mastra").getLogger().error("Media result persistence failed", { error }),
    );
    return c.json({ mediaGeneration: { messageId: message.id } });
  } catch (error) {
    runningThreads.delete(key);
    throw error;
  }
}
