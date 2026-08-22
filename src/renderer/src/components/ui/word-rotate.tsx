import { AnimatePresence, type HTMLMotionProps, motion } from "motion/react";
import * as React from "react";
import { cn } from "@/lib/utils";

export interface WordRotateProps {
  words: string[];
  duration?: number;
  framerProps?: HTMLMotionProps<"span">;
  className?: string;
}

export function WordRotate({
  words,
  duration = 2500,
  framerProps = {
    initial: { opacity: 0, y: -16 },
    animate: { opacity: 1, y: 0 },
    exit: { opacity: 0, y: 16 },
    transition: { duration: 0.25, ease: "easeOut" },
  },
  className,
}: WordRotateProps) {
  const [index, setIndex] = React.useState(0);

  React.useEffect(() => {
    const interval = setInterval(() => {
      setIndex((prevIndex) => (prevIndex + 1) % words.length);
    }, duration);

    return () => clearInterval(interval);
  }, [words, duration]);

  return (
    <div className="overflow-hidden py-1">
      <AnimatePresence mode="wait">
        <motion.span key={words[index]} className={cn("inline-block", className)} {...framerProps}>
          {words[index]}
        </motion.span>
      </AnimatePresence>
    </div>
  );
}
