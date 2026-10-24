import { addDays, format, startOfWeek } from "date-fns";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "@/shared/i18n";
import { Button } from "@/shared/ui/button";
import { ScrollArea } from "@/shared/ui/scroll-area";
import type { AgentSchedule } from "../api/schedules-api";

/** Project stored next/last fire times, never invent future Cron occurrences. */
export function ScheduleCalendar({
  schedules,
  onSelect,
}: {
  schedules: AgentSchedule[];
  onSelect: (schedule: AgentSchedule) => void;
}) {
  const { t } = useTranslation();
  const [week, setWeek] = useState(() => startOfWeek(new Date(), { weekStartsOn: 1 }));
  const days = useMemo(() => Array.from({ length: 7 }, (_, index) => addDays(week, index)), [week]);
  return (
    <section className="flex h-full min-h-0 min-w-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b p-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">
            {format(week, "yyyy-MM-dd")} — {format(addDays(week, 6), "MM-dd")}
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">{t("planning:calendarHint")}</p>
        </div>
        <div className="flex gap-1">
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={t("planning:previousWeek")}
            onClick={() => setWeek(addDays(week, -7))}
          >
            <ChevronLeftIcon />
          </Button>
          <Button
            size="xs"
            variant="outline"
            onClick={() => setWeek(startOfWeek(new Date(), { weekStartsOn: 1 }))}
          >
            {t("planning:today")}
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={t("planning:nextWeek")}
            onClick={() => setWeek(addDays(week, 7))}
          >
            <ChevronRightIcon />
          </Button>
        </div>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="grid min-w-0 grid-cols-1 divide-y md:grid-cols-2 xl:grid-cols-4">
          {days.map((day) => {
            const dayKey = format(day, "yyyy-MM-dd");
            const entries = schedules
              .flatMap((schedule) => {
                const events: { at: number; kind: "next" | "last"; schedule: AgentSchedule }[] = [];
                if (
                  schedule.status === "active" &&
                  Number.isFinite(schedule.nextFireAt) &&
                  format(schedule.nextFireAt, "yyyy-MM-dd") === dayKey
                )
                  events.push({ at: schedule.nextFireAt, kind: "next", schedule });
                if (schedule.lastFireAt && format(schedule.lastFireAt, "yyyy-MM-dd") === dayKey)
                  events.push({ at: schedule.lastFireAt, kind: "last", schedule });
                return events;
              })
              .sort((a, b) => a.at - b.at);
            return (
              <div key={dayKey} className="flex min-h-40 min-w-0 flex-col gap-2 border-r p-3">
                <h3 className="text-xs font-semibold">
                  {day.toLocaleDateString(undefined, {
                    weekday: "short",
                    month: "short",
                    day: "numeric",
                  })}
                </h3>
                {entries.length === 0 ? (
                  <p className="text-xs text-muted-foreground">{t("planning:noEvents")}</p>
                ) : null}
                {entries.map(({ schedule, at, kind }) => (
                  <Button
                    key={[schedule.id, kind].join(":")}
                    variant="outline"
                    className="h-auto min-w-0 flex-col items-start gap-1 whitespace-normal p-2 text-left"
                    onClick={() => onSelect(schedule)}
                  >
                    <span className="text-xs text-muted-foreground">
                      {format(at, "HH:mm")} ·{" "}
                      {t(kind === "next" ? "planning:nextRun" : "planning:lastRun")}
                    </span>
                    <span className="w-full break-words text-sm">
                      {schedule.name || schedule.prompt.split("\n")[0]}
                    </span>
                    {schedule.timezone ? (
                      <span className="w-full break-all text-xs text-muted-foreground">
                        {schedule.timezone}
                      </span>
                    ) : null}
                  </Button>
                ))}
              </div>
            );
          })}
        </div>
      </ScrollArea>
    </section>
  );
}
