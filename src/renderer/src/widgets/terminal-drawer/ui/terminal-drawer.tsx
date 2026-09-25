import { useRouterState } from "@tanstack/react-router";
import { PanelRightOpenIcon, PlusIcon, TerminalIcon, XIcon } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { useThreadsQuery } from "@/entities/workbench/model/queries/threads";
import { useWorkbenchStore } from "@/entities/workbench/model/workbench-store";
import { TerminalSession } from "@/entities/workbench/ui/terminal-session";
import { useAuth } from "@/features/auth";
import { formatShortcutDisplay, isMacPlatform } from "@/features/command-palette";
import { useTranslation } from "@/shared/i18n";
import { cn } from "@/shared/lib";
import { Button } from "@/shared/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "@/shared/ui/context-menu";
import { PanelHeader, PanelSurface } from "@/shared/ui/panel";

const TAB_DND_TYPE = "application/x-mastra-tab";

export function TerminalPanel() {
  const { t } = useTranslation();
  const isMac = React.useMemo(() => isMacPlatform(), []);
  const { user } = useAuth();
  const threads = useThreadsQuery(user?.id ?? "anonymous").data ?? [];
  const activeThreadId = useRouterState({
    select: (state) => (state.location.search as { thread?: string }).thread ?? null,
  });
  const terminalPanelOpen = useWorkbenchStore((state) => state.terminalPanelOpen);
  const setTerminalPanelOpen = useWorkbenchStore((state) => state.setTerminalPanelOpen);
  const terminalRequest = useWorkbenchStore((state) => state.terminalRequest);

  const sessionIds = useWorkbenchStore((state) => state.terminalDrawerSessionIds);
  const activeSessionId = useWorkbenchStore((state) => state.activeTerminalDrawerSessionId);
  const addSession = useWorkbenchStore((state) => state.addTerminalDrawerSession);
  const closeSession = useWorkbenchStore((state) => state.closeTerminalDrawerSession);
  const setActiveSessionId = useWorkbenchStore((state) => state.setActiveTerminalDrawerSessionId);
  const reorderSession = useWorkbenchStore((state) => state.reorderTerminalDrawerSession);
  const moveTerminalTab = useWorkbenchStore((state) => state.moveTerminalTab);

  const activeThread = threads.find((t) => t.id === activeThreadId);
  const activeWorkspacePath = activeThread?.metadata?.workspacePath;

  const [handledRequestId, setHandledRequestId] = React.useState<number | null>(null);
  const pendingRequest = terminalRequest?.id === handledRequestId ? null : terminalRequest;

  const draggedSessionRef = React.useRef<string | null>(null);
  const [draggingSessionId, setDraggingSessionId] = React.useState<string | null>(null);
  const [dragOverSessionId, setDragOverSessionId] = React.useState<string | null>(null);

  return (
    <PanelSurface>
      <PanelHeader className="h-9 justify-between border-b px-2 py-0">
        <div
          className="flex h-full min-w-0 flex-1 items-center gap-1 overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
          }}
          onDrop={(e) => {
            e.preventDefault();
            setDragOverSessionId(null);
            setDraggingSessionId(null);
            const rawData = e.dataTransfer.getData(TAB_DND_TYPE);
            if (rawData) {
              try {
                const data = JSON.parse(rawData);
                if (data.kind !== "terminal") {
                  toast.info(t("workspace:onlyTerminalSupported"));
                  return;
                }
                if (data.source === "workspace") {
                  moveTerminalTab("workspace", "terminal", data.id, data.title);
                }
              } catch {}
            }
          }}
        >
          {sessionIds.map((id, index) => {
            const isSelected = id === activeSessionId;
            const title = t("workspace:terminalIndex", {
              index: index + 1,
            });
            return (
              <ContextMenu key={id}>
                <ContextMenuTrigger>
                  <button
                    draggable
                    onDragStart={(e) => {
                      draggedSessionRef.current = id;
                      setDraggingSessionId(id);
                      e.dataTransfer.setData(
                        TAB_DND_TYPE,
                        JSON.stringify({
                          source: "terminal",
                          id,
                          kind: "terminal",
                          title,
                        }),
                      );
                      e.dataTransfer.effectAllowed = "move";
                    }}
                    onDragOver={(e) => {
                      e.preventDefault();
                      e.dataTransfer.dropEffect = "move";
                      if (dragOverSessionId !== id) setDragOverSessionId(id);
                    }}
                    onDragLeave={() => {
                      if (dragOverSessionId === id) setDragOverSessionId(null);
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setDragOverSessionId(null);
                      setDraggingSessionId(null);
                      const rawData = e.dataTransfer.getData(TAB_DND_TYPE);
                      if (rawData) {
                        try {
                          const data = JSON.parse(rawData);
                          if (data.kind !== "terminal") {
                            toast.info(t("workspace:onlyTerminalSupported"));
                            return;
                          }
                          if (data.source === "terminal") {
                            reorderSession(data.id, id);
                          } else if (data.source === "workspace") {
                            moveTerminalTab("workspace", "terminal", data.id, data.title, id);
                          }
                        } catch {
                          if (draggedSessionRef.current)
                            reorderSession(draggedSessionRef.current, id);
                        }
                      } else if (draggedSessionRef.current) {
                        reorderSession(draggedSessionRef.current, id);
                      }
                      draggedSessionRef.current = null;
                    }}
                    onDragEnd={() => {
                      draggedSessionRef.current = null;
                      setDraggingSessionId(null);
                      setDragOverSessionId(null);
                    }}
                    onClick={() => setActiveSessionId(id)}
                    className={cn(
                      "group relative flex h-7 max-w-44 min-w-0 items-center gap-1.5 rounded-md border px-2 text-xs font-normal transition-colors cursor-pointer select-none",
                      isSelected
                        ? "border-border bg-background text-foreground shadow-xs font-medium"
                        : "border-transparent text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                      draggingSessionId === id && "opacity-50",
                      dragOverSessionId === id && "ring-2 ring-primary/40",
                    )}
                    title={title}
                    type="button"
                  >
                    <TerminalIcon
                      className={cn(
                        "size-3 shrink-0",
                        isSelected ? "text-primary" : "text-muted-foreground",
                      )}
                    />
                    <span className="truncate">{title}</span>
                    {sessionIds.length > 1 ? (
                      <span
                        role="button"
                        tabIndex={0}
                        aria-label={`${t("workspace:closeTab")} ${title}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          closeSession(id);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.stopPropagation();
                            closeSession(id);
                          }
                        }}
                        className="ml-0.5 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground cursor-pointer"
                      >
                        <XIcon className="size-3" />
                      </span>
                    ) : null}
                  </button>
                </ContextMenuTrigger>
                <ContextMenuContent className="w-48">
                  <ContextMenuGroup>
                    <ContextMenuLabel className="max-w-44 truncate">{title}</ContextMenuLabel>
                    <ContextMenuItem onClick={() => closeSession(id)}>
                      <XIcon className="text-muted-foreground" />
                      <span>{t("workspace:closeTab")}</span>
                      <ContextMenuShortcut>
                        {formatShortcutDisplay(["Mod", "W"], isMac)}
                      </ContextMenuShortcut>
                    </ContextMenuItem>
                    <ContextMenuItem
                      disabled={sessionIds.length <= 1}
                      onClick={() => {
                        for (const other of sessionIds) {
                          if (other !== id) closeSession(other);
                        }
                      }}
                    >
                      <span>{t("workspace:closeOtherTabs")}</span>
                    </ContextMenuItem>
                    <ContextMenuItem
                      onClick={() => moveTerminalTab("terminal", "workspace", id, title)}
                    >
                      <PanelRightOpenIcon className="text-muted-foreground" />
                      <span>{t("workspace:moveToWorkspace")}</span>
                    </ContextMenuItem>
                  </ContextMenuGroup>
                  <ContextMenuSeparator />
                  <ContextMenuGroup>
                    <ContextMenuItem onClick={() => addSession()}>
                      <PlusIcon className="text-muted-foreground" />
                      <span>{t("workspace:newTerminal")}</span>
                    </ContextMenuItem>
                  </ContextMenuGroup>
                </ContextMenuContent>
              </ContextMenu>
            );
          })}
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={() => addSession()}
            className="size-6 shrink-0"
            title={t("workspace:newTerminal")}
            aria-label={t("workspace:newTerminal")}
          >
            <PlusIcon className="size-3.5" />
          </Button>
        </div>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={() => setTerminalPanelOpen(false)}
          className="size-6 shrink-0"
          title={t("workspace:collapse")}
          aria-label={t("workspace:collapse")}
        >
          <XIcon className="size-3.5" />
        </Button>
      </PanelHeader>
      <div className="relative min-h-0 flex-1">
        {sessionIds.map((id) => (
          <div
            key={`${id}:${activeThreadId ?? "none"}`}
            className={`size-full ${id === activeSessionId ? "block" : "hidden"}`}
          >
            <TerminalSession
              sessionId={id}
              active={id === activeSessionId && terminalPanelOpen}
              cwd={activeWorkspacePath}
              threadId={activeThreadId ?? undefined}
              pendingRequest={id === activeSessionId ? pendingRequest : null}
              onHandledRequest={() => {
                if (pendingRequest) setHandledRequestId(pendingRequest.id);
              }}
            />
          </div>
        ))}
      </div>
    </PanelSurface>
  );
}

export { TerminalSession };
