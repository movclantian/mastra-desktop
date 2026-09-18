import { useQueryClient } from "@tanstack/react-query";
import { useRouterState } from "@tanstack/react-router";
import { Code2Icon, FileDiffIcon, RefreshCwIcon } from "lucide-react";
import * as React from "react";
import { fetchChangeContent } from "@/entities/workbench";
import { useThreadChangesQuery } from "@/entities/workbench/model/queries/workspace";
import { qk } from "@/entities/workbench/model/query-keys";
import { useAuth } from "@/features/auth";
import { useTranslation } from "@/shared/i18n";
import { cn } from "@/shared/lib";
import { Button } from "@/shared/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/shared/ui/empty";
import { FlickeringGrid } from "@/shared/ui/flickering-grid";
import { PanelHeader } from "@/shared/ui/panel";
import { ScrollArea } from "@/shared/ui/scroll-area";
import { groupWorkspaceChanges } from "../lib/changes";
import { CodeChangeGroup as WorkspaceCodeChangeGroup } from "./code-changes";

export function ChangesWorkspace({ active }: { active: boolean }) {
  const { t } = useTranslation();
  const { user: authUser } = useAuth();
  const user = authUser ?? { id: "anonymous", name: "Guest", email: "guest@example.com" };
  const activeThreadId = useRouterState({
    select: (state) => (state.location.search as { thread?: string }).thread ?? null,
  });
  const changesQuery = useThreadChangesQuery(user.id, activeThreadId, {
    refetchInterval: active ? 1_000 : undefined,
    enabled: active,
  });
  const changes = changesQuery.data ?? [];
  const queryClient = useQueryClient();
  const [expandedFiles, setExpandedFiles] = React.useState<Set<string>>(new Set());
  const [expandedChanges, setExpandedChanges] = React.useState<Set<string>>(new Set());
  const loading = changesQuery.isPending || changesQuery.isFetching;

  const refresh = React.useCallback(async () => {
    const result = await changesQuery.refetch();
    if (result.error) throw result.error;
  }, [changesQuery]);

  React.useEffect(() => {
    setExpandedFiles((current) => {
      const valid = new Set(changes.map((item) => item.path));
      const kept = new Set([...current].filter((path) => valid.has(path)));
      if (kept.size === 0 && changes.length > 0) kept.add(changes[changes.length - 1].path);
      return kept;
    });
    setExpandedChanges((current) => {
      const valid = new Set(changes.map((item) => item.id));
      const kept = new Set([...current].filter((id) => valid.has(id)));
      if (kept.size === 0 && changes.length > 0) kept.add(changes[changes.length - 1].id);
      return kept;
    });
  }, [changes]);

  const orderedChanges = React.useMemo(() => [...changes].reverse(), [changes]);
  const changeGroups = React.useMemo(() => groupWorkspaceChanges(orderedChanges), [orderedChanges]);
  const fetchContent = React.useCallback(
    (changeId: string, side: "before" | "after") => {
      if (!activeThreadId) return Promise.resolve(null);
      return queryClient.fetchQuery({
        queryKey: qk.changeContent(activeThreadId, changeId, side),
        queryFn: () => fetchChangeContent(activeThreadId, changeId, user.id, side),
        staleTime: Infinity,
      });
    },
    [activeThreadId, queryClient, user.id],
  );
  return (
    <div className="flex size-full min-h-0 flex-col bg-muted/10">
      <PanelHeader className="h-10 shrink-0 justify-between border-b bg-muted/30 px-3">
        <div className="flex min-w-0 items-center gap-2">
          <FileDiffIcon className="size-4 shrink-0 text-muted-foreground" />
          <span className="text-xs font-medium">{t("workspace:codeChanges")}</span>
          <span className="text-[10px] text-muted-foreground">
            {t("workspace:codeChangesSummary", {
              files: changeGroups.length,
              records: changes.length,
            })}
          </span>
        </div>
        <Button
          aria-label={t("workspace:refreshChanges")}
          className="size-7"
          onClick={() => void refresh()}
          size="icon"
          title={t("workspace:refreshChanges")}
          variant="ghost"
        >
          <RefreshCwIcon className={cn("size-3.5", loading && "animate-spin")} />
        </Button>
      </PanelHeader>
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-2 p-3">
          {!activeThreadId ? (
            <Empty className="py-12 text-muted-foreground">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <FileDiffIcon />
                </EmptyMedia>
                <EmptyTitle>{t("workspace:selectSession")}</EmptyTitle>
                <EmptyDescription>{t("workspace:fileChangesHereDesc")}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : orderedChanges.length === 0 ? (
            /* 变更历史空态 = 闪烁点阵网格,像一块待写入的终端屏幕 */
            <div className="relative overflow-hidden rounded-lg">
              <FlickeringGrid
                className="pointer-events-none absolute inset-0 [mask-image:radial-gradient(ellipse_at_center,white,transparent_78%)]"
                squareSize={3}
                gridGap={7}
                flickerChance={0.14}
                maxOpacity={0.22}
                color="var(--primary)"
              />
              <Empty className="relative z-10 bg-transparent py-12 text-muted-foreground">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <Code2Icon />
                  </EmptyMedia>
                  <EmptyTitle>{t("workspace:noCodeChanges")}</EmptyTitle>
                  <EmptyDescription>{t("workspace:noCodeChangesDesc")}</EmptyDescription>
                </EmptyHeader>
              </Empty>
            </div>
          ) : (
            changeGroups.map((group) => (
              <WorkspaceCodeChangeGroup
                expandedChanges={expandedChanges}
                group={group}
                key={group.path}
                onChangeOpen={(changeId, open) => {
                  setExpandedChanges((current) => {
                    const next = new Set(current);
                    if (open) next.add(changeId);
                    else next.delete(changeId);
                    return next;
                  });
                }}
                onOpenChange={(open) => {
                  setExpandedFiles((current) => {
                    const next = new Set(current);
                    if (open) next.add(group.path);
                    else next.delete(group.path);
                    return next;
                  });
                }}
                open={expandedFiles.has(group.path)}
                fetchContent={fetchContent}
              />
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
