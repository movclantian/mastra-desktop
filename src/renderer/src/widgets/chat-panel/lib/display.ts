import { i18n } from "@/shared/i18n";
import type { WorkUIMessage } from "../model/types";

// ---------------------------------------------------------------------------
// 消息流展示层纯函数:把服务端按 response-boundary 拆分的助手行合并为用户视角
// 的"一轮对话",以及流式错误分类。与 React 无关,便于独立维护。
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

  for (const message of messages) {
    const previous = display.at(-1);
    const previousMessage = previous?.message;
    if (previous && previousMessage?.role === "assistant" && message.role === "assistant") {
      previous.message = {
        ...previousMessage,
        parts: [...previousMessage.parts, ...message.parts],
      };
      previous.sourceIds.push(message.id);
      continue;
    }

    display.push({
      message: { ...message },
      sourceIds: [message.id],
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
  const trimmed = message.trim();
  if (!trimmed) return i18n.t("chat:messages.streamInterrupted");

  // Hono/Mastra errors arrive through the AI SDK as a JSON-encoded Error
  // message. Show the server's user-facing text instead of the entire envelope.
  for (const candidate of [trimmed, trimmed.replace(/^Error:\s*/i, "")]) {
    try {
      const payload = JSON.parse(candidate) as {
        error?: unknown;
        text?: unknown;
        details?: { text?: unknown };
      };
      if (typeof payload.error === "string" && payload.error.trim()) return payload.error;
      if (typeof payload.text === "string" && payload.text.trim()) return payload.text;
      if (typeof payload.details?.text === "string" && payload.details.text.trim()) {
        return payload.details.text;
      }
    } catch {
      // Plain Error messages use the original text.
    }
  }

  return trimmed;
}
