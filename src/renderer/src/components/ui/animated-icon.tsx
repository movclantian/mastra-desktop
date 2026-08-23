import { motion } from "motion/react";
import type * as React from "react";
import { cn } from "@/lib/utils";

export interface AnimatedChevronProps {
  open: boolean;
  className?: string;
  size?: number;
  direction?: "down" | "right";
}

export function AnimatedChevron({
  open,
  className,
  size = 16,
  direction = "down",
}: AnimatedChevronProps) {
  return (
    <motion.svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      animate={{
        rotate: open ? (direction === "down" ? 180 : 90) : 0,
      }}
      transition={{
        type: "spring",
        stiffness: 280,
        damping: 20,
      }}
      className={cn("shrink-0", className)}
    >
      <path d="m6 9 6 6 6-6" />
    </motion.svg>
  );
}

export function AnimatedClickBounce({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <motion.span
      whileTap={{ scale: 0.88 }}
      whileHover={{ scale: 1.05 }}
      transition={{ type: "spring", stiffness: 400, damping: 17 }}
      className={cn("inline-flex items-center justify-center", className)}
    >
      {children}
    </motion.span>
  );
}
