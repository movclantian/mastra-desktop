import { useQuery } from "@tanstack/react-query";
import { CircleHelpIcon, FileCheck2Icon, ShieldAlertIcon, SparklesIcon, XIcon } from "lucide-react";
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
} from "@/shared/ui/ai-elements/plan";
import {
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
  CodeBlock,
  CodeBlockActions,
  CodeBlockContent,
  CodeBlockCopyButton,
  CodeBlockHeader,
  CodeBlockTitle,
} from "@/shared/ui/code-block";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/shared/ui/item";
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
import { TraceDescription, TraceIcon, TraceLine } from "@/shared/ui/trace";
import {
  type AgentInteraction,
  type AgentTask,
  asRecord,
  asString,
  normalizeAgentTasks,
} from "../model/types";

export function AgentQueuePanel({
  tasks,
  isStreaming,
  onClose,
}: {
  tasks: AgentTask[];
  isStreaming: boolean;
  onClose?: () => void;
}) {
  const { t } = useTranslation();
  const visibleTasks = React.useMemo(() => normalizeAgentTasks(tasks), [tasks]);
  const sections = [
    { completed: false, tasks: visibleTasks.filter((task) => task.status !== "completed") },
    { completed: true, tasks: visibleTasks.filter((task) => task.status === "completed") },
  ];
  return sections.map((section) =>
    section.tasks.length ? (
      <QueueSection key={String(section.completed)} defaultOpen={!section.completed}>
        <QueueSectionTrigger
          action={
            section.completed && !sections[0].tasks.length && onClose ? (
              <Button
                aria-label={t("common:close")}
                onClick={onClose}
                size="icon-xs"
                variant="ghost"
              >
                <XIcon />
              </Button>
            ) : null
          }
        >
          <QueueSectionLabel
            count={section.tasks.length}
            label={t(section.completed ? "chat:panels.completed" : "chat:panels.pending")}
            icon={<SparklesIcon />}
          />
        </QueueSectionTrigger>
        <QueueSectionContent>
          <QueueList>
            {section.tasks.map((task) => (
              <TraceLine
                key={task.id}
                className="w-full items-start"
                status={isStreaming && task.status === "in_progress" ? "running" : undefined}
              >
                <QueueItemIndicator
                  completed={section.completed}
                  inProgress={task.status === "in_progress"}
                />
                <QueueItemContent completed={section.completed}>{task.content}</QueueItemContent>
                {task.status === "in_progress" ? (
                  <TraceDescription className="text-xs">
                    {t("chat:panels.inProgress")}
                  </TraceDescription>
                ) : null}
              </TraceLine>
            ))}
          </QueueList>
        </QueueSectionContent>
      </QueueSection>
    ) : null,
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
          <TraceIcon>
            <FileCheck2Icon />
          </TraceIcon>
          <PlanTitle>{title}</PlanTitle>
          <PlanDescription className="w-full">
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
        <TraceIcon>
          <FileCheck2Icon />
        </TraceIcon>
        <PlanTitle>{title}</PlanTitle>
        <PlanDescription className="w-full">{t("chat:panels.planSubmittedDesc")}</PlanDescription>
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
    <Item variant="outline" size="sm" className="mb-2 min-w-0">
      <ItemMedia variant="icon">
        <ShieldAlertIcon />
      </ItemMedia>
      <ItemContent className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <ItemTitle className="line-clamp-none break-words">
            {t("chat:panels.toolWaitingApproval", { label })}
          </ItemTitle>
          {category ? (
            <Badge className="text-[10px]" variant="outline">
              {CATEGORY_META[category].label}
            </Badge>
          ) : null}
        </div>
        <ItemDescription className="line-clamp-none">
          {t("chat:panels.confirmBeforeContinue")}
        </ItemDescription>
        {interaction.args !== undefined ? (
          <CodeBlock size="sm">
            {/* 官方 CodeBlock 标题栏:标注这是哪个工具的参数,避免裸 JSON 失去归属 */}
            <CodeBlockHeader>
              <CodeBlockTitle>{t("chat:panels.toolArguments", { label })}</CodeBlockTitle>
              <CodeBlockActions>
                <CodeBlockCopyButton value={JSON.stringify(interaction.args, null, 2)} />
              </CodeBlockActions>
            </CodeBlockHeader>
            <CodeBlockContent wrap className="max-h-32">
              {JSON.stringify(interaction.args, null, 2)}
            </CodeBlockContent>
          </CodeBlock>
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
      </ItemContent>
      <ItemActions className="w-full flex-wrap justify-end">
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
        <Button
          size="sm"
          disabled={busy}
          onClick={() => onResume({ approved: true })}
          type="button"
        >
          {t("chat:panels.approveExecution")}
        </Button>
      </ItemActions>
    </Item>
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
