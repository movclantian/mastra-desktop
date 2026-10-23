import type { ComponentProps } from "react";
import { createContext, useContext } from "react";
import { cn } from "@/shared/lib/utils";
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceLine,
  TraceTitle,
} from "@/shared/ui/trace";

const PlanStreamingContext = createContext(false);

export function Plan({
  children,
  isStreaming = false,
  ...props
}: ComponentProps<typeof TraceCollapsible> & { isStreaming?: boolean }) {
  return (
    <PlanStreamingContext.Provider value={isStreaming}>
      <Trace>
        <TraceCollapsible {...props}>{children}</TraceCollapsible>
      </Trace>
    </PlanStreamingContext.Provider>
  );
}
export function PlanHeader({
  children,
  className,
  ...props
}: ComponentProps<typeof TraceCollapsibleTrigger>) {
  return (
    <TraceCollapsibleTrigger className={cn("flex-1", className)} {...props}>
      <TraceLine
        className="min-w-0 flex-1 flex-wrap"
        status={useContext(PlanStreamingContext) ? "running" : undefined}
      >
        {children}
      </TraceLine>
    </TraceCollapsibleTrigger>
  );
}
export function PlanTitle({ className, ...props }: ComponentProps<typeof TraceTitle>) {
  return <TraceTitle className={cn("whitespace-normal font-medium", className)} {...props} />;
}
export function PlanDescription({ className, ...props }: ComponentProps<typeof TraceDescription>) {
  return (
    <TraceDescription className={cn("block whitespace-normal text-sm", className)} {...props} />
  );
}
export function PlanContent({
  children,
  ...props
}: ComponentProps<typeof TraceCollapsibleContent>) {
  return <TraceCollapsibleContent {...props}>{children}</TraceCollapsibleContent>;
}
export function PlanAction(props: ComponentProps<"div">) {
  return <div {...props} />;
}
export function PlanFooter({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("mt-2 flex flex-wrap items-center gap-2", className)} {...props} />;
}
