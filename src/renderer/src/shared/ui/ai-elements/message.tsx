"use client";

import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { math } from "@streamdown/math";
import { mermaid } from "@streamdown/mermaid";
import type { UIMessage } from "ai";
import type { ComponentProps, HTMLAttributes } from "react";
import { memo } from "react";
import { defaultComponents, Streamdown } from "streamdown";
import { cn } from "@/shared/lib";
import { Button } from "@/shared/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/shared/ui/tooltip";

export type MessageProps = HTMLAttributes<HTMLDivElement> & {
  from: UIMessage["role"];
};

export const Message = ({ className, from, ...props }: MessageProps) => (
  <div
    className={cn(
      "group flex min-w-0 w-full max-w-[95%] flex-col gap-2",
      from === "user" ? "is-user ml-auto justify-end" : "is-assistant",
      className,
    )}
    {...props}
  />
);

export type MessageContentProps = HTMLAttributes<HTMLDivElement>;

export const MessageContent = ({ children, className, ...props }: MessageContentProps) => (
  <div
    className={cn(
      "is-user:dark flex w-fit min-w-0 max-w-full flex-col gap-2 overflow-hidden text-sm",
      "group-[.is-user]:ml-auto group-[.is-user]:rounded-lg group-[.is-user]:border group-[.is-user]:border-border group-[.is-user]:bg-secondary group-[.is-user]:px-4 group-[.is-user]:py-3 group-[.is-user]:text-foreground group-[.is-user]:shadow-xs",
      "group-[.is-assistant]:text-foreground",
      className,
    )}
    {...props}
  >
    {children}
  </div>
);

export type MessageActionsProps = ComponentProps<"div">;

export const MessageActions = ({ className, children, ...props }: MessageActionsProps) => (
  <div className={cn("flex items-center gap-1", className)} {...props}>
    {children}
  </div>
);

export type MessageActionProps = ComponentProps<typeof Button> & {
  tooltip?: string;
  label?: string;
};

export const MessageAction = ({
  tooltip,
  children,
  label,
  variant = "ghost",
  size = "icon-sm",
  ...props
}: MessageActionProps) => {
  const button = (
    <Button size={size} type="button" variant={variant} {...props}>
      {children}
      <span className="sr-only">{label || tooltip}</span>
    </Button>
  );

  if (tooltip) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger>{button}</TooltipTrigger>
          <TooltipContent>
            <p>{tooltip}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return button;
};

export type MessageResponseProps = ComponentProps<typeof Streamdown>;

const streamdownPlugins = { cjk, code, math, mermaid };

/** Fragment links stay inside this answer; they must never open a browser window or alter routing. */
export function MessageAnchor({
  node: _node,
  href,
  onClick,
  ...props
}: ComponentProps<typeof defaultComponents.a>) {
  if (!href?.startsWith("#"))
    return <defaultComponents.a href={href} onClick={onClick} {...props} />;
  return (
    <a
      {...props}
      href={href}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented) return;
        event.preventDefault();
        let id: string;
        try {
          id = decodeURIComponent(href.slice(1));
        } catch {
          return;
        }
        const root =
          event.currentTarget.closest("[data-message-text]") ??
          event.currentTarget.closest(".markdown-response") ??
          document;
        const target = Array.from(root.querySelectorAll<HTMLElement>("[id]")).find(
          (element) => element.id === id,
        );
        target?.scrollIntoView({ block: "nearest", behavior: "smooth" });
        target?.focus({ preventScroll: true });
      }}
    />
  );
}

export const MessageResponse = memo(({ className, components, ...props }: MessageResponseProps) => (
  <Streamdown
    // space-y-0 覆盖 Streamdown 内部默认的 space-y-4(cn 合并时后写的生效)
    className={cn(
      "markdown-response size-full space-y-0 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
      className,
    )}
    plugins={streamdownPlugins}
    components={{ a: MessageAnchor, ...components }}
    {...props}
  />
));

MessageResponse.displayName = "MessageResponse";

export type MessageToolbarProps = ComponentProps<"div">;

export const MessageToolbar = ({ className, children, ...props }: MessageToolbarProps) => (
  <div className={cn("mt-4 flex w-full items-center justify-between gap-4", className)} {...props}>
    {children}
  </div>
);
