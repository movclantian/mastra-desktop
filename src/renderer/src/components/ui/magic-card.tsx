import * as React from "react";
import { cn } from "@/lib/utils";

export interface MagicCardProps extends React.HTMLAttributes<HTMLDivElement> {
  gradientSize?: number;
  gradientColor?: string;
  gradientOpacity?: number;
  gradientFrom?: string;
  gradientTo?: string;
}

export function MagicCard({
  children,
  className,
  gradientSize = 200,
  gradientColor = "#262626",
  gradientOpacity = 0.8,
  gradientFrom = "var(--primary)",
  gradientTo = "var(--accent)",
  ...props
}: MagicCardProps) {
  const cardRef = React.useRef<HTMLDivElement>(null);
  const [mouseX, setMouseX] = React.useState(-gradientSize);
  const [mouseY, setMouseY] = React.useState(-gradientSize);

  const handleMouseMove = React.useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (cardRef.current) {
      const { left, top } = cardRef.current.getBoundingClientRect();
      setMouseX(e.clientX - left);
      setMouseY(e.clientY - top);
    }
  }, []);

  const handleMouseLeave = React.useCallback(() => {
    setMouseX(-gradientSize);
    setMouseY(-gradientSize);
  }, [gradientSize]);

  return (
    <div
      ref={cardRef}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      className={cn(
        "group relative flex size-full rounded-xl border bg-card text-card-foreground shadow-xs overflow-hidden",
        className,
      )}
      {...props}
    >
      <div
        className="pointer-events-none absolute -inset-px rounded-xl opacity-0 transition-opacity duration-300 group-hover:opacity-100"
        style={{
          background: `radial-gradient(${gradientSize}px circle at ${mouseX}px ${mouseY}px, ${gradientFrom}, transparent 80%)`,
        }}
      />
      <div
        className="pointer-events-none absolute inset-0 rounded-[calc(var(--radius)-1px)] opacity-0 transition-opacity duration-300 group-hover:opacity-100"
        style={{
          background: `radial-gradient(${gradientSize}px circle at ${mouseX}px ${mouseY}px, color-mix(in srgb, ${gradientTo} 15%, transparent), transparent 70%)`,
        }}
      />
      <div className="relative z-10 size-full">{children}</div>
    </div>
  );
}
