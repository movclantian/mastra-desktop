import * as React from "react";
import { cn } from "@/lib/utils";

export interface TypingAnimationProps {
  text: string;
  duration?: number;
  className?: string;
  cursor?: boolean;
}

export function TypingAnimation({
  text,
  duration = 50,
  className,
  cursor = true,
}: TypingAnimationProps) {
  const [displayedText, setDisplayedText] = React.useState<string>("");
  const [i, setI] = React.useState<number>(0);

  React.useEffect(() => {
    const typingEffect = setInterval(() => {
      if (i < text.length) {
        setDisplayedText(text.substring(0, i + 1));
        setI(i + 1);
      } else {
        clearInterval(typingEffect);
      }
    }, duration);

    return () => {
      clearInterval(typingEffect);
    };
  }, [duration, i, text]);

  return (
    <span className={cn("font-sans leading-[1.2] tracking-[-0.02em]", className)}>
      {displayedText}
      {cursor && i < text.length && (
        <span className="ml-0.5 inline-block w-1.5 animate-pulse bg-primary">|</span>
      )}
    </span>
  );
}
