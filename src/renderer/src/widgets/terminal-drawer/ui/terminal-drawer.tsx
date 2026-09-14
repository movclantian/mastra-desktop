import { PlusIcon, XIcon } from "lucide-react";
import { nanoid } from "nanoid";
import * as React from "react";
import { TerminalSession, useWorkbench } from "@/entities/workbench";
import { Button } from "@/shared/ui/button";
import { PanelHeader, PanelSurface } from "@/shared/ui/panel";

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
    (id: string, e: React.MouseEvent) => {
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
        <div className="flex min-w-0 items-center gap-1 overflow-x-auto">
          {sessionIds.map((id, index) => {
            const isActive = id === activeSessionId;
            return (
              <div
                key={id}
                onClick={() => setActiveSessionId(id)}
                className={`flex h-7 items-center gap-1.5 rounded-md px-2 text-xs cursor-pointer select-none transition-colors ${
                  isActive
                    ? "bg-background text-foreground shadow-xs"
                    : "text-muted-foreground hover:bg-muted/60"
                }`}
              >
                <span>终端 {index + 1}</span>
                {sessionIds.length > 1 ? (
                  <button
                    type="button"
                    onClick={(e) => closeSession(id, e)}
                    className="size-3.5 rounded hover:bg-muted p-0.5"
                  >
                    <XIcon className="size-full" />
                  </button>
                ) : null}
              </div>
            );
          })}
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={addSession}
            className="size-6"
            title="新建终端会话"
          >
            <PlusIcon className="size-3.5" />
          </Button>
        </div>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={() => setTerminalPanelOpen(false)}
          className="size-6"
          title="收起终端"
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
