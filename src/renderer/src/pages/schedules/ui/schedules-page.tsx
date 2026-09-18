import { useRouterState } from "@tanstack/react-router";
import {
  CalendarClockIcon,
  CheckIcon,
  Clock3Icon,
  MoreHorizontalIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import type { AgentProfile, WorkThread } from "@/entities/workbench";
import {
  useAgentsQuery,
  useCreateScheduleMutation,
  useDeleteScheduleMutation,
  useScheduleActionMutation,
  useSchedulesQuery,
  useThreadsQuery,
  useUpdateScheduleMutation,
} from "@/entities/workbench";
import { useAuth } from "@/features/auth";
import { useTranslation } from "@/shared/i18n";
import { cn, toastError } from "@/shared/lib";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/shared/ui/card";
import { Field, FieldDescription, FieldLabel } from "@/shared/ui/field";
import { Input } from "@/shared/ui/input";
import { ScrollArea } from "@/shared/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/shared/ui/select";
import { Separator } from "@/shared/ui/separator";
import { Textarea } from "@/shared/ui/textarea";
import type { AgentSchedule } from "../api/schedules-api";

type Frequency = "daily" | "weekdays" | "weekly" | "custom";
type SignalType = NonNullable<AgentSchedule["signalType"]>;
type ActiveBehavior = NonNullable<NonNullable<AgentSchedule["ifActive"]>["behavior"]>;
type IdleBehavior = NonNullable<NonNullable<AgentSchedule["ifIdle"]>["behavior"]>;
type ScheduleDraft = {
  name: string;
  prompt: string;
  threadId: string;
  frequency: Frequency;
  weekday: string;
  time: string;
  cron: string;
  timezone: string;
  agentId: string;
  signalType: SignalType;
  tagName: string;
  ifActive: ActiveBehavior;
  ifIdle: IdleBehavior;
  attributesJson: string;
  providerOptionsJson: string;
};

const WEEKDAY_KEYS = [
  ["1", "schedules:days.1"],
  ["2", "schedules:days.2"],
  ["3", "schedules:days.3"],
  ["4", "schedules:days.4"],
  ["5", "schedules:days.5"],
  ["6", "schedules:days.6"],
  ["0", "schedules:days.0"],
] as const;

function defaultDraft(threadId = "", agentId = "mastra-work-agent"): ScheduleDraft {
  return {
    name: "",
    prompt: "",
    threadId,
    frequency: "daily",
    weekday: "1",
    time: "09:00",
    cron: "0 9 * * *",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    agentId,
    signalType: "notification",
    tagName: "schedule",
    ifActive: "deliver",
    ifIdle: "wake",
    attributesJson: "",
    providerOptionsJson: "",
  };
}

function cronFor(draft: ScheduleDraft): string {
  if (draft.frequency === "custom") return draft.cron.trim();
  const [hour, minute] = draft.time.split(":").map(Number);
  const safeHour = Number.isFinite(hour) ? Math.min(23, Math.max(0, hour)) : 9;
  const safeMinute = Number.isFinite(minute) ? Math.min(59, Math.max(0, minute)) : 0;
  const day =
    draft.frequency === "weekdays" ? "1-5" : draft.frequency === "weekly" ? draft.weekday : "*";
  return `${safeMinute} ${safeHour} * * ${day}`;
}

function scheduleLabel(schedule: AgentSchedule, fallback = "Schedule"): string {
  if (schedule.name?.trim()) return schedule.name;
  return schedule.prompt.split(/\r?\n/)[0]?.slice(0, 48) || fallback;
}

function formatFireAt(value: number | undefined, neverRun = "-"): string {
  if (!value) return neverRun;
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
    value,
  );
}

function frequencyForCron(cron: string): Frequency {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return "custom";
  if (parts[4] === "1-5") return "weekdays";
  if (parts[2] === "*" && parts[3] === "*" && parts[4] === "*") return "daily";
  if (parts[2] === "*" && parts[3] === "*" && /^[0-6]$/.test(parts[4])) return "weekly";
  return "custom";
}

function draftFromSchedule(schedule: AgentSchedule): ScheduleDraft {
  const frequency = frequencyForCron(schedule.cron);
  const parts = schedule.cron.trim().split(/\s+/);
  const minute = Number(parts[0]);
  const hour = Number(parts[1]);
  return {
    name: schedule.name ?? "",
    prompt: schedule.prompt,
    threadId: schedule.threadId ?? "",
    frequency,
    weekday: frequency === "weekly" ? parts[4] : "1",
    time:
      Number.isFinite(hour) && Number.isFinite(minute)
        ? `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`
        : "09:00",
    cron: schedule.cron,
    timezone: schedule.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    agentId:
      typeof schedule.metadata?.profileId === "string"
        ? schedule.metadata.profileId
        : schedule.agentId,
    signalType: schedule.signalType ?? "notification",
    tagName: schedule.tagName ?? "schedule",
    ifActive: schedule.ifActive?.behavior ?? "deliver",
    ifIdle: schedule.ifIdle?.behavior ?? "wake",
    attributesJson: schedule.attributes ? JSON.stringify(schedule.attributes, null, 2) : "",
    providerOptionsJson: schedule.providerOptions
      ? JSON.stringify(schedule.providerOptions, null, 2)
      : "",
  };
}

function threadTitle(thread: WorkThread, fallback = "New Thread"): string {
  return thread.title?.trim() || fallback;
}

function agentLabel(agent: AgentProfile): string {
  return agent.displayName || agent.name || agent.id;
}

export function SchedulesPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const userId = user?.id ?? "anonymous";
  const activeThreadId = useRouterState({
    select: (state) => (state.location.search as { thread?: string }).thread ?? null,
  });
  const threads = useThreadsQuery(userId).data ?? [];
  const agents = useAgentsQuery().data ?? [];
  const schedulesQuery = useSchedulesQuery();
  const createMutation = useCreateScheduleMutation(userId);
  const updateMutation = useUpdateScheduleMutation(userId);
  const actionMutation = useScheduleActionMutation(userId);
  const deleteMutation = useDeleteScheduleMutation(userId);
  const schedules = schedulesQuery.data ?? [];
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [query, setQuery] = React.useState("");
  const [draft, setDraft] = React.useState<ScheduleDraft>(() =>
    defaultDraft(activeThreadId ?? "", agents[0]?.id ?? "mastra-work-agent"),
  );
  const [editing, setEditing] = React.useState(false);
  const loading = schedulesQuery.isPending || schedulesQuery.isFetching;
  const saving = createMutation.isPending || updateMutation.isPending;
  const busyId = actionMutation.isPending
    ? (actionMutation.variables?.id ?? null)
    : deleteMutation.isPending
      ? (deleteMutation.variables ?? null)
      : null;

  const load = React.useCallback(async () => {
    try {
      const result = await schedulesQuery.refetch();
      if (result.error) throw result.error;
    } catch (error) {
      toastError(error, t("schedules:loadFailed"));
    }
  }, [schedulesQuery, t]);

  React.useEffect(() => {
    setSelectedId((current) =>
      current && schedules.some((item) => item.id === current)
        ? current
        : (schedules[0]?.id ?? null),
    );
  }, [schedules]);

  const selected = schedules.find((item) => item.id === selectedId) ?? null;
  const filtered = React.useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    const defaultName = t("schedules:defaultScheduleName");
    return schedules.filter(
      (item) =>
        !needle ||
        `${scheduleLabel(item, defaultName)} ${item.prompt}`.toLocaleLowerCase().includes(needle),
    );
  }, [query, schedules, t]);

  const updateDraft = (patch: Partial<ScheduleDraft>) =>
    setDraft((current) => ({ ...current, ...patch }));

  const openNew = () => {
    const preferredThread =
      activeThreadId ?? threads.find((thread) => !thread.metadata?.archivedAt)?.id ?? "";
    setSelectedId(null);
    setDraft(defaultDraft(preferredThread, agents[0]?.id ?? "mastra-work-agent"));
    setEditing(true);
  };

  const openExisting = (schedule: AgentSchedule) => {
    setSelectedId(schedule.id);
    setDraft(draftFromSchedule(schedule));
    setEditing(false);
  };

  const save = async () => {
    if (!draft.prompt.trim()) {
      toast.error(t("schedules:promptRequired"));
      return;
    }
    const cron = cronFor(draft);
    if (!cron) {
      toast.error(t("schedules:invalidCron"));
      return;
    }
    let attributes: AgentSchedule["attributes"];
    let providerOptions: AgentSchedule["providerOptions"];
    try {
      if (draft.attributesJson.trim()) {
        const value: unknown = JSON.parse(draft.attributesJson);
        if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error();
        attributes = value as AgentSchedule["attributes"];
      }
      if (draft.providerOptionsJson.trim()) {
        const value: unknown = JSON.parse(draft.providerOptionsJson);
        if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error();
        providerOptions = value as AgentSchedule["providerOptions"];
      }
    } catch {
      toast.error(t("schedules:invalidJsonAttrs"));
      return;
    }
    try {
      const payload = {
        name: draft.name.trim() || undefined,
        prompt: draft.prompt.trim(),
        cron,
        timezone: draft.timezone.trim() || undefined,
        ...(draft.threadId ? { threadId: draft.threadId } : {}),
        signalType: draft.signalType,
        tagName: draft.tagName.trim() || undefined,
        ifActive: { behavior: draft.ifActive },
        ifIdle: { behavior: draft.ifIdle },
        ...(attributes ? { attributes } : {}),
        ...(providerOptions ? { providerOptions } : {}),
      };
      if (selectedId) {
        await updateMutation.mutateAsync({ id: selectedId, input: payload });
      } else {
        const next = await createMutation.mutateAsync({ ...payload, agentId: draft.agentId });
        setSelectedId(next.id);
      }
      setEditing(false);
      toast.success(t("schedules:saved"));
    } catch (error) {
      toastError(error, t("schedules:saveFailed"));
    }
  };

  const act = async (id: string, action: "pause" | "resume" | "run" | "delete") => {
    try {
      if (action === "delete") {
        await deleteMutation.mutateAsync(id);
        if (selectedId === id) {
          setSelectedId(null);
          setEditing(false);
        }
        toast.success(t("schedules:deleted"));
      } else if (action === "run") {
        await actionMutation.mutateAsync({ id, action });
        toast.success(t("schedules:started"));
      } else {
        await actionMutation.mutateAsync({ id, action });
        toast.success(
          action === "pause" ? t("schedules:statusPaused") : t("schedules:statusResumed"),
        );
      }
    } catch (error) {
      toastError(error, t("schedules:operateFailed"));
    }
  };

  const selectedThread = selected?.threadId
    ? threads.find((thread) => thread.id === selected.threadId)
    : undefined;

  return (
    <div className="flex size-full min-h-0 flex-col bg-background">
      <header className="flex shrink-0 items-center justify-between gap-4 border-b border-border px-5 py-4">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
            <CalendarClockIcon className="size-5 text-primary" />
            {t("schedules:title")}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">{t("schedules:subtitle")}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            size="icon"
            variant="ghost"
            title={t("schedules:refresh")}
            aria-label={t("schedules:refresh")}
            onClick={() => void load()}
          >
            <RefreshCwIcon className={cn(loading && "animate-spin")} />
          </Button>
          <Button onClick={openNew} size="sm">
            <PlusIcon />
            {t("schedules:newSchedule")}
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <aside className="flex min-h-0 w-full shrink-0 flex-col border-b border-border md:w-[min(34%,25rem)] md:border-r md:border-b-0">
          <div className="shrink-0 p-4">
            <div className="relative">
              <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="pl-9"
                placeholder={t("schedules:searchPlaceholder")}
              />
            </div>
          </div>
          <ScrollArea className="min-h-0 flex-1 px-3 pb-3">
            {loading ? (
              <div className="flex items-center gap-2 px-2 py-8 text-sm text-muted-foreground">
                <RefreshCwIcon className="size-4 animate-spin" /> {t("schedules:loading")}
              </div>
            ) : filtered.length === 0 ? (
              <div className="px-2 py-8 text-sm text-muted-foreground">
                {t("schedules:emptyList")}
              </div>
            ) : (
              <div className="space-y-2">
                {filtered.map((schedule) => (
                  <button
                    key={schedule.id}
                    type="button"
                    className={cn(
                      "w-full rounded-lg border p-3 text-left transition-colors hover:bg-muted/50",
                      selectedId === schedule.id && "border-primary/50 bg-muted/60",
                    )}
                    onClick={() => openExisting(schedule)}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span className="line-clamp-1 min-w-0 font-medium">
                        {scheduleLabel(schedule, t("schedules:defaultScheduleName"))}
                      </span>
                      <Badge variant={schedule.status === "active" ? "default" : "secondary"}>
                        {schedule.status === "active"
                          ? t("schedules:statusActive")
                          : t("schedules:statusPausedTag")}
                      </Badge>
                    </div>
                    <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                      {schedule.prompt}
                    </p>
                    <div className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Clock3Icon className="size-3.5" /> {t("schedules:nextRun")}{" "}
                      {formatFireAt(schedule.nextFireAt, t("schedules:neverRun"))}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </ScrollArea>
        </aside>

        <main className="min-h-0 min-w-0 flex-1">
          <ScrollArea className="size-full">
            <div className="mx-auto w-full max-w-3xl p-5 md:p-8">
              {editing || selected ? (
                <Card>
                  <CardHeader className="flex flex-row items-start justify-between gap-4 border-b">
                    <div className="min-w-0">
                      <CardTitle>
                        {selected ? t("schedules:detailsTitle") : t("schedules:newSchedule")}
                      </CardTitle>
                      <CardDescription className="mt-1">
                        {t("schedules:detailsDesc")}
                      </CardDescription>
                    </div>
                    {selected && !editing ? (
                      <Button
                        size="icon"
                        variant="ghost"
                        title={t("schedules:edit")}
                        aria-label={t("schedules:edit")}
                        onClick={() => setEditing(true)}
                      >
                        <MoreHorizontalIcon />
                      </Button>
                    ) : (
                      <Button
                        size="icon"
                        variant="ghost"
                        title={t("schedules:cancelEdit")}
                        aria-label={t("schedules:cancelEdit")}
                        onClick={() => {
                          setEditing(false);
                          if (!selected) setSelectedId(null);
                        }}
                      >
                        <XIcon />
                      </Button>
                    )}
                  </CardHeader>
                  <CardContent className="space-y-5 pt-5">
                    {selected && !editing ? (
                      <div className="space-y-5">
                        <div className="rounded-lg bg-muted/40 p-4">
                          <p className="whitespace-pre-wrap text-sm leading-6">{selected.prompt}</p>
                        </div>
                        <div className="grid gap-3 sm:grid-cols-2">
                          <div>
                            <p className="text-xs text-muted-foreground">{t("schedules:runIn")}</p>
                            <p className="mt-1 text-sm">
                              {selectedThread
                                ? threadTitle(selectedThread, t("schedules:newThread"))
                                : t("schedules:newThreadPerRun")}
                            </p>
                          </div>
                          <div>
                            <p className="text-xs text-muted-foreground">Cron</p>
                            <p className="mt-1 font-mono text-sm">{selected.cron}</p>
                          </div>
                          <div>
                            <p className="text-xs text-muted-foreground">{t("schedules:signal")}</p>
                            <p className="mt-1 text-sm">
                              {selected.signalType ?? "notification"} · &lt;
                              {selected.tagName ?? "schedule"}&gt;
                            </p>
                          </div>
                          <div>
                            <p className="text-xs text-muted-foreground">
                              {t("schedules:busyIdleStatus")}
                            </p>
                            <p className="mt-1 text-sm">
                              {selected.ifActive?.behavior ?? "deliver"} /{" "}
                              {selected.ifIdle?.behavior ?? "wake"}
                            </p>
                          </div>
                          <div>
                            <p className="text-xs text-muted-foreground">
                              {t("schedules:nextRun")}
                            </p>
                            <p className="mt-1 text-sm">
                              {formatFireAt(selected.nextFireAt, t("schedules:neverRun"))}
                            </p>
                          </div>
                          <div>
                            <p className="text-xs text-muted-foreground">
                              {t("schedules:lastRun")}
                            </p>
                            <p className="mt-1 text-sm">
                              {formatFireAt(selected.lastFireAt, t("schedules:neverRun"))}
                            </p>
                          </div>
                        </div>
                        <Separator />
                        <div className="flex flex-wrap gap-2">
                          <Button
                            size="sm"
                            onClick={() => void act(selected.id, "run")}
                            disabled={busyId === selected.id}
                          >
                            <PlayIcon /> {t("schedules:runNow")}
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() =>
                              void act(
                                selected.id,
                                selected.status === "active" ? "pause" : "resume",
                              )
                            }
                            disabled={busyId === selected.id}
                          >
                            {selected.status === "active" ? <PauseIcon /> : <CheckIcon />}
                            {selected.status === "active"
                              ? t("schedules:pause")
                              : t("schedules:resume")}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-destructive hover:text-destructive"
                            onClick={() => void act(selected.id, "delete")}
                            disabled={busyId === selected.id}
                          >
                            <Trash2Icon /> {t("schedules:delete")}
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <ScheduleForm
                        draft={draft}
                        threads={threads}
                        agents={agents}
                        targetEditable={!selected}
                        saving={saving}
                        onChange={updateDraft}
                        onSave={() => void save()}
                      />
                    )}
                  </CardContent>
                </Card>
              ) : (
                <div className="flex min-h-[26rem] flex-col items-center justify-center text-center">
                  <CalendarClockIcon className="size-10 text-muted-foreground/60" />
                  <h2 className="mt-4 text-lg font-medium">{t("schedules:emptyHeroTitle")}</h2>
                  <p className="mt-2 max-w-md text-sm text-muted-foreground">
                    {t("schedules:emptyHeroDesc")}
                  </p>
                  <Button className="mt-5" onClick={openNew}>
                    <PlusIcon /> {t("schedules:newSchedule")}
                  </Button>
                </div>
              )}
            </div>
          </ScrollArea>
        </main>
      </div>
    </div>
  );
}

function ScheduleForm({
  draft,
  threads,
  agents,
  targetEditable,
  saving,
  onChange,
  onSave,
}: {
  draft: ScheduleDraft;
  threads: WorkThread[];
  agents: AgentProfile[];
  targetEditable: boolean;
  saving: boolean;
  onChange: (patch: Partial<ScheduleDraft>) => void;
  onSave: () => void;
}) {
  const { t } = useTranslation();
  const frequency = draft.frequency;
  return (
    <form
      className="space-y-5"
      onSubmit={(event) => {
        event.preventDefault();
        onSave();
      }}
    >
      <Field>
        <FieldLabel htmlFor="schedule-name">{t("schedules:form.title")}</FieldLabel>
        <Input
          id="schedule-name"
          value={draft.name}
          onChange={(event) => onChange({ name: event.target.value })}
          placeholder={t("schedules:form.titlePlaceholder")}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="schedule-prompt">{t("schedules:form.prompt")}</FieldLabel>
        <Textarea
          id="schedule-prompt"
          value={draft.prompt}
          onChange={(event) => onChange({ prompt: event.target.value })}
          placeholder={t("schedules:form.promptPlaceholder")}
          rows={5}
        />
        <FieldDescription>{t("schedules:form.promptHint")}</FieldDescription>
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field>
          <FieldLabel>{t("schedules:form.runIn")}</FieldLabel>
          <Select
            value={draft.threadId || "__new__"}
            onValueChange={(threadId) =>
              onChange({ threadId: threadId === "__new__" ? "" : (threadId ?? "") })
            }
            disabled={!targetEditable}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder={t("schedules:form.selectThread")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__new__">{t("schedules:form.newThreadOption")}</SelectItem>
              {threads
                .filter((thread) => !thread.metadata?.archivedAt)
                .map((thread) => (
                  <SelectItem key={thread.id} value={thread.id}>
                    {threadTitle(thread, t("schedules:newThread"))}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </Field>
        <Field>
          <FieldLabel>{t("schedules:form.useAgent")}</FieldLabel>
          <Select
            value={draft.agentId}
            onValueChange={(agentId) => onChange({ agentId: agentId ?? "mastra-work-agent" })}
            disabled={!targetEditable}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder={t("schedules:form.selectAgent")} />
            </SelectTrigger>
            <SelectContent>
              {agents.map((agent) => (
                <SelectItem key={agent.id} value={agent.id}>
                  {agentLabel(agent)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor="schedule-attributes">{t("schedules:form.attributes")}</FieldLabel>
          <Textarea
            id="schedule-attributes"
            value={draft.attributesJson}
            onChange={(event) => onChange({ attributesJson: event.target.value })}
            placeholder={'{"source":"cron"}'}
            rows={3}
            className="font-mono text-xs"
          />
          <FieldDescription>{t("schedules:form.attributesHint")}</FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="schedule-provider-options">
            {t("schedules:form.providerOptions")}
          </FieldLabel>
          <Textarea
            id="schedule-provider-options"
            value={draft.providerOptionsJson}
            onChange={(event) => onChange({ providerOptionsJson: event.target.value })}
            placeholder={'{"openai":{"reasoningEffort":"low"}}'}
            rows={3}
            className="font-mono text-xs"
          />
          <FieldDescription>{t("schedules:form.providerOptionsHint")}</FieldDescription>
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field>
          <FieldLabel>{t("schedules:form.signalType")}</FieldLabel>
          <Select
            value={draft.signalType}
            onValueChange={(value) => onChange({ signalType: value as SignalType })}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="notification">
                {t("schedules:form.signalTypes.notification")}
              </SelectItem>
              <SelectItem value="user">{t("schedules:form.signalTypes.user")}</SelectItem>
              <SelectItem value="user-message">
                {t("schedules:form.signalTypes.userMessage")}
              </SelectItem>
              <SelectItem value="reactive">{t("schedules:form.signalTypes.reactive")}</SelectItem>
              <SelectItem value="state">{t("schedules:form.signalTypes.state")}</SelectItem>
              <SelectItem value="system-reminder">
                {t("schedules:form.signalTypes.systemReminder")}
              </SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field>
          <FieldLabel htmlFor="schedule-tag">{t("schedules:form.signalTag")}</FieldLabel>
          <Input
            id="schedule-tag"
            value={draft.tagName}
            onChange={(event) => onChange({ tagName: event.target.value })}
            placeholder="schedule"
          />
          <FieldDescription>{t("schedules:form.signalTagHint")}</FieldDescription>
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field>
          <FieldLabel>{t("schedules:form.runningBehavior")}</FieldLabel>
          <Select
            value={draft.ifActive}
            onValueChange={(value) => onChange({ ifActive: value as ActiveBehavior })}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="deliver">
                {t("schedules:form.runningBehaviors.deliver")}
              </SelectItem>
              <SelectItem value="discard">
                {t("schedules:form.runningBehaviors.discard")}
              </SelectItem>
              <SelectItem value="persist">
                {t("schedules:form.runningBehaviors.persist")}
              </SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field>
          <FieldLabel>{t("schedules:form.idleBehavior")}</FieldLabel>
          <Select
            value={draft.ifIdle}
            onValueChange={(value) => onChange({ ifIdle: value as IdleBehavior })}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="wake">{t("schedules:form.idleBehaviors.wake")}</SelectItem>
              <SelectItem value="discard">{t("schedules:form.idleBehaviors.discard")}</SelectItem>
              <SelectItem value="persist">{t("schedules:form.idleBehaviors.persist")}</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field>
          <FieldLabel>{t("schedules:form.frequency")}</FieldLabel>
          <Select
            value={frequency}
            onValueChange={(value) => onChange({ frequency: value as Frequency })}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="daily">{t("schedules:form.frequencies.daily")}</SelectItem>
              <SelectItem value="weekdays">{t("schedules:form.frequencies.weekdays")}</SelectItem>
              <SelectItem value="weekly">{t("schedules:form.frequencies.weekly")}</SelectItem>
              <SelectItem value="custom">{t("schedules:form.frequencies.custom")}</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        {frequency === "custom" ? (
          <Field>
            <FieldLabel htmlFor="schedule-cron">{t("schedules:form.cronExpression")}</FieldLabel>
            <Input
              id="schedule-cron"
              value={draft.cron}
              onChange={(event) => onChange({ cron: event.target.value })}
              placeholder="0 9 * * 1-5"
              className="font-mono"
            />
          </Field>
        ) : (
          <Field>
            <FieldLabel htmlFor="schedule-time">{t("schedules:form.time")}</FieldLabel>
            <Input
              id="schedule-time"
              type="time"
              value={draft.time}
              onChange={(event) => onChange({ time: event.target.value })}
            />
          </Field>
        )}
      </div>
      {frequency === "weekly" ? (
        <Field>
          <FieldLabel>{t("schedules:form.weekday")}</FieldLabel>
          <Select
            value={draft.weekday}
            onValueChange={(weekday) => onChange({ weekday: weekday ?? "1" })}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {WEEKDAY_KEYS.map(([value, key]) => (
                <SelectItem key={value} value={value}>
                  {t(key)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      ) : null}
      <Field>
        <FieldLabel htmlFor="schedule-timezone">{t("schedules:form.timezone")}</FieldLabel>
        <Input
          id="schedule-timezone"
          value={draft.timezone}
          onChange={(event) => onChange({ timezone: event.target.value })}
          placeholder="Asia/Shanghai"
        />
        <FieldDescription>{t("schedules:form.timezoneHint")}</FieldDescription>
      </Field>
      <div className="flex justify-end gap-2 pt-2">
        <Button type="submit" disabled={saving || !draft.prompt.trim()}>
          {saving ? <RefreshCwIcon className="animate-spin" /> : <CheckIcon />}
          {t("schedules:form.save")}
        </Button>
      </div>
    </form>
  );
}
