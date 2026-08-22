import * as React from "react";
import { cn } from "@/lib/utils";

export interface FlickeringGridProps extends React.HTMLAttributes<HTMLDivElement> {
  squareSize?: number;
  gridGap?: number;
  flickerChance?: number;
  color?: string;
  width?: number;
  height?: number;
  className?: string;
  maxOpacity?: number;
}

export function FlickeringGrid({
  squareSize = 4,
  gridGap = 6,
  flickerChance = 0.3,
  color = "rgb(120, 119, 198)",
  width,
  height,
  className,
  maxOpacity = 0.3,
  ...props
}: FlickeringGridProps) {
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const [canvasSize, setCanvasSize] = React.useState({ width: 0, height: 0 });

  React.useEffect(() => {
    const updateSize = () => {
      if (containerRef.current) {
        setCanvasSize({
          width: width || containerRef.current.clientWidth,
          height: height || containerRef.current.clientHeight,
        });
      }
    };

    updateSize();
    window.addEventListener("resize", updateSize);
    return () => window.removeEventListener("resize", updateSize);
  }, [width, height]);

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const cols = Math.floor(canvasSize.width / (squareSize + gridGap));
    const rows = Math.floor(canvasSize.height / (squareSize + gridGap));

    const grid = Array.from({ length: cols * rows }, () => Math.random() * maxOpacity);

    let animationId: number;

    const render = () => {
      ctx.clearRect(0, 0, canvasSize.width, canvasSize.height);

      for (let i = 0; i < cols; i++) {
        for (let j = 0; j < rows; j++) {
          const index = i * rows + j;
          if (Math.random() < flickerChance) {
            grid[index] = Math.random() * maxOpacity;
          }

          ctx.fillStyle = color.replace("rgb", "rgba").replace(")", `, ${grid[index]})`);
          ctx.fillRect(
            i * (squareSize + gridGap),
            j * (squareSize + gridGap),
            squareSize,
            squareSize,
          );
        }
      }

      animationId = requestAnimationFrame(render);
    };

    render();

    return () => cancelAnimationFrame(animationId);
  }, [canvasSize, squareSize, gridGap, flickerChance, color, maxOpacity]);

  return (
    <div
      ref={containerRef}
      className={cn("pointer-events-none absolute inset-0 size-full", className)}
      {...props}
    >
      <canvas
        ref={canvasRef}
        width={canvasSize.width}
        height={canvasSize.height}
        className="size-full"
      />
    </div>
  );
}
