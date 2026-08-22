import { motion } from "motion/react";
import * as React from "react";
import { cn } from "@/lib/utils";

interface Sparkle {
  id: string;
  x: string;
  y: string;
  color: string;
  delay: number;
  scale: number;
  lifespan: number;
}

export interface SparklesTextProps {
  text: string;
  sparklesCount?: number;
  className?: string;
  colors?: {
    first: string;
    second: string;
  };
}

const SparkleSvg = ({ color }: { color: string }) => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    className="size-full"
  >
    <path
      d="M12 0L14.59 9.41L24 12L14.59 14.59L12 24L9.41 14.59L0 12L9.41 9.41L12 0Z"
      fill={color}
    />
  </svg>
);

export function SparklesText({
  text,
  sparklesCount = 10,
  className,
  colors = {
    first: "#9E7AFF",
    second: "#FE8FB5",
  },
}: SparklesTextProps) {
  const [sparkles, setSparkles] = React.useState<Sparkle[]>([]);

  React.useEffect(() => {
    const generateSparkle = (): Sparkle => {
      return {
        id: Math.random().toString(),
        x: `${Math.random() * 100}%`,
        y: `${Math.random() * 100}%`,
        color: Math.random() > 0.5 ? colors.first : colors.second,
        delay: Math.random() * 2,
        scale: Math.random() * 0.6 + 0.4,
        lifespan: Math.random() * 1.5 + 1.5,
      };
    };

    const newSparkles = Array.from({ length: sparklesCount }, generateSparkle);
    setSparkles(newSparkles);
  }, [sparklesCount, colors.first, colors.second]);

  return (
    <div className={cn("relative inline-block", className)}>
      <span className="relative z-10">{text}</span>
      {sparkles.map((sparkle) => (
        <motion.div
          key={sparkle.id}
          className="pointer-events-none absolute size-4"
          style={{
            top: sparkle.y,
            left: sparkle.x,
          }}
          initial={{ scale: 0, rotate: 0 }}
          animate={{
            scale: [0, sparkle.scale, 0],
            rotate: [0, 90, 180],
          }}
          transition={{
            duration: sparkle.lifespan,
            repeat: Number.POSITIVE_INFINITY,
            delay: sparkle.delay,
            ease: "easeInOut",
          }}
        >
          <SparkleSvg color={sparkle.color} />
        </motion.div>
      ))}
    </div>
  );
}
