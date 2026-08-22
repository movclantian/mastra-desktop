import { PanelBottomIcon, PanelRightIcon, PlusIcon, Settings2Icon } from "lucide-react";
import * as React from "react";

import { ChatPanel } from "@/components/app/chat";
import { PanelHeader } from "@/components/app/primitives";
import { SettingsDialog } from "@/components/app/settings";
import { AppSidebar } from "@/components/app/sidebar";
import { SkillHub } from "@/components/app/skills";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { Toaster } from "@/components/ui/sonner";
import { Spinner } from "@/components/ui/spinner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useWorkbench, WorkbenchProvider } from "@/lib/workbench";

const WorkspacePanel = React.lazy(() => import("@/components/app/workbench/workspace-panel"));
const TerminalPanel = React.lazy(() => import("@/components/app/workbench/terminal-panel"));
const KnowledgeLibrary = React.lazy(() =>
  import("@/components/app/library").then((module) => ({ default: module.KnowledgeLibrary })),
);

function PanelFallback() {
  return (
    <div className="flex size-full items-center justify-center bg-background">
      <Spinner className="size-5" />
    </div>
  );
}

function httpLinkFromTarget(target: EventTarget | null): HTMLAnchorElement | null {
  if (!(target instanceof Element)) return null;
  const anchor = target.closest("a[href]") as HTMLAnchorElement | null;
  if (!anchor || anchor.hasAttribute("download")) return null;
  try {
    return /^https?:$/i.test(new URL(anchor.href).protocol) ? anchor : null;
  } catch {
    return null;
  }
}

function AppShell() {
  const {
    threads,
    activeThreadId,
    createThread,
    libraryOpen,
    setLibraryOpen,
    skillOpen,
    workspacePanelOpen,
    setWorkspacePanelOpen,
    terminalPanelOpen,
    setTerminalPanelOpen,
    openBrowserUrl,
  } = useWorkbench();
  const [librarySettingsOpen, setLibrarySettingsOpen] = React.useState(false);
  const [workspaceWidth, setWorkspaceWidth] = React.useState(560);
  const [isDraggingWorkspace, setIsDraggingWorkspace] = React.useState(false);
  const [terminalHeight, setTerminalHeight] = React.useState(280);
  const [isDraggingTerminal, setIsDraggingTerminal] = React.useState(false);

  React.useEffect(() => {
    if (!libraryOpen) setLibrarySettingsOpen(false);
  }, [libraryOpen]);

  const activeThread = threads.find((t) => t.id === activeThreadId);

  // 工作区水平拖拽拉伸
  const handleWorkspaceResizeStart = React.useCallback(
    (event: React.PointerEvent) => {
      event.preventDefault();
      setIsDraggingWorkspace(true);
      const startX = event.clientX;
      const startWidth = workspaceWidth;

      const onPointerMove = (e: PointerEvent) => {
        const deltaX = startX - e.clientX;
        const newWidth = Math.max(340, Math.min(window.innerWidth * 0.7, startWidth + deltaX));
        setWorkspaceWidth(newWidth);
      };

      const onPointerUp = () => {
        setIsDraggingWorkspace(false);
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
      };

      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
    },
    [workspaceWidth],
  );

  // 终端垂直拖拽拉伸
  const handleTerminalResizeStart = React.useCallback(
    (event: React.PointerEvent) => {
      event.preventDefault();
      setIsDraggingTerminal(true);
      const startY = event.clientY;
      const startHeight = terminalHeight;

      const onPointerMove = (e: PointerEvent) => {
        const deltaY = startY - e.clientY;
        const newHeight = Math.max(140, Math.min(window.innerHeight * 0.6, startHeight + deltaY));
        setTerminalHeight(newHeight);
      };

      const onPointerUp = () => {
        setIsDraggingTerminal(false);
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
      };

      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
    },
    [terminalHeight],
  );

  React.useEffect(() => {
    const routeClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0) return;
      const anchor = httpLinkFromTarget(event.target);
      if (!anchor || anchor.hasAttribute("download")) return;
      event.preventDefault();
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        void window.api.openExternal(anchor.href);
      } else {
        openBrowserUrl(anchor.href);
      }
    };
    const routeAuxClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 1) return;
      const anchor = httpLinkFromTarget(event.target);
      if (!anchor || anchor.hasAttribute("download")) return;
      event.preventDefault();
      void window.api.openExternal(anchor.href);
    };
    document.addEventListener("click", routeClick, true);
    document.addEventListener("auxclick", routeAuxClick, true);
    return () => {
      document.removeEventListener("click", routeClick, true);
      document.removeEventListener("auxclick", routeAuxClick, true);
    };
  }, [openBrowserUrl]);

  // 顶栏标题按页面切换;新建会话只属于会话页,资料库设置固定在资料库页右上角
  const title = skillOpen
    ? "技能套件"
    : libraryOpen
      ? "资料库"
      : (activeThread?.title ?? "MastraWork");

  const showWorkspace = workspacePanelOpen && !skillOpen && !libraryOpen;

  return (
    <SidebarProvider className="h-svh overflow-hidden">
      <AppSidebar />
      <SidebarInset className="overflow-hidden border shadow-sm">
        <div className="flex size-full min-h-0 min-w-0 overflow-hidden bg-background">
          {/* 左侧主体(聊天 / 技能 / 资料库 / 终端) */}
          <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
            <PanelHeader className="relative z-10 h-12 shrink-0 px-4">
              <div className="flex items-center gap-1.5 min-w-0 flex-1">
                <SidebarTrigger className="-ml-1" />
                <Separator orientation="vertical" className="mx-1 h-4" />
                <p className="truncate text-sm font-medium">{title}</p>
              </div>
              {!skillOpen && !libraryOpen ? (
                <>
                  <Button
                    aria-label="切换终端面板"
                    aria-pressed={terminalPanelOpen}
                    onClick={() => setTerminalPanelOpen(!terminalPanelOpen)}
                    size="icon-sm"
                    title="切换终端面板"
                    variant={terminalPanelOpen ? "secondary" : "ghost"}
                  >
                    <PanelBottomIcon />
                  </Button>
                  <Button
                    aria-label="切换工作区面板"
                    aria-pressed={workspacePanelOpen}
                    onClick={() => setWorkspacePanelOpen(!workspacePanelOpen)}
                    size="icon-sm"
                    title="切换工作区面板"
                    variant={workspacePanelOpen ? "secondary" : "ghost"}
                  >
                    <PanelRightIcon />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setLibraryOpen(false);
                      void createThread();
                    }}
                  >
                    <PlusIcon />
                    新建会话
                  </Button>
                </>
              ) : null}
              {libraryOpen ? (
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label="资料库设置"
                  title="资料库设置"
                  onClick={() => setLibrarySettingsOpen(true)}
                >
                  <Settings2Icon />
                </Button>
              ) : null}
            </PanelHeader>

            <main className="relative z-0 flex min-h-0 flex-1 flex-col overflow-hidden">
              {skillOpen ? (
                <SkillHub />
              ) : libraryOpen ? (
                <React.Suspense fallback={<PanelFallback />}>
                  <KnowledgeLibrary
                    settingsOpen={librarySettingsOpen}
                    onSettingsOpenChange={setLibrarySettingsOpen}
                  />
                </React.Suspense>
              ) : (
                <div className="flex size-full min-h-0 flex-col overflow-hidden">
                  <div className="min-h-0 flex-1 overflow-hidden">
                    <ChatPanel />
                  </div>

                  {/* 底部终端抽屉:平滑滑入/滑出与可拉伸高度 */}
                  <aside
                    style={{
                      height: terminalPanelOpen ? `${terminalHeight}px` : 0,
                    }}
                    className={cn(
                      "relative flex w-full min-w-0 flex-col border-t bg-background overflow-hidden shrink-0",
                      !isDraggingTerminal && "transition-[height,opacity] duration-200 ease-linear",
                      terminalPanelOpen
                        ? "opacity-100"
                        : "border-t-0 opacity-0 pointer-events-none",
                    )}
                  >
                    {terminalPanelOpen ? (
                      <div
                        onPointerDown={handleTerminalResizeStart}
                        className="group/resizer absolute -top-1.5 inset-x-0 z-30 h-3 cursor-row-resize select-none"
                      >
                        <div className="my-auto h-px w-full bg-border group-hover/resizer:h-0.5 group-hover/resizer:bg-primary transition-colors" />
                      </div>
                    ) : null}
                    <div
                      style={{ height: `${terminalHeight}px` }}
                      className={cn(
                        "flex w-full min-h-0 shrink-0 flex-col",
                        !isDraggingTerminal && "transition-transform duration-200 ease-linear",
                        terminalPanelOpen ? "translate-y-0" : "translate-y-4",
                      )}
                    >
                      <React.Suspense fallback={<PanelFallback />}>
                        <TerminalPanel />
                      </React.Suspense>
                    </div>
                  </aside>
                </div>
              )}
            </main>
          </div>

          {/* 右侧工作区抽屉:平滑滑入/滑出与可拉伸宽度 */}
          <aside
            style={{
              width: showWorkspace ? `${workspaceWidth}px` : 0,
            }}
            className={cn(
              "relative flex h-full min-h-0 flex-col border-l bg-background overflow-hidden shrink-0",
              !isDraggingWorkspace && "transition-[width,opacity] duration-200 ease-linear",
              showWorkspace ? "opacity-100" : "border-l-0 opacity-0 pointer-events-none",
            )}
          >
            {showWorkspace ? (
              <div
                onPointerDown={handleWorkspaceResizeStart}
                className="group/resizer absolute inset-y-0 -left-1.5 z-30 w-3 cursor-col-resize select-none"
              >
                <div className="mx-auto h-full w-px bg-border group-hover/resizer:w-0.5 group-hover/resizer:bg-primary transition-colors" />
              </div>
            ) : null}
            <div
              style={{ width: `${workspaceWidth}px` }}
              className={cn(
                "flex h-full min-h-0 shrink-0 flex-col",
                !isDraggingWorkspace && "transition-transform duration-200 ease-linear",
                showWorkspace ? "translate-x-0" : "translate-x-4",
              )}
            >
              <React.Suspense fallback={<PanelFallback />}>
                <WorkspacePanel />
              </React.Suspense>
            </div>
          </aside>
        </div>
      </SidebarInset>
      <SettingsDialog />
    </SidebarProvider>
  );
}

export default function App(): React.JSX.Element {
  return (
    <WorkbenchProvider>
      <TooltipProvider>
        <AppShell />
        <Toaster position="bottom-right" />
      </TooltipProvider>
    </WorkbenchProvider>
  );
}
