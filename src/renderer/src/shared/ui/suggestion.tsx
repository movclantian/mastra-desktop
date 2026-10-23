import type * as React from "react";
import { cn } from "@/shared/lib";
import { Button } from "@/shared/ui/button";

export type SuggestionsProps = React.ComponentProps<"div">;

/**
 * A horizontally scrolling row of prompt suggestions.
 * `scroll-fade-x` fades the edge that has more to show; `shrink-0` keeps each label on one line.
 */
function Suggestions({ className, ...props }: SuggestionsProps) {
  return (
    <div
      data-slot="suggestions"
      className={cn(
        "scrollbar-none flex scroll-fade-x gap-2 overflow-x-auto overscroll-x-contain",
        className,
      )}
      {...props}
    />
  );
}

export type SuggestionProps = Omit<React.ComponentProps<typeof Button>, "onClick"> & {
  suggestion: string;
  onClick?: (suggestion: string) => void;
};

/** A prompt you send without typing: the label is the message, sent as is. */
function Suggestion({ className, suggestion, onClick, ...props }: SuggestionProps) {
  return (
    <Button
      data-slot="suggestion"
      variant="outline"
      size="sm"
      className={cn("shrink-0", className)}
      onClick={() => onClick?.(suggestion)}
      {...props}
    >
      {suggestion}
    </Button>
  );
}

export { Suggestion, Suggestions };
