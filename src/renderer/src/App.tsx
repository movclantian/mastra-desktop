import { PanelBottomIcon, PanelRightIcon, PlusIcon, Settings2Icon } from "lucide-react";
import * as React from "react";

import { ChatPanel } from "@/components/app/chat/panel";
import { SettingsDialog } from "@/components/app/settings/dialog";
import { AppSidebar } from "@/components/app/sidebar/app-sidebar";
import { SkillHub } from "@/components/app/skill-hub";
import { Button } from "@/components/ui/button";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { Toaster } from "@/components/ui/sonner";
import { Spinner } from "@/components/ui/spinner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useWorkbench, WorkbenchProvider } from "@/lib/workbench";

const WorkspacePanel = React.lazy(() => import("@/components/app/workbench/workspace-panel"));
const TerminalPanel = React.lazy(() => import("@/components/app/workbench/terminal-panel"));
const KnowledgeLibrary = React.lazy(() =>
  import("@/components/app/library/knowledge-library").then((module) => ({
    default: module.KnowledgeLibrary,
  })),
);

function PanelFallback() {
  return (
    <div className="flex size-full items-center justify-center bg-background">
      <Spinner className="size-5" />
    </div>
  );
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
  } = useWorkbench();
  const [librarySettingsOpen, setLibrarySettingsOpen] = React.useState(false);
  React.useEffect(() => {
    if (!libraryOpen) setLibrarySettingsOpen(false);
  }, [libraryOpen]);
  const activeThread = threads.find((t) => t.id === activeThreadId);
  // 顶栏标题按页面切换;新建会话只属于会话页,资料库设置固定在资料库页右上角
  const title = skillOpen
    ? "技能套件"
    : libraryOpen
      ? "资料库"
      : (activeThread?.title ?? "MastraWork");

  return (
    <SidebarProvider>
      <AppSidebar />
      {/* h-svh:锁定视口高度,内部 flex 链(main min-h-0 flex-1)才能
          约束 MessageScroller,否则长会话把 PromptInput 顶出屏幕 */}
      <SidebarInset className="h-svh overflow-hidden">
        <header className="relative z-10 flex h-12 shrink-0 items-center gap-2 border-b bg-background px-4">
          <div className="min-w-0 flex-1">
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
        </header>
        <main className="relative z-0 min-h-0 flex-1">
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
            <ResizablePanelGroup orientation="vertical">
              <ResizablePanel defaultSize={terminalPanelOpen ? "72%" : "100%"} minSize="35%">
                <ResizablePanelGroup orientation="horizontal">
                  <ResizablePanel defaultSize={workspacePanelOpen ? "50%" : "100%"} minSize="34%">
                    <ChatPanel />
                  </ResizablePanel>
                  {workspacePanelOpen ? (
                    <>
                      <ResizableHandle />
                      <ResizablePanel defaultSize="50%" minSize="30%" maxSize="66%">
                        <React.Suspense fallback={<PanelFallback />}>
                          <WorkspacePanel />
                        </React.Suspense>
                      </ResizablePanel>
                    </>
                  ) : null}
                </ResizablePanelGroup>
              </ResizablePanel>
              {terminalPanelOpen ? (
                <>
                  <ResizableHandle />
                  <ResizablePanel defaultSize="28%" minSize="18%" maxSize="65%">
                    <React.Suspense fallback={<PanelFallback />}>
                      <TerminalPanel />
                    </React.Suspense>
                  </ResizablePanel>
                </>
              ) : null}
            </ResizablePanelGroup>
          )}
        </main>
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
