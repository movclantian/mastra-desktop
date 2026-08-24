import type { UIMessage } from "ai";
import {
  CheckCircle2Icon,
  CircleAlertIcon,
  CircleHelpIcon,
  CircleIcon,
  FileCheck2Icon,
  LoaderCircleIcon,
  PauseCircleIcon,
  PlayIcon,
  RotateCcwIcon,
  ShieldAlertIcon,
  SparklesIcon,
  XIcon,
} from "lucide-react";
import * as React from "react";
import { MessageResponse } from "@/components/ai-elements/message";
import {
  Plan,
  PlanAction,
  PlanContent,
  PlanDescription,
  PlanFooter,
  PlanHeader,
  PlanTitle,
  PlanTrigger,
} from "@/components/ai-elements/plan";
import {
  QueueItem,
  QueueItemContent,
  QueueItemIndicator,
  QueueList,
  QueueSection,
  QueueSectionContent,
  QueueSectionLabel,
  QueueSectionTrigger,
} from "@/components/ai-elements/queue";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Questionnaire,
  QuestionnaireActions,
  QuestionnaireChoice,
  QuestionnaireChoices,
  QuestionnaireDescription,
  QuestionnaireError,
  QuestionnaireInput,
  QuestionnaireItem,
  QuestionnaireProgress,
  QuestionnaireSubmit,
  QuestionnaireTitle,
} from "@/components/ui/questionnaire";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { CATEGORY_META, type ToolCategory } from "@/features/session/session-policy";
import {
  type AgentInteraction,
  type AgentSubagentState,
  type AgentTask,
  type AgentToolState,
  asRecord,
  asString,
  type BackgroundTaskState,
  getPlanDraft,
  type WorkflowRuntimeRun,
  type WorkflowRuntimeState,
} from "../types";

function workflowStatusLabel(status: string): string {
  return (
    {
      running: "运行中",
      success: "已完成",
      failed: "失败",
      suspended: "等待审批",
      canceled: "已取消",
      paused: "已暂停",
      pending: "排队中",
      waiting: "等待中",
      tripwire: "已拦截",
      bailed: "已中止",
      skipped: "已跳过",
    }[status] ?? status
  );
}

function workflowStepIcon(status: string) {
  if (status === "success") return <CheckCircle2Icon className="size-3.5 text-emerald-600" />;
  if (status === "failed") return <CircleAlertIcon className="size-3.5 text-destructive" />;
  if (status === "suspended" || status === "paused") {
    return <PauseCircleIcon className="size-3.5 text-amber-600" />;
  }
  if (status === "running") {
    return <LoaderCircleIcon className="size-3.5 animate-spin text-primary" />;
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
export type BackgroundTaskAction = "restart" | "cancel" | "resume";

function WorkflowRunCard({
  run,
  onAction,
  onResume,
}: {
  run: WorkflowRuntimeRun;
  onAction?: (run: WorkflowRuntimeRun, action: WorkflowRunAction) => void;
  onResume?: (run: WorkflowRuntimeRun) => void;
}) {
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
          {workflowStatusLabel(run.status)}
        </Badge>
      </div>
      {onAction && onResume ? (
        <div className="mt-2 flex flex-wrap justify-end gap-1">
          {run.status === "suspended" ? (
            <Button
              aria-label="恢复 Workflow"
              className="h-6 px-2 text-[10px]"
              onClick={() => onResume(run)}
              size="sm"
              title="恢复 Workflow"
              variant="outline"
            >
              <PlayIcon />
              恢复
            </Button>
          ) : null}
          {["failed", "tripwire", "canceled", "bailed"].includes(run.status) ? (
            <Button
              aria-label="重启 Workflow"
              className="h-6 px-2 text-[10px]"
              onClick={() => onAction(run, "restart")}
              size="sm"
              title="重启 Workflow"
              variant="outline"
            >
              <RotateCcwIcon />
              重启
            </Button>
          ) : null}
          {["pending", "running", "waiting", "suspended", "paused"].includes(run.status) ? (
            <Button
              aria-label="取消 Workflow"
              className="h-6 px-2 text-[10px]"
              onClick={() => onAction(run, "cancel")}
              size="sm"
              title="取消 Workflow"
              variant="ghost"
            >
              <XIcon />
              取消
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
          开始 {workflowTimeLabel(run.startedAt) ?? "未知"}
          {workflowTimeLabel(run.finishedAt ?? run.updatedAt)
            ? ` · 更新 ${workflowTimeLabel(run.finishedAt ?? run.updatedAt)}`
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
                {event.at ? new Date(event.at).toLocaleTimeString() : "步骤"}
              </span>
              <span className="min-w-0 truncate">
                {event.stepId ? `${event.stepId}: ` : ""}
                {event.message || workflowStatusLabel(event.status || event.type)}
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
          <span className="text-sm font-medium">Workflow 运行状态</span>
          <Badge
            className="ml-auto text-[10px]"
            variant={
              badgeRun?.status === "failed" || badgeRun?.status === "tripwire"
                ? "destructive"
                : "secondary"
            }
          >
            {badgeRun ? workflowStatusLabel(badgeRun.status) : "最近运行"}
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
            <DialogTitle>恢复 Workflow</DialogTitle>
            <DialogDescription>
              {resumeDescription || "填写当前挂起步骤需要的 JSON resume data。"}
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
              取消
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
                  setResumeError("Resume data 必须是有效的 JSON。");
                }
              }}
            >
              <PlayIcon />
              继续
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function AgentQueuePanel({
  tasks,
  subagents = [],
  activeTools = [],
  backgroundTasks = [],
  queuedFollowUps = 0,
  onBackgroundAction,
}: {
  tasks: AgentTask[];
  subagents?: AgentSubagentState[];
  activeTools?: AgentToolState[];
  backgroundTasks?: BackgroundTaskState[];
  queuedFollowUps?: number;
  onBackgroundAction?: (
    task: BackgroundTaskState,
    action: BackgroundTaskAction,
    resumeData?: unknown,
  ) => void;
}) {
  const [resumeTask, setResumeTask] = React.useState<BackgroundTaskState | null>(null);
  const [resumeText, setResumeText] = React.useState("{}");
  const [resumeError, setResumeError] = React.useState<string | null>(null);
  if (
    tasks.length === 0 &&
    subagents.length === 0 &&
    activeTools.length === 0 &&
    backgroundTasks.length === 0 &&
    queuedFollowUps === 0
  )
    return null;

  return (
    <>
      {/* 只渲染 QueueSection,与 UserRequestQueuePanel 的排队请求 section 同住
          一张 Queue 卡片(由 chat/panel.tsx 统一包裹),保持两个队列的视觉一体。 */}
      {tasks.length > 0 ? (
        <QueueSection defaultOpen>
          <QueueSectionTrigger className="px-2 py-1">
            <QueueSectionLabel
              count={tasks.length}
              label="任务"
              icon={<SparklesIcon className="size-4" />}
            />
          </QueueSectionTrigger>
          <QueueSectionContent>
            <QueueList className="mt-1">
              {tasks.map((task) => {
                const completed = task.status === "completed";
                return (
                  <QueueItem className="px-2 py-1" key={task.id}>
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
                        {completed ? "已完成" : task.status === "in_progress" ? "进行中" : "待处理"}
                      </span>
                    </div>
                  </QueueItem>
                );
              })}
            </QueueList>
          </QueueSectionContent>
        </QueueSection>
      ) : null}
      {subagents.length > 0 ? (
        <QueueSection defaultOpen>
          <QueueSectionTrigger className="px-2 py-1">
            <QueueSectionLabel
              count={subagents.length}
              label="子代理"
              icon={<SparklesIcon className="size-4" />}
            />
          </QueueSectionTrigger>
          <QueueSectionContent>
            <QueueList className="mt-1">
              {subagents.map((subagent) => (
                <QueueItem className="px-2 py-1" key={`${subagent.agentType}:${subagent.task}`}>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <QueueItemIndicator
                        completed={subagent.status === "completed"}
                        className={
                          subagent.status === "error"
                            ? "border-destructive bg-destructive/10"
                            : undefined
                        }
                      />
                      <QueueItemContent className="line-clamp-2">
                        {subagent.displayName ?? subagent.agentType}: {subagent.task}
                      </QueueItemContent>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {subagent.status === "completed"
                          ? "已完成"
                          : subagent.status === "error"
                            ? "失败"
                            : "进行中"}
                      </span>
                    </div>
                    {subagent.textDelta ? (
                      <p className="mt-1 pl-6 text-xs text-muted-foreground">
                        {subagent.textDelta}
                      </p>
                    ) : null}
                  </div>
                </QueueItem>
              ))}
            </QueueList>
          </QueueSectionContent>
        </QueueSection>
      ) : null}
      {backgroundTasks.length > 0 ? (
        <QueueSection defaultOpen>
          <QueueSectionTrigger className="px-2 py-1">
            <QueueSectionLabel
              count={backgroundTasks.length}
              label="后台任务"
              icon={<RotateCcwIcon className="size-4" />}
            />
          </QueueSectionTrigger>
          <QueueSectionContent>
            <QueueList className="mt-1">
              {backgroundTasks.map((task) => {
                const terminal = ["completed", "failed", "cancelled", "timed_out"].includes(
                  task.status,
                );
                const failed = task.status === "failed" || task.status === "timed_out";
                const outputText = workflowOutputPreview(task.result ?? task.output);
                return (
                  <QueueItem className="px-2 py-1" key={task.id}>
                    <div className="flex min-w-0 items-center gap-2">
                      <QueueItemIndicator
                        completed={task.status === "completed"}
                        className={failed ? "border-destructive bg-destructive/10" : undefined}
                      />
                      <QueueItemContent className="line-clamp-1">{task.toolName}</QueueItemContent>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {task.status === "completed"
                          ? "已完成"
                          : task.status === "timed_out"
                            ? "已超时"
                            : failed
                              ? "失败"
                              : task.status === "suspended"
                                ? "已暂停"
                                : terminal
                                  ? "已取消"
                                  : "运行中"}
                      </span>
                    </div>
                    {task.progress ? (
                      <p className="mt-1 pl-6 text-xs text-muted-foreground">
                        {task.progress.runningCount !== undefined
                          ? `并行任务 ${task.progress.runningCount} 个`
                          : "后台任务正在处理"}
                        {task.progress.elapsedMs !== undefined
                          ? ` · 已运行 ${Math.max(0, Math.round(task.progress.elapsedMs / 1000))} 秒`
                          : ""}
                      </p>
                    ) : null}
                    {task.status === "suspended" && task.suspendPayload !== undefined ? (
                      <p className="mt-1 pl-6 text-xs text-amber-700 dark:text-amber-300">
                        等待外部输入后继续
                      </p>
                    ) : null}
                    {outputText && task.status === "completed" ? (
                      <p
                        className="mt-1 line-clamp-2 pl-6 text-xs text-muted-foreground"
                        title={outputText}
                      >
                        {outputText}
                      </p>
                    ) : null}
                    {onBackgroundAction &&
                    (failed || task.status === "running" || task.status === "suspended") ? (
                      <div className="mt-1 flex justify-end gap-1 pl-6">
                        {failed ? (
                          <Button
                            aria-label="重试后台任务"
                            className="h-6 px-2 text-[10px]"
                            onClick={() => onBackgroundAction(task, "restart")}
                            size="sm"
                            title="重试后台任务"
                            variant="outline"
                          >
                            <RotateCcwIcon />
                            重试
                          </Button>
                        ) : null}
                        {task.status === "suspended" ? (
                          <Button
                            aria-label="恢复后台任务"
                            className="h-6 px-2 text-[10px]"
                            onClick={() => {
                              setResumeError(null);
                              setResumeTask(task);
                              setResumeText("{}");
                            }}
                            size="sm"
                            title="恢复后台任务"
                            variant="outline"
                          >
                            <PlayIcon />
                            恢复
                          </Button>
                        ) : null}
                        {task.status === "running" ? (
                          <Button
                            aria-label="取消后台任务"
                            className="h-6 px-2 text-[10px]"
                            onClick={() => onBackgroundAction(task, "cancel")}
                            size="sm"
                            title="取消后台任务"
                            variant="ghost"
                          >
                            <XIcon />
                            取消
                          </Button>
                        ) : null}
                      </div>
                    ) : null}
                    {task.retryCount !== undefined &&
                    task.maxRetries !== undefined &&
                    task.maxRetries > 0 ? (
                      <p className="mt-1 pl-6 text-[10px] text-muted-foreground">
                        已重试 {task.retryCount}/{task.maxRetries} 次
                        {task.timeoutMs !== undefined
                          ? ` · 超时 ${Math.round(task.timeoutMs / 1000)} 秒`
                          : ""}
                      </p>
                    ) : task.timeoutMs !== undefined ? (
                      <p className="mt-1 pl-6 text-[10px] text-muted-foreground">
                        超时 {Math.round(task.timeoutMs / 1000)} 秒
                      </p>
                    ) : null}
                    {task.error?.message ? (
                      <p className="mt-1 pl-6 text-xs text-destructive">{task.error.message}</p>
                    ) : null}
                  </QueueItem>
                );
              })}
            </QueueList>
          </QueueSectionContent>
        </QueueSection>
      ) : null}
      {activeTools.length > 0 ? (
        <QueueSection defaultOpen>
          <QueueSectionTrigger className="px-2 py-1">
            <QueueSectionLabel
              count={activeTools.length}
              label="工具"
              icon={<SparklesIcon className="size-4" />}
            />
          </QueueSectionTrigger>
          <QueueSectionContent>
            <QueueList className="mt-1">
              {activeTools.map((tool) => (
                <QueueItem className="px-2 py-1" key={tool.toolCallId}>
                  <div className="flex min-w-0 items-center gap-2">
                    <QueueItemIndicator completed={tool.status === "completed"} />
                    <QueueItemContent className="line-clamp-2">{tool.name}</QueueItemContent>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {tool.status === "error"
                        ? "失败"
                        : tool.status === "completed"
                          ? "已完成"
                          : "进行中"}
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
              label="后续消息"
              icon={<SparklesIcon className="size-4" />}
            />
          </QueueSectionTrigger>
        </QueueSection>
      ) : null}
      <Dialog
        open={resumeTask !== null}
        onOpenChange={(open) => {
          if (!open) {
            setResumeTask(null);
            setResumeError(null);
          }
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>恢复后台任务</DialogTitle>
            <DialogDescription>
              {resumeTask?.suspendPayload
                ? "填写工具挂起时要求的 JSON 数据。"
                : "此任务已暂停,如无需额外数据可直接提交空对象。"}
            </DialogDescription>
          </DialogHeader>
          <Textarea
            className="min-h-28 font-mono text-xs"
            onChange={(event) => setResumeText(event.target.value)}
            value={resumeText}
          />
          {resumeError ? <p className="text-xs text-destructive">{resumeError}</p> : null}
          <DialogFooter>
            <Button onClick={() => setResumeTask(null)} variant="ghost">
              取消
            </Button>
            <Button
              onClick={() => {
                if (!resumeTask || !onBackgroundAction) return;
                try {
                  onBackgroundAction(resumeTask, "resume", JSON.parse(resumeText));
                  setResumeTask(null);
                  setResumeError(null);
                } catch {
                  setResumeError("Resume data 必须是有效的 JSON。");
                }
              }}
            >
              <PlayIcon />
              继续
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
  const payload = interaction.suspendPayload ?? {};
  const question = asString(payload.question) ?? "Agent需要你的回答";
  const selectionMode = payload.selectionMode === "multi_select" ? "multi_select" : "single_select";
  const options = Array.isArray(payload.options)
    ? payload.options.flatMap((option) => {
        const record = asRecord(option);
        const label = asString(record?.label);
        return label ? [{ label, description: asString(record?.description) }] : [];
      })
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

  if (completed) {
    const outputRecord = asRecord(interaction.output);
    const answerValue = outputRecord?.answer ?? interaction.output;
    const answers = Array.isArray(answerValue)
      ? answerValue.flatMap((value) => (asString(value) ? [value] : []))
      : asString(answerValue)
        ? [answerValue]
        : [];
    return (
      <div className="rounded-lg border bg-background/60 p-3">
        <div className="mb-3 flex items-center gap-2 text-sm font-medium text-muted-foreground">
          <CircleHelpIcon className="size-4 text-primary" />
          已回答
        </div>
        <Questionnaire items={items}>
          <QuestionnaireProgress />
          <QuestionnaireItem multiple={selectionMode === "multi_select"} name="answer" required>
            <QuestionnaireTitle>{question}</QuestionnaireTitle>
            <QuestionnaireChoices>
              {options.length > 0 ? (
                options.map((option) => (
                  <QuestionnaireChoice
                    defaultChecked={answers.includes(option.label)}
                    disabled
                    key={option.label}
                    value={option.label}
                  >
                    {option.label}
                    {option.description ? (
                      <span className="text-muted-foreground">{option.description}</span>
                    ) : null}
                  </QuestionnaireChoice>
                ))
              ) : (
                <QuestionnaireInput
                  aria-label="已回答内容"
                  defaultValue={formatInteractionValue(answerValue)}
                  disabled
                />
              )}
            </QuestionnaireChoices>
          </QuestionnaireItem>
        </Questionnaire>
      </div>
    );
  }

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const answer =
      selectionMode === "multi_select" ? formData.getAll("answer") : formData.get("answer");
    onResume(answer ?? "");
  };

  return (
    <div className="mb-2 rounded-xl border bg-background p-3 shadow-xs">
      <div className="mb-3 flex items-center gap-2 text-sm font-medium">
        <CircleHelpIcon className="size-4 text-primary" />
        Agent 正在等待你的回答
      </div>
      <Questionnaire
        items={items}
        onSubmit={handleSubmit}
        shortcuts={options.length > 0 ? "letters" : undefined}
      >
        <QuestionnaireProgress />
        <QuestionnaireItem multiple={selectionMode === "multi_select"} name="answer" required>
          <QuestionnaireTitle>{question}</QuestionnaireTitle>
          {options.length > 0 ? (
            <QuestionnaireDescription>
              {selectionMode === "multi_select" ? "可选择多个选项" : "请选择一个选项"}
            </QuestionnaireDescription>
          ) : null}
          <QuestionnaireChoices>
            {options.map((option) => (
              <QuestionnaireChoice key={option.label} value={option.label}>
                {option.label}
                {option.description ? (
                  <span className="text-muted-foreground">{option.description}</span>
                ) : null}
              </QuestionnaireChoice>
            ))}
            {options.length === 0 ? (
              <QuestionnaireInput aria-label="回答 Agent 的问题" placeholder="输入你的回答..." />
            ) : null}
          </QuestionnaireChoices>
          <QuestionnaireError />
        </QuestionnaireItem>
        <QuestionnaireActions>
          <Button
            className="col-start-2 row-start-1 min-h-11 sm:min-h-0"
            disabled={busy}
            onClick={() => onResume("")}
            size="default"
            type="button"
            variant="outline"
          >
            取消
          </Button>
          <QuestionnaireSubmit disabled={busy}>
            {busy ? "正在提交..." : "提交回答"}
          </QuestionnaireSubmit>
        </QuestionnaireActions>
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
  const [feedback, setFeedback] = React.useState("");
  const payload = interaction.suspendPayload ?? {};
  const draft = interaction.plan;
  const title = draft?.title ?? asString(payload.title) ?? "实施计划";
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
            <PlanDescription>计划已完成审批并回显在历史消息中。</PlanDescription>
          </div>
          <PlanTrigger />
        </PlanHeader>
        <PlanContent className="pt-0">
          <ScrollArea className="max-h-72 rounded-md border bg-muted/20 p-3">
            {plan ? (
              <MessageResponse>{plan}</MessageResponse>
            ) : (
              <p className="text-sm text-muted-foreground">计划文件: {path ?? "未知"}</p>
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
          <PlanDescription>Agent 已提交一份实施计划,批准后才会继续执行。</PlanDescription>
        </div>
        <PlanTrigger />
      </PlanHeader>
      <PlanContent className="space-y-3 pt-0">
        <ScrollArea className="max-h-72 rounded-md border bg-muted/20 p-3">
          {plan ? (
            <MessageResponse>{plan}</MessageResponse>
          ) : (
            <p className="text-sm text-muted-foreground">
              计划内容暂未随历史消息加载,文件路径: {path ?? "未知"}
            </p>
          )}
        </ScrollArea>
        <Textarea
          aria-label="计划反馈"
          disabled={busy}
          onChange={(event) => setFeedback(event.target.value)}
          placeholder="拒绝时可填写修改意见(可选)..."
          value={feedback}
        />
      </PlanContent>
      <PlanFooter className="justify-end gap-2">
        <PlanAction>
          <Button disabled={busy} onClick={() => resume("rejected")} size="sm" variant="outline">
            拒绝并修改
          </Button>
        </PlanAction>
        <PlanAction>
          <Button disabled={busy} onClick={() => resume("approved")} size="sm">
            批准执行
          </Button>
        </PlanAction>
      </PlanFooter>
    </Plan>
  );
}

export function formatInteractionValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "未提供回答";
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

/**
 * 审批面板里的工具显示名。工作区工具统一去掉 mastra_workspace_ 前缀
 * (官方常量表就是这个前缀,见 workspace-class.mdx 的工具清单),
 * 因此这里不需要再抄一份工具名单 —— 只给少数自定义工具起中文名。
 */
const APPROVAL_TOOL_LABELS: Record<string, string> = {
  execute_typescript: "执行多工具编排",
};

function approvalToolLabel(toolName: string): string {
  return APPROVAL_TOOL_LABELS[toolName] ?? toolName.replace(/^mastra_workspace_/, "");
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
  const [reason, setReason] = React.useState("");
  const label = approvalToolLabel(interaction.toolName);
  const category = interaction.category;

  return (
    <div className="mb-2 rounded-xl border border-amber-500/40 bg-background p-3 shadow-xs">
      <div className="flex items-start gap-2">
        <ShieldAlertIcon className="mt-0.5 size-4 shrink-0 text-amber-600" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-medium">工具“{label}”等待批准</p>
            {category ? (
              <Badge className="text-[10px]" variant="outline">
                {CATEGORY_META[category].label}
              </Badge>
            ) : null}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">确认后 Agent 才会继续这次操作。</p>
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
            aria-label="拒绝理由"
            className="mt-2 min-h-16"
            disabled={busy}
            onChange={(event) => setReason(event.target.value)}
            placeholder="拒绝时可说明原因,模型会据此调整做法(可选)..."
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
              拒绝
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
                始终允许「{CATEGORY_META[category].label}」
              </Button>
            ) : null}
            <Button
              disabled={busy}
              onClick={() => onResume({ approved: true })}
              size="sm"
              type="button"
            >
              批准执行
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function AgentInteractionPanel({
  interactions,
  busy,
  onResume,
  onAlwaysAllow,
  messages,
}: {
  interactions: AgentInteraction[];
  busy: boolean;
  onResume: (interaction: AgentInteraction, resumeData: unknown) => void;
  onAlwaysAllow?: (category: ToolCategory) => Promise<void> | void;
  messages: UIMessage[];
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
