import type { MessageBranchRecord, WorkUIMessage } from "../types";

// ---------------------------------------------------------------------------
// 消息流展示层纯函数:把服务端按 response-boundary 拆分的助手行合并为用户视角
// 的"一轮对话",以及流式错误分类。与 React 无关,便于独立维护。
// ---------------------------------------------------------------------------

export interface DisplayMessage {
  message: WorkUIMessage;
  sourceIds: string[];
  sourceEndIndex: number;
}

/**
 * Mastra seals each response-boundary (reasoning/tool loop) as a separate
 * assistant memory row. That boundary is important to the model, but it is
 * not a conversation turn for the user. Keep all parts in order while making
 * consecutive assistant rows one visual message. Branch rows stay separate so
 * their selectors and pair metadata remain addressable by id.
 */
export function buildDisplayMessages(
  messages: WorkUIMessage[],
  branchesByMessageId: Map<string, MessageBranchRecord>,
): DisplayMessage[] {
  const display: DisplayMessage[] = [];

  for (const [index, message] of messages.entries()) {
    const hasBranch = branchesByMessageId.has(message.id);
    const previous = display.at(-1);
    const previousMessage = previous?.message;
    const previousHasBranch = previous
      ? previous.sourceIds.some((id) => branchesByMessageId.has(id))
      : false;
    const compacted = Boolean(
      (message.metadata as { compactedHistory?: unknown } | undefined)?.compactedHistory,
    );
    const previousCompacted = Boolean(
      (previousMessage?.metadata as { compactedHistory?: unknown } | undefined)?.compactedHistory,
    );

    if (
      message.role === "assistant" &&
      previousMessage?.role === "assistant" &&
      previous !== undefined &&
      !hasBranch &&
      !previousHasBranch &&
      !compacted &&
      !previousCompacted
    ) {
      previous.message = {
        ...previousMessage,
        id: message.id,
        parts: [...previousMessage.parts, ...message.parts],
        metadata: {
          ...previousMessage.metadata,
          ...message.metadata,
        },
      };
      previous.sourceIds.push(message.id);
      previous.sourceEndIndex = index;
      continue;
    }

    display.push({
      message,
      sourceIds: [message.id],
      sourceEndIndex: index,
    });
  }

  return display;
}

export const STREAM_RECONNECT_LIMIT = 2;

export function isTransientStreamError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /fetch|network|econnreset|econnrefused|und_err|socket|timeout|连接|网络/i.test(message);
}

export function streamErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return message.trim() || "流式响应意外中断";
}
