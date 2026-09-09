import { type UseInViewOptions, useInView } from "motion/react";
import * as React from "react";

const MOBILE_BREAKPOINT = 768;

export function useIsMobile() {
  const [isMobile, setIsMobile] = React.useState<boolean | undefined>(undefined);

  React.useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
    const onChange = () => {
      setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
    };
    mql.addEventListener("change", onChange);
    setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return !!isMobile;
}

export interface UseIsInViewOptions {
  inView?: boolean;
  inViewOnce?: boolean;
  inViewMargin?: UseInViewOptions["margin"];
}

export function useIsInView<T extends HTMLElement = HTMLElement>(
  ref: React.Ref<T>,
  options: UseIsInViewOptions = {},
) {
  const { inView, inViewOnce = false, inViewMargin = "0px" } = options;
  const localRef = React.useRef<T>(null);
  React.useImperativeHandle(ref, () => localRef.current as T);
  const inViewResult = useInView(localRef, {
    once: inViewOnce,
    margin: inViewMargin,
  });
  const isInView = !inView || inViewResult;
  return { ref: localRef, isInView };
}

export function useHorizontalWheelScroll() {
  React.useEffect(() => {
    const handleWheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX) || event.deltaY === 0) return;

      let target = event.target as HTMLElement | null;
      while (target && target !== document.body && target !== document.documentElement) {
        const style = window.getComputedStyle(target);
        const scrollableX =
          (style.overflowX === "auto" || style.overflowX === "scroll") &&
          target.scrollWidth > target.clientWidth;
        const scrollableY =
          (style.overflowY === "auto" || style.overflowY === "scroll") &&
          target.scrollHeight > target.clientHeight;

        if (scrollableX && (!scrollableY || target.dataset.horizontalScroll === "true")) {
          const canScroll =
            event.deltaY > 0
              ? target.scrollLeft < target.scrollWidth - target.clientWidth - 1
              : target.scrollLeft > 1;
          if (canScroll) {
            target.scrollLeft += event.deltaY;
            event.preventDefault();
            return;
          }
        }
        target = target.parentElement;
      }
    };

    window.addEventListener("wheel", handleWheel, { passive: false });
    return () => window.removeEventListener("wheel", handleWheel);
  }, []);
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

export function useWindowMinWidth({
  elementRef,
  contentMinWidth,
  reservedWidth,
}: {
  elementRef: React.RefObject<HTMLElement | null>;
  contentMinWidth: number;
  reservedWidth: number;
}) {
  const latest = React.useRef({ contentMinWidth, reservedWidth });
  latest.current = { contentMinWidth, reservedWidth };

  const report = React.useCallback(() => {
    const element = elementRef.current;
    if (!element) return;
    const { contentMinWidth, reservedWidth } = latest.current;
    if (contentMinWidth <= 0) return;
    const chrome = window.innerWidth - element.clientWidth;
    window.api?.window.setMinimumWidth?.(contentMinWidth + chrome + reservedWidth);
  }, [elementRef]);

  React.useEffect(() => {
    const element = elementRef.current;
    if (!element) return;
    let frame = 0;
    let previous = -1;
    const reportWhenSettled = () => {
      const width = element.clientWidth;
      if (width !== previous) {
        previous = width;
        frame = requestAnimationFrame(reportWhenSettled);
        return;
      }
      frame = 0;
      report();
    };
    const observer = new ResizeObserver(() => {
      previous = -1;
      if (!frame) frame = requestAnimationFrame(reportWhenSettled);
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [elementRef, report]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: 需在 contentMinWidth / reservedWidth 变化时主动重新触发 report
  React.useEffect(() => {
    report();
  }, [report, contentMinWidth, reservedWidth]);
}
