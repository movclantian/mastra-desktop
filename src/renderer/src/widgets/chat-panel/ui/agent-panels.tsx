import type { UIMessage } from "ai";
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
  QuestionnaireSkip,
  QuestionnaireSubmit,
  QuestionnaireTitle,
} from "@/shared/ui/questionnaire";
import { ScrollArea } from "@/shared/ui/scroll-area";
import { Textarea } from "@/shared/ui/textarea";
import {
  type AgentInteraction,
  type AgentTask,
  type AgentToolState,
  asRecord,
  asString,
  getPlanDraft,
  normalizeAgentTasks,
  normalizeAgentTools,
  type WorkflowRuntimeRun,
  type WorkflowRuntimeState,
} from "../model/types";

function workflowStatusLabel(status: string, t?: (key: string) => string): string {
  const key = `chat.panels.workflowStatus.${status}`;
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

export type WorkflowRunAction = "resume" | "restart" | "cancel";

function WorkflowRunCard({
  run,
  onAction,
  onResume,
}: {
  run: WorkflowRuntimeRun;
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
      {onAction && onResume ? (
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
              onClick={() => onAction(run, "restart")}
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
      <div className="mt-2 grid gap-1">
        {run.steps.map((step) => (
          <div className="min-w-0" key={step.id}>
            <div className="flex min-w-0 items-center gap-2 text-xs">
              <span className="shrink-0">{workflowStepIcon(step.status)}</span>
              <span className="min-w-0 flex-1 truncate">{step.label || step.id}</span>
              {step.progress ? (
                <span className="shrink-0 tabular-nums text-muted-foreground">
                  {step.progress.completedCount}/{step.progress.totalCount}
                </span>
              ) : null}
            </div>
            {step.error ? (
              <p className="truncate pl-6 text-[10px] text-destructive" title={step.error}>
                {step.error}
              </p>
            ) : null}
          </div>
        ))}
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
  onAction,
}: {
  workflow: WorkflowRuntimeState | null;
  onAction?: (run: WorkflowRuntimeRun, action: WorkflowRunAction, resumeData?: unknown) => void;
}) {
  const { t } = useTranslation();
  const [resumeRun, setResumeRun] = React.useState<WorkflowRuntimeRun | null>(null);
  const [resumeText, setResumeText] = React.useState('{\n  "approved": true\n}');
  const [resumeError, setResumeError] = React.useState<string | null>(null);
  if (!workflow || workflow.runs.length === 0) return null;
  const visibleRuns = workflow.runs.slice(0, 3);
  const active = workflow.active;
  const badgeRun = active ?? visibleRuns[0];
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
                      setResumeRun(run);
                    }
                  : undefined
              }
              run={run}
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
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("chat:panels.resumeWorkflow")}</DialogTitle>
            <DialogDescription>
              {resumeDescription || t("chat:panels.resumeDesc")}
            </DialogDescription>
          </DialogHeader>
          <Textarea
            className="min-h-32 font-mono text-xs"
            onChange={(event) => setResumeText(event.target.value)}
            value={resumeText}
          />
          {resumeError ? <p className="text-xs text-destructive">{resumeError}</p> : null}
          <DialogFooter>
            <Button onClick={() => setResumeRun(null)} variant="ghost">
              {t("common:cancel")}
            </Button>
            <Button
              onClick={() => {
                if (!resumeRun || !onAction) return;
                try {
                  const parsed = JSON.parse(resumeText);
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

export function AgentQueuePanel({
  tasks,
  activeTools = [],
  queuedFollowUps = 0,
  onClose,
}: {
  tasks: AgentTask[];
  activeTools?: AgentToolState[];
  queuedFollowUps?: number;
  onClose?: () => void;
}) {
  const { t } = useTranslation();
  // This is the last rendering boundary. Do not assume upstream message or
  // display-state projections were the only producers: reconnects and queued
  // snapshots can still replay the same id directly into this component.
  const visibleTasks = React.useMemo(() => normalizeAgentTasks(tasks), [tasks]);
  const visibleTools = React.useMemo(() => normalizeAgentTools(activeTools), [activeTools]);
  if (visibleTasks.length === 0 && visibleTools.length === 0 && queuedFollowUps === 0) return null;
  const completed =
    visibleTasks.length > 0 &&
    visibleTasks.every((task) => task.status === "completed") &&
    visibleTools.length === 0 &&
    queuedFollowUps === 0;

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
      {visibleTools.length > 0 ? (
        <QueueSection defaultOpen>
          <QueueSectionTrigger className="px-2 py-1">
            <QueueSectionLabel
              count={visibleTools.length}
              label={t("chat:panels.tool")}
              icon={<SparklesIcon className="size-4" />}
            />
          </QueueSectionTrigger>
          <QueueSectionContent>
            <QueueList className="mt-1">
              {visibleTools.map((tool, index) => (
                <QueueItem className="px-2 py-1" key={`${tool.toolCallId}:${index}`}>
                  <div className="flex min-w-0 items-center gap-2">
                    <QueueItemIndicator completed={tool.status === "completed"} />
                    <QueueItemContent className="line-clamp-2">{tool.name}</QueueItemContent>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {tool.status === "error"
                        ? t("chat:panels.failed")
                        : tool.status === "completed"
                          ? t("chat:panels.completed")
                          : t("chat:panels.inProgress")}
                    </span>
                  </div>
                </QueueItem>
              ))}
            </QueueList>
          </QueueSectionContent>
        </QueueSection>
      ) : null}
      {queuedFollowUps > 0 ? (
        <QueueSection defaultOpen>
          <QueueSectionTrigger className="px-2 py-1">
            <QueueSectionLabel
              count={queuedFollowUps}
              label={t("chat:panels.followUp")}
              icon={<SparklesIcon className="size-4" />}
            />
          </QueueSectionTrigger>
        </QueueSection>
      ) : null}
    </>
  );
}

export function AgentQuestionnairePanel({
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

  const outputRecord = asRecord(interaction.output);
  const answerValue = outputRecord?.answer ?? interaction.output;
  const answers = Array.isArray(answerValue)
    ? answerValue.flatMap((value) => (asString(value) ? [value] : []))
    : asString(answerValue)
      ? [answerValue]
      : [];

  // items 声明须与 JSX 组合完全一致(库会校验 required/disabled 并告警):
  // 已完成视图的选项只读展示,choices 需同步声明 disabled
  const items = [
    {
      name: "answer",
      required: true,
      ...(options.length > 0
        ? {
            choices: options.map((option) => ({
              value: option.label,
              ...(completed ? { disabled: true } : {}),
            })),
          }
        : {}),
    },
  ];

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const answer =
      selectionMode === "multi_select" ? formData.getAll("answer") : formData.get("answer");
    onResume(answer ?? "");
  };

  return (
    <div
      className={cn(
        "mb-2 rounded-xl border p-3 shadow-xs",
        completed ? "border-border/60 bg-background/60" : "bg-background",
      )}
    >
      <div
        className={cn(
          "mb-3 flex items-center gap-2 text-sm font-medium",
          completed ? "text-muted-foreground" : "text-foreground",
        )}
      >
        <CircleHelpIcon className="size-4 text-primary" />
        {completed ? t("chat:panels.answered") : t("chat:panels.waitingAnswer")}
      </div>
      <Questionnaire
        items={items}
        onSubmit={completed ? undefined : handleSubmit}
        shortcuts={!completed && options.length > 0 ? "letters" : undefined}
      >
        <QuestionnaireItem multiple={selectionMode === "multi_select"} name="answer" required>
          <QuestionnaireTitle>{question}</QuestionnaireTitle>
          {!completed && options.length > 0 ? (
            <QuestionnaireDescription>
              {selectionMode === "multi_select"
                ? t("chat:panels.multiSelectHint")
                : t("chat:panels.singleSelectHint")}
            </QuestionnaireDescription>
          ) : null}
          <QuestionnaireChoices>
            {options.length > 0 ? (
              options.map((option) => (
                <QuestionnaireChoice
                  defaultChecked={completed ? answers.includes(option.label) : undefined}
                  disabled={completed}
                  key={option.label}
                  value={option.label}
                >
                  <span className="font-medium">{option.label}</span>
                  {option.description ? (
                    <QuestionnaireChoiceDescription>
                      {option.description}
                    </QuestionnaireChoiceDescription>
                  ) : null}
                </QuestionnaireChoice>
              ))
            ) : (
              <QuestionnaireInput
                aria-label={
                  completed ? t("chat:panels.answeredContent") : t("chat:panels.answerQuestion")
                }
                defaultValue={completed ? formatInteractionValue(answerValue, t) : undefined}
                disabled={completed}
                placeholder={completed ? undefined : t("chat:panels.inputAnswerPlaceholder")}
              />
            )}
          </QuestionnaireChoices>
          {!completed ? <QuestionnaireError /> : null}
        </QuestionnaireItem>
        {!completed ? (
          <QuestionnaireActions>
            <QuestionnaireSkip disabled={busy} onClick={() => onResume("")} type="button">
              {t("common:cancel")}
            </QuestionnaireSkip>
            <QuestionnaireSubmit disabled={busy}>
              {busy ? t("chat:panels.submitting") : t("chat:panels.submitAnswer")}
            </QuestionnaireSubmit>
          </QuestionnaireActions>
        ) : null}
      </Questionnaire>
    </div>
  );
}

export function AgentPlanPanel({
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
  const [feedback, setFeedback] = React.useState("");
  const payload = interaction.suspendPayload ?? {};
  const draft = interaction.plan;
  const title = draft?.title ?? asString(payload.title) ?? t("chat:panels.implementationPlan");
  const plan = draft?.plan ?? asString(payload.plan);
  const path = draft?.path ?? asString(payload.path);

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
              {t("chat:panels.planNotLoaded", { path: path ?? t("chat:panels.unknown") })}
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
          <Button disabled={busy} onClick={() => resume("approved")} size="sm">
            {t("chat:panels.approveExecution")}
          </Button>
        </PlanAction>
      </PlanFooter>
    </Plan>
  );
}

export function formatInteractionValue(value: unknown, t?: (key: string) => string): string {
  if (typeof value === "string") return value;
  if (value === undefined)
    return t ? t("chat:panels.noAnswerProvided") : i18n.t("chat:panels.noAnswerProvided");
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
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

export function AgentApprovalPanel({
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
  messages,
  threadId,
}: {
  interactions: AgentInteraction[];
  busyKeys: ReadonlySet<string>;
  onResume: (interaction: AgentInteraction, resumeData: unknown) => void;
  onAlwaysAllow?: (category: ToolCategory) => Promise<void> | void;
  messages: UIMessage[];
  threadId: string | null;
}) {
  if (interactions.length === 0) return null;

  return (
    <div className="min-w-0">
      {interactions.map((interaction) => {
        const enriched =
          interaction.toolName === "submit_plan"
            ? {
                ...interaction,
                plan:
                  interaction.plan ??
                  getPlanDraft(messages, asString(interaction.suspendPayload?.path)),
              }
            : interaction;
        const resume = (resumeData: unknown) => onResume(enriched, resumeData);
        const busy = threadId !== null && busyKeys.has(`${threadId}:${interaction.key}`);
        if (interaction.toolName === "ask_user") {
          return (
            <AgentQuestionnairePanel
              busy={busy}
              interaction={enriched}
              key={interaction.key}
              onResume={resume}
            />
          );
        }
        if (interaction.toolName === "submit_plan") {
          return (
            <AgentPlanPanel
              busy={busy}
              interaction={enriched}
              key={interaction.key}
              onResume={resume}
            />
          );
        }
        return (
          <AgentApprovalPanel
            busy={busy}
            interaction={enriched}
            key={interaction.key}
            onAlwaysAllow={onAlwaysAllow}
            onResume={resume}
          />
        );
      })}
    </div>
  );
}
