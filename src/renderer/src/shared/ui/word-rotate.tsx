"use client";

import { AnimatePresence, type MotionProps, motion } from "motion/react";
import { useEffect, useState } from "react";

import { cn } from "@/shared/lib";

interface WordRotateProps {
  words: string[];
  duration?: number;
  motionProps?: MotionProps;
  className?: string;
}

export function WordRotate({
  words,
  duration = 2500,
  motionProps = {
    initial: { opacity: 0, y: -16 },
    animate: { opacity: 1, y: 0 },
    exit: { opacity: 0, y: 16 },
    transition: { duration: 0.25, ease: "easeOut" },
  },
  className,
}: WordRotateProps) {
  const [index, setIndex] = useState(0);
  const wordsKey = words.join("\0");

  useEffect(() => {
    if (words.length <= 1) return;
    const interval = setInterval(() => {
      setIndex((prevIndex) => (prevIndex + 1) % words.length);
    }, duration);

    return () => clearInterval(interval);
  }, [wordsKey, words.length, duration]);

  return (
    <div className="overflow-hidden py-0.5">
      <AnimatePresence mode="wait">
        <motion.span
          key={`${words[index]}-${index}`}
          className={cn("inline-block", className)}
          {...motionProps}
        >
          {words[index]}
        </motion.span>
      </AnimatePresence>
    </div>
  );
}
