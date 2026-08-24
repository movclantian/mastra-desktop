import * as React from "react";

/**
 * 挂在应用顶层的两件全局交互。它们与任何布局无关,只是需要一个常驻的文档级监听,
 * 所以从 AppShell 里搬出来 —— 留在那里只会淹没真正属于外壳的东西。
 */

/**
 * 滚轮横向转换:鼠标悬在任意可横向滚动的区域(标签栏、操作条、代码块)上时,
 * 把垂直滚轮转成横向滚动 —— 没有横向滚轮的鼠标也能浏览海量标签。
 */
export function useHorizontalWheelScroll() {
  React.useEffect(() => {
    const handleWheel = (event: WheelEvent) => {
      // 已有横向分量、或压根没有垂直分量,交给系统原生处理
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

        // 纵向也能滚的容器不接管,除非它显式声明了横向优先 —— 否则会抢掉页面滚动
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

/** 从事件目标向上找一个真正的 http(s) 链接。下载链接与非 http 协议都不接管 */
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
  if (window.api?.openExternal) void window.api.openExternal(url);
  else window.open(url, "_blank", "noopener,noreferrer");
}

/**
 * 网页链接的去向:默认走应用内浏览器,带修饰键或中键点击则交给系统浏览器。
 *
 * click 与 auxclick 共用一个处理器 —— 两者只在「哪些键算外部打开」上有差别,
 * 而 click 只由主键触发、auxclick 只由非主键触发,靠 event.button 一次分流即可。
 * 捕获阶段监听,好让这条规则先于组件自己的 onClick 生效。
 */
export function useLinkRouting(openInAppBrowser: (url: string) => void) {
  React.useEffect(() => {
    const route = (event: MouseEvent) => {
      if (event.defaultPrevented) return;
      const middleClick = event.button === 1;
      // 主键与中键之外(右键等)一概不管
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
