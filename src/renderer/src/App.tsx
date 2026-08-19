import { PlusIcon, Settings2Icon } from "lucide-react";
import * as React from "react";

import { ChatPanel } from "@/components/app/chat/panel";
import { KnowledgeLibrary } from "@/components/app/library/knowledge-library";
import { SettingsDialog } from "@/components/app/settings/dialog";
import { AppSidebar } from "@/components/app/sidebar/app-sidebar";
import { SkillHub } from "@/components/app/skill-hub";
import { Button } from "@/components/ui/button";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useWorkbench, WorkbenchProvider } from "@/lib/workbench";

function AppShell() {
  const { threads, activeThreadId, createThread, libraryOpen, setLibraryOpen, skillOpen } =
    useWorkbench();
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
            <KnowledgeLibrary
              settingsOpen={librarySettingsOpen}
              onSettingsOpenChange={setLibrarySettingsOpen}
            />
          ) : (
            <ChatPanel />
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
