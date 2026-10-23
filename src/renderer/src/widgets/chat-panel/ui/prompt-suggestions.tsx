import { useQuery } from "@tanstack/react-query";
import { isToolUIPart } from "ai";
import * as React from "react";
import { fetchPromptSuggestions, useSuggestionConfigQuery } from "@/entities/workbench";
import { useTranslation } from "@/shared/i18n";
import { Suggestion, Suggestions } from "@/shared/ui/suggestion";
import type { WorkUIMessage } from "../model/types";

// ---------------------------------------------------------------------------
// 提示建议条(官方 Suggestion pattern,见 docs/examples/suggestion.mdx)。
// 位置:Queue 卡片上方、输入框之上;仅在「设置 → 提示建议」开启时出现。
// 生成走独立建议请求:可固定建议模型或跟随当前请求模型,不会写入会话历史。
// ---------------------------------------------------------------------------

const MAX_CONTEXT_MESSAGES = 12;

/** 只取纯文本 part,工具/推理不参与建议上下文。 */
function messageText(message: WorkUIMessage): string {
  return message.parts
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function toSuggestionMessages(messages: WorkUIMessage[]) {
  return messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => ({
      role: message.role as "user" | "assistant",
      text: messageText(message),
    }))
    .filter((message) => message.text.length > 0)
    .slice(-MAX_CONTEXT_MESSAGES);
}

export function PromptSuggestions({
  messages,
  busy,
  fallbackModel,
  onSelect,
  threadId,
  requestBlocked = false,
}: {
  messages: WorkUIMessage[];
  /** Full-turn mode waits for idle; request mode may surface after a completed tool-call response. */
  busy: boolean;
  threadId: string | null;
  requestBlocked?: boolean;
  /** 未配置建议模型时回退到当前请求模型 */
  fallbackModel?: string;
  onSelect: (suggestion: string) => void;
}) {
  const { t } = useTranslation();
  const config = useSuggestionConfigQuery();
  const enabled = config.data?.enabled === true;
  const model = config.data?.model ?? "";
  const strategy = config.data?.strategy ?? "turn";
  const context = React.useMemo(() => toSuggestionMessages(messages), [messages]);
  const contextKey = React.useMemo(
    () =>
      JSON.stringify(
        messages
          .filter((message) => message.role === "user" || message.role === "assistant")
          .map((message) => ({ id: message.id, role: message.role, text: messageText(message) }))
          .filter((message) => message.text.length > 0)
          .slice(-MAX_CONTEXT_MESSAGES),
      ),
    [messages],
  );
  const completedRequestKey = React.useMemo(() => {
    const latest = messages.at(-1);
    if (latest?.role !== "assistant") return null;
    const completedTools = latest.parts.filter(
      (part) => isToolUIPart(part) && part.state !== "input-streaming",
    );
    if (completedTools.length)
      return `${latest.id}:${completedTools.map((part) => part.toolCallId).join(",")}`;
    return !busy ? `turn:${latest.id}` : null;
  }, [busy, messages]);
  const canGenerate =
    !requestBlocked && (strategy === "request" ? completedRequestKey !== null : !busy);
  const query = useQuery({
    queryKey: [
      "prompt-suggestions",
      threadId ?? "draft",
      strategy,
      completedRequestKey ?? "",
      contextKey,
      model,
      fallbackModel ?? "",
    ],
    queryFn: ({ signal }) => fetchPromptSuggestions(context, model || fallbackModel, signal),
    enabled: enabled && canGenerate && context.length > 0,
    staleTime: Infinity,
    retry: 0,
  });

  const suggestions = query.data?.suggestions ?? [];
  if (!enabled || (busy && strategy === "turn") || requestBlocked || suggestions.length === 0)
    return null;

  return (
    <div className="mx-auto w-full max-w-3xl px-1 pb-1">
      <Suggestions aria-label={t("chat:suggestions.label")}>
        {suggestions.map((suggestion) => (
          <Suggestion key={suggestion} onClick={onSelect} suggestion={suggestion} type="button" />
        ))}
      </Suggestions>
    </div>
  );
}
