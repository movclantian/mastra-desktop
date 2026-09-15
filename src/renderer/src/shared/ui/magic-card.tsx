"use client";

import { motion, useMotionTemplate, useMotionValue, useSpring } from "motion/react";
import type React from "react";
import { useCallback, useEffect, useRef } from "react";
import { cn } from "@/shared/lib";
import { useTheme } from "@/shared/theme";

interface MagicCardBaseProps extends React.HTMLAttributes<HTMLDivElement> {
  children?: React.ReactNode;
  className?: string;
  gradientSize?: number;
  gradientFrom?: string;
  gradientTo?: string;
}

interface MagicCardGradientProps extends MagicCardBaseProps {
  mode?: "gradient";

  gradientColor?: string;
  gradientOpacity?: number;

  glowFrom?: never;
  glowTo?: never;
  glowAngle?: never;
  glowSize?: never;
  glowBlur?: never;
  glowOpacity?: never;
}

interface MagicCardOrbProps extends MagicCardBaseProps {
  mode: "orb";

  glowFrom?: string;
  glowTo?: string;
  glowAngle?: number;
  glowSize?: number;
  glowBlur?: number;
  glowOpacity?: number;

  gradientColor?: never;
  gradientOpacity?: never;
}

type MagicCardProps = MagicCardGradientProps | MagicCardOrbProps;
type ResetReason = "enter" | "leave" | "global" | "init";

function isOrbMode(props: MagicCardProps): props is MagicCardOrbProps {
  return props.mode === "orb";
}

export function MagicCard(props: MagicCardProps) {
  // 混合模式与光晕基色跟随真实主题：在深色卡片上柔和提亮，在浅色底上提供温润微透的品牌色光泽，杜绝突兀的大黑斑
  const { isDark } = useTheme();

  const {
    children,
    className,
    gradientSize = 200,
    gradientFrom = "var(--primary)",
    gradientTo = "var(--accent)",
    mode = "gradient",
    gradientColor = isDark
      ? `color-mix(in srgb, ${gradientFrom} 15%, transparent)`
      : `color-mix(in srgb, ${gradientFrom} 6%, transparent)`,
    gradientOpacity = 1,
    ...restProps
  } = props;

  const glowFrom = isOrbMode(props) ? (props.glowFrom ?? "#ee4f27") : "#ee4f27";
  const glowTo = isOrbMode(props) ? (props.glowTo ?? "#6b21ef") : "#6b21ef";
  const glowAngle = isOrbMode(props) ? (props.glowAngle ?? 90) : 90;
  const glowSize = isOrbMode(props) ? (props.glowSize ?? 420) : 420;
  const glowBlur = isOrbMode(props) ? (props.glowBlur ?? 60) : 60;
  const glowOpacity = isOrbMode(props) ? (props.glowOpacity ?? 0.9) : 0.9;

  const mouseX = useMotionValue(-gradientSize);
  const mouseY = useMotionValue(-gradientSize);

  const orbX = useSpring(mouseX, { stiffness: 250, damping: 30, mass: 0.6 });
  const orbY = useSpring(mouseY, { stiffness: 250, damping: 30, mass: 0.6 });
  const orbVisible = useSpring(0, { stiffness: 300, damping: 35 });

  const modeRef = useRef(mode);
  const glowOpacityRef = useRef(glowOpacity);
  const gradientSizeRef = useRef(gradientSize);

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  useEffect(() => {
    glowOpacityRef.current = glowOpacity;
  }, [glowOpacity]);

  useEffect(() => {
    gradientSizeRef.current = gradientSize;
  }, [gradientSize]);

  const reset = useCallback(
    (reason: ResetReason = "leave") => {
      const currentMode = modeRef.current;

      if (currentMode === "orb") {
        if (reason === "enter") orbVisible.set(glowOpacityRef.current);
        else orbVisible.set(0);
        return;
      }

      const off = -gradientSizeRef.current;
      mouseX.set(off);
      mouseY.set(off);
    },
    [mouseX, mouseY, orbVisible],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      mouseX.set(e.clientX - rect.left);
      mouseY.set(e.clientY - rect.top);
    },
    [mouseX, mouseY],
  );

  useEffect(() => {
    reset("init");
  }, [reset]);

  useEffect(() => {
    const handleGlobalPointerOut = (e: PointerEvent) => {
      if (!e.relatedTarget) reset("global");
    };
    const handleBlur = () => reset("global");
    const handleVisibility = () => {
      if (document.visibilityState !== "visible") reset("global");
    };

    window.addEventListener("pointerout", handleGlobalPointerOut);
    window.addEventListener("blur", handleBlur);
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      window.removeEventListener("pointerout", handleGlobalPointerOut);
      window.removeEventListener("blur", handleBlur);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [reset]);

  return (
    <motion.div
      className={cn(
        "group relative isolate overflow-hidden rounded-[inherit] border border-transparent",
        className,
      )}
      onPointerMove={handlePointerMove}
      onPointerLeave={() => reset("leave")}
      onPointerEnter={() => reset("enter")}
      {...(restProps as any)}
      style={{
        background: useMotionTemplate`
          linear-gradient(var(--color-background) 0 0) padding-box,
          radial-gradient(${gradientSize}px circle at ${mouseX}px ${mouseY}px,
            ${gradientFrom},
            ${gradientTo},
            var(--color-border) 100%
          ) border-box
        `,
      }}
    >
      <div className="bg-background absolute inset-px z-20 rounded-[inherit]" />

      {mode === "gradient" && (
        <motion.div
          suppressHydrationWarning
          className="pointer-events-none absolute inset-px z-30 rounded-[inherit] opacity-0 transition-opacity duration-300 group-hover:opacity-[var(--gradient-opacity,1)]"
          style={
            {
              "--gradient-opacity": gradientOpacity,
              background: useMotionTemplate`
                radial-gradient(${gradientSize}px circle at ${mouseX}px ${mouseY}px,
                  ${gradientColor},
                  transparent 100%
                )
              `,
            } as any
          }
        />
      )}

      {mode === "orb" && (
        <motion.div
          suppressHydrationWarning
          aria-hidden="true"
          className="pointer-events-none absolute z-30"
          style={{
            width: glowSize,
            height: glowSize,
            x: orbX,
            y: orbY,
            translateX: "-50%",
            translateY: "-50%",
            borderRadius: 9999,
            filter: `blur(${glowBlur}px)`,
            opacity: orbVisible,
            background: `linear-gradient(${glowAngle}deg, ${glowFrom}, ${glowTo})`,

            mixBlendMode: isDark ? "screen" : "multiply",
            willChange: "transform, opacity",
          }}
        />
      )}
      <div className="relative z-40">{children}</div>
    </motion.div>
  );
}
