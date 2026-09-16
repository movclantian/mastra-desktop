import {
  PanelBottomCloseIcon,
  PanelBottomOpenIcon,
  PanelRightOpenIcon,
  Settings2Icon,
} from "lucide-react";
import { useWorkbench } from "@/entities/workbench";
import { OpenInIde } from "@/features/workspace-session";
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

export function AppTopBar({ onOpenLibrarySettings }: { onOpenLibrarySettings: () => void }) {
  const {
    threads,
    activeThreadId,
    activeView,
    activeSkill,
    setActiveSkill,
    workspacePanelOpen,
    setWorkspacePanelOpen,
    terminalPanelOpen,
    setTerminalPanelOpen,
    isThreadBusy,
  } = useWorkbench();

  const title =
    activeView === "agents"
      ? "专家"
      : activeView === "skills"
        ? "技能套件"
        : activeView === "library"
          ? "资料库"
          : activeView === "schedules"
            ? "已安排"
            : (threads.find((thread) => thread.id === activeThreadId)?.title ?? "MastraWork");
  const isCurrentThreadBusy = activeThreadId ? isThreadBusy(activeThreadId) : false;

  return (
    <PanelHeader className="relative z-10 pl-4 pr-2">
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        <SidebarTrigger className="-ml-1" />
        <Separator orientation="vertical" className="mx-1 h-4" />
        <Breadcrumb className="min-w-0">
          <BreadcrumbList className="flex-nowrap text-xs sm:text-sm">
            {activeView === "skills" && activeSkill ? (
              <>
                <BreadcrumbItem className="shrink-0">
                  <BreadcrumbLink
                    className="cursor-pointer"
                    render={<button type="button" onClick={() => setActiveSkill(null)} />}
                  >
                    技能套件
                  </BreadcrumbLink>
                </BreadcrumbItem>
                <BreadcrumbSeparator />
                <BreadcrumbItem className="min-w-0">
                  <BreadcrumbPage className="max-w-64 truncate font-medium">
                    {activeSkill.name}
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
                      title="当前会话正在运行中…"
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
      {/* 动态页面动作插槽: 供当前页面或详情模式挂载顶栏快捷按钮 */}
      <div id="app-top-bar-actions" className="flex items-center gap-2 shrink-0 empty:hidden" />
      {activeView === "chat" ? (
        <>
          <OpenInIde />
          <Separator orientation="vertical" className="mx-0.5 h-4" />
          <Button
            aria-label={terminalPanelOpen ? "收起终端面板" : "展开终端面板"}
            aria-pressed={terminalPanelOpen}
            onClick={() => setTerminalPanelOpen(!terminalPanelOpen)}
            size="icon-sm"
            title={terminalPanelOpen ? "收起终端面板" : "展开终端面板"}
            variant={terminalPanelOpen ? "secondary" : "ghost"}
          >
            {terminalPanelOpen ? <PanelBottomCloseIcon /> : <PanelBottomOpenIcon />}
          </Button>
          {/* 工作区面板显隐按钮随容器迁移:面板展开后,收起按钮迁移到工作区面板头部
              (原关闭按钮位置);顶栏只在面板收起时承载展开入口 —— 按钮在屏幕上
              始终贴近右缘,展开/收起前后位置完全一致 */}
          {!workspacePanelOpen ? (
            <Button
              aria-label="展开工作区面板"
              className="size-7 shrink-0"
              onClick={() => setWorkspacePanelOpen(true)}
              size="icon-sm"
              title="展开工作区面板"
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
          aria-label="资料库设置"
          title="资料库设置"
          onClick={onOpenLibrarySettings}
        >
          <Settings2Icon />
        </Button>
      ) : null}
    </PanelHeader>
  );
}
