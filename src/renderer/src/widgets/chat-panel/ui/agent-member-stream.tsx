import { AlertCircleIcon, CheckCircle2Icon, CheckIcon, CircleIcon } from "lucide-react";
import type { AgentProfile } from "@/entities/workbench";
import { cn } from "@/shared/lib";
import { MessageResponse } from "@/shared/ui/ai-elements/message";
import { Avatar, AvatarBadge, AvatarFallback } from "@/shared/ui/avatar";
import { Badge } from "@/shared/ui/badge";
import { DotmCircular5 } from "@/shared/ui/dotm-circular-5";
import { Message, MessageAvatar, MessageContent, MessageHeader } from "@/shared/ui/message";
import type {
  AgentSubagentState,
  BackgroundTaskState,
  WorkflowRuntimeState,
  WorkUIMessage,
} from "../model/types";

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

function statusLabel(status: AgentMemberRuntimeStatus): string {
  return status === "running"
    ? "流式输出"
    : status === "completed"
      ? "已完成"
      : status === "error"
        ? "失败"
        : "等待调度";
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
}: {
  members: AgentProfile["members"];
  activeMemberId: string | null;
  runtimes: Record<string, AgentMemberRuntime>;
  onSelect: (memberId: string) => void;
}) {
  if (members.length < 2) return null;
  return (
    <div
      aria-label="当前线程 Agent 成员"
      className="flex min-w-0 items-center gap-1 overflow-x-auto px-1 py-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      role="tablist"
    >
      {members.map((member) => {
        const runtime = runtimes[member.id] ?? { status: "idle", entries: [] };
        const active = member.id === activeMemberId;
        return (
          <button
            aria-selected={active}
            className={cn(
              "group flex h-12 min-w-0 shrink-0 items-center gap-2 rounded-full border px-2.5 pr-3 text-left transition-colors",
              "max-sm:px-1.5 max-sm:pr-1.5",
              active
                ? "border-primary/70 bg-background shadow-sm"
                : "border-transparent bg-muted/65 hover:border-border hover:bg-muted",
            )}
            key={member.id}
            onClick={() => onSelect(member.id)}
            role="tab"
            title={`${member.name} · ${member.profession || "团队成员"}`}
            type="button"
          >
            <Avatar className="size-9 max-sm:size-8" size="sm">
              <AvatarFallback className={active ? "bg-primary/15 text-primary" : undefined}>
                {memberInitials(member.name)}
              </AvatarFallback>
              <AvatarBadge className={memberStatusClass(runtime.status)}>
                {statusIcon(runtime.status, "size-2.5")}
              </AvatarBadge>
            </Avatar>
            <span className="hidden min-w-0 max-w-36 flex-col sm:flex">
              <span className="truncate text-sm font-semibold">{member.name}</span>
              <span className="truncate text-[11px] text-muted-foreground">
                {member.profession || "团队成员"}
              </span>
            </span>
            {active ? <CheckIcon className="size-4 shrink-0 text-primary max-sm:hidden" /> : null}
          </button>
        );
      })}
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
  const requests = messages
    .filter((message) => message.role === "user")
    .flatMap((message) =>
      message.parts
        .map((part) => (part.type === "text" ? { id: message.id, text: part.text.trim() } : null))
        .filter((item): item is { id: string; text: string } => Boolean(item?.text)),
    )
    .slice(-6);
  const entries = runtime.entries.slice(-8);
  const latestRequest = requests.at(-1);
  return (
    <div className="flex w-full flex-col gap-4 py-6" data-agent-member-view>
      <div className="flex items-center gap-3 border-b pb-3">
        <Avatar size="default">
          <AvatarFallback className="bg-primary/15 text-primary">
            {memberInitials(member.name)}
          </AvatarFallback>
          <AvatarBadge className={memberStatusClass(runtime.status)}>
            {statusIcon(runtime.status, "size-2.5")}
          </AvatarBadge>
        </Avatar>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{member.name}</p>
          <p className="truncate text-xs text-muted-foreground">
            {member.profession || "团队成员"}
          </p>
        </div>
        <Badge
          className="shrink-0 gap-1 text-[10px]"
          variant={runtime.status === "error" ? "destructive" : "secondary"}
        >
          {statusIcon(runtime.status, "size-3")}
          {statusLabel(runtime.status)}
        </Badge>
      </div>

      {requests.map((request) => (
        <Message align="end" key={request.id}>
          <MessageContent className="max-w-[85%]">
            <MessageHeader className="justify-end px-0">当前请求</MessageHeader>
            <div className="rounded-2xl bg-primary px-3 py-2 text-sm text-primary-foreground">
              {request.text}
            </div>
          </MessageContent>
        </Message>
      ))}

      {entries.map((entry) => (
        <Message key={entry.id}>
          <MessageAvatar className="self-start">
            <Avatar size="sm">
              <AvatarFallback className="bg-primary/15 text-primary">
                {memberInitials(member.name)}
              </AvatarFallback>
            </Avatar>
          </MessageAvatar>
          <MessageContent>
            <MessageHeader className="px-0">
              {member.name} · {entry.label}
            </MessageHeader>
            <div className="rounded-2xl border bg-background px-3 py-2 text-sm">
              {entry.text ? (
                <MessageResponse>{entry.text}</MessageResponse>
              ) : (
                <span className="flex items-center gap-2 text-muted-foreground">
                  {statusIcon(entry.status)}
                  {entry.status === "running" ? "正在流式输出…" : statusLabel(entry.status)}
                </span>
              )}
            </div>
          </MessageContent>
        </Message>
      ))}

      {entries.length === 0 ? (
        <Message>
          <MessageAvatar className="self-start">
            <Avatar size="sm">
              <AvatarFallback className="bg-primary/15 text-primary">
                {memberInitials(member.name)}
              </AvatarFallback>
            </Avatar>
          </MessageAvatar>
          <MessageContent>
            <MessageHeader className="px-0">{member.name}</MessageHeader>
            <div className="rounded-2xl border bg-background px-3 py-2 text-sm text-muted-foreground">
              {isBusy && latestRequest ? "等待该成员接收任务…" : "该成员尚未产生输出"}
            </div>
          </MessageContent>
        </Message>
      ) : null}

      {isBusy && runtime.status === "running" ? (
        <div className="flex items-center gap-2 pl-11 text-xs text-muted-foreground">
          <DotmCircular5 size={14} dotSize={1.6} colorPreset="solid-theme" />
          {member.name} 正在流式输出
        </div>
      ) : null}
    </div>
  );
}
