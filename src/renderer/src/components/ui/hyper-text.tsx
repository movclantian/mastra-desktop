import { AnimatePresence, motion } from "motion/react";
import * as React from "react";
import { cn } from "@/lib/utils";

const alphabets =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()_+~|}{[]:;?><,./-=";

export interface HyperTextProps {
  text: string;
  duration?: number;
  framerProps?: any;
  className?: string;
  animateOnHover?: boolean;
}

export function HyperText({
  text,
  duration = 800,
  framerProps = {
    initial: { opacity: 0, y: -10 },
    animate: { opacity: 1, y: 0 },
    exit: { opacity: 0, y: 3 },
  },
  className,
  animateOnHover = true,
}: HyperTextProps) {
  const [displayText, setDisplayText] = React.useState(text.split(""));
  const [trigger, setTrigger] = React.useState(false);
  const interations = React.useRef(0);
  const isFirstRender = React.useRef(true);

  const triggerAnimation = () => {
    interations.current = 0;
    setTrigger(true);
  };

  React.useEffect(() => {
    const interval = setInterval(
      () => {
        if (!trigger) {
          clearInterval(interval);
          return;
        }
        if (interations.current < text.length) {
          setDisplayText((t) =>
            t.map((l, i) =>
              l === " "
                ? " "
                : i <= interations.current
                  ? text[i]
                  : alphabets[Math.floor(Math.random() * alphabets.length)],
            ),
          );
          interations.current = interations.current + 0.1;
        } else {
          setTrigger(false);
          clearInterval(interval);
        }
      },
      duration / (text.length * 10),
    );
    // Clean up interval on unmount
    return () => clearInterval(interval);
  }, [text, duration, trigger]);

  React.useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      triggerAnimation();
    }
  }, []);

  return (
    <div
      className="flex scale-100 cursor-default overflow-hidden py-1 select-none"
      onMouseEnter={animateOnHover ? triggerAnimation : undefined}
    >
      <AnimatePresence mode="wait">
        {displayText.map((letter, i) => (
          <motion.span key={i} className={cn("font-mono", className)} {...framerProps}>
            {letter}
          </motion.span>
        ))}
      </AnimatePresence>
    </div>
  );
}
