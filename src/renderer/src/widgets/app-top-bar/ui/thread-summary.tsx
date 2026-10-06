import { skipToken, useQuery } from "@tanstack/react-query";
import { useRouterState } from "@tanstack/react-router";
import {
  CopyIcon,
  FileIcon,
  GlobeIcon,
  GripHorizontalIcon,
  Loader2Icon,
  NotebookPenIcon,
  PackageIcon,
  PinIcon,
  PinOffIcon,
  PlugIcon,
  RefreshCwIcon,
  SquareCheckIcon,
  XIcon,
} from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { buildRequestModel, summarizeThreadRequest } from "@/entities/workbench";
import {
  fetchThreadContext,
  type ThreadContextItem,
  workspaceRawFileUrl,
} from "@/entities/workbench/api/workbench-api";
import { useProviderConfigQuery } from "@/entities/workbench/model/queries/config";
import { qk } from "@/entities/workbench/model/query-keys";
import { useOpenBrowserUrl, useWorkbenchStore } from "@/entities/workbench/model/workbench-store";
import { useAuth } from "@/features/auth";
import { useTranslation } from "@/shared/i18n";
import { MessageResponse } from "@/shared/ui/ai-elements/message";
import {
  QueueSection,
  QueueSectionContent,
  QueueSectionLabel,
  QueueSectionTrigger,
} from "@/shared/ui/ai-elements/queue";
import { Button } from "@/shared/ui/button";
import { ScrollArea } from "@/shared/ui/scroll-area";

const PANEL_WIDTH = 384; // w-96,与样式保持一致,用于视口内取位

function clampPanelPosition(x: number, y: number) {
  const width = Math.min(PANEL_WIDTH, window.innerWidth - 16);
  return {
    x: Math.max(8, Math.min(x, window.innerWidth - width - 8)),
    y: Math.max(8, Math.min(y, window.innerHeight - 160)),
  };
}

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
    queryKey: qk.threadContext(userId, threadId),
    queryFn: threadId ? () => fetchThreadContext(threadId) : skipToken,
    enabled: open && Boolean(threadId),
    staleTime: 0,
  });
  const summary = useQuery({
    queryKey: ["thread-summary", userId, threadId, model],
    queryFn: threadId ? () => summarizeThreadRequest(threadId, userId, model) : skipToken,
    enabled: false,
    retry: false,
  });

  // 固定模式下锚定在按钮正下方;拖拽模式(header 手柄)后自由放置,可再切回固定吸附。
  const buttonRef = React.useRef<HTMLButtonElement>(null);
  const panelRef = React.useRef<HTMLDivElement>(null);
  const [mode, setMode] = React.useState<"docked" | "floating">("docked");
  const [pos, setPos] = React.useState({ x: 0, y: 0 });
  const dockBelow = React.useCallback(() => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = Math.min(PANEL_WIDTH, window.innerWidth - 16);
    setPos(clampPanelPosition(rect.right - width, rect.bottom + 6));
  }, []);
  React.useEffect(() => {
    if (!open) return;
    const reposition = () => {
      if (mode === "docked") dockBelow();
      else setPos((current) => clampPanelPosition(current.x, current.y));
    };
    reposition();
    window.addEventListener("resize", reposition);
    return () => window.removeEventListener("resize", reposition);
  }, [dockBelow, mode, open]);

  const dragRef = React.useRef<{ px: number; py: number; x: number; y: number } | null>(null);
  const onHandlePointerDown = (event: React.PointerEvent) => {
    if (mode !== "floating" || (event.target as HTMLElement).closest("button")) return;
    dragRef.current = { px: event.clientX, py: event.clientY, x: pos.x, y: pos.y };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onHandlePointerMove = (event: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    setPos(clampPanelPosition(drag.x + event.clientX - drag.px, drag.y + event.clientY - drag.py));
  };
  const onHandlePointerUp = () => {
    dragRef.current = null;
  };

  // 悬浮面板:点外部/Escape 关闭
  React.useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (panelRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, setOpen]);

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
  const workingMemory = context.data?.workingMemory;
  const copyContent = [
    workingMemory?.content,
    summary.data?.summary,
    ...(summary.data?.todos.map((todo) => `- ${todo}`) ?? []),
  ]
    .filter(Boolean)
    .join("\n\n");
  return (
    <>
      <Button
        ref={buttonRef}
        aria-label={t("topbar:btnAriaLabel")}
        title={t("topbar:btnTitle")}
        disabled={!threadId}
        onClick={() => setOpen(true)}
        size="icon-sm"
        variant="ghost"
      >
        <NotebookPenIcon />
      </Button>
      {open && threadId ? (
        <div
          className="fixed z-50 flex min-h-0 w-96 max-w-[calc(100vw-1rem)] flex-col overflow-hidden rounded-lg border bg-background shadow-lg"
          ref={panelRef}
          style={{
            left: pos.x,
            top: pos.y,
            maxHeight: `min(70dvh, 40rem, calc(100dvh - ${pos.y + 8}px))`,
          }}
        >
          <div
            className={`flex shrink-0 items-center gap-1 border-b px-2 py-1.5 ${
              mode === "floating" ? "cursor-grab active:cursor-grabbing" : ""
            }`}
            onPointerDown={onHandlePointerDown}
            onPointerMove={onHandlePointerMove}
            onPointerUp={onHandlePointerUp}
            onPointerCancel={onHandlePointerUp}
          >
            {mode === "floating" ? (
              <GripHorizontalIcon className="size-3.5 shrink-0 text-muted-foreground" />
            ) : null}
            <span className="min-w-0 flex-1 truncate font-medium text-sm">
              {t("topbar:summaryTitle")}
            </span>
            <Button
              aria-label={t("common:refresh")}
              title={t("common:refresh")}
              disabled={context.isFetching}
              onClick={() => void context.refetch()}
              size="icon-xs"
              variant="ghost"
            >
              <RefreshCwIcon className={context.isFetching ? "animate-spin" : undefined} />
            </Button>
            <Button
              aria-label={mode === "docked" ? t("topbar:dragMode") : t("topbar:dockMode")}
              onClick={() => {
                if (mode === "docked") setMode("floating");
                else {
                  setMode("docked");
                }
              }}
              size="icon-xs"
              title={mode === "docked" ? t("topbar:dragMode") : t("topbar:dockMode")}
              variant="ghost"
            >
              {mode === "docked" ? <PinOffIcon /> : <PinIcon />}
            </Button>
            <Button
              aria-label={t("common:close")}
              onClick={() => setOpen(false)}
              size="icon-xs"
              variant="ghost"
            >
              <XIcon />
            </Button>
          </div>
          <ScrollArea className="min-h-0 min-w-0 flex-1">
            <div className="flex min-w-0 flex-col gap-3 px-3 py-2 text-sm">
              {context.isPending ? (
                <p className="flex items-center gap-2 text-muted-foreground">
                  <Loader2Icon className="size-4 animate-spin" />
                  {t("common:loading")}
                </p>
              ) : context.isError ? (
                <Button onClick={() => void context.refetch()} size="sm" variant="outline">
                  {t("common:refresh")}
                </Button>
              ) : (
                <>
                  <section className="flex min-w-0 flex-col gap-2">
                    <div className="flex flex-wrap items-center justify-between gap-1 text-xs text-muted-foreground">
                      <h3>{t("settings:memory.workingMemoryTitle")}</h3>
                      <span>
                        {t(
                          context.data.workingMemory.scope === "thread"
                            ? "settings:memory.scopeThread"
                            : "settings:memory.scopeResource",
                        )}
                      </span>
                    </div>
                    {context.data.workingMemory.content ? (
                      context.data.workingMemory.format === "json" ? (
                        <pre className="whitespace-pre-wrap break-all font-mono text-xs">
                          {context.data.workingMemory.content}
                        </pre>
                      ) : (
                        <MessageResponse
                          mode="static"
                          className="h-auto min-w-0 text-xs [overflow-wrap:anywhere] [&_h1]:text-sm [&_h2]:text-sm [&_h3]:text-xs"
                        >
                          {context.data.workingMemory.content}
                        </MessageResponse>
                      )
                    ) : (
                      <p className="text-xs text-muted-foreground">
                        {t(
                          context.data.workingMemory.enabled
                            ? "topbar:workingMemoryEmpty"
                            : "topbar:workingMemoryDisabled",
                        )}
                      </p>
                    )}
                  </section>
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
                                <li className="min-w-0" key={`${item.kind}:${item.id}`}>
                                  {item.kind === "skill" || item.kind === "mcp" ? (
                                    <span className="flex min-w-0 items-start gap-2 px-3 py-1 text-xs">
                                      <span className="shrink-0 text-muted-foreground">
                                        {item.kind === "mcp" ? "MCP" : t("topbar:skill")}
                                      </span>
                                      <span className="break-all">{item.label}</span>
                                    </span>
                                  ) : (
                                    <Button
                                      className="h-auto w-full justify-start gap-2 px-3 py-1.5 text-left"
                                      onClick={() => preview(item)}
                                      size="sm"
                                      variant="ghost"
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
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t px-2 py-1.5">
            <Button
              disabled={summary.isFetching}
              onClick={() => void summary.refetch()}
              size="sm"
              variant="outline"
            >
              {t(summary.data ? "topbar:regenerate" : "topbar:generateSummary")}
            </Button>
            {copyContent && (
              <Button
                size="sm"
                onClick={() => {
                  void navigator.clipboard
                    .writeText(copyContent)
                    .then(() => toast.success(t("topbar:copiedSummary")))
                    .catch(() => toast.error(t("common:error")));
                }}
              >
                <CopyIcon />
                {t("topbar:copyAll")}
              </Button>
            )}
          </div>
        </div>
      ) : null}
    </>
  );
}
