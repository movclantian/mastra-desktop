import type { LanguageModelUsage } from "ai";
import {
  AlertCircleIcon,
  CheckCircle2Icon,
  InfoIcon,
  LoaderCircleIcon,
  SparklesIcon,
} from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { getModelContextWindow, getModelKind } from "@/entities/workbench";
import {
  useCatalogQuery,
  useMemoryConfigQuery,
  useProviderConfigQuery,
  useSaveMemoryConfig,
} from "@/entities/workbench/model/queries/config";
import { useUpdateThreadContextWindowMutation } from "@/entities/workbench/model/queries/threads";
import { useWorkbenchStore } from "@/entities/workbench/model/workbench-store";
import { useTranslation } from "@/shared/i18n";
import {
  Context,
  ContextContent,
  ContextContentBody,
  ContextContentBreakdown,
  ContextContentFooter,
  ContextContentHeader,
  ContextContentWindowControl,
  ContextTrigger,
} from "@/shared/ui/ai-elements/context";
import { Button } from "@/shared/ui/button";
import { Marker, MarkerContent, MarkerIcon } from "@/shared/ui/marker";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";
import type {
  ObservationalMemoryActivityEvent,
  ObservationalMemoryStatusEvent,
} from "../model/types";

// ---------------------------------------------------------------------------
// 上下文用量(docs/aielements/context.tsx):展示当前会话 token 消耗,
// 位于模型选择器左侧;usage 取自最后一条助手消息的 metadata。
// ---------------------------------------------------------------------------

function ContextUnavailable({ catalogStatus }: { catalogStatus: "loading" | "ready" | "error" }) {
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
  userId,
  threadId,
  threadBudgetPercent,
  omStatus,
  omActivity,
}: {
  usage: LanguageModelUsage | undefined;
  billingUsage?: LanguageModelUsage;
  userId: string;
  threadId: string | null;
  threadBudgetPercent?: number;
  omStatus?: ObservationalMemoryStatusEvent;
  omActivity?: ObservationalMemoryActivityEvent;
}) {
  const { t } = useTranslation();
  const providers = useProviderConfigQuery().data?.providers ?? [];
  const catalogQuery = useCatalogQuery();
  const memoryConfig = useMemoryConfigQuery();
  const saveMemoryConfig = useSaveMemoryConfig();
  const updateThreadBudget = useUpdateThreadContextWindowMutation(userId);
  const [budgetPercent, setBudgetPercent] = React.useState(100);
  const catalog = catalogQuery.data ?? [];
  const catalogStatus = catalogQuery.isPending
    ? "loading"
    : catalogQuery.isError
      ? "error"
      : "ready";
  const modelSelection = useWorkbenchStore((state) => state.modelSelection);
  const savedBudgetPercent = Number(memoryConfig.data?.contextWindowPercent ?? 100);
  const safeSavedBudgetPercent =
    Number.isInteger(savedBudgetPercent) && savedBudgetPercent >= 20 && savedBudgetPercent <= 100
      ? savedBudgetPercent
      : 100;
  const hasThreadOverride =
    threadId !== null &&
    Number.isInteger(threadBudgetPercent) &&
    threadBudgetPercent !== undefined &&
    threadBudgetPercent >= 20 &&
    threadBudgetPercent <= 100;
  const savedThreadBudgetPercent = hasThreadOverride
    ? (threadBudgetPercent ?? safeSavedBudgetPercent)
    : safeSavedBudgetPercent;
  React.useEffect(() => setBudgetPercent(savedThreadBudgetPercent), [savedThreadBudgetPercent]);

  const saveBudgetPercent = (percent: number) => {
    setBudgetPercent(percent);
    if (threadId) {
      if (percent === savedThreadBudgetPercent) return;
      updateThreadBudget.mutate(
        { threadId, percent: percent === safeSavedBudgetPercent ? null : percent },
        {
          onError: () => {
            setBudgetPercent(savedThreadBudgetPercent);
            toast.error(t("chat:context.windowBudgetSaveFailed"));
          },
        },
      );
      return;
    }
    const config = memoryConfig.data;
    if (!config || percent === safeSavedBudgetPercent) return;
    saveMemoryConfig.mutate(
      { ...config, contextWindowPercent: percent },
      {
        onError: () => {
          setBudgetPercent(safeSavedBudgetPercent);
          toast.error(t("chat:context.windowBudgetSaveFailed"));
        },
      },
    );
  };

  const selectedProvider = providers.find((p) => p.id === modelSelection?.providerId);
  if (!selectedProvider || !modelSelection) {
    return null;
  }
  if (getModelKind(selectedProvider, modelSelection.modelId, catalog) !== "language") return null;

  const maxTokens = getModelContextWindow(selectedProvider, modelSelection.modelId, catalog);
  if (!maxTokens) {
    return <ContextUnavailable catalogStatus={catalogStatus} />;
  }
  return (
    <Context
      maxTokens={maxTokens}
      budgetPercent={budgetPercent}
      budgetDisabled={
        !memoryConfig.data || saveMemoryConfig.isPending || updateThreadBudget.isPending
      }
      onBudgetPercentChange={setBudgetPercent}
      onBudgetPercentCommit={saveBudgetPercent}
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
          <ContextContentWindowControl />
          <ContextMemoryMarkers status={omStatus} activity={omActivity} />
        </ContextContentBody>
        <ContextContentFooter />
      </ContextContent>
    </Context>
  );
}

const TOKEN_FORMATTER = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 1,
  notation: "compact",
});

function ContextMemoryMarkers({
  status,
  activity,
}: {
  status?: ObservationalMemoryStatusEvent;
  activity?: ObservationalMemoryActivityEvent;
}) {
  const { t } = useTranslation();
  if (!status && !activity) return null;

  const activeWindows = status?.windows.active;
  const buffered = status?.windows.buffered;
  const messageProgress = activeWindows
    ? `${TOKEN_FORMATTER.format(activeWindows.messages.tokens)} / ${TOKEN_FORMATTER.format(activeWindows.messages.threshold)}`
    : undefined;
  const observationProgress = activeWindows
    ? `${TOKEN_FORMATTER.format(activeWindows.observations.tokens)} / ${TOKEN_FORMATTER.format(activeWindows.observations.threshold)}`
    : undefined;
  const marker = activity ? describeMemoryActivity(activity, t) : undefined;

  return (
    <div className="space-y-1.5 border-t border-border/60 px-3 py-3" aria-live="polite">
      {messageProgress && observationProgress ? (
        <Marker className="border-0 pb-0 text-[11px]">
          <MarkerIcon>
            <SparklesIcon />
          </MarkerIcon>
          <MarkerContent>
            {t("chat:context.omProgress", {
              messages: messageProgress,
              observations: observationProgress,
            })}
          </MarkerContent>
        </Marker>
      ) : null}
      {buffered && buffered.observations.status !== "idle" ? (
        <Marker className="border-0 pb-0 text-[11px]">
          <MarkerIcon>
            {buffered?.observations.status === "running" ? (
              <LoaderCircleIcon className="animate-spin" />
            ) : (
              <CheckCircle2Icon />
            )}
          </MarkerIcon>
          <MarkerContent>
            {buffered?.observations.status === "running"
              ? t("chat:context.omBuffering")
              : t("chat:context.omBuffered")}
          </MarkerContent>
        </Marker>
      ) : null}
      {buffered && buffered.reflection.status !== "idle" ? (
        <Marker className="border-0 pb-0 text-[11px]">
          <MarkerIcon>
            {buffered?.reflection.status === "running" ? (
              <LoaderCircleIcon className="animate-spin" />
            ) : (
              <CheckCircle2Icon />
            )}
          </MarkerIcon>
          <MarkerContent>
            {buffered?.reflection.status === "running"
              ? t("chat:context.omReflecting")
              : t("chat:context.omReflectionReady")}
          </MarkerContent>
        </Marker>
      ) : null}
      {marker ? (
        <Marker className="border-0 pb-0 text-[11px]">
          <MarkerIcon>
            {marker.failed ? (
              <AlertCircleIcon className="text-destructive" />
            ) : marker.running ? (
              <LoaderCircleIcon className="animate-spin" />
            ) : (
              <CheckCircle2Icon />
            )}
          </MarkerIcon>
          <MarkerContent>{marker.text}</MarkerContent>
        </Marker>
      ) : null}
    </div>
  );
}

function describeMemoryActivity(
  event: ObservationalMemoryActivityEvent,
  t: (key: string, options?: Record<string, unknown>) => string,
): { failed: boolean; running: boolean; text: string } {
  switch (event.type) {
    case "om_observation_start":
      return {
        failed: false,
        running: true,
        text: t("chat:context.omObservationStarted", {
          tokens: TOKEN_FORMATTER.format(event.tokensToObserve),
        }),
      };
    case "om_observation_end":
      return {
        failed: false,
        running: false,
        text: t("chat:context.omObservationFinished", {
          tokens: TOKEN_FORMATTER.format(event.tokensObserved),
        }),
      };
    case "om_observation_failed":
      return { failed: true, running: false, text: t("chat:context.omFailed") };
    case "om_reflection_start":
      return {
        failed: false,
        running: true,
        text: t("chat:context.omReflectionStarted", {
          tokens: TOKEN_FORMATTER.format(event.tokensToReflect),
        }),
      };
    case "om_reflection_end":
      return {
        failed: false,
        running: false,
        text: t("chat:context.omReflectionFinished", {
          tokens: TOKEN_FORMATTER.format(event.compressedTokens),
        }),
      };
    case "om_reflection_failed":
      return { failed: true, running: false, text: t("chat:context.omFailed") };
    case "om_buffering_start":
      return {
        failed: false,
        running: true,
        text: t("chat:context.omBufferingStarted", {
          tokens: TOKEN_FORMATTER.format(event.tokensToBuffer),
        }),
      };
    case "om_buffering_end":
      return {
        failed: false,
        running: false,
        text: t("chat:context.omBufferingFinished", {
          tokens: TOKEN_FORMATTER.format(event.tokensBuffered),
        }),
      };
    case "om_buffering_failed":
      return { failed: true, running: false, text: t("chat:context.omFailed") };
    case "om_activation":
      return {
        failed: false,
        running: false,
        text: t("chat:context.omActivated", {
          tokens: TOKEN_FORMATTER.format(event.tokensActivated),
          messages: event.messagesActivated,
        }),
      };
    case "om_model_changed":
      return {
        failed: false,
        running: false,
        text: t("chat:context.omModelChanged", { model: event.modelId }),
      };
  }
}
