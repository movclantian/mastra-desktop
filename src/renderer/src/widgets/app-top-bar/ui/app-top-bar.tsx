import {
  ArrowLeftIcon,
  PanelBottomCloseIcon,
  PanelBottomOpenIcon,
  PanelRightCloseIcon,
  PanelRightOpenIcon,
  PlusIcon,
  Settings2Icon,
} from "lucide-react";
import { useWorkbench } from "@/entities/workbench";
import { OpenInIde } from "@/features/workspace-session";
import { Button } from "@/shared/ui/button";
import { Dotm3x3_6 } from "@/shared/ui/dotm-3x3-6";
import { PanelHeader } from "@/shared/ui/panel";
import { Separator } from "@/shared/ui/separator";
import { SidebarTrigger } from "@/shared/ui/sidebar";

export function AppTopBar({ onOpenLibrarySettings }: { onOpenLibrarySettings: () => void }) {
  const {
    threads,
    activeThreadId,
    createThread,
    activeView,
    setActiveView,
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
          : (threads.find((thread) => thread.id === activeThreadId)?.title ?? "MastraWork");
  const isCurrentThreadBusy = activeThreadId ? isThreadBusy(activeThreadId) : false;

  return (
    <PanelHeader className="relative z-10 px-4">
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        <SidebarTrigger className="-ml-1" />
        {activeView === "skills" && activeSkill ? (
          <>
            <Separator orientation="vertical" className="mx-1 h-4" />
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setActiveSkill(null)}
              className="h-7 cursor-pointer gap-1 px-2 text-xs font-normal text-muted-foreground hover:text-foreground"
            >
              <ArrowLeftIcon className="size-3.5" />
              返回插件市场
            </Button>
            <Separator orientation="vertical" className="mx-1 h-4" />
            <p className="truncate text-sm font-medium">{activeSkill.name}</p>
          </>
        ) : (
          <>
            <Separator orientation="vertical" className="mx-1 h-4" />
            <div className="flex min-w-0 items-center gap-2">
              <p className="truncate text-sm font-medium">{title}</p>
              {isCurrentThreadBusy && activeView === "chat" ? (
                <span
                  className="flex shrink-0 items-center text-primary"
                  title="当前会话正在运行中…"
                >
                  <Dotm3x3_6 size={12} dotSize={2} colorPreset="solid-theme" />
                </span>
              ) : null}
            </div>
          </>
        )}
      </div>
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
          <Button
            aria-label={workspacePanelOpen ? "收起工作区面板" : "展开工作区面板"}
            aria-pressed={workspacePanelOpen}
            onClick={() => setWorkspacePanelOpen(!workspacePanelOpen)}
            size="icon-sm"
            title={workspacePanelOpen ? "收起工作区面板" : "展开工作区面板"}
            variant={workspacePanelOpen ? "secondary" : "ghost"}
          >
            {workspacePanelOpen ? <PanelRightCloseIcon /> : <PanelRightOpenIcon />}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setActiveView("chat");
              void createThread();
            }}
          >
            <PlusIcon />
            新建会话
          </Button>
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
