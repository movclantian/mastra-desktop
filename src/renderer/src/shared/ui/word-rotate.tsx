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
  duration = 6000,
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
    setIndex(0);
  }, [wordsKey]);

  useEffect(() => {
    if (words.length <= 1) return;
    const interval = setInterval(() => {
      setIndex((prevIndex) => (prevIndex + 1) % words.length);
    }, duration);

    return () => clearInterval(interval);
  }, [wordsKey, words.length, duration]);

  const safeIndex = words.length > 0 ? index % words.length : 0;
  const currentWord = words[safeIndex];

  if (!currentWord) return null;

  return (
    <div className="overflow-hidden py-0.5">
      <AnimatePresence mode="wait">
        <motion.span
          key={`${currentWord}-${safeIndex}`}
          className={cn("inline-block", className)}
          {...motionProps}
        >
          {currentWord}
        </motion.span>
      </AnimatePresence>
    </div>
  );
}
