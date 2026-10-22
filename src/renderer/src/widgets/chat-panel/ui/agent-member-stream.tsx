import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { getToolName, isToolUIPart } from "ai";
import { AlertCircleIcon, CheckCircle2Icon, CircleIcon, XIcon } from "lucide-react";
import type { AgentProfile } from "@/entities/workbench";
import { useDesktopSettingsQuery } from "@/entities/workbench/model/queries/config";
import { useAuth } from "@/features/auth";
import { requestJson } from "@/shared/api/client";
import { useTranslation } from "@/shared/i18n";
import { cn } from "@/shared/lib";
import { AvatarBadge, AvatarGroup, GeneratedAvatar } from "@/shared/ui/avatar";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { CodeBlock, CodeBlockContent } from "@/shared/ui/code-block";
import { DotmCircular5 } from "@/shared/ui/dotm-circular-5";
import { ScrollArea } from "@/shared/ui/scroll-area";
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "@/shared/ui/trace";
import type { TeamInvocation } from "../../../../../shared/agent-contract";
import { buildDisplayMessages } from "../lib/display";
import type { WorkUIMessage } from "../model/types";
import { useTraceDisclosure } from "./assistant-trace";
import { MessageItem } from "./message-list";

/** 只读子流不提供编辑/重试:用模块级常量,避免内联箭头击穿 MessageItem 的 memo。 */
const noopMessageAction = () => undefined;

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
  profile,
  busy,
  activeMemberId,
  runtimes,
  onSelect,
  onClose,
}: {
  profile: AgentProfile;
  busy: boolean;
  activeMemberId: string | null;
  runtimes: Record<string, AgentMemberRuntime>;
  onSelect: (memberId: string) => void;
  onClose?: () => void;
}) {
  const { t } = useTranslation();
  const { members } = profile;
  if (!members.length) return null;
  const mainAgent = profile.members.find((member) => member.id === profile.id);
  const orderedMembers = mainAgent
    ? [mainAgent, ...members.filter((member) => member.id !== mainAgent.id)]
    : members;
  return (
    <ScrollArea className="max-h-20">
      <div
        aria-label={t("chat:memberStream.threadMembersTab")}
        className="flex min-w-0 flex-wrap items-center gap-2 p-3"
        role="group"
      >
        <AvatarGroup className="min-w-0 flex-wrap gap-y-2 pl-1">
          {orderedMembers.map((member) => {
            const runtime = runtimes[member.id] ?? { status: "idle", entries: [] };
            const active = member.id === (activeMemberId ?? profile.id);
            const memberId =
              member.id === profile.id
                ? undefined
                : profile.workflow
                  ? member.id
                  : member.id.replace(/^runtime-/, "");
            const working = memberId ? runtime.status === "running" : busy;
            const status = memberId ? runtime.status : busy ? "running" : "idle";
            return (
              <Button
                variant="ghost"
                size="xs"
                aria-label={member.name}
                aria-pressed={active}
                className="group relative size-8 shrink-0 rounded-full p-0 transition-transform hover:z-10 hover:scale-105"
                key={member.id}
                onClick={() => onSelect(member.id)}
                title={`${member.name} · ${member.profession || t("chat:memberStream.teamMember")}`}
                type="button"
              >
                <GeneratedAvatar
                  seed={memberId ? `${profile.id}:${memberId}` : profile.id}
                  name={member.name}
                  state={working ? "working" : status === "idle" ? "default" : "sleeping"}
                  className={cn("size-8", active && "z-10 ring-2 ring-inset ring-primary")}
                >
                  <AvatarBadge className={memberStatusClass(status)}>
                    {statusIcon(status, "size-2")}
                  </AvatarBadge>
                </GeneratedAvatar>
              </Button>
            );
          })}
        </AvatarGroup>
        {activeMemberId && activeMemberId !== profile.id ? (
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
  profile,
}: {
  member: AgentProfile["members"][number];
  runtime: AgentMemberRuntime;
  threadId: string | null;
  profile: AgentProfile;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex min-w-0 flex-col gap-4" data-agent-member-view>
      {runtime.entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("chat:memberStream.waitingSchedule")}</p>
      ) : null}
      {runtime.entries.map((entry) =>
        entry.invocation && threadId ? (
          <InvocationTranscript
            key={entry.id}
            threadId={threadId}
            invocation={entry.invocation}
            member={member}
            profile={profile}
          />
        ) : null,
      )}
    </div>
  );
}

function InvocationTranscript({
  threadId,
  invocation,
  member,
  profile,
}: {
  threadId: string;
  invocation: TeamInvocation;
  member: AgentProfile["members"][number];
  profile: AgentProfile;
}) {
  const { user } = useAuth();
  const { t } = useTranslation();
  const running = invocation.status === "running";
  const showDetails = useDesktopSettingsQuery().data?.showWorkDetails ?? false;
  const [open, setOpen] = useTraceDisclosure(showDetails, running);
  const detail = useQuery({
    queryKey: [
      "team-invocation",
      user?.id,
      threadId,
      invocation.id,
      invocation.status,
      invocation.finishReason,
    ],
    queryFn: ({ signal }) =>
      requestJson<{ messages: WorkUIMessage[] }>(
        `/work/sessions/workbench/threads/${encodeURIComponent(threadId)}/invocations/${encodeURIComponent(invocation.id)}`,
        { signal },
      ),
    placeholderData: keepPreviousData,
    refetchInterval: running ? 1500 : false,
    staleTime: running || invocation.status === "suspended" ? 0 : Infinity,
  });
  const parent = profile.members.find((item) => item.id === invocation.parentMemberId);
  const promptId = `${invocation.id}:prompt`;
  const transcript = detail.data?.messages ?? [];
  const tools = [
    ...new Set(
      transcript.flatMap((message) => message.parts.filter(isToolUIPart).map(getToolName)),
    ),
  ];
  const messages: WorkUIMessage[] =
    transcript[0]?.role === "user"
      ? [{ ...transcript[0], id: promptId }, ...transcript.slice(1)]
      : [
          { id: promptId, role: "user", parts: [{ type: "text", text: invocation.prompt }] },
          ...transcript,
        ];
  const display = buildDisplayMessages(messages, running);
  const rawError = detail.error?.message ?? invocation.error;
  const failureText = detail.error
    ? t("chat:memberStream.loadFailed")
    : invocation.finishReason === "timed_out"
      ? t("chat:memberStream.timedOut")
      : invocation.finishReason === "aborted" || invocation.finishReason === "cancelled"
        ? t("chat:memberStream.interrupted")
        : invocation.finishReason === "length"
          ? t("chat:memberStream.outputLimit")
          : t("chat:memberStream.incomplete");
  const duration = invocation.endedAt
    ? Date.parse(invocation.endedAt) - Date.parse(invocation.startedAt)
    : undefined;
  return (
    <Trace>
      <TraceCollapsible open={open} onOpenChange={setOpen}>
        <TraceCollapsibleTrigger className="w-full">
          <TraceLine
            className="flex-1 flex-wrap"
            status={
              running
                ? "running"
                : invocation.status === "error"
                  ? "error"
                  : invocation.status === "suspended"
                    ? "pending"
                    : undefined
            }
          >
            <TraceIcon>{statusIcon(invocation.status)}</TraceIcon>
            <TraceTitle className="flex-1 whitespace-normal">
              {member.name} · {t(`chat:trace.subagentStatus.${invocation.status}`)}
            </TraceTitle>
            {duration !== undefined && Number.isFinite(duration) && duration >= 0 ? (
              <TraceDescription>{(duration / 1000).toFixed(1)} s</TraceDescription>
            ) : null}
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent keepMounted>
          <div className="flex min-w-0 flex-col gap-2">
            <div className="flex flex-wrap gap-1.5">
              <Badge variant="secondary">{invocation.agentId}</Badge>
              {tools.map((tool) => (
                <Badge
                  key={tool}
                  variant="outline"
                  className="max-w-full whitespace-normal break-all font-mono"
                >
                  {tool}
                </Badge>
              ))}
            </div>
            {display.map((entry, index) => {
              const isPrompt = entry.message.role === "user";
              const emptyReply = entry.sourceIds.length === 0;
              return (
                <MessageItem
                  key={entry.key}
                  message={{
                    ...entry.message,
                    metadata: {
                      ...entry.message.metadata,
                      agentProfileId: invocation.profileId,
                      teamMemberId: isPrompt ? parent?.id : invocation.memberId,
                      agentDisplayName: isPrompt
                        ? (parent?.name ?? profile.displayName)
                        : member.name,
                    },
                  }}
                  userId={user?.id ?? ""}
                  readOnly
                  isGenerating={running}
                  isStreaming={running && index === display.length - 1 && !isPrompt}
                  emptyReply={
                    emptyReply && (running || detail.isPending || invocation.status === "error")
                  }
                  replyError={emptyReply && rawError ? failureText : undefined}
                  onEdit={noopMessageAction}
                  onRetry={noopMessageAction}
                />
              );
            })}
            {rawError ? (
              <TraceCollapsible className="flex min-w-0 flex-col gap-1 text-sm">
                {detail.error || display.at(-1)?.sourceIds.length ? (
                  <p role="status" className="flex items-start gap-2 text-destructive">
                    <AlertCircleIcon className="mt-0.5 size-4 shrink-0" />
                    <span className="min-w-0 [overflow-wrap:anywhere]">{failureText}</span>
                  </p>
                ) : null}
                {invocation.error ? (
                  <p className="text-muted-foreground">{t("chat:memberStream.progressRetained")}</p>
                ) : null}
                <TraceCollapsibleTrigger>
                  <TraceLine status="error">
                    <TraceTitle>{t("chat:memberStream.errorDetails")}</TraceTitle>
                  </TraceLine>
                </TraceCollapsibleTrigger>
                <TraceCollapsibleContent>
                  <CodeBlock size="sm" variant="destructive">
                    <CodeBlockContent wrap className="max-h-40">
                      {rawError}
                    </CodeBlockContent>
                  </CodeBlock>
                </TraceCollapsibleContent>
              </TraceCollapsible>
            ) : null}
          </div>
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  );
}
