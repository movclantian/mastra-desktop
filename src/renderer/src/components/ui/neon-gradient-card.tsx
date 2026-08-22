import * as React from "react";
import { cn } from "@/lib/utils";

export interface NeonGradientCardProps extends React.HTMLAttributes<HTMLDivElement> {
  className?: string;
  children?: React.ReactNode;
  borderSize?: number;
  borderRadius?: number;
  neonColors?: {
    firstColor: string;
    secondColor: string;
  };
}

export function NeonGradientCard({
  className,
  children,
  borderSize = 2,
  borderRadius = 12,
  neonColors = {
    firstColor: "var(--primary)",
    secondColor: "var(--accent)",
  },
  ...props
}: NeonGradientCardProps) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = React.useState({ width: 0, height: 0 });

  React.useEffect(() => {
    const updateDimensions = () => {
      if (containerRef.current) {
        const { offsetWidth, offsetHeight } = containerRef.current;
        setDimensions({ width: offsetWidth, height: offsetHeight });
      }
    };

    updateDimensions();
    window.addEventListener("resize", updateDimensions);
    return () => window.removeEventListener("resize", updateDimensions);
  }, []);

  return (
    <div
      ref={containerRef}
      style={
        {
          "--border-size": `${borderSize}px`,
          "--border-radius": `${borderRadius}px`,
          "--neon-first-color": neonColors.firstColor,
          "--neon-second-color": neonColors.secondColor,
          "--card-width": `${dimensions.width}px`,
          "--card-height": `${dimensions.height}px`,
        } as React.CSSProperties
      }
      className={cn("relative z-10 size-full rounded-[var(--border-radius)]", className)}
      {...props}
    >
      <div
        className={cn(
          "relative size-full min-h-[inherit] rounded-[calc(var(--border-radius)-var(--border-size))] bg-card p-6 text-card-foreground",
          "before:absolute before:-top-[var(--border-size)] before:-left-[var(--border-size)] before:-z-10 before:block",
          "before:h-[calc(100%+var(--border-size)*2)] before:w-[calc(100%+var(--border-size)*2)] before:rounded-[var(--border-radius)] before:content-['']",
          "before:bg-[linear-gradient(0deg,var(--neon-first-color),var(--neon-second-color))] before:bg-[length:100%_200%]",
          "before:animate-background-position-spin",
          "after:absolute after:-top-[var(--border-size)] after:-left-[var(--border-size)] after:-z-10 after:block",
          "after:h-[calc(100%+var(--border-size)*2)] after:w-[calc(100%+var(--border-size)*2)] after:rounded-[var(--border-radius)] after:blur-[12px] after:content-['']",
          "after:bg-[linear-gradient(0deg,var(--neon-first-color),var(--neon-second-color))] after:bg-[length:100%_200%] after:opacity-60",
          "after:animate-background-position-spin",
        )}
      >
        {children}
      </div>
    </div>
  );
}
