import type { BorderBeamColorVariant, BorderBeamSize } from "border-beam";
import { BorderBeam } from "border-beam";
import * as React from "react";
import { useTheme } from "@/components/theme-provider";

/**
 * 输入框流光边框(beam.jakubantalik.com/pulse,border-beam 组件)。
 *
 * 拦截 LLM 运行状态:status 从 ready/error 切换到 submitted/streaming 的瞬间
 * 重新随机 size / colorVariant / strength 三个参数并点亮;同一轮生成
 * (submitted → streaming)不重掷;生成结束(→ ready/error)交给组件内建的
 * 0.5s 淡出动画回到不可见空态。
 *
 * BorderBeam 常驻挂载(不随生成卸载),避免包裹层变化导致输入框 remount
 * 丢焦点;空闲时效果层 display:none / 伪元素无 content,零视觉残留。
 */

type ChatRuntimeStatus = "ready" | "submitted" | "streaming" | "error";

/**
 * size 池排除 pulse-outside:它的光晕渲染在子元素背后(z-index: -1),
 * 要求子元素有不透明背景,而输入框浅色主题是透明底,会整片透光穿帮。
 */
const BEAM_SIZES: BorderBeamSize[] = ["sm", "md", "line", "pulse-inner"];

const BEAM_COLORS: BorderBeamColorVariant[] = ["colorful", "mono", "ocean", "sunset"];

/** strength 掷在 0.7-1.0:保持随机但不低于「明显可见」的强度 */
const STRENGTH_MIN = 0.7;
const STRENGTH_RANGE = 0.3;

/**
 * 颜色强度增强。
 *
 * 组件各 size 预设的笔画/内辉/泛光透明度在浅色主题下非常保守
 * (如 md.light 的 stroke 仅 0.12),白色背景上会显得「浅浅的」。
 * 透明度计算里留了三个可继承的 CSS 变量(--beam-*-opacity,默认 1),
 * 在这里统一放大,再补一档 saturation / brightness 让颜色更饱和鲜亮。
 */
const BEAM_INTENSITY_STYLE = {
  "--beam-stroke-opacity": 1.8,
  "--beam-inner-opacity": 1.4,
  "--beam-bloom-opacity": 1.6,
} as React.CSSProperties;

/** 与上面变量的放大倍数配套:饱和度/亮度/色相流动幅度 */
const BEAM_SATURATION = 2;
const BEAM_BRIGHTNESS = 1.6;
const BEAM_HUE_RANGE = 60;

interface BeamConfig {
  size: BorderBeamSize;
  colorVariant: BorderBeamColorVariant;
  strength: number;
}

function rollBeamConfig(): BeamConfig {
  const pick = <T,>(pool: T[]): T => pool[Math.floor(Math.random() * pool.length)];
  return {
    size: pick(BEAM_SIZES),
    colorVariant: pick(BEAM_COLORS),
    strength: Number((STRENGTH_MIN + Math.random() * STRENGTH_RANGE).toFixed(2)),
  };
}

export function PromptInputGlow({
  status,
  children,
}: {
  status: ChatRuntimeStatus;
  children: React.ReactNode;
}) {
  const { theme } = useTheme();
  const [config, setConfig] = React.useState<BeamConfig>(rollBeamConfig);
  const [active, setActive] = React.useState(false);
  const busyRef = React.useRef(false);

  React.useEffect(() => {
    const busy = status === "submitted" || status === "streaming";

    // 拦截 ready/error → submitted/streaming:重掷三参数并点亮
    if (busy && !busyRef.current) {
      setConfig(rollBeamConfig());
      setActive(true);
    }

    // 生成结束:active=false 触发组件内建淡出,无需定时器
    if (!busy && busyRef.current) {
      setActive(false);
    }

    busyRef.current = busy;
  }, [status]);

  return (
    <BorderBeam
      active={active}
      brightness={BEAM_BRIGHTNESS}
      // 输入框 rounded-lg(8px);显式传入可跳过组件对第一子元素圆角的探测
      borderRadius={8}
      colorVariant={config.colorVariant}
      hueRange={BEAM_HUE_RANGE}
      saturation={BEAM_SATURATION}
      size={config.size}
      strength={config.strength}
      theme={theme === "system" ? "auto" : theme}
      // 1) 组件默认 overflow:hidden 会裁掉 SkillAwareTextarea 渲染在输入框
      //    上方的 / 与 @ 命令下拉浮层;效果层自带 clip-path 自裁剪,放开安全
      // 2) --beam-*-opacity 放大各效果层透明度,让颜色更鲜亮
      style={{ overflow: "visible", ...BEAM_INTENSITY_STYLE }}
    >
      {children}
    </BorderBeam>
  );
}
