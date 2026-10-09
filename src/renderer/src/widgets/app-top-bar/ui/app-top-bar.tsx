import { useLocation, useNavigate, useRouterState } from "@tanstack/react-router";
import {
  KeyboardIcon,
  PanelBottomCloseIcon,
  PanelBottomOpenIcon,
  PanelRightOpenIcon,
  Settings2Icon,
} from "lucide-react";
import { useIsThreadBusy, useThreadsQuery } from "@/entities/workbench/model/queries/threads";
import { viewFromPath } from "@/entities/workbench/model/types";
import { useWorkbenchStore } from "@/entities/workbench/model/workbench-store";
import { useAuth } from "@/features/auth";
import { CommandPaletteTrigger } from "@/features/command-palette";
import { OpenInIde } from "@/features/workspace-session";
import { useTranslation } from "@/shared/i18n";
import { Breadcrumb, BreadcrumbItem, BreadcrumbList, BreadcrumbPage } from "@/shared/ui/breadcrumb";
import { Button } from "@/shared/ui/button";
import { Dotm3x3_6 } from "@/shared/ui/dotm-3x3-6";
import { PanelHeader, WindowTitleBar } from "@/shared/ui/panel";
import { ScrollArea } from "@/shared/ui/scroll-area";
import { Separator } from "@/shared/ui/separator";
import { SidebarTrigger } from "@/shared/ui/sidebar";

import { ThreadSummaryButton } from "./thread-summary";

export function AppWindowBar() {
  const { t } = useTranslation();
  const setShortcutsHelpOpen = useWorkbenchStore((state) => state.setShortcutsHelpOpen);

  return (
    <WindowTitleBar className="border-b-0 bg-sidebar pl-2">
      <div className="app-no-drag flex shrink-0 items-center gap-1.5">
        <SidebarTrigger />
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => setShortcutsHelpOpen(true)}
          title={t("commandPalette:shortcutsGuide")}
          aria-label={t("commandPalette:shortcutsGuide")}
        >
          <KeyboardIcon />
        </Button>
      </div>
      <div className="min-w-0 flex-1 self-stretch" aria-hidden="true" />
      <CommandPaletteTrigger />
    </WindowTitleBar>
  );
}

export function AppTopBar() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { user } = useAuth();
  const userId = user?.id ?? "anonymous";
  const location = useLocation();
  const activeView = viewFromPath(location.pathname);
  const activeThreadId = useRouterState({
    select: (state) => (state.location.search as { thread?: string }).thread ?? null,
  });
  const threads = useThreadsQuery(userId).data ?? [];
  const workspacePanelOpen = useWorkbenchStore((state) => state.workspacePanelOpen);
  const setWorkspacePanelOpen = useWorkbenchStore((state) => state.setWorkspacePanelOpen);
  const terminalPanelOpen = useWorkbenchStore((state) => state.terminalPanelOpen);
  const setTerminalPanelOpen = useWorkbenchStore((state) => state.setTerminalPanelOpen);
  const isThreadBusy = useIsThreadBusy(userId);

  const title =
    activeView === "agents"
      ? t("sidebar:agents")
      : activeView === "skills"
        ? t("sidebar:skills")
        : activeView === "library"
          ? t("sidebar:library")
          : activeView === "schedules"
            ? t("sidebar:schedules")
            : (threads.find((thread) => thread.id === activeThreadId)?.title ?? "MastraWork");
  const isCurrentThreadBusy = activeThreadId ? isThreadBusy(activeThreadId) : false;

  return (
    <PanelHeader className="relative z-10 pl-4 pr-2">
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        <Breadcrumb className="min-w-0">
          <BreadcrumbList className="flex-nowrap text-xs sm:text-sm">
            <BreadcrumbItem className="min-w-0">
              <BreadcrumbPage className="flex min-w-0 items-center gap-2 font-medium">
                <span className="truncate">{title}</span>
                {isCurrentThreadBusy && activeView === "chat" ? (
                  <span
                    className="flex shrink-0 items-center text-primary"
                    title={t("topbar:runningTooltip")}
                  >
                    <Dotm3x3_6 size={12} dotSize={2} colorPreset="solid-theme" />
                  </span>
                ) : null}
              </BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
      </div>
      <ScrollArea orientation="horizontal" className="min-w-0 max-w-[70%] shrink">
        <div className="flex h-11 w-max items-center gap-2" data-horizontal-scroll="true">
          {/* 动态页面动作插槽: 供当前页面或详情模式挂载顶栏快捷按钮 */}
          <div id="app-top-bar-actions" className="flex items-center gap-2 shrink-0 empty:hidden" />
          {activeView === "chat" ? (
            <>
              <ThreadSummaryButton />
              <OpenInIde />
              <Separator orientation="vertical" className="mx-0.5 h-4" />
              <Button
                aria-label={
                  terminalPanelOpen ? t("topbar:collapseTerminal") : t("topbar:expandTerminal")
                }
                aria-pressed={terminalPanelOpen}
                onClick={() => setTerminalPanelOpen(!terminalPanelOpen)}
                size="icon-sm"
                title={
                  terminalPanelOpen ? t("topbar:collapseTerminal") : t("topbar:expandTerminal")
                }
                variant={terminalPanelOpen ? "secondary" : "ghost"}
              >
                {terminalPanelOpen ? <PanelBottomCloseIcon /> : <PanelBottomOpenIcon />}
              </Button>
            </>
          ) : null}
          {activeView === "library" ? (
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={t("topbar:librarySettings")}
              title={t("topbar:librarySettings")}
              onClick={() => {
                void navigate({
                  to: "/library",
                  search: (prev) => ({ ...prev, settings: true }),
                });
              }}
            >
              <Settings2Icon />
            </Button>
          ) : null}
        </div>
      </ScrollArea>
      {/* Keep this outside the scrollable actions, aligned with the workspace's collapse button. */}
      {activeView === "chat" && !workspacePanelOpen ? (
        <Button
          aria-label={t("topbar:expandWorkspace")}
          className="size-7 shrink-0"
          onClick={() => setWorkspacePanelOpen(true)}
          size="icon-sm"
          title={t("topbar:expandWorkspace")}
          variant="ghost"
        >
          <PanelRightOpenIcon />
        </Button>
      ) : null}
    </PanelHeader>
  );
}
