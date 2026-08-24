import * as React from "react";

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
