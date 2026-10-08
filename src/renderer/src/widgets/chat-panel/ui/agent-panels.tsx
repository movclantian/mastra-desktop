import { useQuery } from "@tanstack/react-query";
import {
  CheckCircle2Icon,
  CircleAlertIcon,
  CircleHelpIcon,
  CircleIcon,
  FileCheck2Icon,
  PauseCircleIcon,
  PlayIcon,
  RotateCcwIcon,
  ShieldAlertIcon,
  SparklesIcon,
  XIcon,
} from "lucide-react";
import * as React from "react";
import { CATEGORY_META, type ToolCategory } from "@/entities/workbench";
import { fetchWorkspaceFile } from "@/entities/workbench/api/workbench-api";
import { useAuth } from "@/features/auth";
import { i18n, useTranslation } from "@/shared/i18n";
import { cn } from "@/shared/lib";
import { MessageResponse } from "@/shared/ui/ai-elements/message";
import {
  Plan,
  PlanAction,
  PlanContent,
  PlanDescription,
  PlanFooter,
  PlanHeader,
  PlanTitle,
  PlanTrigger,
} from "@/shared/ui/ai-elements/plan";
import {
  QueueItem,
  QueueItemContent,
  QueueItemIndicator,
  QueueList,
  QueueSection,
  QueueSectionContent,
  QueueSectionLabel,
  QueueSectionTrigger,
} from "@/shared/ui/ai-elements/queue";
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
import { Dotm3x3_6 } from "@/shared/ui/dotm-3x3-6";
import { PulsatingButton } from "@/shared/ui/pulsating-button";
import {
  Questionnaire,
  QuestionnaireActions,
  QuestionnaireChoice,
  QuestionnaireChoiceDescription,
  QuestionnaireChoices,
  QuestionnaireDescription,
  QuestionnaireError,
  QuestionnaireInput,
  QuestionnaireItem,
  QuestionnaireSubmit,
  QuestionnaireTitle,
} from "@/shared/ui/questionnaire";
import { ScrollArea } from "@/shared/ui/scroll-area";
import { Textarea } from "@/shared/ui/textarea";
import {
  type AgentInteraction,
  type AgentTask,
  asRecord,
  asString,
  normalizeAgentTasks,
  type WorkflowRuntimeRun,
  type WorkflowRuntimeState,
} from "../model/types";
import { WorkflowSteps } from "./team-collaboration";

function workflowStatusLabel(status: string, t?: (key: string) => string): string {
  const key = `chat:panels.workflowStatus.${status}`;
  return t ? t(key) : i18n.t(key);
}

function workflowStepIcon(status: string) {
  if (status === "success") return <CheckCircle2Icon className="size-3.5 text-emerald-600" />;
  if (status === "failed") return <CircleAlertIcon className="size-3.5 text-destructive" />;
  if (status === "suspended" || status === "paused") {
    return <PauseCircleIcon className="size-3.5 text-amber-600" />;
  }
  if (status === "running") {
    return <Dotm3x3_6 size={13} dotSize={2} colorPreset="solid-theme" />;
  }
  return <CircleIcon className="size-3.5 text-muted-foreground" />;
}

function workflowOutputPreview(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  const record = asRecord(value);
  const direct = asString(record?.text) ?? asString(record?.result);
  if (direct) return direct;
  if (value === undefined || value === null) return undefined;
  try {
    const serialized = JSON.stringify(value);
    return serialized && serialized !== "{}" ? serialized : undefined;
  } catch {
    return undefined;
  }
}

function workflowTimeLabel(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toLocaleTimeString();
}

export type WorkflowRunAction = "resume" | "rerun" | "cancel";

function WorkflowRunCard({
  run,
  invocations,
  onAction,
  onResume,
}: {
  run: WorkflowRuntimeRun;
  invocations: import("../../../../../shared/agent-contract").TeamInvocation[];
  onAction?: (run: WorkflowRuntimeRun, action: WorkflowRunAction) => void;
  onResume?: (run: WorkflowRuntimeRun) => void;
}) {
  const { t } = useTranslation();
  const events = run.events.slice(-6).reverse();
  const outputText = workflowOutputPreview(run.output);
  return (
    <div className="border-b px-3 py-2 last:border-b-0">
      <div className="flex min-w-0 items-center gap-2">
        {workflowStepIcon(run.status)}
        <span className="min-w-0 flex-1 truncate font-mono text-xs">{run.workflowId}</span>
        <Badge
          variant={run.status === "failed" || run.status === "tripwire" ? "destructive" : "outline"}
          className="shrink-0 text-[10px]"
        >
          {workflowStatusLabel(run.status, t)}
        </Badge>
      </div>
      {onAction && onResume && !run.controlledByAgent ? (
        <div className="mt-2 flex flex-wrap justify-end gap-1">
          {run.status === "suspended" ? (
            /* 挂起的 Workflow 在等人操作 —— 脉冲扩散把"该你了"从一排同质按钮里拉出来 */
            <PulsatingButton
              aria-label={t("chat:panels.resumeWorkflow")}
              className="h-6 gap-1 rounded-md px-2 text-[10px]"
              duration="1.8s"
              distance="5px"
              onClick={() => onResume(run)}
              title={t("chat:panels.resumeWorkflow")}
              variant="ripple"
            >
              <PlayIcon className="size-3" />
              {t("chat:panels.resumeWorkflow").replace(" Workflow", "")}
            </PulsatingButton>
          ) : null}
          {["failed", "tripwire", "canceled", "bailed"].includes(run.status) ? (
            <Button
              aria-label={t("chat:panels.restartWorkflow")}
              className="h-6 px-2 text-[10px]"
              onClick={() => onAction(run, "rerun")}
              size="sm"
              title={t("chat:panels.restartWorkflow")}
              variant="outline"
            >
              <RotateCcwIcon />
              {t("chat:panels.restartWorkflow").replace(" Workflow", "")}
            </Button>
          ) : null}
          {["pending", "running", "waiting", "suspended", "paused"].includes(run.status) ? (
            <Button
              aria-label={t("chat:panels.cancelWorkflow")}
              className="h-6 px-2 text-[10px]"
              onClick={() => onAction(run, "cancel")}
              size="sm"
              title={t("chat:panels.cancelWorkflow")}
              variant="ghost"
            >
              <XIcon />
              {t("common:cancel")}
            </Button>
          ) : null}
        </div>
      ) : null}
      <div className="mt-2">
        <WorkflowSteps run={run} invocations={invocations} />
      </div>
      {workflowTimeLabel(run.startedAt) || workflowTimeLabel(run.finishedAt ?? run.updatedAt) ? (
        <p className="mt-2 truncate border-t pt-2 text-[10px] text-muted-foreground">
          {t("chat:panels.startedAt", {
            time: workflowTimeLabel(run.startedAt) ?? t("chat:panels.unknown"),
          })}
          {workflowTimeLabel(run.finishedAt ?? run.updatedAt)
            ? ` · ${workflowTimeLabel(run.finishedAt ?? run.updatedAt)}`
            : ""}
        </p>
      ) : null}
      {outputText ? (
        <p
          className="mt-2 line-clamp-2 border-t pt-2 text-xs text-muted-foreground"
          title={outputText}
        >
          {outputText}
        </p>
      ) : null}
      {run.error ? (
        <p className="mt-2 truncate border-t pt-2 text-[10px] text-destructive" title={run.error}>
          {run.error}
        </p>
      ) : null}
      {events.length > 0 ? (
        <div className="mt-2 border-t pt-2 text-[10px] text-muted-foreground">
          {events.map((event) => (
            <div className="flex min-w-0 gap-2" key={`${run.runId}:${event.id}`}>
              <span className="shrink-0 tabular-nums">
                {event.at ? new Date(event.at).toLocaleTimeString() : t("chat:panels.step")}
              </span>
              <span className="min-w-0 truncate">
                {event.stepId ? `${event.stepId}: ` : ""}
                {event.message || workflowStatusLabel(event.status || event.type, t)}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function WorkflowRunPanel({
  workflow,
  invocations,
  onAction,
}: {
  workflow: WorkflowRuntimeState | null;
  invocations: import("../../../../../shared/agent-contract").TeamInvocation[];
  onAction?: (run: WorkflowRuntimeRun, action: WorkflowRunAction, resumeData?: unknown) => void;
}) {
  const { t } = useTranslation();
  const [resumeRun, setResumeRun] = React.useState<WorkflowRuntimeRun | null>(null);
  const [resumeText, setResumeText] = React.useState('{\n  "approved": true\n}');
  const [resumeError, setResumeError] = React.useState<string | null>(null);
  const [feedback, setFeedback] = React.useState("");
  if (!workflow || workflow.runs.length === 0) return null;
  const visibleRuns = workflow.runs;
  const active = workflow.active;
  const badgeRun = active ?? visibleRuns[0];
  const suspension = asRecord(
    resumeRun?.steps.find((step) => step.status === "suspended")?.suspendPayload,
  );
  const needsApproval = Boolean(
    suspension && (!suspension.agentRunId || suspension.requiresApproval === true),
  );
  const resumeDescription = asString(
    asRecord(resumeRun?.steps.find((step) => step.status === "suspended")?.suspendPayload)
      ?.description,
  );
  return (
    <>
      <div className="mx-auto mb-2 w-full max-w-3xl rounded-lg border bg-background shadow-xs">
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <SparklesIcon className="size-4 text-primary" />
          <span className="text-sm font-medium">{t("chat:panels.workflowRunStatus")}</span>
          <Badge
            className="ml-auto text-[10px]"
            variant={
              badgeRun?.status === "failed" || badgeRun?.status === "tripwire"
                ? "destructive"
                : "secondary"
            }
          >
            {badgeRun ? workflowStatusLabel(badgeRun.status, t) : t("chat:panels.recentRun")}
          </Badge>
        </div>
        <ScrollArea className="max-h-72">
          {visibleRuns.map((run) => (
            <WorkflowRunCard
              key={run.runId}
              onAction={onAction}
              onResume={
                onAction
                  ? (run) => {
                      setResumeError(null);
                      setFeedback("");
                      setResumeRun(run);
                    }
                  : undefined
              }
              run={run}
              invocations={invocations}
            />
          ))}
        </ScrollArea>
      </div>
      <Dialog
        open={resumeRun !== null}
        onOpenChange={(open) => {
          if (!open) {
            setResumeError(null);
            setResumeRun(null);
          }
        }}
      >
        <DialogContent className="flex max-h-[calc(100dvh-2rem)] max-w-lg flex-col overflow-hidden">
          <DialogHeader>
            <DialogTitle>{t("chat:panels.resumeWorkflow")}</DialogTitle>
            <DialogDescription>
              {needsApproval ? t("agentHub:approvalDescription") : t("chat:panels.resumeDesc")}
            </DialogDescription>
          </DialogHeader>
          <ScrollArea className="min-h-0 flex-1">
            <div className="grid min-w-0 gap-3">
              {resumeDescription ? (
                <pre className="whitespace-pre-wrap break-words text-xs">{resumeDescription}</pre>
              ) : null}
              {needsApproval ? (
                <Textarea
                  aria-label={t("agentHub:feedback")}
                  placeholder={t("agentHub:feedback")}
                  value={feedback}
                  onChange={(event) => setFeedback(event.target.value)}
                />
              ) : (
                <Textarea
                  aria-label={t("chat:panels.resumeWorkflow")}
                  className="min-h-32 max-h-64 whitespace-pre-wrap break-words font-mono text-xs"
                  onChange={(event) => setResumeText(event.target.value)}
                  value={resumeText}
                />
              )}
            </div>
          </ScrollArea>
          {resumeError ? <p className="text-xs text-destructive">{resumeError}</p> : null}
          <DialogFooter>
            {needsApproval ? (
              <Button
                variant="destructive"
                onClick={() => {
                  if (!resumeRun || !onAction) return;
                  onAction(resumeRun, "resume", { approved: false, feedback });
                  setResumeRun(null);
                }}
              >
                {t("agentHub:decline")}
              </Button>
            ) : null}
            <Button onClick={() => setResumeRun(null)} variant="ghost">
              {t("common:cancel")}
            </Button>
            <Button
              onClick={() => {
                if (!resumeRun || !onAction) return;
                try {
                  const parsed = needsApproval
                    ? { approved: true, feedback }
                    : JSON.parse(resumeText);
                  onAction(resumeRun, "resume", parsed);
                  setResumeError(null);
                  setResumeRun(null);
                } catch {
                  setResumeError(t("chat:panels.invalidJson"));
                }
              }}
            >
              <PlayIcon />
              {t("common:confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function AgentQueuePanel({ tasks, onClose }: { tasks: AgentTask[]; onClose?: () => void }) {
  const { t } = useTranslation();
  // This is the last rendering boundary. Do not assume upstream message or
  // display-state projections were the only producers: reconnects and queued
  // snapshots can still replay the same id directly into this component.
  const visibleTasks = React.useMemo(() => normalizeAgentTasks(tasks), [tasks]);
  if (visibleTasks.length === 0) return null;
  const completed =
    visibleTasks.length > 0 && visibleTasks.every((task) => task.status === "completed");

  return (
    <>
      {/* 只渲染 QueueSection,与 UserRequestQueuePanel 的排队请求 section 同住
          一张 Queue 卡片(由 chat/panel.tsx 统一包裹),保持两个队列的视觉一体。 */}
      {visibleTasks.length > 0 ? (
        <QueueSection defaultOpen>
          <QueueSectionTrigger
            action={
              completed && onClose ? (
                <Button
                  aria-label={t("common:close")}
                  className="size-7 shrink-0 text-muted-foreground"
                  onClick={onClose}
                  size="icon"
                  title={t("common:close")}
                  type="button"
                  variant="ghost"
                >
                  <XIcon className="size-4" />
                </Button>
              ) : null
            }
            className="px-2 py-1"
          >
            <QueueSectionLabel
              count={visibleTasks.length}
              label={t("chat:panels.task")}
              icon={<SparklesIcon className="size-4" />}
            />
          </QueueSectionTrigger>
          <QueueSectionContent>
            <QueueList className="mt-1">
              {visibleTasks.map((task, index) => {
                const completed = task.status === "completed";
                return (
                  <QueueItem className="px-2 py-1" key={`${task.id}:${index}`}>
                    <div className="flex min-w-0 items-center gap-2">
                      <QueueItemIndicator
                        completed={completed}
                        className={
                          task.status === "in_progress" ? "border-primary bg-primary/20" : undefined
                        }
                      />
                      <QueueItemContent className="line-clamp-none" completed={completed}>
                        {task.content}
                      </QueueItemContent>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {completed
                          ? t("chat:panels.completed")
                          : task.status === "in_progress"
                            ? t("chat:panels.inProgress")
                            : t("chat:panels.pending")}
                      </span>
                    </div>
                  </QueueItem>
                );
              })}
            </QueueList>
          </QueueSectionContent>
        </QueueSection>
      ) : null}
    </>
  );
}

function AgentQuestionnairePanel({
  interaction,
  busy,
  onResume,
  completed = false,
}: {
  interaction: AgentInteraction;
  busy: boolean;
  onResume: (resumeData: unknown) => void;
  completed?: boolean;
}) {
  const { t } = useTranslation();
  const payload = interaction.suspendPayload ?? {};
  const question = asString(payload.question) ?? t("chat:panels.waitingAnswer");
  const selectionMode = payload.selectionMode === "multi_select" ? "multi_select" : "single_select";
  const options = Array.isArray(payload.options)
    ? payload.options.flatMap((option) => {
        const record = asRecord(option);
        const label = asString(record?.label);
        return label ? [{ label, description: asString(record?.description) }] : [];
      })
    : [];
  // Native ask_user returns content, not an answer field. Preserve the full text:
  // multi-select answers are formatted by Mastra and may themselves contain commas.
  const answer = asString(asRecord(interaction.output)?.content)?.replace(/^User answered: /, "");
  const items = [
    {
      name: "answer",
      required: true,
      choices: options.map((option) => ({ value: option.label, disabled: busy })),
    },
  ];
  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const formData = new FormData(event.currentTarget);
    const answer =
      selectionMode === "multi_select" ? formData.getAll("answer") : formData.get("answer");
    onResume(answer ?? "");
  };

  return (
    <div
      className={cn(
        "mb-2 min-w-0 rounded-xl border p-3 shadow-xs",
        completed ? "border-border/60 bg-background/60" : "bg-background",
      )}
    >
      <div
        className={cn(
          "mb-3 flex items-center gap-2 text-sm font-medium",
          completed ? "text-muted-foreground" : "text-foreground",
        )}
      >
        <CircleHelpIcon className="size-4 shrink-0 text-primary" />
        {completed ? t("chat:panels.answered") : t("chat:panels.waitingAnswer")}
      </div>
      {completed ? (
        <ScrollArea className="max-h-[45dvh]">
          <p className="break-words text-sm font-medium">{question}</p>
          <p className="mt-2 whitespace-pre-wrap break-words text-sm text-muted-foreground">
            {answer || t("chat:panels.noAnswerProvided")}
          </p>
        </ScrollArea>
      ) : (
        <Questionnaire
          className="gap-2"
          items={items}
          onSubmit={handleSubmit}
          shortcuts={!busy && options.length > 0 ? "letters" : undefined}
        >
          <ScrollArea className="max-h-[45dvh]">
            <QuestionnaireItem
              className="gap-2"
              multiple={selectionMode === "multi_select"}
              name="answer"
              required
            >
              <QuestionnaireTitle className="break-words text-sm">{question}</QuestionnaireTitle>
              {options.length > 0 ? (
                <QuestionnaireDescription className="text-xs">
                  {selectionMode === "multi_select"
                    ? t("chat:panels.multiSelectHint")
                    : t("chat:panels.singleSelectHint")}
                </QuestionnaireDescription>
              ) : null}
              <QuestionnaireChoices>
                {options.map((option) => (
                  <QuestionnaireChoice
                    className="gap-2 px-2.5 py-2 sm:min-h-9"
                    disabled={busy}
                    key={option.label}
                    value={option.label}
                  >
                    <span className="break-words font-medium">{option.label}</span>
                    {option.description ? (
                      <QuestionnaireChoiceDescription className="break-words text-xs">
                        {option.description}
                      </QuestionnaireChoiceDescription>
                    ) : null}
                  </QuestionnaireChoice>
                ))}
                {/* The primitive handles input/choice exclusivity for single-select,
                    and includes both values in FormData for multi-select. */}
                <QuestionnaireInput
                  aria-label={t("chat:panels.answerQuestion")}
                  disabled={busy}
                  placeholder={
                    options.length > 0
                      ? t("chat:panels.customAnswerPlaceholder")
                      : t("chat:panels.inputAnswerPlaceholder")
                  }
                />
              </QuestionnaireChoices>
              <QuestionnaireError />
            </QuestionnaireItem>
          </ScrollArea>
          <QuestionnaireActions>
            <Button
              className="col-start-2 row-start-1"
              disabled={busy}
              onClick={() => onResume(t("chat:panels.declineAnswerResponse"))}
              type="button"
              size="sm"
              variant="outline"
            >
              {t("chat:panels.declineAnswer")}
            </Button>
            <QuestionnaireSubmit disabled={busy} size="sm">
              {busy ? t("chat:panels.submitting") : t("chat:panels.submitAnswer")}
            </QuestionnaireSubmit>
          </QuestionnaireActions>
        </Questionnaire>
      )}
    </div>
  );
}

function AgentPlanPanel({
  interaction,
  busy,
  onResume,
  completed = false,
  threadId,
}: {
  interaction: AgentInteraction;
  busy: boolean;
  onResume: (resumeData: unknown) => void;
  completed?: boolean;
  threadId?: string | null;
}) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [feedback, setFeedback] = React.useState("");
  const payload = interaction.suspendPayload ?? {};
  const path = asString(payload.path);
  // submit_plan suspends with a path; the host reads the file and echoes the reviewed snapshot on resume.
  const planQuery = useQuery({
    queryKey: ["plan-file", user?.id, threadId, interaction.toolCallId, path],
    enabled: !completed && Boolean(user && threadId && path),
    queryFn: async () => {
      if (!user || !threadId || !path) throw new Error(t("workspace:readFileFailed"));
      const file = await fetchWorkspaceFile(threadId, user.id, path);
      if (file.isBinary || !file.content.trim()) throw new Error(t("workspace:readFileFailed"));
      return file.content;
    },
  });
  const plan = completed ? asString(payload.plan) : planQuery.data;
  const title =
    asString(payload.title) ??
    plan?.match(/^#\s+(.+)$/m)?.[1] ??
    t("chat:panels.implementationPlan");

  if (completed) {
    return (
      <Plan className="rounded-lg" defaultOpen>
        <PlanHeader>
          <div className="min-w-0">
            <div className="mb-1 flex items-center gap-2">
              <FileCheck2Icon className="size-4 shrink-0 text-primary" />
              <PlanTitle>{title}</PlanTitle>
            </div>
            <PlanDescription>
              {t(
                interaction.planDecision === "approved"
                  ? "chat:panels.planApprovedDesc"
                  : interaction.planDecision === "rejected"
                    ? "chat:panels.planRejectedDesc"
                    : interaction.planDecision === "revision"
                      ? "chat:panels.planRevisionDesc"
                      : "chat:panels.planUnknownDesc",
              )}
            </PlanDescription>
          </div>
          <PlanTrigger />
        </PlanHeader>
        <PlanContent className="pt-0">
          <ScrollArea className="max-h-72 rounded-md border bg-muted/20 p-3">
            {plan ? (
              <MessageResponse>{plan}</MessageResponse>
            ) : (
              <p className="text-sm text-muted-foreground">
                {t("chat:panels.planFile", { path: path ?? t("chat:panels.unknown") })}
              </p>
            )}
          </ScrollArea>
        </PlanContent>
      </Plan>
    );
  }

  const resume = (action: "approved" | "rejected") => {
    onResume({
      action,
      ...(feedback.trim() ? { feedback: feedback.trim() } : {}),
      ...(path ? { path } : {}),
      title,
      ...(plan ? { plan } : {}),
    });
  };

  return (
    <Plan className="mb-2" defaultOpen>
      <PlanHeader>
        <div className="min-w-0">
          <div className="mb-1 flex items-center gap-2">
            <FileCheck2Icon className="size-4 shrink-0 text-primary" />
            <PlanTitle>{title}</PlanTitle>
          </div>
          <PlanDescription>{t("chat:panels.planSubmittedDesc")}</PlanDescription>
        </div>
        <PlanTrigger />
      </PlanHeader>
      <PlanContent className="space-y-3 pt-0">
        <ScrollArea className="max-h-72 rounded-md border bg-muted/20 p-3">
          {plan ? (
            <MessageResponse>{plan}</MessageResponse>
          ) : (
            <p className="text-sm text-muted-foreground">
              {planQuery.error?.message ??
                t("chat:panels.planNotLoaded", { path: path ?? t("chat:panels.unknown") })}
            </p>
          )}
        </ScrollArea>
        <Textarea
          aria-label={t("chat:panels.planFeedback")}
          disabled={busy}
          onChange={(event) => setFeedback(event.target.value)}
          placeholder={t("chat:panels.rejectFeedbackPlaceholder")}
          value={feedback}
        />
      </PlanContent>
      <PlanFooter className="justify-end gap-2">
        <PlanAction>
          <Button disabled={busy} onClick={() => resume("rejected")} size="sm" variant="outline">
            {t("chat:panels.reject")}
          </Button>
        </PlanAction>
        <PlanAction>
          <Button
            disabled={busy || !plan || planQuery.isError || planQuery.isFetching}
            onClick={() => resume("approved")}
            size="sm"
          >
            {t("chat:panels.approveExecution")}
          </Button>
        </PlanAction>
      </PlanFooter>
    </Plan>
  );
}

export function AgentInteractionHistory({ interaction }: { interaction: AgentInteraction }) {
  if (interaction.toolName === "ask_user") {
    return (
      <AgentQuestionnairePanel
        busy={false}
        completed
        interaction={interaction}
        onResume={() => undefined}
      />
    );
  }
  if (interaction.toolName === "submit_plan") {
    return (
      <AgentPlanPanel busy={false} completed interaction={interaction} onResume={() => undefined} />
    );
  }
  return null;
}

function approvalToolLabel(toolName: string): string {
  if (toolName === "execute_typescript") return i18n.t("chat:panels.executeTypescript");
  return toolName.replace(/^mastra_workspace_/, "");
}

function AgentApprovalPanel({
  interaction,
  busy,
  onResume,
  onAlwaysAllow,
}: {
  interaction: AgentInteraction;
  busy: boolean;
  onResume: (resumeData: unknown) => void;
  /** 「始终允许此类」:先把该类别写成 allow,再批准本次调用(官方 always_allow_category) */
  onAlwaysAllow?: (category: ToolCategory) => Promise<void> | void;
}) {
  const { t } = useTranslation();
  const [reason, setReason] = React.useState("");
  const label = approvalToolLabel(interaction.toolName);
  const category = interaction.category;

  return (
    <div className="mb-2 rounded-xl border border-amber-500/40 bg-background p-3 shadow-xs">
      <div className="flex items-start gap-2">
        <ShieldAlertIcon className="mt-0.5 size-4 shrink-0 text-amber-600" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-medium">{t("chat:panels.toolWaitingApproval", { label })}</p>
            {category ? (
              <Badge className="text-[10px]" variant="outline">
                {CATEGORY_META[category].label}
              </Badge>
            ) : null}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("chat:panels.confirmBeforeContinue")}
          </p>
          {interaction.args !== undefined ? (
            <ScrollArea className="mt-2 max-h-32 rounded-md border bg-muted/30 p-2">
              <pre className="whitespace-pre-wrap break-words font-mono text-xs">
                {JSON.stringify(interaction.args, null, 2)}
              </pre>
            </ScrollArea>
          ) : null}
          {/* 拒绝理由会代替工具结果回给模型(human-in-the-loop.mdx「Explaining a decline」),
              模型据此调整而不是盲目重试;留空则回落官方默认文案。 */}
          <Textarea
            aria-label={t("chat:panels.rejectReason")}
            className="mt-2 min-h-16"
            disabled={busy}
            onChange={(event) => setReason(event.target.value)}
            placeholder={t("chat:panels.rejectPlaceholder")}
            value={reason}
          />
          <div className="mt-3 flex flex-wrap justify-end gap-2">
            <Button
              disabled={busy}
              onClick={() =>
                onResume({ approved: false, ...(reason.trim() ? { reason: reason.trim() } : {}) })
              }
              size="sm"
              type="button"
              variant="outline"
            >
              {t("chat:panels.reject")}
            </Button>
            {category && onAlwaysAllow ? (
              <Button
                disabled={busy}
                onClick={async () => {
                  await onAlwaysAllow(category);
                  onResume({ approved: true });
                }}
                size="sm"
                type="button"
                variant="secondary"
              >
                {t("chat:panels.alwaysAllowCategory", { category: CATEGORY_META[category].label })}
              </Button>
            ) : null}
            {/* 阻塞式审批:Agent 正停在这里等人点。脉冲把主操作从"拒绝/始终允许"里区分出来 */}
            <PulsatingButton
              className="h-8 rounded-md px-3 text-sm disabled:cursor-not-allowed disabled:opacity-60"
              disabled={busy}
              duration="2s"
              distance="6px"
              onClick={() => onResume({ approved: true })}
              type="button"
            >
              {t("chat:panels.approveExecution")}
            </PulsatingButton>
          </div>
        </div>
      </div>
    </div>
  );
}

export function AgentInteractionPanel({
  interactions,
  busyKeys,
  onResume,
  onAlwaysAllow,
  threadId,
}: {
  interactions: AgentInteraction[];
  busyKeys: ReadonlySet<string>;
  onResume: (interaction: AgentInteraction, resumeData: unknown) => void;
  onAlwaysAllow?: (category: ToolCategory) => Promise<void> | void;
  threadId: string | null;
}) {
  if (interactions.length === 0) return null;

  return (
    <div className="min-w-0">
      {interactions.map((interaction) => {
        const resume = (resumeData: unknown) => onResume(interaction, resumeData);
        const busy = threadId !== null && busyKeys.has(`${threadId}:${interaction.key}`);
        if (interaction.toolName === "ask_user") {
          return (
            <AgentQuestionnairePanel
              busy={busy}
              interaction={interaction}
              key={interaction.key}
              onResume={resume}
            />
          );
        }
        if (interaction.toolName === "submit_plan") {
          return (
            <AgentPlanPanel
              busy={busy}
              interaction={interaction}
              threadId={threadId}
              key={interaction.key}
              onResume={resume}
            />
          );
        }
        return (
          <AgentApprovalPanel
            busy={busy}
            interaction={interaction}
            key={interaction.key}
            onAlwaysAllow={onAlwaysAllow}
            onResume={resume}
          />
        );
      })}
    </div>
  );
}
