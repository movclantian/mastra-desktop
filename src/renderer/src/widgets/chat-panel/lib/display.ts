import { isToolUIPart } from "ai";

import type { WorkUIMessage } from "../model/types";

// ---------------------------------------------------------------------------
// 消息流展示层纯函数:把服务端按 response-boundary 拆分的助手行合并为用户视角
// 的"一轮对话"。与 React 无关。
// ---------------------------------------------------------------------------

export interface DisplayMessage {
  message: WorkUIMessage;
  sourceIds: string[];
}

/**
 * Mastra seals each response-boundary (reasoning/tool loop) as a separate
 * assistant memory row. That boundary is important to the model, but it is
 * not a conversation turn for the user. Keep all parts in order while making
 * consecutive assistant rows one visual message.
 */
export function buildDisplayMessages(messages: WorkUIMessage[]): DisplayMessage[] {
  const display: DisplayMessage[] = [];
  let toolPositions = new Map<string, number>();

  for (const message of messages) {
    const previous = display.at(-1);
    const previousMessage = previous?.message;
    let entry: DisplayMessage;
    if (previous && previousMessage?.role === "assistant" && message.role === "assistant") {
      entry = previous;
      entry.sourceIds.push(message.id);
    } else {
      entry = { message: { ...message, parts: [] }, sourceIds: [message.id] };
      display.push(entry);
      toolPositions = new Map();
    }
    // One call may appear in multiple persisted/streamed rows as its state
    // advances. Keep its first position but render only the latest snapshot.
    // Mutate only our display array, never the SDK's source message/parts.
    for (const part of message.parts) {
      if (message.role === "assistant" && isToolUIPart(part)) {
        const position = toolPositions.get(part.toolCallId);
        if (position !== undefined) {
          entry.message.parts[position] = part;
          continue;
        }
        toolPositions.set(part.toolCallId, entry.message.parts.length);
      }
      entry.message.parts.push(part);
    }
  }

  return display;
}
