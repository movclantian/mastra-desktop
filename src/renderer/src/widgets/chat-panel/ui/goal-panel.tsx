import { CheckCircle2Icon, PauseIcon, PencilIcon, PlayIcon, TargetIcon, XIcon } from "lucide-react";
import * as React from "react";
import { useTranslation } from "@/shared/i18n";
import { toastError } from "@/shared/lib";
import { usePromptInputController } from "@/shared/ui/ai-elements/prompt-input";
import {
  QueueSection,
  QueueSectionContent,
  QueueSectionLabel,
  QueueSectionTrigger,
} from "@/shared/ui/ai-elements/queue";
import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/shared/ui/field";
import { Input } from "@/shared/ui/input";
import { ScrollArea } from "@/shared/ui/scroll-area";
import { Textarea } from "@/shared/ui/textarea";
import type { GoalObjective } from "../model/types";

export interface GoalAction {
  action: "pause" | "resume" | "clear" | "update";
  objective?: string;
  maxRuns?: number;
}

export function GoalDraftPanel({
  starting,
  onCancel,
}: {
  starting: boolean;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const { textInput } = usePromptInputController();
  return (
    <QueueSection data-slot="goal-draft-panel">
      <QueueSectionTrigger
        action={
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            disabled={starting}
            aria-label={t("chat:goal.cancelMode")}
            onClick={onCancel}
          >
            <XIcon />
          </Button>
        }
      >
        <QueueSectionLabel
          label={t("chat:goal.title")}
          icon={<TargetIcon className="size-3.5" />}
        />
        <span className="ml-2 shrink-0 text-xs" role="status">
          {t(starting ? "chat:goal.starting" : "chat:goal.draft")}
        </span>
      </QueueSectionTrigger>
      <QueueSectionContent>
        <ScrollArea className="max-h-28">
          <p className="whitespace-pre-wrap break-words px-3 py-2 text-xs text-muted-foreground [overflow-wrap:anywhere]">
            {textInput.value.trim() || t("chat:goal.composerHint")}
          </p>
        </ScrollArea>
      </QueueSectionContent>
    </QueueSection>
  );
}

export function GoalPanel({
  objective,
  running,
  canResume,
  onAction,
}: {
  objective: GoalObjective;
  running: boolean;
  canResume: boolean;
  onAction: (action: GoalAction) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [pending, setPending] = React.useState(false);
  const [editing, setEditing] = React.useState(false);
  const [text, setText] = React.useState(objective.objective);
  const [budget, setBudget] = React.useState(String(objective.maxRuns ?? 50));
  const maxRuns = Number(budget);
  const exhausted = objective.runsUsed >= (objective.maxRuns ?? 50);
  const minutes = Math.floor((objective.activeDurationMs ?? 0) / 60_000);
  const seconds = Math.floor(((objective.activeDurationMs ?? 0) % 60_000) / 1_000);
  const act = async (action: GoalAction) => {
    setPending(true);
    try {
      await onAction(action);
      if (action.action === "update") setEditing(false);
    } catch (error) {
      toastError(error, t("chat:goal.actionFailed"));
    } finally {
      setPending(false);
    }
  };
  return (
    <QueueSection data-slot="goal-panel">
      <QueueSectionTrigger
        action={
          <div className="flex shrink-0 items-center gap-0.5">
            {objective.status !== "done" &&
              (running ? (
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  aria-label={t("chat:goal.pause")}
                  title={t("chat:goal.pause")}
                  disabled={pending}
                  onClick={() => void act({ action: "pause" })}
                >
                  <PauseIcon />
                </Button>
              ) : (
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  aria-label={t("chat:goal.resume")}
                  title={t(exhausted ? "chat:goal.budgetExhausted" : "chat:goal.resume")}
                  disabled={pending || exhausted || !canResume}
                  onClick={() => void act({ action: "resume" })}
                >
                  <PlayIcon />
                </Button>
              ))}
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              aria-label={t("common:edit")}
              title={t("common:edit")}
              disabled={pending}
              onClick={() => {
                setText(objective.objective);
                setBudget(String(objective.maxRuns ?? 50));
                setEditing(true);
              }}
            >
              <PencilIcon />
            </Button>
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              aria-label={t("chat:goal.clear")}
              title={t("chat:goal.clear")}
              disabled={pending}
              onClick={() => void act({ action: "clear" })}
            >
              <XIcon />
            </Button>
          </div>
        }
      >
        <QueueSectionLabel
          label={t("chat:goal.title")}
          icon={
            objective.status === "done" ? (
              <CheckCircle2Icon className="size-3.5" />
            ) : (
              <TargetIcon className="size-3.5" />
            )
          }
        />
        <span className="ml-2 text-xs">{t(`chat:goal.${objective.status}`)}</span>
      </QueueSectionTrigger>
      <QueueSectionContent>
        <div className="flex min-w-0 flex-col gap-1 px-2 py-1">
          <ScrollArea className="max-h-28">
            <p className="whitespace-pre-wrap break-words text-sm">{objective.objective}</p>
          </ScrollArea>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground tabular-nums">
            <span title={t("chat:goal.evaluationsHint")}>
              {t("chat:goal.evaluations", {
                used: objective.runsUsed,
                total: objective.maxRuns ?? 50,
              })}
            </span>
            <span>
              {t("chat:goal.duration", { time: `${minutes}:${String(seconds).padStart(2, "0")}` })}
            </span>
          </div>
          {objective.status === "paused" && objective.pausedReason && !exhausted && (
            <p className="break-words text-xs text-muted-foreground">{objective.pausedReason}</p>
          )}
          {exhausted && objective.status !== "done" && (
            <p className="break-words text-xs text-muted-foreground">
              {t("chat:goal.budgetExhausted")}
            </p>
          )}
        </div>
      </QueueSectionContent>
      <Dialog open={editing} onOpenChange={setEditing}>
        <DialogContent className="flex max-h-[min(85vh,36rem)] flex-col sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("chat:goal.editTitle")}</DialogTitle>
            <DialogDescription>{t("chat:goal.editHint")}</DialogDescription>
          </DialogHeader>
          <ScrollArea className="min-h-0 flex-1">
            <div className="flex flex-col gap-3 p-1">
              <Field>
                <FieldLabel htmlFor="goal-objective">{t("chat:goal.title")}</FieldLabel>
                <Textarea
                  id="goal-objective"
                  rows={5}
                  maxLength={20_000}
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="goal-budget">{t("chat:goal.budget")}</FieldLabel>
                <Input
                  id="goal-budget"
                  type="number"
                  min={1}
                  max={500}
                  step={1}
                  value={budget}
                  onChange={(event) => setBudget(event.target.value)}
                />
                <FieldDescription>{t("chat:goal.budgetHint")}</FieldDescription>
              </Field>
            </div>
          </ScrollArea>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setEditing(false)}>
              {t("common:cancel")}
            </Button>
            <Button
              type="button"
              disabled={
                pending ||
                !text.trim() ||
                !Number.isInteger(maxRuns) ||
                maxRuns < 1 ||
                maxRuns > 500
              }
              onClick={() => void act({ action: "update", objective: text.trim(), maxRuns })}
            >
              {t("common:save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </QueueSection>
  );
}
