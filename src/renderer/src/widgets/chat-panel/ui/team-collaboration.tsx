import { useState } from "react";
import { ProfileAvatar, TeamStructure } from "@/entities/workbench/ui/agent-profile-details";
import { useTranslation } from "@/shared/i18n";
import { MessageResponse } from "@/shared/ui/ai-elements/message";
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
import { ScrollArea } from "@/shared/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/shared/ui/tabs";
import { Textarea } from "@/shared/ui/textarea";
import type {
  AgentProfile,
  TeamHandoff,
  TeamHandoffState,
  TeamInvocation,
} from "../../../../../shared/agent-contract";
import type { WorkflowRuntimeRun, WorkflowRuntimeStep } from "../model/types";

export function SupervisorDelegations({
  profile,
  invocations,
  onSelect,
}: {
  profile: AgentProfile;
  invocations: TeamInvocation[];
  onSelect: (memberId: string) => void;
}) {
  const { t } = useTranslation();
  if (profile.workflow?.strategy !== "supervisor") return null;
  const calls = invocations.filter((call) => call.profileId === profile.id && !call.workflowRunId);
  const name = (id?: string) =>
    profile.members.find((member) => member.id === id)?.name ?? profile.displayName;
  const renderCall = (call: TeamInvocation): React.ReactNode => (
    <li key={call.id} className="grid min-w-0 gap-1 border-l pl-2">
      <button
        type="button"
        onClick={() => onSelect(call.memberId)}
        className="flex min-w-0 flex-wrap items-center gap-2 text-left text-xs hover:underline"
      >
        <span className="break-words">
          {name(call.parentMemberId)} → {name(call.memberId)}
        </span>
        <Badge variant="outline">{call.status}</Badge>
      </button>
      <p className="whitespace-pre-wrap break-words text-xs">{call.prompt}</p>
      <span className="break-all font-mono text-[10px] text-muted-foreground">
        {call.toolCallId}
      </span>
      {call.error ? <p className="break-words text-xs text-destructive">{call.error}</p> : null}
      <ul className="grid min-w-0 gap-2">
        {calls.filter((child) => child.parentInvocationId === call.id).map(renderCall)}
      </ul>
    </li>
  );
  return (
    <details className="mx-auto mb-2 w-full max-w-3xl rounded-lg border p-2">
      <summary className="cursor-pointer text-sm">
        {t("agentHub:delegationHistory")} · {calls.length}
      </summary>
      <ScrollArea className="max-h-72">
        <div className="grid min-w-0 gap-3 pt-2">
          <TeamStructure profile={profile} />
          <ul className="grid min-w-0 gap-2">
            {calls
              .filter((call) => !calls.some((parent) => parent.id === call.parentInvocationId))
              .map(renderCall)}
          </ul>
        </div>
      </ScrollArea>
    </details>
  );
}

function RuntimeStep({
  step,
  label,
  expanded = false,
}: {
  step?: WorkflowRuntimeStep;
  label: string;
  expanded?: boolean;
}) {
  const { t } = useTranslation();
  const output =
    step?.output && typeof step.output === "object" && "text" in step.output
      ? String(step.output.text)
      : undefined;
  return (
    <details open={expanded} className="min-w-0 rounded-md border p-2">
      <summary className="cursor-pointer break-words text-xs">
        {label} · {step?.status ?? t("agentHub:waiting")}
        {step?.progress ? ` · ${step.progress.completedCount}/${step.progress.totalCount}` : ""}
      </summary>
      <div className="grid min-w-0 gap-2 pt-2">
        {step?.error ? (
          <p className="whitespace-pre-wrap break-words text-xs text-destructive">{step.error}</p>
        ) : null}
        <details>
          <summary className="cursor-pointer text-xs">{t("agentHub:input")}</summary>
          <pre className="whitespace-pre-wrap break-all text-xs">
            {JSON.stringify(step?.input, null, 2)}
          </pre>
        </details>
        <div className="min-w-0 text-xs">
          <p className="font-medium">{t("agentHub:output")}</p>
          {output ? (
            <MessageResponse>{output}</MessageResponse>
          ) : (
            <pre className="whitespace-pre-wrap break-all">
              {JSON.stringify(step?.output, null, 2)}
            </pre>
          )}
        </div>
      </div>
    </details>
  );
}

function CouncilOpinions({
  members,
  run,
  stepId,
  profile,
}: {
  members: string[];
  run: WorkflowRuntimeRun;
  stepId: string;
  profile: AgentProfile;
}) {
  const { t } = useTranslation();
  const name = (id: string) => profile.members.find((member) => member.id === id)?.name ?? id;
  const opinion = (id: string) => {
    const step = run.steps.find((step) => step.id === `${stepId}-${id}`);
    const output = step?.output as { text?: string } | undefined;
    return (
      <article className="grid min-w-0 content-start gap-2 rounded-md border p-2">
        <p className="break-words text-xs font-medium">
          {name(id)} · {step?.status ?? t("agentHub:waiting")}
        </p>
        {output?.text ? <MessageResponse>{output.text}</MessageResponse> : null}
        {step?.error ? <p className="break-words text-xs text-destructive">{step.error}</p> : null}
      </article>
    );
  };
  return (
    <>
      <p className="text-xs font-medium">{t("agentHub:councilOpinions")}</p>
      <div className="hidden min-w-0 grid-cols-[repeat(auto-fit,minmax(min(100%,14rem),1fr))] gap-2 md:grid">
        {members.map((id) => (
          <div key={id} className="min-w-0">
            {opinion(id)}
          </div>
        ))}
      </div>
      <Tabs defaultValue={members[0]} className="min-w-0 md:hidden">
        <TabsList className="h-auto flex-wrap">
          {members.map((id) => (
            <TabsTrigger className="whitespace-normal break-words" key={id} value={id}>
              {name(id)}
            </TabsTrigger>
          ))}
        </TabsList>
        {members.map((id) => (
          <TabsContent key={id} value={id}>
            {opinion(id)}
          </TabsContent>
        ))}
      </Tabs>
    </>
  );
}

export function WorkflowSteps({
  run,
  invocations,
}: {
  run: WorkflowRuntimeRun;
  invocations: TeamInvocation[];
}) {
  const { t } = useTranslation();
  const profile = run.profile;
  if (!profile?.workflow)
    return (
      <div className="grid min-w-0 gap-1">
        {run.steps.map((step) => (
          <RuntimeStep key={step.id} step={step} label={step.label ?? step.id} />
        ))}
      </div>
    );
  const name = (id: string) => profile.members.find((member) => member.id === id)?.name ?? id;
  return (
    <ol className="grid min-w-0 gap-2">
      {profile.workflow.steps.map((definition, index) => (
        <li key={definition.id} className="grid min-w-0 gap-2 rounded-lg border p-2">
          <p className="break-words text-xs font-medium">
            {index + 1}. {definition.id} · {t(`agentHub:stepKinds.${definition.kind}`)}
          </p>
          {index > 0 ? (
            <p className="break-all text-[10px] text-muted-foreground">
              {t("agentHub:dependsOn")}: {profile.workflow?.steps[index - 1].id}
            </p>
          ) : null}
          {definition.kind === "council" ? (
            <>
              <CouncilOpinions
                profile={profile}
                run={run}
                members={definition.memberIds}
                stepId={definition.id}
              />
              <RuntimeStep
                label={`${t("agentHub:synthesis")} · ${name(definition.judgeMemberId)}`}
                expanded
                step={run.steps.find((step) => step.id === `${definition.id}-synthesis`)}
              />
            </>
          ) : definition.kind === "branch" ? (
            <>
              <p className="break-words text-xs">
                {definition.condition.operator} “{definition.condition.value}”
              </p>
              <RuntimeStep
                label={`true → ${name(definition.branch.onTrueMemberId)}`}
                step={run.steps.find((step) => step.id === `${definition.id}-true`)}
              />
              <RuntimeStep
                label={`false → ${name(definition.branch.onFalseMemberId)}`}
                step={run.steps.find((step) => step.id === `${definition.id}-false`)}
              />
            </>
          ) : definition.kind === "loop" ? (
            <>
              <p className="text-xs">
                {t("agentHub:invocationCount")}:{" "}
                {
                  invocations.filter(
                    (call) => call.workflowRunId === run.runId && call.stepId === definition.id,
                  ).length
                }
              </p>
              <p className="break-words text-xs">
                {definition.loop.mode} ·{" "}
                {definition.loop.mode === "foreach"
                  ? `${t("agentHub:concurrency")}: ${definition.loop.concurrency}`
                  : `${definition.condition?.operator} “${definition.condition?.value}” · ${t("agentHub:maxIterations")}: ${definition.loop.maxIterations}`}
              </p>
              {run.steps
                .filter(
                  (step) => step.id === definition.id || step.id.startsWith(`${definition.id}[`),
                )
                .map((step) => (
                  <RuntimeStep
                    key={step.id}
                    label={`${name(definition.memberId)} · ${step.id}`}
                    step={step}
                  />
                ))}
            </>
          ) : (
            <RuntimeStep
              label={
                definition.kind === "agent" ? name(definition.memberId) : definition.approval.title
              }
              step={run.steps.find((step) => step.id === definition.id)}
            />
          )}
        </li>
      ))}
    </ol>
  );
}

export function HandoffRecord({
  handoff,
  profile,
}: {
  handoff: TeamHandoff;
  profile: AgentProfile;
}) {
  const { t } = useTranslation();
  const name = (id: string) => profile.members.find((member) => member.id === id)?.name ?? id;
  return (
    <details className="my-2 min-w-0 rounded-md border border-dashed p-2">
      <summary className="cursor-pointer break-words text-xs">
        {t("agentHub:handoff")} · {name(handoff.fromMemberId)} → {name(handoff.toMemberId)} ·{" "}
        {new Date(handoff.createdAt).toLocaleString()}
      </summary>
      <p className="whitespace-pre-wrap break-words text-sm">{handoff.reason}</p>
      <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">
        {handoff.context}
      </p>
    </details>
  );
}

export function HandoffPanel({
  profile,
  state,
  busy,
  onTransfer,
}: {
  profile: AgentProfile;
  state: TeamHandoffState | null;
  busy: boolean;
  onTransfer: (input: {
    fromMemberId: string;
    toMemberId: string;
    reason: string;
    context: string;
  }) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState("");
  const [reason, setReason] = useState("");
  const [context, setContext] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (profile.workflow?.strategy !== "handoff" || state?.profileId !== profile.id) return null;
  const member = profile.members.find((member) => member.id === state.activeMemberId);
  if (!member) return null;
  return (
    <>
      <div className="mx-auto mb-2 flex w-full max-w-3xl min-w-0 shrink-0 flex-wrap items-center gap-2 rounded-lg border p-2">
        <ProfileAvatar name={member.name} avatar={member.avatar} />
        <div className="min-w-0 flex-1">
          <p className="text-xs text-muted-foreground">{t("agentHub:currentExpert")}</p>
          <p className="break-words text-sm font-medium">{member.name}</p>
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => {
            setTarget(profile.members.find((candidate) => candidate.id !== member.id)?.id ?? "");
            setReason("");
            setContext("");
            setError(null);
            setOpen(true);
          }}
        >
          {t("agentHub:handoff")}
        </Button>
      </div>
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!sending) setOpen(value);
        }}
      >
        <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col overflow-hidden">
          <DialogHeader>
            <DialogTitle>{t("agentHub:handoff")}</DialogTitle>
            <DialogDescription>{t("agentHub:handoffDescription")}</DialogDescription>
          </DialogHeader>
          <ScrollArea className="min-h-0 flex-1">
            <div className="grid min-w-0 gap-3">
              <label className="grid gap-1 text-sm">
                {t("agentHub:nextExpert")}
                <select
                  disabled={sending}
                  className="min-w-0 rounded-md border bg-background p-2"
                  value={target}
                  onChange={(event) => setTarget(event.target.value)}
                >
                  {profile.members
                    .filter((candidate) => candidate.id !== member.id)
                    .map((candidate) => (
                      <option key={candidate.id} value={candidate.id}>
                        {candidate.name}
                      </option>
                    ))}
                </select>
              </label>
              <label className="grid gap-1 text-sm">
                {t("agentHub:handoffReason")}
                <Textarea
                  maxLength={2000}
                  disabled={sending}
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                />
              </label>
              <label className="grid gap-1 text-sm">
                {t("agentHub:handoffContext")}
                <Textarea
                  maxLength={20000}
                  disabled={sending}
                  value={context}
                  onChange={(event) => setContext(event.target.value)}
                />
              </label>
              {error ? <p className="break-words text-sm text-destructive">{error}</p> : null}
            </div>
          </ScrollArea>
          <DialogFooter>
            <Button
              disabled={busy || sending || !target || !reason.trim() || !context.trim()}
              onClick={async () => {
                setSending(true);
                setError(null);
                try {
                  await onTransfer({
                    fromMemberId: member.id,
                    toMemberId: target,
                    reason: reason.trim(),
                    context: context.trim(),
                  });
                  setOpen(false);
                } catch (error) {
                  setError(error instanceof Error ? error.message : String(error));
                } finally {
                  setSending(false);
                }
              }}
            >
              {t("agentHub:handoff")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
