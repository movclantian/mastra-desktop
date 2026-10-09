import { motion, useMotionValue, useSpring } from "motion/react";
import { type FC, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useWorkbenchStore } from "@/entities/workbench/model/workbench-store";

interface Position {
  x: number;
  y: number;
}

export interface SmoothCursorProps {
  cursor?: React.ReactNode;
  /**
   * 旋转与缩放的平滑弹簧配置 (坐标追踪已采用 0 延迟实时映射)
   */
  springConfig?: {
    damping: number;
    stiffness: number;
    mass: number;
    restDelta: number;
  };
}

const DESKTOP_POINTER_QUERY = "(any-hover: hover) and (any-pointer: fine)";

function isTrackablePointer(pointerType: string) {
  return pointerType !== "touch";
}

/* Magic UI 官方原生黑白双层高光指针 SVG (带精准滤镜阴影) */
const DefaultCursorSVG: FC = () => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={50}
      height={54}
      viewBox="0 0 50 54"
      fill="none"
      style={{ scale: 0.5 }}
    >
      <g filter="url(#filter0_d_91_7928)">
        <path
          d="M42.6817 41.1495L27.5103 6.79925C26.7269 5.02557 24.2082 5.02558 23.3927 6.79925L7.59814 41.1495C6.75833 42.9759 8.52712 44.8902 10.4125 44.1954L24.3757 39.0496C24.8829 38.8627 25.4385 38.8627 25.9422 39.0496L39.8121 44.1954C41.6849 44.8902 43.4884 42.9759 42.6817 41.1495Z"
          fill="black"
        />
        <path
          d="M43.7146 40.6933L28.5431 6.34306C27.3556 3.65428 23.5772 3.69516 22.3668 6.32755L6.57226 40.6778C5.3134 43.4156 7.97238 46.298 10.803 45.2549L24.7662 40.109C25.0221 40.0147 25.2999 40.0156 25.5494 40.1082L39.4193 45.254C42.2261 46.2953 44.9254 43.4347 43.7146 40.6933Z"
          stroke="white"
          strokeWidth={2.25825}
        />
      </g>
      <defs>
        <filter
          id="filter0_d_91_7928"
          x={0.602397}
          y={0.952444}
          width={49.0584}
          height={52.428}
          filterUnits="userSpaceOnUse"
          colorInterpolationFilters="sRGB"
        >
          <feFlood floodOpacity={0} result="BackgroundImageFix" />
          <feColorMatrix
            in="SourceAlpha"
            type="matrix"
            values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0"
            result="hardAlpha"
          />
          <feOffset dy={2.25825} />
          <feGaussianBlur stdDeviation={2.25825} />
          <feComposite in2="hardAlpha" operator="out" />
          <feColorMatrix type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.08 0" />
          <feBlend mode="normal" in2="BackgroundImageFix" result="effect1_dropShadow_91_7928" />
          <feBlend
            mode="normal"
            in="SourceGraphic"
            in2="effect1_dropShadow_91_7928"
            result="shape"
          />
        </filter>
      </defs>
    </svg>
  );
};

function isNativeCursorTarget(target: Element | null): boolean {
  if (!target) return false;
  return !!target.closest(
    '.app-drag, input:not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="file"]), textarea, [contenteditable="true"], .monaco-editor, .cm-content',
  );
}

export function SmoothCursor({
  cursor = <DefaultCursorSVG />,
  springConfig = {
    damping: 30,
    stiffness: 400,
    mass: 0.1,
    restDelta: 0.001,
  },
}: SmoothCursorProps) {
  const hasRunningTask = useWorkbenchStore(
    (state) => state.agentBusyFlag || Object.values(state.busyThreadIds).some(Boolean),
  );
  const lastMousePos = useRef<Position>({ x: 0, y: 0 });
  const hasPointerPosition = useRef(false);
  const velocity = useRef<Position>({ x: 0, y: 0 });
  const lastUpdateTime = useRef(Date.now());
  const previousAngle = useRef(0);
  const accumulatedRotation = useRef(0);

  const [isEnabled, setIsEnabled] = useState(false);
  const [isVisible, setIsVisible] = useState(false);
  const [isOverNativeControl, setIsOverNativeControl] = useState(false);
  const useCustomCursor = isEnabled && !hasRunningTask;

  // ⚡ 0 延迟核心：坐标使用 useMotionValue 直接映射，彻底剔除物理弹簧的滞后计算
  const cursorX = useMotionValue(0);
  const cursorY = useMotionValue(0);

  // 倾斜与缩放保留高灵敏轻量弹簧动效
  const rotation = useSpring(0, {
    ...springConfig,
    damping: springConfig.damping ?? 40,
    stiffness: springConfig.stiffness ?? 500,
    mass: springConfig.mass ?? 0.08,
  });
  const scale = useSpring(1, {
    ...springConfig,
    stiffness: 600,
    damping: 30,
    mass: 0.08,
  });

  useEffect(() => {
    const mediaQuery = window.matchMedia(DESKTOP_POINTER_QUERY);

    const updateEnabled = () => {
      const enabled = mediaQuery.matches;
      setIsEnabled(enabled);
      if (!enabled) setIsVisible(false);
    };

    updateEnabled();
    mediaQuery.addEventListener("change", updateEnabled);

    return () => {
      mediaQuery.removeEventListener("change", updateEnabled);
      document.documentElement.classList.remove("smooth-cursor-mode");
    };
  }, []);

  useLayoutEffect(() => {
    const root = document.documentElement;
    if (!useCustomCursor || !isVisible) {
      root.classList.remove("smooth-cursor-mode");
      return;
    }

    if (hasPointerPosition.current) {
      const { x, y } = lastMousePos.current;
      cursorX.set(x);
      cursorY.set(y);
      setIsOverNativeControl(isNativeCursorTarget(document.elementFromPoint(x, y)));
    }
    root.classList.add("smooth-cursor-mode");
    return () => root.classList.remove("smooth-cursor-mode");
  }, [cursorX, cursorY, isVisible, useCustomCursor]);

  useEffect(() => {
    if (!isEnabled) return;

    let timeout: ReturnType<typeof setTimeout> | null = null;

    const updateVelocity = (currentPos: Position) => {
      const currentTime = Date.now();
      const deltaTime = currentTime - lastUpdateTime.current;

      if (deltaTime > 0) {
        velocity.current = {
          x: (currentPos.x - lastMousePos.current.x) / deltaTime,
          y: (currentPos.y - lastMousePos.current.y) / deltaTime,
        };
      }

      lastUpdateTime.current = currentTime;
      lastMousePos.current = currentPos;
    };

    const handlePointerMove = (e: PointerEvent) => {
      if (!isTrackablePointer(e.pointerType)) return;

      const currentPos = { x: e.clientX, y: e.clientY };
      hasPointerPosition.current = true;
      if (hasRunningTask) {
        lastMousePos.current = currentPos;
        lastUpdateTime.current = Date.now();
        return;
      }

      setIsVisible(true);

      // ⚡ 立即无延迟更新光标绝对坐标 (0ms lag)
      cursorX.set(currentPos.x);
      cursorY.set(currentPos.y);

      // Text inputs and the native title bar use the system cursor.
      const target = e.target as Element | null;
      setIsOverNativeControl(isNativeCursorTarget(target));

      // 计算速度与动态倾斜角
      updateVelocity(currentPos);
      const speed = Math.sqrt(velocity.current.x ** 2 + velocity.current.y ** 2);

      if (speed > 0.15) {
        const currentAngle =
          Math.atan2(velocity.current.y, velocity.current.x) * (180 / Math.PI) + 90;

        let angleDiff = currentAngle - previousAngle.current;
        if (angleDiff > 180) angleDiff -= 360;
        if (angleDiff < -180) angleDiff += 360;
        accumulatedRotation.current += angleDiff;
        rotation.set(accumulatedRotation.current);
        previousAngle.current = currentAngle;

        scale.set(0.94);

        if (timeout !== null) clearTimeout(timeout);
        timeout = setTimeout(() => {
          scale.set(1);
        }, 120);
      }
    };

    const handleMouseDown = () => {
      if (hasRunningTask) return;
      scale.set(0.88);
    };

    const handleMouseUp = () => {
      if (hasRunningTask) return;
      scale.set(1);
    };

    const handleMouseLeave = () => {
      setIsVisible(false);
    };

    const handleMouseEnter = () => {
      if (!hasRunningTask && hasPointerPosition.current) setIsVisible(true);
    };

    window.addEventListener("pointermove", handlePointerMove, { passive: true });
    window.addEventListener("mousedown", handleMouseDown, { passive: true });
    window.addEventListener("mouseup", handleMouseUp, { passive: true });
    document.addEventListener("mouseleave", handleMouseLeave);
    document.addEventListener("mouseenter", handleMouseEnter);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("mousedown", handleMouseDown);
      window.removeEventListener("mouseup", handleMouseUp);
      document.removeEventListener("mouseleave", handleMouseLeave);
      document.removeEventListener("mouseenter", handleMouseEnter);
      if (timeout !== null) clearTimeout(timeout);
    };
  }, [cursorX, cursorY, hasRunningTask, rotation, scale, isEnabled]);

  if (!isEnabled) {
    return null;
  }

  const shouldShow = useCustomCursor && isVisible && !isOverNativeControl;

  return (
    <motion.div
      className="smooth-cursor-container"
      style={{
        position: "fixed",
        left: cursorX,
        top: cursorY,
        translateX: "-50%",
        translateY: "-50%",
        rotate: rotation,
        scale: scale,
        zIndex: 99999,
        pointerEvents: "none",
        willChange: "transform",
        opacity: shouldShow ? 1 : 0,
      }}
      initial={false}
      animate={{ opacity: shouldShow ? 1 : 0 }}
      transition={{ duration: 0 }}
    >
      {cursor}
    </motion.div>
  );
}
