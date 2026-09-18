import {
  type DOMMotionComponents,
  type HTMLMotionProps,
  type MotionProps,
  motion,
  useInView,
} from "motion/react";
import {
  type ComponentType,
  type RefAttributes,
  type RefObject,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { cn } from "@/shared/lib";

const motionElements = {
  article: motion.article,
  div: motion.div,
  h1: motion.h1,
  h2: motion.h2,
  h3: motion.h3,
  h4: motion.h4,
  h5: motion.h5,
  h6: motion.h6,
  li: motion.li,
  p: motion.p,
  section: motion.section,
  span: motion.span,
} as const;

type MotionElementType = Extract<keyof DOMMotionComponents, keyof typeof motionElements>;
type TypingAnimationMotionComponent = ComponentType<
  Omit<HTMLMotionProps<"span">, "ref"> & RefAttributes<HTMLElement>
>;

interface TypingAnimationProps extends Omit<MotionProps, "children"> {
  children?: string;
  text?: string;
  words?: string[];
  className?: string;
  duration?: number;
  typeSpeed?: number;
  deleteSpeed?: number;
  delay?: number;
  pauseDelay?: number;
  loop?: boolean;
  as?: MotionElementType;
  startOnView?: boolean;
  showCursor?: boolean;
  blinkCursor?: boolean;
  cursorStyle?: "line" | "block" | "underscore";
}

export function TypingAnimation({
  children,
  text,
  words,
  className,
  duration = 100,
  typeSpeed,
  deleteSpeed,
  delay = 0,
  pauseDelay = 1000,
  loop = false,
  as: Component = "span",
  startOnView = true,
  showCursor = true,
  blinkCursor = true,
  cursorStyle = "line",
  ...props
}: TypingAnimationProps) {
  const MotionComponent = motionElements[Component] as TypingAnimationMotionComponent;

  const [displayedText, setDisplayedText] = useState<string>("");
  const [currentWordIndex, setCurrentWordIndex] = useState(0);
  const [currentCharIndex, setCurrentCharIndex] = useState(0);
  const [phase, setPhase] = useState<"typing" | "pause" | "deleting">("typing");
  const elementRef = useRef<HTMLElement | null>(null);
  const isInView = useInView(elementRef as RefObject<Element>, {
    amount: 0.3,
    once: true,
  });

  const rawContent = children ?? text;

  const normalizedWords = useMemo(() => {
    if (Array.isArray(words)) return words;
    if (typeof words === "string") return [words];
    return undefined;
  }, [words]);

  const wordsToAnimate = useMemo(
    () => normalizedWords ?? (rawContent ? [rawContent] : []),
    [normalizedWords, rawContent],
  );
  const hasMultipleWords = wordsToAnimate.length > 1;

  const typingSpeed = typeSpeed ?? duration;
  const deletingSpeed = deleteSpeed ?? typingSpeed / 2;

  const shouldStart = startOnView ? isInView : true;
  const animationSourceKey = useMemo(
    () => (normalizedWords ? normalizedWords.join("\u0000") : (rawContent ?? "")),
    [normalizedWords, rawContent],
  );

  useEffect(() => {
    setDisplayedText("");
    setCurrentWordIndex(0);
    setCurrentCharIndex(0);
    setPhase("typing");
  }, [animationSourceKey]);

  useEffect(() => {
    let timeout: ReturnType<typeof setTimeout> | null = null;

    if (shouldStart && wordsToAnimate.length > 0) {
      const timeoutDelay =
        delay > 0 && displayedText === ""
          ? delay
          : phase === "typing"
            ? typingSpeed
            : phase === "deleting"
              ? deletingSpeed
              : pauseDelay;

      timeout = setTimeout(() => {
        const currentWord = wordsToAnimate[currentWordIndex] || "";

        if (phase === "typing") {
          if (currentCharIndex < currentWord.length) {
            setDisplayedText(currentWord.slice(0, currentCharIndex + 1));
            setCurrentCharIndex((prev) => prev + 1);
          } else {
            if (hasMultipleWords || loop) {
              setPhase("pause");
            }
          }
        } else if (phase === "pause") {
          setPhase("deleting");
        } else if (phase === "deleting") {
          if (currentCharIndex > 0) {
            setDisplayedText(currentWord.slice(0, currentCharIndex - 1));
            setCurrentCharIndex((prev) => prev - 1);
          } else {
            setCurrentWordIndex((prev) => (prev + 1) % wordsToAnimate.length);
            setPhase("typing");
          }
        }
      }, timeoutDelay);
    }

    return () => {
      if (timeout) clearTimeout(timeout);
    };
  }, [
    shouldStart,
    wordsToAnimate,
    currentWordIndex,
    currentCharIndex,
    phase,
    typingSpeed,
    deletingSpeed,
    pauseDelay,
    delay,
    displayedText,
    hasMultipleWords,
    loop,
  ]);

  const cursorClass = useMemo(() => {
    if (!showCursor) return "";
    const styleClasses = {
      line: "border-r-2 border-current",
      block: "bg-current text-background",
      underscore: "border-b-2 border-current",
    };
    const blinkClass = blinkCursor ? "animate-pulse" : "";
    return `ml-0.5 inline-block ${styleClasses[cursorStyle]} ${blinkClass}`;
  }, [showCursor, cursorStyle, blinkCursor]);

  return (
    <MotionComponent
      ref={elementRef}
      className={cn("font-medium tracking-tight", className)}
      {...props}
    >
      {displayedText}
      {showCursor && (
        <span
          className={cn(
            cursorClass,
            cursorStyle === "block" && "h-[1.1em] w-[0.6em]",
            cursorStyle === "underscore" && "h-[0.2em] w-[0.6em]",
            cursorStyle === "line" && "h-[1.1em] inline-block align-middle",
          )}
        >
          {cursorStyle === "block" ? " " : ""}
        </span>
      )}
    </MotionComponent>
  );
}
