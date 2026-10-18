import { type UseInViewOptions, useInView } from "motion/react";
import * as React from "react";

import { MOBILE_BREAKPOINT } from "@/shared/config";

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

/**
 * 窗口级 "竖滚 → 横滚" 转换。
 *
 * 这个监听必须是 passive:false 才能 preventDefault,副作用是**每一次**滚轮事件
 * 都要等主线程跑完回调,合成器才能滚动。而旧实现沿祖先链对**每个**元素都做
 * getComputedStyle + scrollWidth/clientHeight 读取 —— 这是一串强制同步布局,
 * 聊天长列表里每次滚轮 tick 都触发全量重排,滚动自然发涩。
 *
 * 现在先用纯选择器(属性/类名,无布局)筛出"可能的横向滚动容器",只有命中的
 * 元素才去读样式和尺寸。竖向滚动的主路径变成几次属性匹配就返回。
 */
const HORIZONTAL_SCROLL_HINT =
  '[data-horizontal-scroll="true"], .overflow-auto, .overflow-x-auto, .overflow-x-scroll, .katex-display';

export function useHorizontalWheelScroll() {
  React.useEffect(() => {
    const handleWheel = (event: WheelEvent) => {
      if (event.deltaY === 0 || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;

      const start = event.target;
      if (!(start instanceof Element)) return;

      let target: Element | null = start;
      while (target && target !== document.body && target !== document.documentElement) {
        if (target instanceof HTMLElement && target.matches(HORIZONTAL_SCROLL_HINT)) {
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
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(report, 180);
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      clearTimeout(timer);
    };
  }, [elementRef, report]);

  React.useEffect(() => {
    report();
  }, [report, contentMinWidth, reservedWidth]);
}
