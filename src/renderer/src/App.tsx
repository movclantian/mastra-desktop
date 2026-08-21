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
  React.useEffect(() => {
    if (!libraryOpen) setLibrarySettingsOpen(false);
  }, [libraryOpen]);
  const activeThread = threads.find((t) => t.id === activeThreadId);

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

  return (
    <SidebarProvider>
      <AppSidebar />
      <ResizablePanelGroup className="h-svh min-h-0 min-w-0 flex-1" orientation="horizontal">
        {/* h-svh:主内容和右侧工作区都锁定整窗高度；header 只属于聊天 surface。 */}
        <ResizablePanel defaultSize={workspacePanelOpen ? "58%" : "100%"} minSize="34%">
          <SidebarInset className="h-svh overflow-hidden rounded-none shadow-none">
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
                <ChatPanel />
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
        </ResizablePanel>
        {workspacePanelOpen ? (
          <>
            <ResizableHandle />
            <ResizablePanel defaultSize="42%" minSize="30%" maxSize="66%">
              <React.Suspense fallback={<PanelFallback />}>
                <WorkspacePanel />
              </React.Suspense>
            </ResizablePanel>
          </>
        ) : null}
      </ResizablePanelGroup>
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
