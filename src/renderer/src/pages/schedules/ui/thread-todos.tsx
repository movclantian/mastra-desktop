import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ExternalLinkIcon, RefreshCwIcon } from "lucide-react";
import { useState } from "react";
import type { WorkThread } from "@/entities/workbench/model/types";
import { useTranslation } from "@/shared/i18n";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { ScrollArea } from "@/shared/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/shared/ui/select";
import { fetchDisplayState } from "@/widgets/chat-panel/api/chat-api";

/** Existing native session tasks are the only source of truth. */
export function ThreadTodos({
  threads,
  resourceId,
  activeThreadId,
}: {
  threads: WorkThread[];
  resourceId: string;
  activeThreadId: string | null;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [selected, setSelected] = useState(activeThreadId ?? threads[0]?.id ?? "");
  const threadId = threads.some((thread) => thread.id === selected)
    ? selected
    : (threads[0]?.id ?? "");
  const query = useQuery({
    queryKey: ["thread-todos", resourceId, threadId],
    enabled: Boolean(threadId),
    queryFn: () => fetchDisplayState(threadId, resourceId),
    refetchInterval: 15_000,
  });
  const tasks = query.data?.displayState?.tasks ?? [];
  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b p-3">
        <Select value={threadId} onValueChange={(value) => value && setSelected(value)}>
          <SelectTrigger className="w-full sm:w-64" aria-label={t("planning:selectThread")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {threads.map((thread) => (
              <SelectItem key={thread.id} value={thread.id}>
                {thread.title}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="min-w-0 flex-1 text-xs text-muted-foreground">{t("planning:todosHint")}</p>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={t("planning:refresh")}
          onClick={() => void query.refetch()}
          disabled={!threadId}
        >
          <RefreshCwIcon />
        </Button>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        {query.isError ? (
          <p role="alert" className="p-4 text-sm text-destructive">
            {t("planning:todosFailed")}
          </p>
        ) : null}
        {threadId && query.isPending ? (
          <p className="p-4 text-sm text-muted-foreground">{t("common:loading")}</p>
        ) : null}
        {!threadId || (!query.isPending && !query.isError && tasks.length === 0) ? (
          <p className="p-4 text-sm text-muted-foreground">{t("planning:noTodos")}</p>
        ) : null}
        <div className="divide-y px-4">
          {tasks.map((task) => (
            <article key={task.id} className="flex min-w-0 items-start gap-3 py-3">
              <Badge variant={task.status === "completed" ? "secondary" : "outline"}>
                {t(`planning:taskStatuses.${task.status}`)}
              </Badge>
              <p className="min-w-0 flex-1 whitespace-pre-wrap break-words text-sm">
                {task.content}
              </p>
            </article>
          ))}
        </div>
        {threadId ? (
          <Button
            className="m-3"
            size="sm"
            variant="ghost"
            onClick={() =>
              void navigate({
                to: "/chat",
                search: (previous) => ({ ...previous, thread: threadId }),
              })
            }
          >
            <ExternalLinkIcon />
            {t("planning:openThread")}
          </Button>
        ) : null}
      </ScrollArea>
    </section>
  );
}
