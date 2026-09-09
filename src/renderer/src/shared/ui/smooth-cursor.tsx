import { motion, useMotionValue, useSpring } from "motion/react";
import { type FC, useEffect, useRef, useState } from "react";

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

function isTextTarget(target: HTMLElement | null): boolean {
  if (!target) return false;
  return !!target.closest(
    'input:not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="file"]), textarea, [contenteditable="true"], .monaco-editor, .cm-content, .cm-editor, code, pre',
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
  const lastMousePos = useRef<Position>({ x: 0, y: 0 });
  const velocity = useRef<Position>({ x: 0, y: 0 });
  const lastUpdateTime = useRef(Date.now());
  const previousAngle = useRef(0);
  const accumulatedRotation = useRef(0);

  const [isEnabled, setIsEnabled] = useState(false);
  const [isVisible, setIsVisible] = useState(false);
  const [isOverText, setIsOverText] = useState(false);

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
      const nextIsEnabled = mediaQuery.matches;
      setIsEnabled(nextIsEnabled);

      if (nextIsEnabled) {
        document.documentElement.classList.add("smooth-cursor-mode");
      } else {
        document.documentElement.classList.remove("smooth-cursor-mode");
        setIsVisible(false);
      }
    };

    updateEnabled();
    mediaQuery.addEventListener("change", updateEnabled);

    return () => {
      mediaQuery.removeEventListener("change", updateEnabled);
      document.documentElement.classList.remove("smooth-cursor-mode");
    };
  }, []);

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

      setIsVisible(true);

      const currentPos = { x: e.clientX, y: e.clientY };

      // ⚡ 立即无延迟更新光标绝对坐标 (0ms lag)
      cursorX.set(currentPos.x);
      cursorY.set(currentPos.y);

      // 检测是否位于文本输入区域
      const target = e.target as HTMLElement | null;
      setIsOverText(isTextTarget(target));

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
      scale.set(0.88);
    };

    const handleMouseUp = () => {
      scale.set(1);
    };

    const handleMouseLeave = () => {
      setIsVisible(false);
    };

    const handleMouseEnter = () => {
      setIsVisible(true);
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
  }, [cursorX, cursorY, rotation, scale, isEnabled]);

  if (!isEnabled) {
    return null;
  }

  // 文本编辑区淡出，让原生 I-beam 光标接管；其他区域完全由 Magic UI 光标接管（0 系统光标泄漏）
  const shouldShow = isVisible && !isOverText;

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
      transition={{ duration: 0.1 }}
    >
      {cursor}
    </motion.div>
  );
}
