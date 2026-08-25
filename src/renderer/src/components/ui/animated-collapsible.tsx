import { AnimatePresence, motion } from "motion/react";
import type * as React from "react";
import { cn } from "@/lib/utils";

export interface AnimatedCollapsibleProps {
  open: boolean;
  /** 折叠头。开关由调用方在这里自行绑定 —— 本组件只负责内容区的物理展开 */
  trigger?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  contentClassName?: string;
  /** 展开/收起的观感时长(秒)。弹性由 bounce 保留,不退化成线性补间 */
  duration?: number;
}

const BOUNCE_IN = 0.18;
const BOUNCE_OUT = 0.1;

export function AnimatedCollapsible({
  open,
  children,
  trigger,
  className,
  contentClassName,
  duration = 0.3,
}: AnimatedCollapsibleProps) {
  return (
    <div className={cn("w-full overflow-hidden", className)}>
      {trigger}
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{
              height: "auto",
              opacity: 1,
              transition: {
                height: { type: "spring", visualDuration: duration, bounce: BOUNCE_IN },
                opacity: { duration: duration * 0.6, ease: "easeOut" },
              },
            }}
            exit={{
              height: 0,
              opacity: 0,
              transition: {
                height: { type: "spring", visualDuration: duration * 0.8, bounce: BOUNCE_OUT },
                opacity: { duration: duration * 0.45, ease: "easeIn" },
              },
            }}
            className={cn("overflow-hidden", contentClassName)}
          >
            {children}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
