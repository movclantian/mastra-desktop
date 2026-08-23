import { motion, useMotionValue, useSpring, useTransform, useVelocity } from "motion/react";
import * as React from "react";
import { cn } from "@/lib/utils";

export interface SmoothCursorProps {
  className?: string;
  cursor?: React.ReactNode;
  springConfig?: {
    stiffness?: number;
    damping?: number;
    mass?: number;
    restDelta?: number;
  };
  /** Whether to hide default system cursor while smooth cursor is active */
  hideSystemCursor?: boolean;
  /** Whether to enable subtle rotation and scaling based on movement */
  enableDynamicRotation?: boolean;
}

// 官方标准黑色光标 SVG (来自 Magic UI 官方 DefaultCursorSVG 规范)
export function DefaultCursorSVG({ className }: { className?: string }) {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={cn("size-5.5 drop-shadow-[0_2px_5px_rgba(0,0,0,0.35)]", className)}
    >
      <path
        d="M3 3L10.07 19.97L12.58 12.58L19.97 10.07L3 3Z"
        fill="#09090b"
        stroke="#ffffff"
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

// 优化后的低延迟弹簧参数 (相比默认的 mass: 1, 降低到 0.15 避免拖拽滞后，提升至 600 stiffness)
const OPTIMIZED_SPRING = {
  stiffness: 600,
  damping: 38,
  mass: 0.01,
  restDelta: 0.0001,
};

export function SmoothCursor({
  className,
  cursor,
  springConfig = OPTIMIZED_SPRING,
  hideSystemCursor = true,
  enableDynamicRotation = true,
}: SmoothCursorProps) {
  const [isVisible, setIsVisible] = React.useState(false);
  const [isTouch, setIsTouch] = React.useState(false);
  const [isClicking, setIsClicking] = React.useState(false);

  const rawX = useMotionValue(-100);
  const rawY = useMotionValue(-100);

  const smoothX = useSpring(rawX, {
    stiffness: springConfig.stiffness ?? OPTIMIZED_SPRING.stiffness,
    damping: springConfig.damping ?? OPTIMIZED_SPRING.damping,
    mass: springConfig.mass ?? OPTIMIZED_SPRING.mass,
    restDelta: springConfig.restDelta ?? OPTIMIZED_SPRING.restDelta,
  });

  const smoothY = useSpring(rawY, {
    stiffness: springConfig.stiffness ?? OPTIMIZED_SPRING.stiffness,
    damping: springConfig.damping ?? OPTIMIZED_SPRING.damping,
    mass: springConfig.mass ?? OPTIMIZED_SPRING.mass,
    restDelta: springConfig.restDelta ?? OPTIMIZED_SPRING.restDelta,
  });

  // Calculate velocity for subtle dynamic tilt
  const velX = useVelocity(smoothX);
  const velY = useVelocity(smoothY);

  const rotate = useTransform([velX, velY], ([latestX, latestY]: number[]) => {
    if (!enableDynamicRotation) return 0;
    const vx = latestX || 0;
    const vy = latestY || 0;
    const speed = Math.hypot(vx, vy);
    if (speed < 50) return 0;
    // 微动态倾角 (最大 ±15 度)
    const angle = (Math.atan2(vy, vx) * 180) / Math.PI;
    return Math.max(-15, Math.min(15, angle * 0.12));
  });

  React.useEffect(() => {
    // 触摸屏设备静默禁用
    if (typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches) {
      setIsTouch(true);
      return;
    }

    if (hideSystemCursor) {
      document.documentElement.classList.add("smooth-cursor-active");
    }

    const handlePointerMove = (e: PointerEvent) => {
      rawX.set(e.clientX);
      rawY.set(e.clientY);
      if (!isVisible) setIsVisible(true);
    };

    const handlePointerDown = () => setIsClicking(true);
    const handlePointerUp = () => setIsClicking(false);
    const handleMouseLeave = () => {
      setIsVisible(false);
      document.documentElement.classList.remove("smooth-cursor-active");
    };
    const handleMouseEnter = () => {
      setIsVisible(true);
      if (hideSystemCursor) {
        document.documentElement.classList.add("smooth-cursor-active");
      }
    };

    window.addEventListener("pointermove", handlePointerMove, { passive: true });
    window.addEventListener("pointerdown", handlePointerDown, { passive: true });
    window.addEventListener("pointerup", handlePointerUp, { passive: true });
    document.addEventListener("mouseleave", handleMouseLeave);
    document.addEventListener("mouseenter", handleMouseEnter);

    return () => {
      document.documentElement.classList.remove("smooth-cursor-active");
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("pointerup", handlePointerUp);
      document.removeEventListener("mouseleave", handleMouseLeave);
      document.removeEventListener("mouseenter", handleMouseEnter);
    };
  }, [hideSystemCursor, isVisible, rawX, rawY]);

  if (isTouch) return null;

  return (
    <div
      className={cn(
        "pointer-events-none fixed inset-0 z-99999 select-none transition-opacity duration-150",
        isVisible ? "opacity-100" : "opacity-0",
        className,
      )}
    >
      <motion.div
        style={{
          x: smoothX,
          y: smoothY,
          rotate: rotate,
        }}
        animate={{
          scale: isClicking ? 0.9 : 1,
        }}
        transition={{ type: "spring", stiffness: 700, damping: 30 }}
        className="pointer-events-none absolute top-0 left-0 will-change-transform"
      >
        {cursor ?? <DefaultCursorSVG />}
      </motion.div>
    </div>
  );
}
