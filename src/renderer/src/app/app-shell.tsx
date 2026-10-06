import { fetchEventSource } from "@microsoft/fetch-event-source";
import { Outlet, useLocation, useRouterState } from "@tanstack/react-router";
import * as React from "react";
import { useDefaultLayout, useGroupRef } from "react-resizable-panels";
import {
  hydrateWorkbenchStore,
  useOpenBrowserUrl,
  useWorkbenchStateReporter,
  useWorkbenchStore,
} from "@/entities/workbench";
import { useDesktopSettingsQuery } from "@/entities/workbench/model/queries/config";
import { useSelectThread, useSyncThreadToStore } from "@/entities/workbench/model/queries/threads";
import { viewFromPath } from "@/entities/workbench/model/types";
import { useAuth } from "@/features/auth";
import { GlobalCommandPalette } from "@/features/command-palette";
import { SettingsPage } from "@/pages/settings";
import { MASTRA_SERVER_URL } from "@/shared/api";
import { CHAT_HORIZONTAL_PADDING, SHELL_LAYOUT_ID, WORKSPACE_MIN_WIDTH } from "@/shared/config";
import { useTranslation } from "@/shared/i18n";
import { cn, useHorizontalWheelScroll, useLinkRouting, useWindowMinWidth } from "@/shared/lib";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/shared/ui/resizable";
import { SidebarInset, SidebarProvider, useSidebar } from "@/shared/ui/sidebar";
import { AppSidebar } from "@/widgets/app-sidebar";
import { AppTopBar } from "@/widgets/app-top-bar";
import { WorkspaceDrawer } from "@/widgets/workspace-drawer";
import { BrowserGuestLayer } from "@/widgets/workspace-drawer/ui/browser-guest-layer";
import { DesktopNotificationSchema } from "../../../shared/window-contract";

function WorkspaceDrawerContainer({ open }: { open: boolean }) {
  return (
    <div
      // The resizable panel owns the minimum width. Keeping a second
      // min-width here makes a collapsed panel overflow its zero-width shell
      // and leaves the native browser surface visible without its sidebar.
      style={{ minWidth: 0 }}
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
const MAX_RESTORED_WORKSPACE_PERCENT = 42;
const MAX_WORKSPACE_WIDTH = 760;

function MainGlobalCommandPalette() {
  const { toggleSidebar } = useSidebar();
  return <GlobalCommandPalette toggleSidebar={toggleSidebar} />;
}

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
  useDesktopNotifications();
  return (
    <>
      <WorkbenchShell />
      <BrowserGuestLayer />
    </>
  );
}

function useDesktopNotifications() {
  const { user, token } = useAuth();
  const { t } = useTranslation();
  const settings = useDesktopSettingsQuery().data;
  const selectThread = useSelectThread();
  const desktopEnabled = settings?.desktopNotifications === true;
  const scheduleEnabled = settings?.scheduledTaskNotifications === true;
  React.useEffect(
    () =>
      window.api.window.onNotificationClick((notification) => {
        if (notification.resourceId === user?.id) selectThread(notification.threadId);
      }),
    [selectThread, user?.id],
  );
  React.useEffect(() => {
    if (!user || !token || (!desktopEnabled && !scheduleEnabled)) return;
    const controller = new AbortController();
    const seen = new Set<string>();
    void fetchEventSource(`${MASTRA_SERVER_URL}/work/desktop-notifications`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
      openWhenHidden: true,
      async onopen(response) {
        if (response.status === 401 || response.status === 403) controller.abort();
        if (!response.ok || !response.headers.get("content-type")?.includes("text/event-stream"))
          throw new Error(`Notification subscription failed: ${response.status}`);
      },
      onmessage(event) {
        if (event.event !== "notification") return;
        const parsed = DesktopNotificationSchema.safeParse(JSON.parse(event.data));
        if (!parsed.success || parsed.data.resourceId !== user.id) return;
        const notification = parsed.data;
        if (
          !(notification.kind === "schedule" ? scheduleEnabled : desktopEnabled) ||
          seen.has(notification.id)
        )
          return;
        seen.add(notification.id);
        if (seen.size > 200) seen.delete(seen.values().next().value as string);
        void window.api.window
          .notify({
            ...notification,
            body:
              notification.body ||
              t(
                notification.kind === "schedule"
                  ? "settings:general.scheduledTaskReady"
                  : "settings:general.taskReady",
              ),
          })
          .catch((error) => console.error("Desktop notification failed", error));
      },
      onclose() {
        throw new Error("Notification subscription closed");
      },
      onerror() {
        return 2_000;
      },
    }).catch((error) => {
      if (!controller.signal.aborted) console.error("Notification subscription failed", error);
    });
    return () => controller.abort();
  }, [user?.id, token, desktopEnabled, scheduleEnabled, t]);
}

function WorkbenchShell() {
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
    if (user) {
      hydrateWorkbenchStore(user.id);
    }
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
  const layoutRef = useGroupRef();

  React.useEffect(() => {
    const layout = layoutRef.current;
    if (!layout) return;
    if (wantsWorkspace && workspacePanelMode === "docked") {
      const current = layout.getLayout();
      if ((current.workspace ?? 0) < 1) {
        const savedSize =
          typeof defaultLayout?.workspace === "number" && defaultLayout.workspace > 0
            ? defaultLayout.workspace
            : 36;
        const groupWidth = groupRef.current?.clientWidth ?? 0;
        const maxByWidth = groupWidth > 0 ? (MAX_WORKSPACE_WIDTH / groupWidth) * 100 : 100;
        const workspace = Math.max(
          24,
          Math.min(MAX_RESTORED_WORKSPACE_PERCENT, maxByWidth, savedSize),
        );
        layout.setLayout({ content: 100 - workspace, workspace });
      }
      return;
    }
    layout.setLayout(CLOSED_SHELL_LAYOUT);
  }, [defaultLayout?.workspace, layoutRef, workspacePanelMode, wantsWorkspace]);

  if (!user) return null;

  // 设置是全局页面:脱离主应用壳(主侧边栏/顶栏/工作台抽屉),占满整屏,
  // 通过设置菜单 sidebar 顶部的「返回应用」回到 chat
  if (location.pathname.startsWith("/settings")) {
    return (
      <>
        <SettingsPage />
        {/* SettingsPage has no collapsible main sidebar, so the palette omits
            the main-sidebar toggle command on this route. */}
        <GlobalCommandPalette />
      </>
    );
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
          groupRef={layoutRef}
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
            collapsible
            collapsedSize={0}
            minSize={WORKSPACE_MIN_WIDTH}
            groupResizeBehavior="preserve-relative-size"
            style={
              workspacePanelMode === "docked"
                ? { ...PANEL_CLIP, ...(wantsWorkspace ? {} : { display: "none" }) }
                : { overflow: "visible", ...(wantsWorkspace ? {} : { display: "none" }) }
            }
          >
            <WorkspaceDrawerContainer open={wantsWorkspace} />
          </ResizablePanel>
        </ResizablePanelGroup>
      </SidebarInset>
      <MainGlobalCommandPalette />
    </SidebarProvider>
  );
}
