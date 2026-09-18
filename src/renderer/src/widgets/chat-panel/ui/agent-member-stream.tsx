import { AlertCircleIcon, CheckCircle2Icon, CircleIcon, XIcon } from "lucide-react";
import type { AgentProfile } from "@/entities/workbench";
import { useTranslation } from "@/shared/i18n";
import { cn } from "@/shared/lib";
import { MessageResponse } from "@/shared/ui/ai-elements/message";
import { Avatar, AvatarBadge, AvatarFallback, AvatarGroup } from "@/shared/ui/avatar";
import { Bubble, BubbleContent } from "@/shared/ui/bubble";
import { Button } from "@/shared/ui/button";
import { DotmCircular5 } from "@/shared/ui/dotm-circular-5";
import { Message, MessageAvatar, MessageContent, MessageHeader } from "@/shared/ui/message";
import { MessageScrollerItem } from "@/shared/ui/message-scroller";
import type {
  AgentSubagentState,
  BackgroundTaskState,
  WorkflowRuntimeState,
  WorkUIMessage,
} from "../model/types";
import { AssistantAvatar } from "./avatars";

export type AgentMemberRuntimeStatus = "idle" | "running" | "completed" | "error";

export interface AgentMemberRuntime {
  status: AgentMemberRuntimeStatus;
  entries: Array<{
    id: string;
    label: string;
    text?: string;
    status: AgentMemberRuntimeStatus;
  }>;
}

function memberSearchText(member: AgentProfile["members"][number]): string {
  return `${member.id} ${member.name} ${member.profession}`.toLocaleLowerCase();
}

function subagentMatchesMember(
  subagent: AgentSubagentState,
  member: AgentProfile["members"][number],
): boolean {
  const haystack = `${subagent.agentType} ${subagent.displayName ?? ""}`.toLocaleLowerCase();
  return memberSearchText(member)
    .split(/\s+/)
    .filter((value) => value.length > 1)
    .some((value) => haystack.includes(value));
}

function backgroundTaskMatchesMember(
  task: BackgroundTaskState,
  member: AgentProfile["members"][number],
): boolean {
  const haystack = `${task.agentId} ${task.toolName}`.toLocaleLowerCase();
  return memberSearchText(member)
    .split(/\s+/)
    .filter((value) => value.length > 1)
    .some((value) => haystack.includes(value));
}

function workflowStepMatchesMember(
  stepId: string,
  member: AgentProfile["members"][number],
  profile: AgentProfile,
): boolean {
  return (profile.workflow?.steps ?? []).some(
    (step) =>
      step.memberId === member.id &&
      (step.id === stepId || stepId.startsWith(`${step.id}-`) || stepId.startsWith(`${step.id}[`)),
  );
}

function workflowText(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["text", "result", "output", "message", "content"]) {
    const text = workflowText(record[key]);
    if (text) return text;
  }
  return undefined;
}

function mergeStatus(
  current: AgentMemberRuntimeStatus,
  next: AgentMemberRuntimeStatus,
): AgentMemberRuntimeStatus {
  if (next === "error" || current === "error") return "error";
  if (next === "running" || current === "running") return "running";
  if (next === "completed" || current === "completed") return "completed";
  return "idle";
}

export function getAgentMemberRuntimes(
  profile: AgentProfile,
  subagents: AgentSubagentState[],
  workflow: WorkflowRuntimeState | null,
  backgroundTasks: BackgroundTaskState[] = [],
): Record<string, AgentMemberRuntime> {
  const runtimes = Object.fromEntries(
    profile.members.map((member) => [member.id, { status: "idle", entries: [] }]),
  ) as Record<string, AgentMemberRuntime>;

  for (const member of profile.members) {
    const runtime = runtimes[member.id];
    for (const subagent of subagents) {
      if (!subagentMatchesMember(subagent, member)) continue;
      const status: AgentMemberRuntimeStatus =
        subagent.status === "error"
          ? "error"
          : subagent.status === "completed"
            ? "completed"
            : "running";
      runtime.status = mergeStatus(runtime.status, status);
      runtime.entries.push({
        id: `subagent-${subagent.agentType}`,
        label: subagent.task,
        text: subagent.textDelta,
        status,
      });
    }
  }

  for (const member of profile.members) {
    const runtime = runtimes[member.id];
    for (const task of backgroundTasks) {
      if (!backgroundTaskMatchesMember(task, member)) continue;
      const status: AgentMemberRuntimeStatus =
        task.status === "failed" || task.status === "timed_out"
          ? "error"
          : task.status === "completed" || task.status === "cancelled"
            ? "completed"
            : "running";
      runtime.status = mergeStatus(runtime.status, status);
      runtime.entries.push({
        id: `background-${task.id}`,
        label: task.toolName,
        text: workflowText(task.result ?? task.output),
        status,
      });
    }
  }

  for (const run of workflow?.runs ?? []) {
    for (const step of run.steps) {
      const member = profile.members.find((candidate) =>
        workflowStepMatchesMember(step.id, candidate, profile),
      );
      if (!member) continue;
      const runtime = runtimes[member.id];
      const status: AgentMemberRuntimeStatus =
        step.status === "failed"
          ? "error"
          : step.status === "success" || step.status === "skipped"
            ? "completed"
            : "running";
      runtime.status = mergeStatus(runtime.status, status);
      runtime.entries.push({
        id: `${run.runId}:${step.id}`,
        label: step.label || step.id,
        text: workflowText(step.output) ?? workflowText(step.error),
        status,
      });
    }
  }

  return runtimes;
}

function statusIcon(status: AgentMemberRuntimeStatus, className = "size-3.5") {
  // 新星点阵 = 该成员正在流式产出,在多成员并行时比一排相同转圈更容易分辨
  if (status === "running") {
    return <DotmCircular5 size={14} dotSize={1.6} colorPreset="solid-theme" />;
  }
  if (status === "completed") return <CheckCircle2Icon className={className} />;
  if (status === "error") return <AlertCircleIcon className={className} />;
  return <CircleIcon className={className} />;
}

function statusLabel(
  status: AgentMemberRuntimeStatus,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  return status === "running"
    ? t("chat:memberStream.streaming")
    : status === "completed"
      ? t("chat:memberStream.completed")
      : status === "error"
        ? t("chat:memberStream.failed")
        : t("chat:memberStream.waitingSchedule");
}

function memberInitials(name: string): string {
  const chars = [...name.trim()];
  return chars.length <= 2 ? chars.join("") || "A" : `${chars[0]}${chars.at(-1)}`;
}

function memberStatusClass(status: AgentMemberRuntimeStatus): string {
  return status === "running"
    ? "bg-primary text-primary-foreground"
    : status === "completed"
      ? "bg-emerald-600 text-white"
      : status === "error"
        ? "bg-destructive text-destructive-foreground"
        : "bg-muted text-muted-foreground";
}

export function AgentMemberSwitcher({
  members,
  activeMemberId,
  runtimes,
  onSelect,
  onClose,
}: {
  members: AgentProfile["members"];
  activeMemberId: string | null;
  runtimes: Record<string, AgentMemberRuntime>;
  onSelect: (memberId: string) => void;
  onClose?: () => void;
}) {
  const { t } = useTranslation();
  if (members.length < 2) return null;
  return (
    <div
      aria-label={t("chat:memberStream.threadMembersTab")}
      className="flex min-w-0 items-center gap-2 overflow-x-auto px-1 py-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      role="tablist"
    >
      <AvatarGroup className="shrink-0 pl-1">
        {members.map((member) => {
          const runtime = runtimes[member.id] ?? { status: "idle", entries: [] };
          const active = member.id === activeMemberId;
          return (
            <button
              aria-label={member.name}
              aria-selected={active}
              className="group relative size-8 shrink-0 rounded-full p-0 transition-transform hover:z-10 hover:scale-105"
              key={member.id}
              onClick={() => onSelect(member.id)}
              role="tab"
              title={`${member.name} · ${member.profession || t("chat:memberStream.teamMember")}`}
              type="button"
            >
              <Avatar
                className={cn("size-8", active && "z-10 ring-2 ring-inset ring-primary")}
                size="sm"
              >
                <AvatarFallback className={active ? "bg-primary/15 text-primary" : undefined}>
                  {memberInitials(member.name)}
                </AvatarFallback>
                <AvatarBadge className={memberStatusClass(runtime.status)}>
                  {statusIcon(runtime.status, "size-2")}
                </AvatarBadge>
              </Avatar>
            </button>
          );
        })}
      </AvatarGroup>
      {activeMemberId ? (
        <span className="min-w-0 truncate text-xs text-muted-foreground">
          {members.find((member) => member.id === activeMemberId)?.name}
        </span>
      ) : null}
      {onClose ? (
        <Button
          aria-label={t("common:close")}
          className="ml-auto size-7 shrink-0 text-muted-foreground"
          onClick={onClose}
          size="icon"
          title={t("common:close")}
          type="button"
          variant="ghost"
        >
          <XIcon className="size-4" />
        </Button>
      ) : null}
    </div>
  );
}

export function AgentMemberMessageView({
  member,
  runtime,
  messages,
  isBusy,
}: {
  member: AgentProfile["members"][number];
  runtime: AgentMemberRuntime;
  messages: WorkUIMessage[];
  isBusy: boolean;
}) {
  const { t } = useTranslation();
  const latestRequest = messages
    .filter((message) => message.role === "user")
    .flatMap((message) =>
      message.parts
        .map((part) => (part.type === "text" ? { id: message.id, text: part.text.trim() } : null))
        .filter((item): item is { id: string; text: string } => Boolean(item?.text)),
    )
    .at(-1);
  const latestEntry = runtime.entries.at(-1);
  return (
    <MessageScrollerItem messageId={latestRequest?.id} scrollAnchor={Boolean(latestRequest)}>
      <div className="flex w-full flex-col gap-4 py-6" data-agent-member-view>
        {latestRequest ? (
          <Message align="end" key={latestRequest.id}>
            <MessageAvatar className="self-start">
              <AssistantAvatar />
            </MessageAvatar>
            <MessageContent className="max-w-[85%]">
              <MessageHeader className="justify-end px-0">MastraWork</MessageHeader>
              <Bubble align="end">
                <BubbleContent className="text-sm">{latestRequest.text}</BubbleContent>
              </Bubble>
            </MessageContent>
          </Message>
        ) : null}

        {latestEntry ? (
          <Message key={latestEntry.id}>
            <MessageAvatar className="self-start">
              <Avatar size="sm">
                <AvatarFallback className="bg-primary/15 text-primary">
                  {memberInitials(member.name)}
                </AvatarFallback>
              </Avatar>
            </MessageAvatar>
            <MessageContent>
              <MessageHeader className="px-0">
                {member.name} · {latestEntry.label}
              </MessageHeader>
              <Bubble variant="ghost">
                <BubbleContent>
                  {latestEntry.text ? (
                    <MessageResponse>{latestEntry.text}</MessageResponse>
                  ) : (
                    <span className="flex items-center gap-2 text-muted-foreground">
                      {statusIcon(latestEntry.status)}
                      {latestEntry.status === "running"
                        ? t("chat:memberStream.streamingWithEllipsis")
                        : statusLabel(latestEntry.status, t)}
                    </span>
                  )}
                </BubbleContent>
              </Bubble>
            </MessageContent>
          </Message>
        ) : null}

        {isBusy && runtime.status === "running" ? (
          <div className="flex items-center gap-2 pl-11 text-xs text-muted-foreground">
            <DotmCircular5 size={14} dotSize={1.6} colorPreset="solid-theme" />
            {t("chat:memberStream.memberStreaming", { name: member.name })}
          </div>
        ) : null}
      </div>
    </MessageScrollerItem>
  );
}
