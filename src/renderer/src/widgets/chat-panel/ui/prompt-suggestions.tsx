import { useQuery } from "@tanstack/react-query";
import * as React from "react";
import { fetchPromptSuggestions, useSuggestionConfigQuery } from "@/entities/workbench";
import { useTranslation } from "@/shared/i18n";
import { Suggestion, Suggestions } from "@/shared/ui/suggestion";
import type { WorkUIMessage } from "../model/types";

// ---------------------------------------------------------------------------
// 提示建议条(官方 Suggestion pattern,见 docs/examples/suggestion.mdx)。
// 位置:Queue 卡片上方、输入框之上;仅在「设置 → 提示建议」开启时出现。
// 生成走独立小模型调用,不占用会话模型,也不进入会话历史。
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
}: {
  messages: WorkUIMessage[];
  /** 生成中/排队中不打扰:建议只在回合结束后出现 */
  busy: boolean;
  /** 未配置建议模型时回退到当前会话模型 */
  fallbackModel?: string;
  onSelect: (suggestion: string) => void;
}) {
  const { t } = useTranslation();
  const config = useSuggestionConfigQuery();
  const enabled = config.data?.enabled === true;
  const model = config.data?.model ?? "";
  const context = React.useMemo(() => toSuggestionMessages(messages), [messages]);
  // 对话不变时不重复请求;busy 期间不发请求。
  const contextKey = React.useMemo(
    () => context.map((message) => `${message.role}:${message.text.length}`).join("|"),
    [context],
  );

  const query = useQuery({
    queryKey: ["prompt-suggestions", contextKey, model, fallbackModel ?? ""],
    queryFn: ({ signal }) => fetchPromptSuggestions(context, model || fallbackModel, signal),
    enabled: enabled && !busy && context.length > 0,
    staleTime: Infinity,
    retry: 0,
  });

  const suggestions = query.data?.suggestions ?? [];
  if (!enabled || busy || suggestions.length === 0) return null;

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
