import { AnimatePresence, motion } from "motion/react";
import type * as React from "react";
import { cn } from "@/lib/utils";

export interface AnimatedCollapsibleProps {
  open: boolean;
  onOpenChange?: (open: boolean) => void;
  trigger?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  contentClassName?: string;
  duration?: number;
}

export function AnimatedCollapsible({
  open,
  children,
  trigger,
  className,
  contentClassName,
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
                height: { type: "spring", stiffness: 220, damping: 26 },
                opacity: { duration: 0.2, ease: "easeOut" },
              },
            }}
            exit={{
              height: 0,
              opacity: 0,
              transition: {
                height: { type: "spring", stiffness: 240, damping: 28 },
                opacity: { duration: 0.15, ease: "easeIn" },
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
