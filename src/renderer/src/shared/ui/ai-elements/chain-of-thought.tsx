import { BrainIcon } from "lucide-react";
import type { ComponentProps } from "react";
import { cn } from "@/shared/lib/utils";
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "@/shared/ui/trace";

export function ChainOfThought({ children, ...props }: ComponentProps<typeof TraceCollapsible>) {
  return (
    <Trace>
      <TraceCollapsible {...props}>{children}</TraceCollapsible>
    </Trace>
  );
}
export function ChainOfThoughtHeader({
  children,
  className,
  status,
  ...props
}: ComponentProps<typeof TraceCollapsibleTrigger> & {
  status?: ComponentProps<typeof TraceLine>["status"];
}) {
  return (
    <TraceCollapsibleTrigger className={cn("w-full", className)} {...props}>
      <TraceLine className="flex-1" status={status}>
        <TraceIcon>
          <BrainIcon />
        </TraceIcon>
        <TraceTitle className="flex-1 whitespace-normal">{children}</TraceTitle>
      </TraceLine>
    </TraceCollapsibleTrigger>
  );
}
export function ChainOfThoughtContent({
  children,
  ...props
}: ComponentProps<typeof TraceCollapsibleContent>) {
  return (
    <TraceCollapsibleContent {...props}>
      <Trace>{children}</Trace>
    </TraceCollapsibleContent>
  );
}
