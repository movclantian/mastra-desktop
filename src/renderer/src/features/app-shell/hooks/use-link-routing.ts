import * as React from "react";

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

function openInSystemBrowser(url: string) {
  if (window.api?.workspace.openExternal) void window.api.workspace.openExternal(url);
  else window.open(url, "_blank", "noopener,noreferrer");
}

export function useLinkRouting(openInAppBrowser: (url: string) => void) {
  React.useEffect(() => {
    const route = (event: MouseEvent) => {
      if (event.defaultPrevented) return;
      const middleClick = event.button === 1;
      if (event.button !== 0 && !middleClick) return;
      const anchor = httpLinkFromTarget(event.target);
      if (!anchor) return;
      event.preventDefault();
      if (middleClick || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        openInSystemBrowser(anchor.href);
      } else {
        openInAppBrowser(anchor.href);
      }
    };
    document.addEventListener("click", route, true);
    document.addEventListener("auxclick", route, true);
    return () => {
      document.removeEventListener("click", route, true);
      document.removeEventListener("auxclick", route, true);
    };
  }, [openInAppBrowser]);
}
