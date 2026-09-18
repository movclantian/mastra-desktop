import { Outlet, useLocation, useRouterState } from "@tanstack/react-router";
import * as React from "react";
import { useDefaultLayout, usePanelRef } from "react-resizable-panels";
import {
  hydrateWorkbenchStore,
  useOpenBrowserUrl,
  useWorkbenchStateReporter,
  useWorkbenchStore,
} from "@/entities/workbench";
import { useSyncThreadToStore } from "@/entities/workbench/model/queries/threads";
import { viewFromPath } from "@/entities/workbench/model/types";
import { useAuth } from "@/features/auth";
import { SettingsPage } from "@/pages/settings";
import { CHAT_HORIZONTAL_PADDING, SHELL_LAYOUT_ID, WORKSPACE_MIN_WIDTH } from "@/shared/config";
import { cn, useHorizontalWheelScroll, useLinkRouting, useWindowMinWidth } from "@/shared/lib";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/shared/ui/resizable";
import { SidebarInset, SidebarProvider } from "@/shared/ui/sidebar";
import { AppSidebar } from "@/widgets/app-sidebar";
import { AppTopBar } from "@/widgets/app-top-bar";
import { WorkspaceDrawer } from "@/widgets/workspace-drawer";

function WorkspaceDrawerContainer({
  open,
  minWidth,
  docked,
}: {
  open: boolean;
  minWidth: number;
  docked: boolean;
}) {
  return (
    <div
      style={{ minWidth: docked && open ? minWidth : 0 }}
      className={cn(
        "flex h-full min-h-0 w-full flex-col bg-background transition-opacity duration-200 ease-linear",
        open ? "opacity-100" : "pointer-events-none opacity-0",
      )}
    >
      <WorkspaceDrawer />
    </div>
  );
}

const DRAWER_TRANSITION =
  "[&>[data-panel]]:transition-[flex-grow] [&>[data-panel]]:duration-200 [&>[data-panel]]:ease-linear";

const PANEL_CLIP = { overflow: "hidden" } as const;
const SHELL_PANEL_IDS = ["content", "workspace"];
const CLOSED_SHELL_LAYOUT = { content: 100, workspace: 0 };

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

/**
 * 主应用壳:视图由路由驱动(Outlet),/settings 路由脱离主壳独立全屏。
 * hash 路由刷新/崩溃恢复后仍能还原当前视图;客户端 UI 态来自 zustand store。
 */
export function RootShell() {
  const { user } = useAuth();
  const location = useLocation();
  const activeView = viewFromPath(location.pathname);
  const urlThread = useRouterState({
    select: (state) => (state.location.search as { thread?: string }).thread ?? null,
  });

  const workspacePanelOpen = useWorkbenchStore((state) => state.workspacePanelOpen);
  const workspacePanelMode = useWorkbenchStore((state) => state.workspacePanelMode);
  const promptMinWidth = useWorkbenchStore((state) => state.promptMinWidth);
  const openBrowserUrl = useOpenBrowserUrl();

  // 登录后注入用户 + 从 localStorage 恢复面板模式与会话草稿(幂等)
  React.useEffect(() => {
    if (user) hydrateWorkbenchStore(user.id);
  }, [user]);

  useSyncThreadToStore(urlThread);
  useWorkbenchStateReporter(urlThread, activeView);
  useHorizontalWheelScroll();
  useLinkRouting(openBrowserUrl);

  const transition = useDrawerTransition();

  const chatMinWidth = promptMinWidth > 0 ? promptMinWidth + CHAT_HORIZONTAL_PADDING : 0;
  const frozenChatMinWidth = React.useRef(chatMinWidth);
  if (!transition.resizing) frozenChatMinWidth.current = chatMinWidth;
  const panelMinWidth = transition.resizing ? frozenChatMinWidth.current : chatMinWidth;
  const wantsWorkspace = workspacePanelOpen && activeView === "chat";
  const dockedWorkspace = wantsWorkspace && workspacePanelMode === "docked";

  const groupRef = React.useRef<HTMLDivElement>(null);
  useWindowMinWidth({
    elementRef: groupRef,
    contentMinWidth: panelMinWidth,
    reservedWidth: dockedWorkspace ? WORKSPACE_MIN_WIDTH : 0,
  });

  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: `${SHELL_LAYOUT_ID}:${encodeURIComponent(user?.id ?? "anonymous")}`,
    panelIds: SHELL_PANEL_IDS,
    storage: localStorage,
    onlySaveAfterUserInteractions: true,
  });
  const workspaceRef = usePanelRef();

  React.useEffect(() => {
    const panel = workspaceRef.current;
    if (!panel) return;
    if (wantsWorkspace && workspacePanelMode === "docked") panel.expand();
    else panel.collapse();
  }, [workspacePanelMode, wantsWorkspace, workspaceRef]);

  if (!user) return null;

  // 设置是全局页面:脱离主应用壳(主侧边栏/顶栏/工作台抽屉),占满整屏,
  // 通过设置菜单 sidebar 顶部的「返回应用」回到 chat
  if (location.pathname.startsWith("/settings")) {
    return <SettingsPage />;
  }

  return (
    <SidebarProvider className="h-svh overflow-hidden">
      <AppSidebar />
      <SidebarInset
        className={cn(
          "border shadow-sm",
          workspacePanelMode === "fullscreen" ? "overflow-visible" : "overflow-hidden",
        )}
      >
        <ResizablePanelGroup
          orientation="horizontal"
          elementRef={groupRef}
          defaultLayout={dockedWorkspace ? defaultLayout : CLOSED_SHELL_LAYOUT}
          onLayoutChanged={onLayoutChanged}
          className={cn("min-h-0 min-w-0 overflow-hidden bg-background", transition.className)}
        >
          <ResizablePanel
            id="content"
            minSize={panelMinWidth}
            style={PANEL_CLIP}
            className="flex min-w-0 flex-col"
          >
            <AppTopBar />
            <main className="relative z-0 flex min-h-0 flex-1 flex-col overflow-hidden">
              <Outlet />
            </main>
          </ResizablePanel>
          <ResizableHandle {...transition.handleProps} {...drawerHandleProps(dockedWorkspace)} />
          <ResizablePanel
            id="workspace"
            panelRef={workspaceRef}
            collapsible
            collapsedSize={0}
            minSize={WORKSPACE_MIN_WIDTH}
            groupResizeBehavior="preserve-pixel-size"
            style={
              workspacePanelMode === "docked"
                ? { ...PANEL_CLIP, ...(wantsWorkspace ? {} : { display: "none" }) }
                : { overflow: "visible", ...(wantsWorkspace ? {} : { display: "none" }) }
            }
          >
            <WorkspaceDrawerContainer
              docked={workspacePanelMode === "docked"}
              open={wantsWorkspace}
              minWidth={WORKSPACE_MIN_WIDTH}
            />
          </ResizablePanel>
        </ResizablePanelGroup>
      </SidebarInset>
    </SidebarProvider>
  );
}
