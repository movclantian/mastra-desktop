"use client";

import type { DynamicToolUIPart, ToolUIPart } from "ai";
import { CheckCircleIcon, CircleIcon, ClockIcon, XCircleIcon } from "lucide-react";

import type { ComponentProps, ReactNode } from "react";
import { isValidElement } from "react";
import { i18n } from "@/shared/i18n";
import { cn } from "@/shared/lib";
import { Badge } from "@/shared/ui/badge";

import { CodeBlock, CodeBlockContent } from "@/shared/ui/code-block";

export type ToolPart = (ToolUIPart | DynamicToolUIPart) & {
  createdAt?: number;
  updatedAt?: number;
  terminal?: { output: string; exitCode?: number };
};

const statusIcons: Record<ToolPart["state"], ReactNode> = {
  "approval-requested": <ClockIcon className="size-4 text-yellow-600" />,
  "approval-responded": <CheckCircleIcon className="size-4 text-blue-600" />,
  "input-available": <ClockIcon className="size-4 animate-pulse" />,
  "input-streaming": <CircleIcon className="size-4" />,
  "output-available": <CheckCircleIcon className="size-4 text-green-600" />,
  "output-denied": <XCircleIcon className="size-4 text-orange-600" />,
  "output-error": <XCircleIcon className="size-4 text-red-600" />,
};

export const getStatusBadge = (status: ToolPart["state"]) => (
  <Badge className="gap-1.5 rounded-full text-xs" variant="secondary">
    {statusIcons[status]}
    {i18n.t(`common:toolStates.${status}`)}
  </Badge>
);

export type ToolInputProps = ComponentProps<"div"> & {
  input: ToolPart["input"];
};

export const ToolInput = ({ className, input, ...props }: ToolInputProps) => (
  <div className={cn("space-y-2 overflow-hidden", className)} {...props}>
    <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
      {i18n.t("common:parameters")}
    </h4>
    <div className="rounded-md bg-muted/50">
      <CodeBlock size="sm">
        <CodeBlockContent wrap className="max-h-64">
          {JSON.stringify(input, null, 2)}
        </CodeBlockContent>
      </CodeBlock>
    </div>
  </div>
);

export type ToolOutputProps = ComponentProps<"div"> & {
  output: ToolPart["output"];
  errorText: ToolPart["errorText"];
};

export const ToolOutput = ({ className, output, errorText, ...props }: ToolOutputProps) => {
  if (output === undefined && !errorText) {
    return null;
  }

  return (
    <div className={cn("space-y-2", className)} {...props}>
      <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
        {errorText ? i18n.t("common:error") : i18n.t("common:result")}
      </h4>
      {errorText ? (
        <CodeBlock size="sm" variant="destructive">
          <CodeBlockContent wrap className="max-h-64">
            {errorText}
          </CodeBlockContent>
        </CodeBlock>
      ) : null}
      {output !== undefined ? (
        isValidElement(output) ? (
          output
        ) : (
          <CodeBlock size="sm">
            <CodeBlockContent wrap className="max-h-64">
              {typeof output === "string" ? output : JSON.stringify(output, null, 2)}
            </CodeBlockContent>
          </CodeBlock>
        )
      ) : null}
    </div>
  );
};
