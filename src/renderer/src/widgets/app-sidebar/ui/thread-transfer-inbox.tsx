import { ArrowLeftRightIcon, CheckIcon, HistoryIcon, InboxIcon, XIcon } from "lucide-react";
import { toast } from "sonner";
import {
  useDecideThreadTransferMutation,
  useThreadTransferHistoryQuery,
} from "@/entities/workbench/model/queries/threads";
import type { ThreadTransferHistoryItem } from "@/entities/workbench/model/types";
import { useTranslation } from "@/shared/i18n";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";

const STATUS_KEYS: Record<ThreadTransferHistoryItem["status"], string> = {
  awaiting_confirmation: "sidebar:transferStatusAwaiting",
  prepared: "sidebar:transferStatusRunning",
  assets_moved: "sidebar:transferStatusRunning",
  memory_moved: "sidebar:transferStatusRunning",
  messages_rewritten: "sidebar:transferStatusRunning",
  committed: "sidebar:transferStatusCompleted",
  failed: "sidebar:transferStatusFailed",
  rejected: "sidebar:transferStatusRejected",
  needs_reconciliation: "sidebar:transferStatusNeedsReview",
};

const EVENT_KEYS: Record<string, string> = {
  requested: "sidebar:transferAuditRequested",
  accepted: "sidebar:transferAuditAccepted",
  rejected: "sidebar:transferAuditRejected",
  assets_moved: "sidebar:transferAuditAssets",
  memory_moved: "sidebar:transferAuditOwnership",
  messages_rewritten: "sidebar:transferAuditHistory",
  committed: "sidebar:transferAuditCompleted",
  failed: "sidebar:transferAuditFailed",
  needs_reconciliation: "sidebar:transferAuditNeedsReview",
};

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function ThreadTransferInboxDialog({
  open,
  onOpenChange,
  userId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userId: string;
}) {
  const { t } = useTranslation();
  const historyQuery = useThreadTransferHistoryQuery(userId, open);
  const decisionMutation = useDecideThreadTransferMutation(userId);
  const transfers = historyQuery.data ?? [];
  const incoming = transfers.filter(
    (transfer) =>
      transfer.targetResourceId === userId && transfer.status === "awaiting_confirmation",
  );
  const history = transfers.filter(
    (transfer) =>
      transfer.targetResourceId !== userId || transfer.status !== "awaiting_confirmation",
  );

  const decide = async (transferId: string, decision: "accept" | "reject") => {
    try {
      const result = await decisionMutation.mutateAsync({ transferId, decision });
      if (decision === "accept" && result.status === "reconciliation_pending") {
        toast.warning(t("sidebar:transferAcceptReconciliationPending"));
        return;
      }
      toast.success(
        decision === "accept"
          ? t("sidebar:transferAcceptSuccess")
          : t("sidebar:transferRejectSuccess"),
      );
    } catch {
      toast.error(t("sidebar:transferDecisionFailed"));
    }
  };

  const renderTransfer = (transfer: ThreadTransferHistoryItem, isIncoming: boolean) => (
    <article className="rounded-lg border bg-card p-3" key={transfer.id}>
      <div className="flex items-start gap-3">
        <ArrowLeftRightIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate text-sm font-medium">{transfer.threadTitle}</h3>
            <Badge variant={transfer.status === "failed" ? "destructive" : "secondary"}>
              {t(STATUS_KEYS[transfer.status])}
            </Badge>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {isIncoming
              ? t("sidebar:transferFrom", { name: transfer.sourceName })
              : t("sidebar:transferTo", { name: transfer.targetName })}
            <span className="mx-1">·</span>
            {formatTime(transfer.createdAt)}
          </p>
          {isIncoming ? (
            <div className="mt-3 flex gap-2">
              <Button
                disabled={decisionMutation.isPending}
                onClick={() => void decide(transfer.id, "accept")}
                size="sm"
              >
                <CheckIcon data-icon="inline-start" />
                {t("sidebar:acceptTransfer")}
              </Button>
              <Button
                disabled={decisionMutation.isPending}
                onClick={() => void decide(transfer.id, "reject")}
                size="sm"
                variant="outline"
              >
                <XIcon data-icon="inline-start" />
                {t("sidebar:rejectTransfer")}
              </Button>
            </div>
          ) : null}
          {transfer.events.length > 0 ? (
            <details className="mt-3 text-xs">
              <summary className="flex cursor-pointer list-none items-center gap-1.5 text-muted-foreground">
                <HistoryIcon className="size-3.5" />
                {t("sidebar:transferAudit")}
              </summary>
              <ol className="mt-2 space-y-1 border-l pl-3 text-muted-foreground">
                {transfer.events.map((event, index) => (
                  <li key={`${event.action}-${event.createdAt}-${index}`}>
                    <span>{t(EVENT_KEYS[event.action] ?? "sidebar:transferAuditUpdated")}</span>
                    <span className="mx-1">·</span>
                    <span>
                      {event.actorResourceId === transfer.sourceResourceId
                        ? transfer.sourceName
                        : event.actorResourceId === transfer.targetResourceId
                          ? transfer.targetName
                          : event.actorResourceId}
                    </span>
                    <span className="mx-1">·</span>
                    <time dateTime={event.createdAt}>{formatTime(event.createdAt)}</time>
                  </li>
                ))}
              </ol>
            </details>
          ) : null}
        </div>
      </div>
    </article>
  );

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-h-[80vh] max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("sidebar:transferCenter")}</DialogTitle>
          <DialogDescription>{t("sidebar:transferCenterDescription")}</DialogDescription>
        </DialogHeader>
        <div
          className="-mx-4 no-scrollbar max-h-[50vh] space-y-5 overflow-y-auto px-4"
          tabIndex={0}
        >
          <section className="space-y-2">
            <h2 className="flex items-center gap-2 text-sm font-medium">
              <InboxIcon className="size-4" />
              {t("sidebar:incomingTransfers")}
              {incoming.length > 0 ? <Badge variant="secondary">{incoming.length}</Badge> : null}
            </h2>
            {historyQuery.isPending ? (
              <p className="py-4 text-center text-sm text-muted-foreground">
                {t("common:loading")}
              </p>
            ) : incoming.length === 0 ? (
              <p className="rounded-lg border border-dashed py-5 text-center text-sm text-muted-foreground">
                {t("sidebar:noIncomingTransfers")}
              </p>
            ) : (
              <div className="space-y-2">
                {incoming.map((transfer) => renderTransfer(transfer, true))}
              </div>
            )}
          </section>
          <section className="space-y-2">
            <h2 className="flex items-center gap-2 text-sm font-medium">
              <HistoryIcon className="size-4" />
              {t("sidebar:transferHistory")}
            </h2>
            {historyQuery.isError ? (
              <p className="rounded-lg border border-destructive/30 p-3 text-sm text-destructive">
                {t("sidebar:transferHistoryFailed")}
              </p>
            ) : history.length === 0 ? (
              <p className="rounded-lg border border-dashed py-5 text-center text-sm text-muted-foreground">
                {t("sidebar:noTransferHistory")}
              </p>
            ) : (
              <div className="space-y-2">
                {history.map((transfer) => renderTransfer(transfer, false))}
              </div>
            )}
          </section>
        </div>
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)} variant="outline">
            {t("common:close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
