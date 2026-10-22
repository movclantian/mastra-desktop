"use client";

import { CircleCheckIcon, CircleDotIcon, CircleIcon, PaperclipIcon } from "lucide-react";
import { type ComponentProps, forwardRef, type ReactNode } from "react";
import { cn } from "@/shared/lib";
import { Button } from "@/shared/ui/button";
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "@/shared/ui/trace";

export type QueueItemProps = ComponentProps<"div">;

export const QueueItem = forwardRef<HTMLDivElement, QueueItemProps>(
  ({ className, ...props }, ref) => (
    <div
      className={cn(
        "group flex min-w-0 w-full flex-col gap-1 rounded-md px-3 hover:bg-muted",
        className,
      )}
      ref={ref}
      {...props}
    />
  ),
);

QueueItem.displayName = "QueueItem";

export type QueueItemIndicatorProps = ComponentProps<"span"> & {
  completed?: boolean;
  inProgress?: boolean;
};

export const QueueItemIndicator = ({
  completed = false,
  inProgress = false,
  className,
  ...props
}: QueueItemIndicatorProps) => (
  <TraceIcon className={className} {...props}>
    {completed ? <CircleCheckIcon /> : inProgress ? <CircleDotIcon /> : <CircleIcon />}
  </TraceIcon>
);

export type QueueItemContentProps = ComponentProps<"span"> & {
  completed?: boolean;
};

export const QueueItemContent = ({
  completed = false,
  className,
  ...props
}: QueueItemContentProps) => (
  <TraceTitle
    className={cn(
      "grow whitespace-normal break-words",
      completed ? "text-muted-foreground/50 line-through" : "text-muted-foreground",
      className,
    )}
    {...props}
  />
);

export type QueueItemDescriptionProps = ComponentProps<typeof TraceDescription> & {
  completed?: boolean;
};

export const QueueItemDescription = ({
  completed = false,
  className,
  ...props
}: QueueItemDescriptionProps) => (
  <TraceDescription
    className={cn(
      "ml-6 whitespace-normal break-words text-xs",
      completed ? "text-muted-foreground/40 line-through" : "text-muted-foreground",
      className,
    )}
    {...props}
  />
);

export type QueueItemActionsProps = ComponentProps<"div">;

export const QueueItemActions = ({ className, ...props }: QueueItemActionsProps) => (
  <div className={cn("flex gap-1", className)} {...props} />
);

export type QueueItemActionProps = Omit<ComponentProps<typeof Button>, "variant" | "size">;

export const QueueItemAction = ({ className, ...props }: QueueItemActionProps) => (
  <Button
    className={cn(
      "size-auto rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-muted-foreground/10 hover:text-foreground group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100",
      className,
    )}
    size="icon"
    type="button"
    variant="ghost"
    {...props}
  />
);

export type QueueItemAttachmentProps = ComponentProps<"div">;

export const QueueItemAttachment = ({ className, ...props }: QueueItemAttachmentProps) => (
  <div className={cn("mt-1 flex flex-wrap gap-2", className)} {...props} />
);

export type QueueItemImageProps = ComponentProps<"img">;

export const QueueItemImage = ({ className, ...props }: QueueItemImageProps) => (
  <img
    alt=""
    className={cn("h-8 w-8 rounded border object-cover", className)}
    height={32}
    width={32}
    {...props}
  />
);

export type QueueItemFileProps = ComponentProps<"span">;

export const QueueItemFile = ({ children, className, ...props }: QueueItemFileProps) => (
  <span
    className={cn("flex items-center gap-1 rounded border bg-muted px-2 py-1 text-xs", className)}
    {...props}
  >
    <PaperclipIcon size={12} />
    <span className="max-w-[100px] truncate">{children}</span>
  </span>
);

export type QueueListProps = ComponentProps<"div">;

export const QueueList = (props: QueueListProps) => <Trace {...props} />;

// QueueSection - collapsible section container
export type QueueSectionProps = ComponentProps<typeof TraceCollapsible>;

export const QueueSection = ({ className, defaultOpen = true, ...props }: QueueSectionProps) => (
  <TraceCollapsible className={cn(className)} defaultOpen={defaultOpen} {...props} />
);

// QueueSectionTrigger - section header/trigger
export type QueueSectionTriggerProps = ComponentProps<"button"> & {
  action?: ReactNode;
};

export const QueueSectionTrigger = ({
  children,
  className,
  action,
  ...props
}: QueueSectionTriggerProps) => (
  <div className="flex min-w-0 items-center gap-1">
    <TraceCollapsibleTrigger
      render={
        <Button
          variant="ghost"
          size="xs"
          className={cn(
            "group flex h-auto min-w-0 flex-1 items-center justify-between rounded-md bg-muted/40 px-2 py-1 text-left font-medium text-muted-foreground text-sm transition-colors hover:bg-muted",
            className,
          )}
          type="button"
          {...props}
        />
      }
    >
      {children}
    </TraceCollapsibleTrigger>
    {action}
  </div>
);

// QueueSectionLabel - label content with icon and count
export type QueueSectionLabelProps = ComponentProps<"span"> & {
  count?: number;
  label: string;
  icon?: React.ReactNode;
};

export const QueueSectionLabel = ({
  count,
  label,
  icon,
  className,
  ...props
}: QueueSectionLabelProps) => (
  <TraceLine className={className} {...props}>
    {icon ? <TraceIcon>{icon}</TraceIcon> : null}
    <TraceTitle>
      {count} {label}
    </TraceTitle>
  </TraceLine>
);

// QueueSectionContent - collapsible content area
export type QueueSectionContentProps = ComponentProps<typeof TraceCollapsibleContent>;

export const QueueSectionContent = ({ className, ...props }: QueueSectionContentProps) => (
  <TraceCollapsibleContent className={cn(className)} {...props} />
);

export type QueueProps = ComponentProps<"div">;

export const Queue = ({ className, ...props }: QueueProps) => (
  <Trace
    className={cn(
      "flex flex-col gap-2 rounded-xl border border-border bg-background px-3 pt-2 pb-2 shadow-xs",
      className,
    )}
    {...props}
  />
);
