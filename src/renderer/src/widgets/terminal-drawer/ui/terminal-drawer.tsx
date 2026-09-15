import { PlusIcon, TerminalIcon, XIcon } from "lucide-react";
import { nanoid } from "nanoid";
import * as React from "react";
import { TerminalSession, useWorkbench } from "@/entities/workbench";
import { Button } from "@/shared/ui/button";
import { PanelHeader, PanelSurface } from "@/shared/ui/panel";
import { Tabs, TabsList, TabsTrigger } from "@/shared/ui/tabs";

export function TerminalPanel() {
  const { activeThreadId, threads, terminalPanelOpen, setTerminalPanelOpen, terminalRequest } =
    useWorkbench();

  const activeThread = threads.find((t) => t.id === activeThreadId);
  const activeWorkspacePath = activeThread?.metadata?.workspacePath;

  const [sessionIds, setSessionIds] = React.useState<string[]>(() => [nanoid(6)]);
  const [activeSessionId, setActiveSessionId] = React.useState<string>(sessionIds[0]);
  const [handledRequestId, setHandledRequestId] = React.useState<number | null>(null);
  const pendingRequest = terminalRequest?.id === handledRequestId ? null : terminalRequest;

  const addSession = React.useCallback(() => {
    const nextId = nanoid(6);
    setSessionIds((prev) => [...prev, nextId]);
    setActiveSessionId(nextId);
  }, []);

  const closeSession = React.useCallback(
    (id: string, e: React.MouseEvent | React.SyntheticEvent) => {
      e.stopPropagation();
      setSessionIds((prev) => {
        if (prev.length <= 1) return prev;
        const next = prev.filter((s) => s !== id);
        if (activeSessionId === id) {
          setActiveSessionId(next[next.length - 1]);
        }
        return next;
      });
    },
    [activeSessionId],
  );

  return (
    <PanelSurface>
      <PanelHeader className="h-9 justify-between border-b px-2 py-0">
        <div className="flex h-full min-w-0 flex-1 items-center gap-1 overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <Tabs
            value={activeSessionId}
            onValueChange={(val) => {
              if (val) setActiveSessionId(val);
            }}
            className="flex-row items-center gap-1 shrink-0"
          >
            <TabsList className="h-7 gap-1 border-0 bg-transparent p-0">
              {sessionIds.map((id, index) => (
                <TabsTrigger
                  key={id}
                  value={id}
                  className="group relative h-7 gap-1.5 rounded-md border border-transparent px-2 text-xs font-normal text-muted-foreground data-active:border-border data-active:bg-background data-active:text-foreground data-active:shadow-xs hover:bg-muted/60 hover:text-foreground"
                >
                  <TerminalIcon className="size-3 text-muted-foreground group-data-active:text-primary" />
                  <span>终端 {index + 1}</span>
                  {sessionIds.length > 1 ? (
                    <span
                      role="button"
                      tabIndex={0}
                      aria-label={`关闭终端 ${index + 1}`}
                      onClick={(e) => closeSession(id, e)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.stopPropagation();
                          closeSession(id, e);
                        }
                      }}
                      className="ml-0.5 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground cursor-pointer"
                    >
                      <XIcon className="size-3" />
                    </span>
                  ) : null}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={addSession}
            className="size-6 shrink-0"
            title="新建终端会话"
            aria-label="新建终端会话"
          >
            <PlusIcon className="size-3.5" />
          </Button>
        </div>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={() => setTerminalPanelOpen(false)}
          className="size-6 shrink-0"
          title="收起终端"
          aria-label="收起终端"
        >
          <XIcon className="size-3.5" />
        </Button>
      </PanelHeader>
      <div className="relative min-h-0 flex-1">
        {sessionIds.map((id) => (
          <div key={id} className={`size-full ${id === activeSessionId ? "block" : "hidden"}`}>
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
