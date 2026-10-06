import { useQuery } from "@tanstack/react-query";
import { isToolUIPart } from "ai";
import { AlertCircleIcon, CheckCircle2Icon, CircleIcon, XIcon } from "lucide-react";
import { useState } from "react";
import type { AgentProfile } from "@/entities/workbench";
import { useAuth } from "@/features/auth";
import { requestJson } from "@/shared/api/client";
import { useTranslation } from "@/shared/i18n";
import { cn } from "@/shared/lib";
import { MessageResponse } from "@/shared/ui/ai-elements/message";
import { AvatarBadge, AvatarGroup, GeneratedAvatar } from "@/shared/ui/avatar";
import { Button } from "@/shared/ui/button";
import { DotmCircular5 } from "@/shared/ui/dotm-circular-5";
import { ScrollArea } from "@/shared/ui/scroll-area";
import type { TeamInvocation } from "../../../../../shared/agent-contract";
import type { TracePart, WorkUIMessage } from "../model/types";
import { AssistantTrace } from "./assistant-trace";

export type AgentMemberRuntimeStatus = "idle" | "running" | "suspended" | "completed" | "error";

export interface AgentMemberRuntime {
  status: AgentMemberRuntimeStatus;
  entries: Array<{
    id: string;
    label: string;
    text?: string;
    status: AgentMemberRuntimeStatus;
    invocation?: TeamInvocation;
  }>;
}

export function getAgentMemberRuntimes(
  profile: AgentProfile,

  invocations: TeamInvocation[] = [],
): Record<string, AgentMemberRuntime> {
  return Object.fromEntries(
    profile.members.map((member) => {
      const entries: AgentMemberRuntime["entries"] = invocations
        .filter(
          (call) =>
            call.profileId === profile.id &&
            call.memberId === (profile.workflow ? member.id : member.id.replace(/^runtime-/, "")),
        )
        .map((call) => ({
          id: call.id,
          label: call.prompt,
          text: call.text ?? call.error,
          status: call.status,
          invocation: call,
        }));
      const status = entries.some((entry) => entry.status === "running")
        ? "running"
        : (entries.at(-1)?.status ?? "idle");
      return [member.id, { status, entries }];
    }),
  );
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
    : status === "suspended"
      ? t("chat:panels.workflowStatus.suspended")
      : status === "completed"
        ? t("chat:memberStream.completed")
        : status === "error"
          ? t("chat:memberStream.failed")
          : t("chat:memberStream.waitingSchedule");
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
  if (!members.length) return null;
  return (
    <ScrollArea className="max-h-24">
      <div
        aria-label={t("chat:memberStream.threadMembersTab")}
        className="flex min-w-0 flex-wrap items-center gap-2 px-1 py-1"
        role="group"
      >
        <AvatarGroup className="min-w-0 flex-wrap gap-y-2 pl-1">
          {members.map((member) => {
            const runtime = runtimes[member.id] ?? { status: "idle", entries: [] };
            const active = member.id === activeMemberId;
            return (
              <button
                aria-label={member.name}
                aria-pressed={active}
                className="group relative size-8 shrink-0 rounded-full p-0 transition-transform hover:z-10 hover:scale-105"
                key={member.id}
                onClick={() => onSelect(member.id)}
                title={`${member.name} · ${member.profession || t("chat:memberStream.teamMember")}`}
                type="button"
              >
                <GeneratedAvatar
                  seed={member.id}
                  name={member.name}
                  src={member.avatar}
                  className={cn("size-8", active && "z-10 ring-2 ring-inset ring-primary")}
                  size="sm"
                >
                  <AvatarBadge className={memberStatusClass(runtime.status)}>
                    {statusIcon(runtime.status, "size-2")}
                  </AvatarBadge>
                </GeneratedAvatar>
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
    </ScrollArea>
  );
}

export function AgentMemberMessageView({
  member,
  runtime,
  threadId,
}: {
  member: AgentProfile["members"][number];
  runtime: AgentMemberRuntime;
  threadId: string | null;
}) {
  const { t } = useTranslation();
  return (
    <div className="grid min-w-0 gap-3 py-2" data-agent-member-view>
      <p className="break-words text-sm font-medium">
        {member.name} · {member.profession}
      </p>
      {runtime.entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("chat:memberStream.waitingSchedule")}</p>
      ) : null}
      {runtime.entries.map((entry) => (
        <div key={entry.id} className="grid min-w-0 gap-2 rounded-lg border p-3">
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            {statusIcon(entry.status)}
            <span>{statusLabel(entry.status, t)}</span>
            {entry.invocation ? (
              <time>{new Date(entry.invocation.startedAt).toLocaleString()}</time>
            ) : null}
          </div>
          <p className="whitespace-pre-wrap break-words text-sm">{entry.label}</p>
          {entry.text ? <MessageResponse>{entry.text}</MessageResponse> : null}
          {entry.invocation?.error ? (
            <p className="whitespace-pre-wrap break-words text-xs text-destructive">
              {entry.invocation.error}
            </p>
          ) : null}
          {entry.invocation && threadId ? (
            <InvocationTranscript threadId={threadId} invocation={entry.invocation} />
          ) : null}
        </div>
      ))}
    </div>
  );
}

function InvocationTranscript({
  threadId,
  invocation,
}: {
  threadId: string;
  invocation: TeamInvocation;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const { user } = useAuth();
  const detail = useQuery({
    queryKey: ["team-invocation", user?.id, threadId, invocation.id, invocation.status],
    queryFn: ({ signal }) =>
      requestJson<{ messages: WorkUIMessage[]; tools: unknown[] }>(
        `/work/sessions/workbench/threads/${encodeURIComponent(threadId)}/invocations/${encodeURIComponent(invocation.id)}`,
        { signal },
      ),
    enabled: open,
    refetchInterval: open && invocation.status === "running" ? 1500 : false,
    staleTime: invocation.status === "running" || invocation.status === "suspended" ? 0 : Infinity,
  });
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer text-xs text-muted-foreground">
        {t("agentHub:invocationDetails")}
      </summary>
      <ScrollArea className="max-h-96">
        <div className="grid min-w-0 gap-2 pt-2">
          {detail.isPending ? <p>{t("common:loading")}</p> : null}
          {detail.error ? (
            <p className="break-words text-destructive">{detail.error.message}</p>
          ) : null}
          {detail.data?.messages.map((message) => (
            <div className="min-w-0" key={message.id}>
              <span className="text-xs text-muted-foreground">{message.role}</span>
              <AssistantTrace
                parts={message.parts.filter(
                  (part): part is TracePart => part.type === "reasoning" || isToolUIPart(part),
                )}
                isStreaming={false}
              />
              {message.parts.map((part, index) =>
                part.type === "text" ? (
                  <MessageResponse key={index}>{part.text}</MessageResponse>
                ) : null,
              )}
            </div>
          ))}
          {detail.data?.tools.length ? (
            <details>
              <summary className="cursor-pointer text-xs">{t("agentHub:toolPayloads")}</summary>
              <pre className="whitespace-pre-wrap break-all text-xs">
                {JSON.stringify(detail.data.tools, null, 2)}
              </pre>
            </details>
          ) : null}
        </div>
      </ScrollArea>
    </details>
  );
}
