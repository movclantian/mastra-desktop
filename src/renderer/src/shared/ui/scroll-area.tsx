"use client";

import { ScrollArea as ScrollAreaPrimitive } from "@base-ui/react/scroll-area";
import * as React from "react";

import { cn } from "@/shared/lib";

function ScrollArea({
  className,
  children,
  orientation = "vertical",
  ...props
}: ScrollAreaPrimitive.Root.Props & {
  orientation?: "vertical" | "horizontal" | "both" | "none";
}) {
  const contentChildren: React.ReactNode[] = [];
  const scrollbarChildren: React.ReactNode[] = [];

  React.Children.forEach(children, (child) => {
    if (
      React.isValidElement(child) &&
      (child.type === ScrollBar ||
        (child.props as { "data-slot"?: string })?.["data-slot"] === "scroll-area-scrollbar")
    ) {
      scrollbarChildren.push(child);
    } else {
      contentChildren.push(child);
    }
  });

  const hasExplicitScrollbars = scrollbarChildren.length > 0;
  const scrollsHorizontally = orientation === "horizontal" || orientation === "both";

  return (
    <ScrollAreaPrimitive.Root
      data-slot="scroll-area"
      className={cn("group/scroll-area relative flex flex-col min-h-0 overflow-hidden", className)}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport
        data-slot="scroll-area-viewport"
        className="size-full flex-1 min-h-0 max-h-full rounded-[inherit] transition-[color,box-shadow] outline-none overscroll-contain focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1"
      >
        <ScrollAreaPrimitive.Content
          className={scrollsHorizontally ? "min-w-full" : "w-full"}
          style={scrollsHorizontally ? undefined : { minWidth: "100%" }}
        >
          {contentChildren}
        </ScrollAreaPrimitive.Content>
      </ScrollAreaPrimitive.Viewport>
      {hasExplicitScrollbars ? (
        scrollbarChildren
      ) : (
        <>
          {orientation === "vertical" || orientation === "both" ? (
            <ScrollBar orientation="vertical" />
          ) : null}
          {orientation === "horizontal" || orientation === "both" ? (
            <ScrollBar orientation="horizontal" />
          ) : null}
        </>
      )}
      {orientation === "both" ? <ScrollAreaPrimitive.Corner /> : null}
    </ScrollAreaPrimitive.Root>
  );
}

function ScrollBar({
  className,
  orientation = "vertical",
  ...props
}: ScrollAreaPrimitive.Scrollbar.Props) {
  return (
    <ScrollAreaPrimitive.Scrollbar
      data-slot="scroll-area-scrollbar"
      data-orientation={orientation}
      orientation={orientation}
      className={cn(
        "z-10 flex touch-none p-0.5 transition-opacity select-none opacity-0 data-hovering:opacity-100 data-scrolling:opacity-100 group-hover/scroll-area:opacity-100",
        "data-[orientation=horizontal]:h-2 data-[orientation=horizontal]:flex-col data-[orientation=horizontal]:border-t data-[orientation=horizontal]:border-t-transparent",
        "data-[orientation=vertical]:h-full data-[orientation=vertical]:w-2.5 data-[orientation=vertical]:border-l data-[orientation=vertical]:border-l-transparent",
        className,
      )}
      {...props}
    >
      <ScrollAreaPrimitive.Thumb
        data-slot="scroll-area-thumb"
        className="relative rounded-full bg-muted-foreground/30 hover:bg-muted-foreground/50 active:bg-muted-foreground/70 transition-colors data-[orientation=vertical]:w-full data-[orientation=horizontal]:h-full"
      />
    </ScrollAreaPrimitive.Scrollbar>
  );
}

const ScrollAreaContent = ScrollAreaPrimitive.Content;

export { ScrollArea, ScrollAreaContent, ScrollBar };
