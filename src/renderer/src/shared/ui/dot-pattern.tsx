"use client";

import type React from "react";

import { cn } from "@/shared/lib";

/**
 *  DotPattern Component Props
 *
 * @param {number} [width=16] - The horizontal spacing between dots
 * @param {number} [height=16] - The vertical spacing between dots
 * @param {number} [x=0] - The x-offset of the entire pattern
 * @param {number} [y=0] - The y-offset of the entire pattern
 * @param {number} [cx=1] - The x-offset of individual dots
 * @param {number} [cy=1] - The y-offset of individual dots
 * @param {number} [cr=1] - The radius of each dot
 * @param {string} [className] - Additional CSS classes to apply to the container
 */
interface DotPatternProps extends React.HTMLAttributes<HTMLDivElement> {
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  cx?: number;
  cy?: number;
  cr?: number;
  className?: string;
}

/**
 * DotPattern Component
 *
 * 点阵背景:一个 `radial-gradient` 由浏览器按 `background-size` 平铺,整个背景
 * 只有一个 DOM 节点,且天然铺满容器 —— 与容器尺寸无关,resize 无成本。
 *
 * 上游 Magic UI 的实现把每颗点渲染成独立的 `motion.circle`
 * (数量 = ceil(w/width) * ceil(h/height),全屏下约五千个),并把
 * getBoundingClientRect 的结果存进 state + 监听 resize 全量重算。
 * 那套写法只在需要逐点随机延迟的 glow 动画时才有必要,而本项目两处调用
 * 都是静态点阵(glow 从未启用),于是整条逐点渲染路径连同 glow 一起移除。
 *
 * 点位与上游一致:第 (col,row) 颗落在 (x + col*width + cx, y + row*height + cy)。
 * gradient 的圆心默认在每块 tile 的中心,所以 tile 原点要回退半块。
 * 外沿多 0.5px 过渡是为了拿到与 SVG `<circle>` 相当的抗锯齿边缘。
 *
 * @component
 *
 * @see DotPatternProps for the props interface.
 *
 * @example
 * // Basic usage
 * <DotPattern />
 *
 * // With custom spacing
 * <DotPattern width={20} height={20} className="opacity-50" />
 *
 * @notes
 * - Dots color can be controlled via the text color utility classes
 */
export function DotPattern({
  width = 16,
  height = 16,
  x = 0,
  y = 0,
  cx = 1,
  cy = 1,
  cr = 1,
  className,
  style,
  ...props
}: DotPatternProps) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute inset-0 h-full w-full text-neutral-400/80",
        className,
      )}
      style={{
        backgroundImage: `radial-gradient(circle at center, currentColor ${cr}px, transparent ${cr + 0.5}px)`,
        backgroundSize: `${width}px ${height}px`,
        backgroundPosition: `${x + cx - width / 2}px ${y + cy - height / 2}px`,
        ...style,
      }}
      {...props}
    />
  );
}
