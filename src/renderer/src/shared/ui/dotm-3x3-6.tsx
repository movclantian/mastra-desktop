"use client";

import type { CSSProperties } from "react";

import {
  type DotAnimationResolver,
  DotMatrix3Base,
  type DotMatrixCommonProps,
} from "@/shared/ui/visual/dotmatrix/core";
import { useDotMatrixPhases, usePrefersReducedMotion } from "@/shared/ui/visual/dotmatrix/hooks";

const animationResolver: DotAnimationResolver = ({
  isActive,
  manhattanDistance,
  reducedMotion,
  phase,
}) => {
  if (!isActive) {
    return { className: "dmx-inactive" };
  }

  const ring = Math.max(0, Math.min(2, manhattanDistance));
  const style = { "--dmx-center-ripple-ring": ring } as CSSProperties;

  if (reducedMotion || phase === "idle") {
    return {
      style: {
        ...style,
        opacity: 0.06 + (1 - ring / 2) * 0.82,
      },
    };
  }

  return { className: "dmx-center-ripple-3", style };
};

export function Dotm3x3_6({
  pattern = "full",
  dotShape = "circle",
  animated = true,
  hoverAnimated = false,
  speed = 1.75,
  ...rest
}: DotMatrixCommonProps) {
  const reducedMotion = usePrefersReducedMotion();
  const { phase, onMouseEnter, onMouseLeave } = useDotMatrixPhases({
    animated: Boolean(animated && !reducedMotion),
    hoverAnimated: Boolean(hoverAnimated && !reducedMotion),
    speed,
  });

  return (
    <DotMatrix3Base
      {...rest}
      speed={speed}
      pattern={pattern}
      dotShape={dotShape}
      animated={animated}
      phase={phase}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      reducedMotion={reducedMotion}
      animationResolver={animationResolver}
    />
  );
}
