import type { LanguageModelUsage } from "ai";
import { InfoIcon, SparklesIcon } from "lucide-react";
import {
  formatModelContextWindow,
  getModelContextWindow,
  useWorkbench,
} from "@/entities/workbench";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { Dotm3x3_11 } from "@/shared/ui/dotm-3x3-11";
import { Marker, MarkerContent, MarkerIcon } from "@/shared/ui/marker";
import { ScrollArea } from "@/shared/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";
import type { CompressResult } from "../model/types";

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
  compacting,
  onCompress,
  compressResult,
  onCompressResultClose,
}: {
  usage: LanguageModelUsage | undefined;
  estimatedUsedTokens?: number;
  compacting: boolean;
  onCompress: () => void;
  compressResult: CompressResult | null;
  onCompressResultClose: () => void;
}) {
  const { providers, catalog, catalogStatus, modelSelection, activeThreadId } = useWorkbench();
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
  const breakdown = estimateContextBreakdown(usedTokens, estimatedUsedTokens);
  return (
    <>
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
            {/* 手动压缩上下文(summarizeConversation.mdx / summarizeThread.mdx)。
                进行中/完成状态由消息流尾部 Marker 展示(marker-status / marker-shimmer)。 */}
            {activeThreadId ? (
              <Button
                className="mt-2 w-full"
                disabled={compacting}
                onClick={onCompress}
                size="sm"
                variant="outline"
              >
                {compacting ? (
                  <Dotm3x3_11 size={14} dotSize={2.2} colorPreset="solid-theme" />
                ) : (
                  <SparklesIcon />
                )}
                {compacting ? "正在压缩..." : "压缩上下文"}
              </Button>
            ) : null}
          </ContextContentBody>
          <ContextContentFooter />
        </ContextContent>
      </Context>

      {/* 压缩结果弹窗 */}
      <Dialog
        onOpenChange={(open) => !open && onCompressResultClose()}
        open={compressResult !== null}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>上下文已压缩</DialogTitle>
            <DialogDescription>
              早期消息已折叠为摘要并注入线程头部;此后模型只接收「摘要 + 近期消息」,
              真正降低上下文窗口占用。
            </DialogDescription>
          </DialogHeader>

          {compressResult?.summary ? (
            <ScrollArea className="max-h-72 rounded-md border p-3">
              <p className="text-sm whitespace-pre-wrap">{compressResult.summary}</p>
            </ScrollArea>
          ) : null}

          {compressResult?.extracted && Object.keys(compressResult.extracted).length > 0 ? (
            <ScrollArea className="max-h-40 rounded-md border p-3">
              <p className="mb-1 text-xs font-medium text-muted-foreground">本次压缩抽取结果</p>
              <pre className="text-xs whitespace-pre-wrap">
                {JSON.stringify(compressResult.extracted, null, 2)}
              </pre>
            </ScrollArea>
          ) : null}

          {/* marker-demo 图标 + shimmer 变体:压缩前后上下文对比 */}
          <Marker role="status">
            <MarkerIcon>
              <SparklesIcon />
            </MarkerIcon>
            <MarkerContent className="shimmer">
              折叠 {compressResult?.deletedMessages ?? 0} 条消息 · 上下文约{" "}
              {formatModelContextWindow(compressResult?.inputTokens ?? 0)} →{" "}
              {formatModelContextWindow(compressResult?.estimatedContextTokens ?? 0)} tokens
            </MarkerContent>
          </Marker>
        </DialogContent>
      </Dialog>
    </>
  );
}
