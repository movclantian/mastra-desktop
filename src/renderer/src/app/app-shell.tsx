import * as React from "react";
import { useDefaultLayout, usePanelRef } from "react-resizable-panels";
import { useWorkbench, WorkbenchProvider } from "@/entities/workbench";
import { LoginScreen, useAuth } from "@/features/auth";
import { AgentHubPage } from "@/pages/agents";
import { ChatPage } from "@/pages/chat";
import { SchedulesPage } from "@/pages/schedules";
import { SettingsPage } from "@/pages/settings";
import { SkillHubPage } from "@/pages/skills";
import { CHAT_HORIZONTAL_PADDING, SHELL_LAYOUT_ID, WORKSPACE_MIN_WIDTH } from "@/shared/config";
import { cn, useHorizontalWheelScroll, useLinkRouting, useWindowMinWidth } from "@/shared/lib";
import { BlurFade } from "@/shared/ui/blur-fade";
import { Dotm3x3_1 } from "@/shared/ui/dotm-3x3-1";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/shared/ui/resizable";
import { SidebarInset, SidebarProvider } from "@/shared/ui/sidebar";
import { SmoothCursor } from "@/shared/ui/smooth-cursor";
import { Toaster } from "@/shared/ui/sonner";
import { TooltipProvider } from "@/shared/ui/tooltip";
import { AppSidebar } from "@/widgets/app-sidebar";
import { AppTopBar } from "@/widgets/app-top-bar";
import { WorkspaceDrawer } from "@/widgets/workspace-drawer";

const KnowledgeLibraryPage = React.lazy(() =>
  import("@/pages/library").then((module) => ({ default: module.KnowledgeLibraryPage })),
);

function PanelFallback() {
  return (
    <div className="flex size-full items-center justify-center bg-background">
      <Dotm3x3_1 size={20} dotSize={3} colorPreset="solid-theme" />
    </div>
  );
}

function WorkspaceDrawerContainer({ open, minWidth }: { open: boolean; minWidth: number }) {
  return (
    <div
      style={{ minWidth }}
      className={cn(
        "flex h-full min-h-0 w-full flex-col bg-background transition-opacity duration-200 ease-linear",
        open ? "opacity-100" : "opacity-0 pointer-events-none",
      )}
    >
      <WorkspaceDrawer />
    </div>
  );
}

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
    className: open
      ? "transition-colors hover:bg-primary"
      : "pointer-events-none !w-0 !border-0 opacity-0",
  };
}

function AppShell() {
  const { user, activeView, workspacePanelOpen, openBrowserUrl, promptMinWidth } = useWorkbench();
  const [librarySettingsOpen, setLibrarySettingsOpen] = React.useState(false);

  React.useEffect(() => {
    if (activeView !== "library") setLibrarySettingsOpen(false);
  }, [activeView]);

  useHorizontalWheelScroll();
  useLinkRouting(openBrowserUrl);

  const transition = useDrawerTransition();

  const chatMinWidth = promptMinWidth > 0 ? promptMinWidth + CHAT_HORIZONTAL_PADDING : 0;
  const frozenChatMinWidth = React.useRef(chatMinWidth);
  if (!transition.resizing) frozenChatMinWidth.current = chatMinWidth;
  const panelMinWidth = transition.resizing ? frozenChatMinWidth.current : chatMinWidth;
  const wantsWorkspace = workspacePanelOpen && activeView === "chat";

  const groupRef = React.useRef<HTMLDivElement>(null);
  useWindowMinWidth({
    elementRef: groupRef,
    contentMinWidth: panelMinWidth,
    reservedWidth: wantsWorkspace ? WORKSPACE_MIN_WIDTH : 0,
  });

  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: `${SHELL_LAYOUT_ID}:${encodeURIComponent(user.id)}`,
    storage: localStorage,
    onlySaveAfterUserInteractions: true,
  });
  const workspaceRef = usePanelRef();

  React.useEffect(() => {
    const panel = workspaceRef.current;
    if (!panel) return;
    if (wantsWorkspace) panel.expand();
    else panel.collapse();
  }, [wantsWorkspace, workspaceRef]);

  // 设置是全局页面:脱离主应用壳(主侧边栏/顶栏/工作台抽屉),占满整屏,
  // 通过设置菜单 sidebar 顶部的「返回应用」回到 chat
  if (activeView === "settings") {
    return <SettingsPage />;
  }

  return (
    <SidebarProvider className="h-svh overflow-hidden">
      <AppSidebar />
      <SidebarInset className="overflow-hidden border shadow-sm">
        <ResizablePanelGroup
          orientation="horizontal"
          elementRef={groupRef}
          defaultLayout={defaultLayout}
          onLayoutChanged={onLayoutChanged}
          className={cn("min-h-0 min-w-0 overflow-hidden bg-background", transition.className)}
        >
          <ResizablePanel
            minSize={panelMinWidth}
            style={PANEL_CLIP}
            className="flex min-w-0 flex-col"
          >
            <AppTopBar onOpenLibrarySettings={() => setLibrarySettingsOpen(true)} />
            <main className="relative z-0 flex min-h-0 flex-1 flex-col overflow-hidden">
              {activeView === "agents" ? (
                <BlurFade key="agent-hub" duration={0.2} blur="3px" className="size-full">
                  <AgentHubPage />
                </BlurFade>
              ) : activeView === "skills" ? (
                <BlurFade key="skill-hub" duration={0.2} blur="3px" className="size-full">
                  <SkillHubPage />
                </BlurFade>
              ) : activeView === "library" ? (
                <BlurFade key="library-hub" duration={0.2} blur="3px" className="size-full">
                  <React.Suspense fallback={<PanelFallback />}>
                    <KnowledgeLibraryPage
                      settingsOpen={librarySettingsOpen}
                      onSettingsOpenChange={setLibrarySettingsOpen}
                    />
                  </React.Suspense>
                </BlurFade>
              ) : activeView === "schedules" ? (
                <BlurFade key="schedules" duration={0.2} blur="3px" className="size-full">
                  <SchedulesPage />
                </BlurFade>
              ) : (
                <ChatPage userId={user.id} />
              )}
            </main>
          </ResizablePanel>
          <ResizableHandle {...transition.handleProps} {...drawerHandleProps(wantsWorkspace)} />
          <ResizablePanel
            panelRef={workspaceRef}
            collapsible
            collapsedSize={0}
            minSize={WORKSPACE_MIN_WIDTH}
            groupResizeBehavior="preserve-pixel-size"
            style={PANEL_CLIP}
          >
            <WorkspaceDrawerContainer open={wantsWorkspace} minWidth={WORKSPACE_MIN_WIDTH} />
          </ResizablePanel>
        </ResizablePanelGroup>
      </SidebarInset>
    </SidebarProvider>
  );
}

export default function App(): React.JSX.Element {
  const { user, token, setSession } = useAuth();

  if (!user || !token) {
    return (
      <TooltipProvider>
        <LoginScreen onAuthenticated={setSession} />
        <SmoothCursor />
        <Toaster position="bottom-right" />
      </TooltipProvider>
    );
  }

  return (
    <WorkbenchProvider user={user}>
      <TooltipProvider>
        <AppShell />
        <SmoothCursor />
        <Toaster position="bottom-right" />
      </TooltipProvider>
    </WorkbenchProvider>
  );
}
