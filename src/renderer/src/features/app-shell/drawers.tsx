import * as React from "react";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

const WorkspacePanel = React.lazy(() => import("@/features/workspace/pages/workspace-panel"));
const TerminalPanel = React.lazy(() => import("@/features/terminal/terminal-panel"));

export function PanelFallback() {
  return (
    <div className="flex size-full items-center justify-center bg-background">
      <Spinner className="size-5" />
    </div>
  );
}

export function WorkspaceDrawer({ open, minWidth }: { open: boolean; minWidth: number }) {
  return (
    <div
      style={{ minWidth }}
      className={cn(
        "flex h-full min-h-0 w-full flex-col bg-background transition-opacity duration-200 ease-linear",
        open ? "border-l opacity-100" : "opacity-0 pointer-events-none",
      )}
    >
      <React.Suspense fallback={<PanelFallback />}>
        <WorkspacePanel />
      </React.Suspense>
    </div>
  );
}

export function TerminalDrawer({ open, minHeight }: { open: boolean; minHeight: number }) {
  return (
    <div
      style={{ minHeight }}
      className={cn(
        "flex h-full w-full min-w-0 flex-col bg-background transition-opacity duration-200 ease-linear",
        open ? "border-t opacity-100" : "opacity-0 pointer-events-none",
      )}
    >
      <React.Suspense fallback={<PanelFallback />}>
        <TerminalPanel />
      </React.Suspense>
    </div>
  );
}
