import { useLocation, useRouterState } from "@tanstack/react-router";
import type { WebviewTag } from "electron";
import * as React from "react";
import { useWorkbenchStore } from "@/entities/workbench/model/workbench-store";
import { useAuth } from "@/features/auth";
import { toastError } from "@/shared/lib";
import type { NativeBrowserSurface } from "../../../../../shared/browser-contract";

function BrowserGuest({
  tab,
  surface,
  visible,
}: {
  tab: NativeBrowserSurface["tabs"][number];
  surface: NativeBrowserSurface;
  visible: boolean;
}) {
  const hostRef = React.useRef<HTMLDivElement>(null);
  const { id } = tab;
  const { partition, bounds } = surface;

  React.useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const guest = document.createElement("webview") as WebviewTag;
    guest.setAttribute("partition", partition);
    guest.setAttribute("allowpopups", "");
    guest.setAttribute("src", `about:blank#${id}`);
    guest.className = "flex size-full";
    const bind = () => {
      guest.removeEventListener("dom-ready", bind);
      void window.api.browserView.bindGuest(id, guest.getWebContentsId()).catch((error) => {
        if (guest.isConnected) toastError(error);
      });
    };
    guest.addEventListener("dom-ready", bind);
    host.append(guest);
    return () => {
      guest.removeEventListener("dom-ready", bind);
      guest.remove();
    };
  }, [id, partition]);

  return (
    <div
      data-slot="browser-guest"
      aria-label={tab.title}
      aria-hidden={!visible}
      inert={!visible}
      className="fixed z-40 overflow-hidden bg-background"
      style={{
        left: bounds.x,
        top: bounds.y,
        width: bounds.width,
        height: bounds.height,
        visibility: visible ? "visible" : "hidden",
        pointerEvents: visible ? "auto" : "none",
      }}
    >
      <div ref={hostRef} className="size-full" />
    </div>
  );
}

/** Keep guests mounted across routes and thread switches, just like browser tabs.
 * These are DOM surfaces, so the normal menu/dialog portals compose above them.
 */
export function BrowserGuestLayer() {
  const { user } = useAuth();
  const location = useLocation();
  const threadId = useRouterState({
    select: (state) => (state.location.search as { thread?: string }).thread,
  });
  const workspacePanelOpen = useWorkbenchStore((store) => store.workspacePanelOpen);
  const activePanelTab = useWorkbenchStore((store) => store.activePanelTab);
  const [surfaces, setSurfaces] = React.useState<NativeBrowserSurface[]>([]);

  React.useEffect(() => {
    const browser = window.api?.browserView;
    if (!browser) return;
    let disposed = false;
    let receivedEvent = false;
    const unsubscribe = browser.onSurfaces((next) => {
      receivedEvent = true;
      setSurfaces(next);
    });
    void browser
      .getSurfaces()
      .then((next) => {
        if (!disposed && !receivedEvent) setSurfaces(next);
      })
      .catch(toastError);
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);

  const visible =
    workspacePanelOpen &&
    activePanelTab.kind === "browser" &&
    !location.pathname.startsWith("/settings");
  return surfaces
    .filter((surface) => surface.resourceId === user?.id)
    .flatMap((surface) =>
      surface.tabs.map((tab) => (
        <BrowserGuest
          key={tab.id}
          tab={tab}
          surface={surface}
          visible={
            visible &&
            surface.bounds.threadId === threadId &&
            tab.id === surface.activeTabId &&
            surface.bounds.width > 0 &&
            surface.bounds.height > 0
          }
        />
      )),
    );
}
