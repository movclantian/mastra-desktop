"use client";

import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { createMathPlugin } from "@streamdown/math";
import { mermaid } from "@streamdown/mermaid";

import type { ComponentProps } from "react";
import { memo } from "react";
import { defaultComponents, Streamdown } from "streamdown";
import { cn } from "@/shared/lib";

export type MessageResponseProps = ComponentProps<typeof Streamdown>;

export const streamdownPlugins = {
  cjk,
  code,
  math: createMathPlugin({ singleDollarTextMath: true }),
  mermaid,
};

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
