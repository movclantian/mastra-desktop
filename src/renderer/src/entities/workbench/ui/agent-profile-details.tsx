import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, useId, useState } from "react";
import { fetchMcpServers, usePluginSkills } from "@/entities/skill";
import { useAuth } from "@/features/auth";
import { requestJson } from "@/shared/api";
import { useTranslation } from "@/shared/i18n";
import { cn } from "@/shared/lib";
import { GeneratedAvatar } from "@/shared/ui/avatar";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { ScrollArea } from "@/shared/ui/scroll-area";
import type { AgentProfile } from "../../../../../shared/agent-contract";
import { DEFAULT_AGENT_PROFILE_ID } from "../../../../../shared/agent-contract";
import { qk } from "../model/query-keys";

export function ProfileAvatar({ name, avatar }: { name: string; avatar?: string }) {
  return <GeneratedAvatar size="lg" seed={name} name={name} src={avatar} />;
}

/** Shared, literal projection of the saved execution definition. */
function TeamWorkflowSteps({ profile }: { profile: AgentProfile }) {
  const { t } = useTranslation();
  const name = (id: string) => profile.members.find((member) => member.id === id)?.name ?? id;
  const definition = profile.workflow;
  if (!definition) return null;
  return (
    <ol className="grid min-w-0 gap-2">
      {definition.steps.map((step, index) => (
        <li key={step.id} className="grid min-w-0 gap-1 rounded-md border p-2 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary">
              {index + 1} · {t(`agentHub:stepKinds.${step.kind}`)}
            </Badge>
            <span className="break-all">{step.id}</span>
          </div>
          {step.kind === "approval" ? (
            <p className="break-words">
              {step.approval.title}: {step.approval.description}
            </p>
          ) : (
            <>
              <p className="break-words">
                {step.kind === "council"
                  ? `${step.memberIds.map(name).join(" ∥ ")} → ${name(step.judgeMemberId)}`
                  : step.kind === "branch"
                    ? `${step.condition.operator} “${step.condition.value}” → ${name(step.branch.onTrueMemberId)} / ${name(step.branch.onFalseMemberId)}`
                    : step.kind === "loop"
                      ? `${name(step.memberId)} · ${step.loop.mode} · ${step.loop.mode === "foreach" ? `${t("agentHub:concurrency")}: ${step.loop.concurrency}` : `${step.condition?.operator} “${step.condition?.value}” · ${t("agentHub:maxIterations")}: ${step.loop.maxIterations}`}`
                      : name(step.memberId)}
              </p>
              <p>
                {t("agentHub:stepContext")}: {t(`agentHub:contexts.${step.context}`)} ·{" "}
                {t("agentHub:retries")}: {step.retries}
              </p>
              {step.prompt ? (
                <p className="whitespace-pre-wrap break-words">{step.prompt}</p>
              ) : null}
            </>
          )}
          {index > 0 ? (
            <p className="break-all text-muted-foreground">
              {t("agentHub:dependsOn")}: {definition.steps[index - 1].id}
            </p>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

export function AgentProfileDetails({
  profile,
  onSaved,
}: {
  profile: AgentProfile;
  onSaved?: (profile: AgentProfile) => void;
}) {
  const { t } = useTranslation();
  const detailsId = useId();
  const definition = profile.workflow;
  const isTeam = profile.type === "team";
  const [selectedId, setSelectedId] = useState<string | null>(
    definition?.strategy === "handoff" ? (definition.entryMemberId ?? null) : null,
  );
  const member = isTeam ? profile.members.find((item) => item.id === selectedId) : undefined;
  const selected = member ?? profile;
  const name = member?.name ?? profile.displayName;
  const roster = [
    { id: null, name: profile.displayName, avatar: profile.avatar, profession: profile.profession },
    ...profile.members,
  ];
  return (
    <div
      className={cn(
        "min-h-0 min-w-0 flex-1",
        isTeam
          ? "grid grid-cols-1 grid-rows-[minmax(0,2fr)_minmax(0,3fr)] gap-3 md:grid-cols-[minmax(12rem,16rem)_minmax(0,1fr)] md:grid-rows-1"
          : "flex flex-col",
      )}
    >
      {isTeam && definition ? (
        <ScrollArea className="min-h-0 min-w-0 rounded-md border">
          <nav aria-label={t("agentHub:teamRoster")} className="grid min-w-0 gap-1 p-1">
            {roster.map((item, index) => (
              <Fragment key={item.id === null ? "profile" : `member:${item.id}`}>
                {index === 1 ? (
                  <div className="my-1 grid min-w-0 gap-2 border-y px-2 py-3">
                    <Badge className="max-w-full whitespace-normal">
                      {t(`agentHub:strategies.${definition.strategy}`)}
                    </Badge>
                    <p className="break-words text-sm leading-relaxed text-muted-foreground">
                      {t(`agentHub:strategyDescriptions.${definition.strategy}`)}
                    </p>
                  </div>
                ) : null}
                <Button
                  type="button"
                  variant={item.id === selectedId ? "secondary" : "ghost"}
                  onClick={() => setSelectedId(item.id)}
                  aria-pressed={item.id === selectedId}
                  aria-label={item.name}
                  aria-controls={detailsId}
                  className="h-auto w-full min-w-0 justify-start gap-2 whitespace-normal p-2 text-left"
                >
                  <ProfileAvatar name={item.name} avatar={item.avatar} />
                  <span className="grid min-w-0 flex-1 gap-1">
                    <span className="break-words text-base">{item.name}</span>
                    <span className="break-words text-sm font-normal text-muted-foreground">
                      {item.id === null
                        ? t(
                            definition.strategy === "supervisor"
                              ? "agentHub:supervisor"
                              : "agentHub:teamOverview",
                          )
                        : item.profession}
                    </span>
                    {definition.strategy === "handoff" && item.id === definition.entryMemberId ? (
                      <span className="text-xs text-primary">{t("agentHub:initialExpert")}</span>
                    ) : null}
                  </span>
                </Button>
              </Fragment>
            ))}
            {definition.steps.length ? (
              <details className="mt-1 min-w-0 border-t px-2 py-2">
                <summary className="cursor-pointer break-words text-xs font-medium">
                  {t("agentHub:executionSteps")}
                </summary>
                <div className="pt-2">
                  <TeamWorkflowSteps profile={profile} />
                </div>
              </details>
            ) : null}
          </nav>
        </ScrollArea>
      ) : null}
      <ScrollArea
        key={member ? `member:${member.id}` : "profile"}
        id={detailsId}
        role="region"
        aria-label={name}
        className="min-h-0 min-w-0 flex-1"
      >
        <div className="grid min-w-0 content-start gap-3 p-1 pr-3">
          <div className="flex min-w-0 items-start gap-3">
            <ProfileAvatar name={name} avatar={selected.avatar} />
            <div className="min-w-0">
              <h3 className="break-words text-lg font-semibold">{name}</h3>
              <p className="break-words text-base text-muted-foreground">{selected.profession}</p>
            </div>
          </div>
          <p className="whitespace-pre-wrap break-words text-base leading-relaxed">
            {selected.description}
          </p>
          {selected.instructions ? (
            <section className="grid min-w-0 gap-2">
              <h4 className="text-base font-semibold">{t("agentHub:instructions")}</h4>
              <p className="whitespace-pre-wrap break-words text-base leading-relaxed">
                {selected.instructions}
              </p>
            </section>
          ) : null}
          <AgentCapabilitySelection
            key={member?.id ?? profile.id}
            profile={profile}
            memberId={member?.id}
            onSaved={onSaved}
          />
          {member ? (
            <>
              <p className="break-words text-sm leading-relaxed">
                {t("agentHub:delegates")}:{" "}
                {member.delegates
                  .map((id) => profile.members.find((target) => target.id === id)?.name ?? id)
                  .join(" · ") || t("agentHub:none")}
              </p>
              <p className="break-words text-sm leading-relaxed">
                {t("agentHub:memoryScope")}: {t(`agentHub:memoryScopes.${member.memoryScope}`)}
              </p>
            </>
          ) : null}
        </div>
      </ScrollArea>
    </div>
  );
}

function AgentCapabilitySelection({
  profile,
  memberId,
  onSaved,
}: {
  profile: AgentProfile;
  memberId?: string;
  onSaved?: (profile: AgentProfile) => void;
}) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const skills = usePluginSkills(user?.id);
  const mcp = useQuery({
    queryKey: ["agent-mcp", user?.id],
    queryFn: fetchMcpServers,
    enabled: !!user,
  });
  const original = memberId
    ? (profile.members.find((member) => member.id === memberId)?.skills ?? [])
    : profile.skills;
  const [selected, setSelected] = useState(original);
  const originalMcp = memberId
    ? (profile.members.find((member) => member.id === memberId)?.mcpServers ?? [])
    : profile.mcpServers;
  const [selectedMcp, setSelectedMcp] = useState(originalMcp);
  const isDefault = profile.id === DEFAULT_AGENT_PROFILE_ID;
  const save = useMutation({
    mutationFn: () =>
      requestJson<{ agent: AgentProfile }>(
        `/work/agents/${encodeURIComponent(profile.id)}/capabilities`,
        { method: "PUT", body: { skills: selected, mcpServers: selectedMcp, memberId } },
        t("plugins:failed"),
      ),
    onSuccess: async ({ agent }) => {
      await queryClient.invalidateQueries({ queryKey: qk.agents() });
      onSaved?.(agent);
    },
  });
  const choices = new Map(skills.data?.map((skill) => [skill.id, skill]));
  return (
    <fieldset className="grid min-w-0 gap-2 rounded-md border p-3" disabled={save.isPending}>
      <legend className="px-1 text-sm font-medium">{t("plugins:capabilities")}</legend>
      <p className="text-xs text-muted-foreground">
        {t(isDefault ? "plugins:defaultSkills" : "plugins:selectionHint")}
      </p>
      {skills.isPending ? <p role="status">{t("plugins:loading")}</p> : null}
      {skills.error ? (
        <Button variant="outline" onClick={() => void skills.refetch()}>
          {t("plugins:retry")}
        </Button>
      ) : null}
      <ScrollArea className="max-h-56 min-w-0">
        <div className="grid min-w-0 gap-2 pr-3">
          <h4 className="text-xs font-medium">{t("plugins:skill")}</h4>
          {[...new Set([...choices.keys(), ...selected])].map((id) => {
            const skill = choices.get(id);
            return (
              <label key={id} className="flex min-w-0 items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={isDefault ? skill?.enabled === true : selected.includes(id)}
                  disabled={isDefault || !onSaved}
                  onChange={(event) =>
                    setSelected((current) =>
                      event.target.checked
                        ? [...current, id]
                        : current.filter((item) => item !== id),
                    )
                  }
                />
                <span className="min-w-0 break-all">
                  {skill?.displayName ?? `${t("plugins:unavailableSkill")} (${id})`}
                  {skill && !skill.enabled ? ` · ${t("plugins:disabled")}` : ""}
                </span>
              </label>
            );
          })}
          <h4 className="border-t pt-2 text-xs font-medium">{t("plugins:mcp")}</h4>
          {mcp.isPending ? <p role="status">{t("plugins:loading")}</p> : null}
          {mcp.error ? (
            <Button variant="outline" onClick={() => void mcp.refetch()}>
              {t("plugins:retry")}
            </Button>
          ) : null}
          {[
            ...new Set([
              ...(mcp.data?.filter((server) => !server.builtin).map((server) => server.id) ?? []),
              ...selectedMcp,
            ]),
          ].map((id) => {
            const server = mcp.data?.find((server) => server.id === id);
            return (
              <label key={id} className="flex min-w-0 items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={isDefault ? server?.enabled === true : selectedMcp.includes(id)}
                  disabled={isDefault || !onSaved}
                  onChange={(event) =>
                    setSelectedMcp((current) =>
                      event.target.checked
                        ? [...current, id]
                        : current.filter((item) => item !== id),
                    )
                  }
                />
                <span className="min-w-0 break-all">
                  {server?.name ?? `${t("plugins:unavailableComponent")} (${id})`}
                  {server && !server.enabled ? ` · ${t("plugins:disabled")}` : ""}
                  {server?.configurationError ? ` · ${t("plugins:missingConfig")}` : ""}
                </span>
              </label>
            );
          })}
        </div>
      </ScrollArea>
      {save.error ? (
        <p role="alert" className="break-words text-sm text-destructive">
          {save.error.message}
        </p>
      ) : null}
      {!isDefault && onSaved ? (
        <Button
          size="sm"
          className="justify-self-start"
          disabled={
            save.isPending ||
            (JSON.stringify(original) === JSON.stringify(selected) &&
              JSON.stringify(originalMcp) === JSON.stringify(selectedMcp))
          }
          onClick={() => save.mutate()}
        >
          {t("plugins:save")}
        </Button>
      ) : null}
    </fieldset>
  );
}
