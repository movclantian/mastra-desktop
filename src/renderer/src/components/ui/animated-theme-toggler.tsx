import { MoonIcon, SunMediumIcon } from "lucide-react";
import * as React from "react";
import * as ReactDOM from "react-dom";
import { useTheme } from "@/components/theme-provider";
import { cn } from "@/lib/utils";

export type AnimatedThemeTogglerVariant =
  | "circle"
  | "star"
  | "diamond"
  | "triangle"
  | "hexagon"
  | "square"
  | "rectangle";

export interface AnimatedThemeTogglerProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  theme?: "light" | "dark";
  onThemeChange?: (theme: "light" | "dark") => void;
  variant?: AnimatedThemeTogglerVariant;
  duration?: number;
  fromCenter?: boolean;
  className?: string;
  showLabel?: boolean;
}

const SHAPE_CLIP_PATHS: Record<AnimatedThemeTogglerVariant, { start: string; end: string }> = {
  circle: {
    start: "circle(0px at var(--x, 50%) var(--y, 50%))",
    end: "circle(var(--radius, 150vw) at var(--x, 50%) var(--y, 50%))",
  },
  square: {
    start: "polygon(var(--x, 50%) var(--y, 50%), var(--x, 50%) var(--y, 50%), var(--x, 50%) var(--y, 50%), var(--x, 50%) var(--y, 50%))",
    end: "polygon(-100vw -100vh, 200vw -100vh, 200vw 200vh, -100vw 200vh)",
  },
  rectangle: {
    start: "inset(50% 50% 50% 50%)",
    end: "inset(0% 0% 0% 0%)",
  },
  diamond: {
    start: "polygon(var(--x, 50%) var(--y, 50%), var(--x, 50%) var(--y, 50%), var(--x, 50%) var(--y, 50%), var(--x, 50%) var(--y, 50%))",
    end: "polygon(50% -150vw, 250vw 50%, 50% 250vw, -150vw 50%)",
  },
  triangle: {
    start: "polygon(var(--x, 50%) var(--y, 50%), var(--x, 50%) var(--y, 50%), var(--x, 50%) var(--y, 50%))",
    end: "polygon(50% -200vw, 300vw 250vh, -200vw 250vh)",
  },
  hexagon: {
    start: "polygon(var(--x, 50%) var(--y, 50%), var(--x, 50%) var(--y, 50%), var(--x, 50%) var(--y, 50%), var(--x, 50%) var(--y, 50%), var(--x, 50%) var(--y, 50%), var(--x, 50%) var(--y, 50%))",
    end: "polygon(50% -200vw, 250vw -50vh, 250vw 150vh, 50% 300vw, -150vw 150vh, -150vw -50vh)",
  },
  star: {
    start: "polygon(var(--x, 50%) var(--y, 50%), var(--x, 50%) var(--y, 50%), var(--x, 50%) var(--y, 50%), var(--x, 50%) var(--y, 50%), var(--x, 50%) var(--y, 50%))",
    end: "polygon(50% -300vw, 350vw 350vh, -250vw 50vh, 350vw 50vh, -250vw 350vh)",
  },
};

export const AnimatedThemeToggler = React.forwardRef<
  HTMLButtonElement,
  AnimatedThemeTogglerProps
>(
  (
    {
      theme: controlledTheme,
      onThemeChange,
      variant = "circle",
      duration = 400,
      fromCenter = false,
      className,
      showLabel = false,
      ...props
    },
    ref,
  ) => {
    const themeContext = useTheme();
    const isDarkMode = controlledTheme ? controlledTheme === "dark" : themeContext.isDark;

    const toggleTheme = (e: React.MouseEvent<HTMLButtonElement>) => {
      const nextTheme = isDarkMode ? "light" : "dark";

      // If document.startViewTransition is not supported (or reduced motion requested), fallback directly
      if (
        typeof document === "undefined" ||
        !("startViewTransition" in document) ||
        window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ) {
        if (onThemeChange) {
          onThemeChange(nextTheme);
        } else {
          themeContext.setMode(nextTheme);
        }
        return;
      }

      // Calculate origin (x, y) coordinates and maximum radius
      const rect = e.currentTarget.getBoundingClientRect();
      const x = fromCenter ? window.innerWidth / 2 : rect.left + rect.width / 2;
      const y = fromCenter ? window.innerHeight / 2 : rect.top + rect.height / 2;

      const maxRadius = Math.hypot(
        Math.max(x, window.innerWidth - x),
        Math.max(y, window.innerHeight - y),
      );

      document.documentElement.style.setProperty("--x", `${x}px`);
      document.documentElement.style.setProperty("--y", `${y}px`);
      document.documentElement.style.setProperty("--radius", `${maxRadius}px`);

      // 使用 flushSync 保证 React 在生成新视图快照前同步提交 DOM、类名与样式变量变化，避免圆角/颜色二次突变
      const transition = document.startViewTransition(() => {
        ReactDOM.flushSync(() => {
          if (onThemeChange) {
            onThemeChange(nextTheme);
          } else {
            themeContext.setMode(nextTheme);
          }
        });
      });

      transition.ready.then(() => {
        const shape = SHAPE_CLIP_PATHS[variant] || SHAPE_CLIP_PATHS.circle;
        document.documentElement.animate(
          {
            clipPath: [shape.start, shape.end],
          },
          {
            duration,
            easing: "ease-in-out",
            pseudoElement: "::view-transition-new(root)",
          },
        );
      });
    };

    return (
      <button
        ref={ref}
        type="button"
        onClick={toggleTheme}
        aria-label={isDarkMode ? "切换至浅色模式" : "切换至深色模式"}
        className={cn(
          "group relative inline-flex size-8 cursor-pointer items-center justify-center rounded-lg border border-border bg-background p-1.5 text-foreground shadow-xs transition-colors hover:bg-accent hover:text-accent-foreground active:scale-95",
          showLabel && "w-auto px-3 gap-2",
          className,
        )}
        {...props}
      >
        <SunMediumIcon
          className={cn(
            "size-4 shrink-0 transition-all duration-300",
            isDarkMode ? "rotate-90 scale-0 opacity-0 absolute" : "rotate-0 scale-100 opacity-100",
          )}
        />
        <MoonIcon
          className={cn(
            "size-4 shrink-0 transition-all duration-300",
            isDarkMode ? "rotate-0 scale-100 opacity-100" : "-rotate-90 scale-0 opacity-0 absolute",
          )}
        />
        {showLabel && (
          <span className="text-xs font-medium truncate select-none">
            {isDarkMode ? "深色模式" : "浅色模式"}
          </span>
        )}
      </button>
    );
  },
);

AnimatedThemeToggler.displayName = "AnimatedThemeToggler";
