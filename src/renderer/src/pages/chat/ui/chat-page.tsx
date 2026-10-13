import * as React from "react";
import { useDefaultLayout, usePanelRef } from "react-resizable-panels";
import { useWorkbenchStore } from "@/entities/workbench/model/workbench-store";
import { useAuth } from "@/features/auth";
import {
  CHAT_LAYOUT_ID,
  PANEL_CLIP,
  TERMINAL_DEFAULT_HEIGHT,
  TERMINAL_MIN_HEIGHT,
} from "@/shared/config";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/shared/ui/resizable";
import { ChatPanel } from "@/widgets/chat-panel";
import { TerminalDrawer } from "@/widgets/terminal-drawer";

function drawerHandleProps(open: boolean) {
  return {
    disabled: !open,
    className: open
      ? "transition-colors hover:bg-primary"
      : "pointer-events-none !h-0 !border-0 opacity-0",
  };
}

export function ChatPage({ userId }: { userId?: string }) {
  const { user: authUser } = useAuth();
  const terminalPanelOpen = useWorkbenchStore((state) => state.terminalPanelOpen);
  const effectiveUserId = userId || authUser?.id || "anonymous";

  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: `${CHAT_LAYOUT_ID}:${encodeURIComponent(effectiveUserId)}`,
    storage: localStorage,
    onlySaveAfterUserInteractions: true,
  });
  const terminalRef = usePanelRef();

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
      className="min-h-0"
    >
      <ResizablePanel style={PANEL_CLIP} className="flex min-h-0 flex-col">
        <ChatPanel />
      </ResizablePanel>
      <ResizableHandle {...drawerHandleProps(terminalPanelOpen)} />
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
