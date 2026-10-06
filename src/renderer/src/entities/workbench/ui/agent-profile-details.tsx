import { useTranslation } from "@/shared/i18n";
import { GeneratedAvatar } from "@/shared/ui/avatar";
import { Badge } from "@/shared/ui/badge";
import type { AgentProfile } from "../../../../../shared/agent-contract";

export function ProfileAvatar({ name, avatar }: { name: string; avatar?: string }) {
  return <GeneratedAvatar size="lg" seed={name} name={name} src={avatar} />;
}

/** Shared, literal projection of the saved execution definition. */
export function TeamStructure({ profile }: { profile: AgentProfile }) {
  const { t } = useTranslation();
  const name = (id: string) => profile.members.find((member) => member.id === id)?.name ?? id;
  const definition = profile.workflow;
  if (!definition) return null;
  return (
    <div className="grid min-w-0 gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Badge>{t(`agentHub:strategies.${definition.strategy}`)}</Badge>
        {definition.steps.some((step) => step.kind === "council") ? (
          <Badge variant="outline">Council</Badge>
        ) : null}
      </div>
      <p className="break-words text-xs text-muted-foreground">
        {t(`agentHub:strategyDescriptions.${definition.strategy}`)}
      </p>
      {definition.strategy === "supervisor" ? (
        <p className="break-words text-sm">
          {profile.displayName} → {profile.members.map((member) => member.name).join(" · ")}
        </p>
      ) : null}
      {definition.strategy === "handoff" && definition.entryMemberId ? (
        <p className="break-words text-sm">
          {t("agentHub:initialExpert")}: {name(definition.entryMemberId)}
        </p>
      ) : null}
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
    </div>
  );
}

export function AgentProfileDetails({ profile }: { profile: AgentProfile }) {
  const { t } = useTranslation();
  return (
    <div className="grid min-w-0 gap-3 p-1">
      <div className="flex min-w-0 items-start gap-3">
        <ProfileAvatar name={profile.displayName} avatar={profile.avatar} />
        <div className="min-w-0">
          <h3 className="break-words font-semibold">{profile.displayName}</h3>
          <p className="break-words text-sm text-muted-foreground">{profile.profession}</p>
        </div>
      </div>
      <p className="whitespace-pre-wrap break-words text-sm">{profile.description}</p>
      <TeamStructure profile={profile} />
      <details>
        <summary className="cursor-pointer text-sm">{t("agentHub:instructions")}</summary>
        <p className="whitespace-pre-wrap break-words text-xs">{profile.instructions}</p>
      </details>
      {profile.skills.length ? (
        <p className="break-words text-xs">
          {t("agentHub:skills")}: {profile.skills.join(", ")}
        </p>
      ) : null}
      <div className="grid min-w-0 gap-2 sm:grid-cols-2">
        {profile.members.map((member) => (
          <article
            key={member.id}
            className="grid min-w-0 content-start gap-2 rounded-lg border p-3"
          >
            <div className="flex min-w-0 items-start gap-2">
              <ProfileAvatar name={member.name} avatar={member.avatar} />
              <div className="min-w-0">
                <h4 className="break-words text-sm font-medium">{member.name}</h4>
                <p className="break-words text-xs text-muted-foreground">{member.profession}</p>
              </div>
            </div>
            <p className="whitespace-pre-wrap break-words text-xs">{member.description}</p>
            <p className="break-words text-xs">
              {t("agentHub:delegates")}:{" "}
              {member.delegates
                .map((id) => profile.members.find((target) => target.id === id)?.name ?? id)
                .join(" · ") || t("agentHub:none")}
            </p>
            <p className="break-words text-xs">
              {t("agentHub:skills")}: {member.skills.join(" · ") || t("agentHub:none")}
            </p>
            <p className="text-xs">
              {t("agentHub:memoryScope")}: {t(`agentHub:memoryScopes.${member.memoryScope}`)}
            </p>
            <details>
              <summary className="cursor-pointer text-xs">{t("agentHub:instructions")}</summary>
              <p className="whitespace-pre-wrap break-words text-xs">{member.instructions}</p>
            </details>
          </article>
        ))}
      </div>
    </div>
  );
}
