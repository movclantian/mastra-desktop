import type { LanguageModelUsage } from "ai";
import { InfoIcon } from "lucide-react";
import { getModelContextWindow, useWorkbench } from "@/entities/workbench";
import {
  Context,
  ContextContent,
  ContextContentBody,
  ContextContentBreakdown,
  ContextContentFooter,
  ContextContentHeader,
  ContextTrigger,
  type ContextUsageBreakdown,
} from "@/shared/ui/ai-elements/context";
import { Button } from "@/shared/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";

function estimateContextBreakdown(
  usedTokens: number,
  estimatedConversationTokens: number | undefined,
): ContextUsageBreakdown {
  const total = Math.max(0, Math.round(usedTokens));
  const conversation =
    estimatedConversationTokens && estimatedConversationTokens > 0
      ? Math.min(total, Math.round(estimatedConversationTokens))
      : total;
  const overhead = Math.max(0, total - conversation);
  const systemPrompt = Math.round(overhead * 0.4);
  const toolsAndSubagents = Math.round(overhead * 0.3);
  const mcp = Math.round(overhead * 0.2);
  const skills = Math.max(0, overhead - systemPrompt - toolsAndSubagents - mcp);
  return {
    "system-prompt": systemPrompt,
    "tools-and-subagents": toolsAndSubagents,
    conversation,
    mcp,
    skills,
  };
}

// ---------------------------------------------------------------------------
// 上下文用量(docs/aielements/context.tsx):展示当前会话 token 消耗,
// 位于模型选择器左侧;usage 取自最后一条助手消息的 metadata。
// ---------------------------------------------------------------------------

export function ContextUnavailable({
  catalogStatus,
}: {
  catalogStatus: "loading" | "ready" | "error";
}) {
  const message =
    catalogStatus === "loading"
      ? "正在读取模型目录,暂时无法确认上下文窗口"
      : catalogStatus === "error"
        ? "模型目录读取失败,暂时无法确认上下文窗口"
        : "模型目录已加载,但没有匹配当前模型的上下文窗口";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="上下文窗口未知"
            className="text-muted-foreground"
          />
        }
      >
        <InfoIcon />
      </TooltipTrigger>
      <TooltipContent>{message}</TooltipContent>
    </Tooltip>
  );
}

export function ChatContextUsage({
  usage,
  estimatedUsedTokens,
  estimatedBreakdown,
}: {
  usage: LanguageModelUsage | undefined;
  estimatedUsedTokens?: number;
  estimatedBreakdown?: ContextUsageBreakdown;
}) {
  const { providers, catalog, catalogStatus, modelSelection } = useWorkbench();
  const selectedProvider = providers.find((p) => p.id === modelSelection?.providerId);
  if (!selectedProvider || !modelSelection) {
    return null;
  }

  const reportedTokens =
    usage?.totalTokens ?? (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0);
  const usedTokens = Math.max(estimatedUsedTokens ?? 0, reportedTokens);
  const maxTokens = getModelContextWindow(selectedProvider, modelSelection.modelId, catalog);
  if (!maxTokens) {
    return <ContextUnavailable catalogStatus={catalogStatus} />;
  }
  const breakdown = estimatedBreakdown ?? estimateContextBreakdown(usedTokens, estimatedUsedTokens);
  return (
    <Context
      usedTokens={usedTokens}
      maxTokens={maxTokens}
      usage={usage}
      breakdown={breakdown}
      modelId={modelSelection.modelId}
      catalog={catalog}
    >
      <ContextTrigger />
      <ContextContent>
        <ContextContentHeader />
        <ContextContentBody>
          <ContextContentBreakdown />
        </ContextContentBody>
        <ContextContentFooter />
      </ContextContent>
    </Context>
  );
}
