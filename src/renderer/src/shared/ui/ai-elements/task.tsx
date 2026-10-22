import { SearchIcon } from "lucide-react";
import type { ComponentProps } from "react";
import { cn } from "@/shared/lib/utils";
import { Badge } from "@/shared/ui/badge";
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "@/shared/ui/trace";

export function TaskItemFile({ className, ...props }: ComponentProps<typeof Badge>) {
  return <Badge variant="secondary" className={cn("gap-1 font-normal", className)} {...props} />;
}
export function Task(props: ComponentProps<typeof TraceCollapsible>) {
  return (
    <Trace>
      <TraceCollapsible defaultOpen {...props} />
    </Trace>
  );
}
export function TaskTrigger({
  children,
  title,
  status,
  ...props
}: ComponentProps<typeof TraceCollapsibleTrigger> & {
  title: string;
  status?: ComponentProps<typeof TraceLine>["status"];
}) {
  return (
    <TraceCollapsibleTrigger {...props}>
      <TraceLine className="flex-1" status={status}>
        <TraceIcon>
          <SearchIcon />
        </TraceIcon>
        <TraceTitle className="flex-1 whitespace-normal">{title}</TraceTitle>
        {children}
      </TraceLine>
    </TraceCollapsibleTrigger>
  );
}
export function TaskContent({
  children,
  ...props
}: ComponentProps<typeof TraceCollapsibleContent>) {
  return (
    <TraceCollapsibleContent keepMounted {...props}>
      <Trace>{children}</Trace>
    </TraceCollapsibleContent>
  );
}
