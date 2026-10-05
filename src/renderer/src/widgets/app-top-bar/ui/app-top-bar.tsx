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
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/shared/ui/breadcrumb";
import { Button } from "@/shared/ui/button";
import { Dotm3x3_6 } from "@/shared/ui/dotm-3x3-6";
import { PanelHeader } from "@/shared/ui/panel";
import { Separator } from "@/shared/ui/separator";
import { SidebarTrigger } from "@/shared/ui/sidebar";

import { ThreadSummaryButton } from "./thread-summary";

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
  const activeSkillPath = useRouterState({
    select: (state) => (state.location.search as { skill?: string }).skill ?? null,
  });
  const workspacePanelOpen = useWorkbenchStore((state) => state.workspacePanelOpen);
  const setWorkspacePanelOpen = useWorkbenchStore((state) => state.setWorkspacePanelOpen);
  const terminalPanelOpen = useWorkbenchStore((state) => state.terminalPanelOpen);
  const setTerminalPanelOpen = useWorkbenchStore((state) => state.setTerminalPanelOpen);
  const setShortcutsHelpOpen = useWorkbenchStore((state) => state.setShortcutsHelpOpen);
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
        <SidebarTrigger className="-ml-1" />
        <Separator orientation="vertical" className="mx-1 h-4" />
        <Breadcrumb className="min-w-0">
          <BreadcrumbList className="flex-nowrap text-xs sm:text-sm">
            {activeView === "skills" && activeSkillPath ? (
              <>
                <BreadcrumbItem className="shrink-0">
                  <BreadcrumbLink
                    className="cursor-pointer"
                    render={
                      <button
                        type="button"
                        onClick={() =>
                          void navigate({
                            to: "/skills",
                            search: (prev) => ({ ...prev, skill: undefined }),
                          })
                        }
                      />
                    }
                  >
                    {t("sidebar:skills")}
                  </BreadcrumbLink>
                </BreadcrumbItem>
                <BreadcrumbSeparator />
                <BreadcrumbItem className="min-w-0">
                  <BreadcrumbPage className="max-w-64 truncate font-medium">
                    {activeSkillPath.split("/").pop() || activeSkillPath}
                  </BreadcrumbPage>
                </BreadcrumbItem>
              </>
            ) : (
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
            )}
          </BreadcrumbList>
        </Breadcrumb>
      </div>
      {/* 全局命令面板快捷入口与快捷键指南 */}
      <div className="flex items-center gap-1.5 shrink-0 mx-1">
        <CommandPaletteTrigger />
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
            title={terminalPanelOpen ? t("topbar:collapseTerminal") : t("topbar:expandTerminal")}
            variant={terminalPanelOpen ? "secondary" : "ghost"}
          >
            {terminalPanelOpen ? <PanelBottomCloseIcon /> : <PanelBottomOpenIcon />}
          </Button>
          {/* 工作区面板显隐按钮随容器迁移:面板展开后,收起按钮迁移到工作区面板头部
              (原关闭按钮位置);顶栏只在面板收起时承载展开入口 —— 按钮在屏幕上
              始终贴近右缘,展开/收起前后位置完全一致 */}
          {!workspacePanelOpen ? (
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
    </PanelHeader>
  );
}
