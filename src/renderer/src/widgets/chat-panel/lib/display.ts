import { isToolUIPart } from "ai";
import { mergeToolPart, type WorkUIMessage } from "../model/types";

// ---------------------------------------------------------------------------
// 消息流展示层纯函数:把服务端按 response-boundary 拆分的助手行合并为用户视角
// 的"一轮对话"。与 React 无关。
// ---------------------------------------------------------------------------

export interface DisplayMessage {
  message: WorkUIMessage;
  sourceIds: string[];
  key: string;
  turnId: string;
  sourceMessages: WorkUIMessage[];
}

/**
 * Mastra seals each response-boundary (reasoning/tool loop) as a separate
 * assistant memory row. That boundary is important to the model, but it is
 * not a conversation turn for the user. Keep all parts in order while making
 * consecutive assistant rows one visual message.
 */
export function buildDisplayMessages(
  messages: WorkUIMessage[],
  pending = false,
  previous: DisplayMessage[] = [],
): DisplayMessage[] {
  const display: DisplayMessage[] = [];
  let toolPositions = new Map<string, number>();
  let turnId = "initial";
  let messageOffset = 0;

  for (let index = 0; index < previous.length; index += 1) {
    const cached = previous[index];
    if (cached.sourceMessages.length === 0) break;
    const matches = cached.sourceMessages.every(
      (source, sourceIndex) => messages[messageOffset + sourceIndex] === source,
    );
    if (!matches) break;
    const nextMessage = messages[messageOffset + cached.sourceMessages.length];
    if (
      index === previous.length - 1 &&
      cached.message.role === "assistant" &&
      nextMessage?.role === "assistant"
    )
      break;
    display.push(cached);
    messageOffset += cached.sourceMessages.length;
    turnId = cached.turnId;
    toolPositions = new Map();
  }

  for (let messageIndex = messageOffset; messageIndex < messages.length; messageIndex += 1) {
    const message = messages[messageIndex];
    if (message.role !== "assistant") turnId = message.id;
    const previous = display.at(-1);
    const previousMessage = previous?.message;
    let entry: DisplayMessage;
    if (
      previous &&
      previousMessage?.role === "assistant" &&
      message.role === "assistant" &&
      (!previousMessage.metadata?.teamMemberId ||
        !message.metadata?.teamMemberId ||
        previousMessage.metadata.teamMemberId === message.metadata.teamMemberId) &&
      (!previousMessage.metadata?.agentProfileId ||
        !message.metadata?.agentProfileId ||
        previousMessage.metadata.agentProfileId === message.metadata.agentProfileId)
    ) {
      entry = previous;
      entry.sourceIds.push(message.id);
      entry.sourceMessages.push(message);
      // Identity is stamped when a run finishes; missing live metadata is not a new speaker.
      entry.message.metadata = {
        ...previousMessage.metadata,
        agentProfileId:
          previousMessage.metadata?.agentProfileId ?? message.metadata?.agentProfileId,
        agentDisplayName:
          previousMessage.metadata?.agentDisplayName ?? message.metadata?.agentDisplayName,
        teamMemberId: previousMessage.metadata?.teamMemberId ?? message.metadata?.teamMemberId,
      };
    } else {
      entry = {
        message: { ...message, parts: [] },
        sourceIds: [message.id],
        sourceMessages: [message],
        turnId,
        key:
          message.role === "assistant"
            ? previousMessage?.role === "assistant"
              ? `reply-${turnId}-${message.id}`
              : `reply-${turnId}`
            : message.id,
      };
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
          entry.message.parts[position] = mergeToolPart(entry.message.parts[position], part);
          continue;
        }
        toolPositions.set(part.toolCallId, entry.message.parts.length);
      }
      entry.message.parts.push(part);
    }
  }

  if (
    (pending || display.at(-1)?.message.role === "user") &&
    display.at(-1)?.message.role !== "assistant"
  ) {
    // Preserve the reply row through pending, failure and idle snapshots.
    const id = `reply-${turnId}`;
    display.push({
      key: id,
      sourceIds: [],
      sourceMessages: [],
      turnId,
      message: { id, role: "assistant", parts: [] },
    });
  }
  return display;
}
