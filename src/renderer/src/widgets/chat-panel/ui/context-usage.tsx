import type { LanguageModelUsage } from "ai";
import { InfoIcon } from "lucide-react";
import { getModelContextWindow } from "@/entities/workbench";
import { useCatalogQuery, useProviderConfigQuery } from "@/entities/workbench/model/queries/config";
import { useWorkbenchStore } from "@/entities/workbench/model/workbench-store";
import { useTranslation } from "@/shared/i18n";
import {
  Context,
  ContextContent,
  ContextContentBody,
  ContextContentBreakdown,
  ContextContentFooter,
  ContextContentHeader,
  ContextTrigger,
} from "@/shared/ui/ai-elements/context";
import { Button } from "@/shared/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";

// ---------------------------------------------------------------------------
// 上下文用量(docs/aielements/context.tsx):展示当前会话 token 消耗,
// 位于模型选择器左侧;usage 取自最后一条助手消息的 metadata。
// ---------------------------------------------------------------------------

export function ContextUnavailable({
  catalogStatus,
}: {
  catalogStatus: "loading" | "ready" | "error";
}) {
  const { t } = useTranslation();
  const message =
    catalogStatus === "loading"
      ? t("chat:context.loading")
      : catalogStatus === "error"
        ? t("chat:context.error")
        : t("chat:context.unmatched");
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("chat:context.unknownContext")}
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
  billingUsage,
}: {
  usage: LanguageModelUsage | undefined;
  billingUsage?: LanguageModelUsage;
}) {
  const providers = useProviderConfigQuery().data?.providers ?? [];
  const catalogQuery = useCatalogQuery();
  const catalog = catalogQuery.data ?? [];
  const catalogStatus = catalogQuery.isPending
    ? "loading"
    : catalogQuery.isError
      ? "error"
      : "ready";
  const modelSelection = useWorkbenchStore((state) => state.modelSelection);
  const selectedProvider = providers.find((p) => p.id === modelSelection?.providerId);
  if (!selectedProvider || !modelSelection) {
    return null;
  }

  const maxTokens = getModelContextWindow(selectedProvider, modelSelection.modelId, catalog);
  if (!maxTokens) {
    return <ContextUnavailable catalogStatus={catalogStatus} />;
  }
  return (
    <Context
      maxTokens={maxTokens}
      usage={usage}
      billingUsage={billingUsage}
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
