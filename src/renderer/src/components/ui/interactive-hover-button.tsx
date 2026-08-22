import { ArrowRight } from "lucide-react";
import * as React from "react";
import { cn } from "@/lib/utils";

export interface InteractiveHoverButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  text?: string;
}

export const InteractiveHoverButton = React.forwardRef<
  HTMLButtonElement,
  InteractiveHoverButtonProps
>(({ text = "Button", className, children, ...props }, ref) => {
  return (
    <button
      ref={ref}
      className={cn(
        "group relative w-auto cursor-pointer overflow-hidden rounded-full border bg-background p-2 px-6 text-center font-semibold",
        className,
      )}
      {...props}
    >
      <div className="flex items-center gap-2">
        <div className="size-2 rounded-full bg-primary transition-all duration-300 group-hover:scale-[100.8]" />
        <span className="inline-block transition-all duration-300 group-hover:translate-x-12 group-hover:opacity-0">
          {children || text}
        </span>
      </div>
      <div className="absolute top-0 z-10 flex size-full translate-x-12 items-center justify-center gap-2 text-primary-foreground opacity-0 transition-all duration-300 group-hover:-translate-x-5 group-hover:opacity-100">
        <span>{children || text}</span>
        <ArrowRight className="size-4" />
      </div>
    </button>
  );
});

InteractiveHoverButton.displayName = "InteractiveHoverButton";
