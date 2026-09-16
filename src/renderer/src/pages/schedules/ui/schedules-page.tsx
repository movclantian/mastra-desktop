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
import { useWorkbench } from "@/entities/workbench";
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
import {
  type AgentSchedule,
  createSchedule,
  deleteSchedule,
  fetchSchedules,
  pauseSchedule,
  resumeSchedule,
  runSchedule,
  updateSchedule,
} from "../api/schedules-api";

type Frequency = "daily" | "weekdays" | "weekly" | "custom";
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
};

const WEEKDAYS = [
  ["1", "周一"],
  ["2", "周二"],
  ["3", "周三"],
  ["4", "周四"],
  ["5", "周五"],
  ["6", "周六"],
  ["0", "周日"],
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

function scheduleLabel(schedule: AgentSchedule): string {
  if (schedule.name?.trim()) return schedule.name;
  return schedule.prompt.split(/\r?\n/)[0]?.slice(0, 48) || "已安排任务";
}

function formatFireAt(value: number | undefined): string {
  if (!value) return "尚未运行";
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(
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
  };
}

function threadTitle(thread: WorkThread): string {
  return thread.title?.trim() || "新对话";
}

function agentLabel(agent: AgentProfile): string {
  return agent.displayName || agent.name || agent.id;
}

export function SchedulesPage() {
  const { threads, agents, activeThreadId, refreshThreads } = useWorkbench();
  const [schedules, setSchedules] = React.useState<AgentSchedule[]>([]);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [query, setQuery] = React.useState("");
  const [draft, setDraft] = React.useState<ScheduleDraft>(() =>
    defaultDraft(activeThreadId ?? "", agents[0]?.id ?? "mastra-work-agent"),
  );
  const [editing, setEditing] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [busyId, setBusyId] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const next = await fetchSchedules();
      setSchedules(next);
      setSelectedId((current) =>
        current && next.some((item) => item.id === current) ? current : (next[0]?.id ?? null),
      );
    } catch (error) {
      toastError(error, "加载已安排任务失败");
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const selected = schedules.find((item) => item.id === selectedId) ?? null;
  const filtered = React.useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return schedules.filter(
      (item) =>
        !needle || `${scheduleLabel(item)} ${item.prompt}`.toLocaleLowerCase().includes(needle),
    );
  }, [query, schedules]);

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
      toast.error("请填写任务描述");
      return;
    }
    const cron = cronFor(draft);
    if (!cron) {
      toast.error("请输入有效的 Cron 表达式");
      return;
    }
    setSaving(true);
    try {
      const payload = {
        agentId: draft.agentId,
        name: draft.name.trim() || undefined,
        prompt: draft.prompt.trim(),
        cron,
        timezone: draft.timezone.trim() || undefined,
        ...(draft.threadId ? { threadId: draft.threadId } : {}),
      };
      if (selectedId) {
        const next = await updateSchedule(selectedId, payload);
        setSchedules((current) => current.map((item) => (item.id === next.id ? next : item)));
      } else {
        const next = await createSchedule(payload);
        setSchedules((current) => [next, ...current]);
        setSelectedId(next.id);
      }
      setEditing(false);
      toast.success("已保存安排");
    } catch (error) {
      toastError(error, "保存安排失败");
    } finally {
      setSaving(false);
    }
  };

  const act = async (id: string, action: "pause" | "resume" | "run" | "delete") => {
    setBusyId(id);
    try {
      if (action === "delete") {
        await deleteSchedule(id);
        setSchedules((current) => current.filter((item) => item.id !== id));
        if (selectedId === id) {
          setSelectedId(null);
          setEditing(false);
        }
        toast.success("已删除安排");
      } else if (action === "run") {
        await runSchedule(id);
        toast.success("已开始运行");
      } else {
        const next = action === "pause" ? await pauseSchedule(id) : await resumeSchedule(id);
        setSchedules((current) => current.map((item) => (item.id === id ? next : item)));
        toast.success(action === "pause" ? "已暂停安排" : "已恢复安排");
      }
      await refreshThreads();
    } catch (error) {
      toastError(error, "操作安排失败");
    } finally {
      setBusyId(null);
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
            已安排的任务
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            让 Mastra Agent 按 Cron 节奏持续处理线程任务
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            size="icon"
            variant="ghost"
            title="刷新安排"
            aria-label="刷新安排"
            onClick={() => void load()}
          >
            <RefreshCwIcon className={cn(loading && "animate-spin")} />
          </Button>
          <Button onClick={openNew} size="sm">
            <PlusIcon />
            新建安排
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
                placeholder="搜索已安排任务"
              />
            </div>
          </div>
          <ScrollArea className="min-h-0 flex-1 px-3 pb-3">
            {loading ? (
              <div className="flex items-center gap-2 px-2 py-8 text-sm text-muted-foreground">
                <RefreshCwIcon className="size-4 animate-spin" /> 正在加载
              </div>
            ) : filtered.length === 0 ? (
              <div className="px-2 py-8 text-sm text-muted-foreground">还没有安排任务</div>
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
                        {scheduleLabel(schedule)}
                      </span>
                      <Badge variant={schedule.status === "active" ? "default" : "secondary"}>
                        {schedule.status === "active" ? "已开启" : "已暂停"}
                      </Badge>
                    </div>
                    <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                      {schedule.prompt}
                    </p>
                    <div className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Clock3Icon className="size-3.5" /> 下次运行{" "}
                      {formatFireAt(schedule.nextFireAt)}
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
                      <CardTitle>{selected ? "安排详情" : "新建安排"}</CardTitle>
                      <CardDescription className="mt-1">
                        每次触发都会向安排专属线程发送一个 Mastra signal。
                      </CardDescription>
                    </div>
                    {selected && !editing ? (
                      <Button
                        size="icon"
                        variant="ghost"
                        title="编辑安排"
                        aria-label="编辑安排"
                        onClick={() => setEditing(true)}
                      >
                        <MoreHorizontalIcon />
                      </Button>
                    ) : (
                      <Button
                        size="icon"
                        variant="ghost"
                        title="取消编辑"
                        aria-label="取消编辑"
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
                            <p className="text-xs text-muted-foreground">运行于</p>
                            <p className="mt-1 text-sm">
                              {selectedThread ? threadTitle(selectedThread) : "每次新建独立运行"}
                            </p>
                          </div>
                          <div>
                            <p className="text-xs text-muted-foreground">Cron</p>
                            <p className="mt-1 font-mono text-sm">{selected.cron}</p>
                          </div>
                          <div>
                            <p className="text-xs text-muted-foreground">下次运行</p>
                            <p className="mt-1 text-sm">{formatFireAt(selected.nextFireAt)}</p>
                          </div>
                          <div>
                            <p className="text-xs text-muted-foreground">上次运行</p>
                            <p className="mt-1 text-sm">{formatFireAt(selected.lastFireAt)}</p>
                          </div>
                        </div>
                        <Separator />
                        <div className="flex flex-wrap gap-2">
                          <Button
                            size="sm"
                            onClick={() => void act(selected.id, "run")}
                            disabled={busyId === selected.id}
                          >
                            <PlayIcon /> 立即运行
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
                            {selected.status === "active" ? "暂停" : "恢复"}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-destructive hover:text-destructive"
                            onClick={() => void act(selected.id, "delete")}
                            disabled={busyId === selected.id}
                          >
                            <Trash2Icon /> 删除
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
                  <h2 className="mt-4 text-lg font-medium">安排重复任务</h2>
                  <p className="mt-2 max-w-md text-sm text-muted-foreground">
                    按日、工作日、每周或自定义 Cron 运行 Agent，把提醒、检查和摘要送回你的线程。
                  </p>
                  <Button className="mt-5" onClick={openNew}>
                    <PlusIcon /> 新建安排
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
        <FieldLabel htmlFor="schedule-name">安排标题</FieldLabel>
        <Input
          id="schedule-name"
          value={draft.name}
          onChange={(event) => onChange({ name: event.target.value })}
          placeholder="例如：每日简报"
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="schedule-prompt">任务描述</FieldLabel>
        <Textarea
          id="schedule-prompt"
          value={draft.prompt}
          onChange={(event) => onChange({ prompt: event.target.value })}
          placeholder="描述 Agent 每次运行应该做什么"
          rows={5}
        />
        <FieldDescription>描述会作为每次 signal 的正文发送到线程。</FieldDescription>
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field>
          <FieldLabel>运行于</FieldLabel>
          <Select
            value={draft.threadId || "__new__"}
            onValueChange={(threadId) =>
              onChange({ threadId: threadId === "__new__" ? "" : (threadId ?? "") })
            }
            disabled={!targetEditable}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="选择线程" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__new__">为安排新建专属线程</SelectItem>
              {threads
                .filter((thread) => !thread.metadata?.archivedAt)
                .map((thread) => (
                  <SelectItem key={thread.id} value={thread.id}>
                    {threadTitle(thread)}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </Field>
        <Field>
          <FieldLabel>使用 Agent</FieldLabel>
          <Select
            value={draft.agentId}
            onValueChange={(agentId) => onChange({ agentId: agentId ?? "mastra-work-agent" })}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="选择 Agent" />
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
          <FieldLabel>重复</FieldLabel>
          <Select
            value={frequency}
            onValueChange={(value) => onChange({ frequency: value as Frequency })}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="daily">每天</SelectItem>
              <SelectItem value="weekdays">每个工作日</SelectItem>
              <SelectItem value="weekly">每周</SelectItem>
              <SelectItem value="custom">自定义 Cron</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        {frequency === "custom" ? (
          <Field>
            <FieldLabel htmlFor="schedule-cron">Cron 表达式</FieldLabel>
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
            <FieldLabel htmlFor="schedule-time">时间</FieldLabel>
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
          <FieldLabel>星期</FieldLabel>
          <Select
            value={draft.weekday}
            onValueChange={(weekday) => onChange({ weekday: weekday ?? "1" })}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {WEEKDAYS.map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      ) : null}
      <Field>
        <FieldLabel htmlFor="schedule-timezone">时区</FieldLabel>
        <Input
          id="schedule-timezone"
          value={draft.timezone}
          onChange={(event) => onChange({ timezone: event.target.value })}
          placeholder="Asia/Shanghai"
        />
        <FieldDescription>使用 IANA 时区；留空时由 Mastra 使用服务端本地时区。</FieldDescription>
      </Field>
      <div className="flex justify-end gap-2 pt-2">
        <Button type="submit" disabled={saving || !draft.prompt.trim()}>
          {saving ? <RefreshCwIcon className="animate-spin" /> : <CheckIcon />}
          保存安排
        </Button>
      </div>
    </form>
  );
}
