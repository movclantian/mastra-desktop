import { PlusIcon } from "lucide-react";

import { AppSidebar } from "@/components/app/app-sidebar";
import { ChatPanel } from "@/components/app/chat-panel";
import { SettingsDialog } from "@/components/app/settings-dialog";
import { Button } from "@/components/ui/button";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useWorkbench, WorkbenchProvider } from "@/lib/workbench";

function AppShell() {
  const { threads, activeThreadId, createThread } = useWorkbench();
  const activeThread = threads.find((t) => t.id === activeThreadId);

  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4 transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-12">
          <SidebarTrigger className="-ml-1" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">
              {activeThread ? activeThread.title : "MastraWork"}
            </p>
          </div>
          <Button size="sm" variant="ghost" onClick={() => void createThread(null)}>
            <PlusIcon />
            新建会话
          </Button>
        </header>
        <main className="min-h-0 flex-1">
          <ChatPanel />
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
