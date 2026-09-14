import * as React from "react";
import { useDefaultLayout, usePanelRef } from "react-resizable-panels";
import { useWorkbench } from "@/entities/workbench";
import { CHAT_LAYOUT_ID, TERMINAL_DEFAULT_HEIGHT, TERMINAL_MIN_HEIGHT } from "@/shared/config";
import { cn } from "@/shared/lib";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/shared/ui/resizable";
import { ChatPanel } from "@/widgets/chat-panel";
import { TerminalDrawer } from "@/widgets/terminal-drawer";

const DRAWER_TRANSITION =
  "[&>[data-panel]]:transition-[flex-grow] [&>[data-panel]]:duration-200 [&>[data-panel]]:ease-linear";

const PANEL_CLIP = { overflow: "hidden" } as const;

function useDrawerTransition() {
  const [ready, setReady] = React.useState(false);
  const [resizing, setResizing] = React.useState(false);

  React.useEffect(() => {
    const frame = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  const onPointerDown = React.useCallback(() => {
    setResizing(true);
    const stop = () => {
      setResizing(false);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  }, []);

  return {
    className: ready && !resizing ? DRAWER_TRANSITION : undefined,
    resizing,
    handleProps: { onPointerDown },
  };
}

function drawerHandleProps(open: boolean) {
  return {
    disabled: !open,
    className: open ? "transition-colors hover:bg-primary" : "pointer-events-none opacity-0",
  };
}

export function ChatPage({ userId }: { userId?: string }) {
  const { user, terminalPanelOpen } = useWorkbench();
  const effectiveUserId = userId || user.id;

  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: `${CHAT_LAYOUT_ID}:${encodeURIComponent(effectiveUserId)}`,
    storage: localStorage,
    onlySaveAfterUserInteractions: true,
  });
  const terminalRef = usePanelRef();
  const transition = useDrawerTransition();

  React.useEffect(() => {
    const panel = terminalRef.current;
    if (!panel) return;
    if (terminalPanelOpen) panel.expand();
    else panel.collapse();
  }, [terminalPanelOpen, terminalRef]);

  return (
    <ResizablePanelGroup
      orientation="vertical"
      defaultLayout={defaultLayout}
      onLayoutChanged={onLayoutChanged}
      className={cn("min-h-0", transition.className)}
    >
      <ResizablePanel style={PANEL_CLIP} className="flex min-h-0 flex-col">
        <ChatPanel />
      </ResizablePanel>
      <ResizableHandle {...transition.handleProps} {...drawerHandleProps(terminalPanelOpen)} />
      <ResizablePanel
        panelRef={terminalRef}
        collapsible
        collapsedSize={0}
        defaultSize={TERMINAL_DEFAULT_HEIGHT}
        minSize={TERMINAL_MIN_HEIGHT}
        maxSize="60%"
        groupResizeBehavior="preserve-pixel-size"
        style={PANEL_CLIP}
      >
        <TerminalDrawer />
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}

export { ChatPage as ChatWithTerminal };
