import { skipToken, useQuery } from "@tanstack/react-query";
import { useRouterState } from "@tanstack/react-router";
import {
  CopyIcon,
  FileIcon,
  GlobeIcon,
  Loader2Icon,
  NotebookPenIcon,
  PackageIcon,
  PlugIcon,
  SquareCheckIcon,
} from "lucide-react";
import { toast } from "sonner";
import { buildRequestModel, summarizeThreadRequest } from "@/entities/workbench";
import {
  fetchThreadContext,
  type ThreadContextItem,
  workspaceRawFileUrl,
} from "@/entities/workbench/api/workbench-api";
import { useProviderConfigQuery } from "@/entities/workbench/model/queries/config";
import { useOpenBrowserUrl, useWorkbenchStore } from "@/entities/workbench/model/workbench-store";
import { useAuth } from "@/features/auth";
import { useTranslation } from "@/shared/i18n";
import {
  QueueSection,
  QueueSectionContent,
  QueueSectionLabel,
  QueueSectionTrigger,
} from "@/shared/ui/ai-elements/queue";
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

export function ThreadSummaryButton() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const userId = user?.id ?? "anonymous";
  const threadId = useRouterState({
    select: (state) => (state.location.search as { thread?: string }).thread ?? null,
  });
  const providers = useProviderConfigQuery().data?.providers ?? [];
  const selection = useWorkbenchStore((state) => state.modelSelection);
  const open = useWorkbenchStore((state) => state.threadSummaryOpen);
  const setOpen = useWorkbenchStore((state) => state.setThreadSummaryOpen);
  const requestFilePreview = useWorkbenchStore((state) => state.requestFilePreview);
  const openBrowser = useOpenBrowserUrl();
  const provider = providers.find((item) => item.id === selection?.providerId);
  const model = provider && selection ? buildRequestModel(provider, selection.modelId) : undefined;
  const context = useQuery({
    queryKey: ["thread-context", userId, threadId],
    queryFn: threadId ? () => fetchThreadContext(threadId) : skipToken,
    enabled: open && Boolean(threadId),
  });
  const summary = useQuery({
    queryKey: ["thread-summary", userId, threadId, model],
    queryFn: threadId ? () => summarizeThreadRequest(threadId, userId, model) : skipToken,
    enabled: false,
    retry: false,
  });
  const groups = [
    { key: "capabilities", kinds: ["skill", "mcp"], icon: <PlugIcon className="size-3.5" /> },
    { key: "artifacts", kinds: ["artifact"], icon: <PackageIcon className="size-3.5" /> },
    { key: "web", kinds: ["web"], icon: <GlobeIcon className="size-3.5" /> },
    { key: "files", kinds: ["file"], icon: <FileIcon className="size-3.5" /> },
  ];
  const preview = (item: ThreadContextItem) => {
    if (!threadId) return;
    if (item.kind === "web" && item.url) {
      setOpen(false);
      openBrowser(item.url);
    } else if (item.kind === "file" || item.kind === "artifact") {
      const url =
        item.url ?? (item.path ? workspaceRawFileUrl(threadId, userId, item.path) : undefined);
      if (!url) return;
      setOpen(false);
      requestFilePreview(threadId, {
        id: item.id,
        filename: item.label,
        mediaType: item.mediaType ?? "",
        url,
      });
    }
  };
  return (
    <>
      <Button
        aria-label={t("topbar:btnAriaLabel")}
        title={t("topbar:btnTitle")}
        disabled={!threadId}
        onClick={() => setOpen(true)}
        size="icon-sm"
        variant="ghost"
      >
        <NotebookPenIcon />
      </Button>
      <Dialog open={open && Boolean(threadId)} onOpenChange={setOpen}>
        <DialogContent className="flex max-h-[min(85vh,44rem)] flex-col sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{t("topbar:summaryTitle")}</DialogTitle>
            <DialogDescription>{t("topbar:contextDesc")}</DialogDescription>
          </DialogHeader>
          <ScrollArea className="min-h-0 flex-1">
            <div className="flex min-w-0 flex-col gap-3 pr-2 text-sm">
              {context.isPending ? (
                <p className="flex items-center gap-2 text-muted-foreground">
                  <Loader2Icon className="size-4 animate-spin" />
                  {t("common:loading")}
                </p>
              ) : context.isError ? (
                <Button variant="outline" size="sm" onClick={() => void context.refetch()}>
                  {t("common:refresh")}
                </Button>
              ) : (
                <>
                  {context.data.latestRequest && (
                    <section className="flex min-w-0 flex-col gap-1">
                      <h3 className="text-xs text-muted-foreground">{t("topbar:latestRequest")}</h3>
                      <p className="line-clamp-4 whitespace-pre-wrap break-words">
                        {context.data.latestRequest}
                      </p>
                    </section>
                  )}
                  {groups.map((group) => {
                    const items = context.data.items.filter((item) =>
                      group.kinds.includes(item.kind),
                    );
                    return (
                      <QueueSection key={group.key} defaultOpen={items.length > 0}>
                        <QueueSectionTrigger>
                          <QueueSectionLabel
                            label={t(`topbar:context.${group.key}`)}
                            count={items.length}
                            icon={group.icon}
                          />
                        </QueueSectionTrigger>
                        <QueueSectionContent>
                          {items.length ? (
                            <ul className="flex flex-col gap-1 py-1">
                              {items.map((item) => (
                                <li key={`${item.kind}:${item.id}`} className="min-w-0">
                                  {item.kind === "skill" || item.kind === "mcp" ? (
                                    <span className="flex min-w-0 items-start gap-2 px-3 py-1 text-xs">
                                      <span className="shrink-0 text-muted-foreground">
                                        {item.kind === "mcp" ? "MCP" : t("topbar:skill")}
                                      </span>
                                      <span className="break-all">{item.label}</span>
                                    </span>
                                  ) : (
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      className="h-auto w-full justify-start gap-2 px-3 py-1.5 text-left"
                                      onClick={() => preview(item)}
                                    >
                                      {group.icon}
                                      <span className="min-w-0 flex-1">
                                        <span className="block whitespace-normal break-all">
                                          {item.label}
                                        </span>
                                        {(item.path || item.url) && (
                                          <span
                                            className="block truncate text-xs text-muted-foreground"
                                            title={item.path ?? item.url}
                                          >
                                            {item.path ?? item.url}
                                          </span>
                                        )}
                                      </span>
                                    </Button>
                                  )}
                                </li>
                              ))}
                            </ul>
                          ) : (
                            <p className="px-3 py-2 text-xs text-muted-foreground">
                              {t("common:empty")}
                            </p>
                          )}
                        </QueueSectionContent>
                      </QueueSection>
                    );
                  })}
                </>
              )}
              {summary.isFetching && (
                <p className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2Icon className="size-4 animate-spin" />
                  {t("topbar:summaryExtracting")}
                </p>
              )}
              {summary.isError && (
                <p className="text-xs text-destructive">{t("topbar:summaryFailed")}</p>
              )}
              {summary.data && (
                <section className="flex min-w-0 flex-col gap-2 border-t pt-3">
                  <h3 className="text-xs text-muted-foreground">{t("topbar:summarySection")}</h3>
                  <p className="whitespace-pre-wrap break-words">{summary.data.summary}</p>
                  {summary.data.todos.length > 0 && (
                    <>
                      <h3 className="text-xs text-muted-foreground">{t("topbar:todosSection")}</h3>
                      <ul className="flex flex-col gap-1">
                        {summary.data.todos.map((todo, index) => (
                          <li className="flex min-w-0 gap-2" key={`${index}:${todo}`}>
                            <SquareCheckIcon className="mt-0.5 size-4 shrink-0" />
                            <span className="break-words">{todo}</span>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </section>
              )}
            </div>
          </ScrollArea>
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              disabled={summary.isFetching}
              onClick={() => void summary.refetch()}
            >
              {t(summary.data ? "topbar:regenerate" : "topbar:generateSummary")}
            </Button>
            {summary.data && (
              <Button
                size="sm"
                onClick={() => {
                  if (!summary.data) return;
                  void navigator.clipboard
                    .writeText(
                      [summary.data.summary, ...summary.data.todos.map((todo) => `- ${todo}`)].join(
                        "\n\n",
                      ),
                    )
                    .then(() => toast.success(t("topbar:copiedSummary")))
                    .catch(() => toast.error(t("common:error")));
                }}
              >
                <CopyIcon />
                {t("topbar:copyAll")}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
