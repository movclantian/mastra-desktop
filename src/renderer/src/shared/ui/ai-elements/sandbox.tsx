"use client";

import type { ToolUIPart } from "ai";
import { ChevronDownIcon, Code } from "lucide-react";
import type { ComponentProps } from "react";
import { cn } from "@/shared/lib";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/shared/ui/collapsible";
import { Tabs, TabsContent, TabsIndicator, TabsList, TabsTrigger } from "@/shared/ui/tabs";

import { getStatusBadge } from "./tool";

export type SandboxRootProps = ComponentProps<typeof Collapsible>;

export const Sandbox = ({ className, ...props }: SandboxRootProps) => (
  <Collapsible
    className={cn(
      "not-prose group mb-4 min-w-0 w-full max-w-full overflow-hidden rounded-md border",
      className,
    )}
    defaultOpen
    {...props}
  />
);

export interface SandboxHeaderProps {
  title?: string;
  state: ToolUIPart["state"];
  className?: string;
}

export const SandboxHeader = ({ className, title, state, ...props }: SandboxHeaderProps) => (
  <CollapsibleTrigger
    className={cn("flex min-w-0 w-full items-center justify-between gap-4 p-3", className)}
    {...props}
  >
    <div className="flex min-w-0 items-center gap-2">
      <Code className="size-4 text-muted-foreground" />
      <span className="min-w-0 truncate font-medium text-sm">{title}</span>
      <span className="shrink-0">{getStatusBadge(state)}</span>
    </div>
    <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
  </CollapsibleTrigger>
);

export type SandboxContentProps = ComponentProps<typeof CollapsibleContent>;

export const SandboxContent = ({ className, ...props }: SandboxContentProps) => (
  <CollapsibleContent
    className={cn(
      "min-w-0 w-full data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 outline-none data-[state=closed]:animate-out data-[state=open]:animate-in",
      className,
    )}
    {...props}
  />
);

export type SandboxTabsProps = ComponentProps<typeof Tabs>;

export const SandboxTabs = ({ className, ...props }: SandboxTabsProps) => (
  <Tabs className={cn("min-w-0 w-full flex-col gap-0", className)} {...props} />
);

export type SandboxTabsBarProps = ComponentProps<"div">;

export const SandboxTabsBar = ({ className, ...props }: SandboxTabsBarProps) => (
  <div
    className={cn("flex min-w-0 w-full items-center border-border border-t border-b", className)}
    {...props}
  />
);

export type SandboxTabsListProps = ComponentProps<typeof TabsList>;

export const SandboxTabsList = ({ className, children, ...props }: SandboxTabsListProps) => (
  <TabsList
    className={cn("h-auto shrink-0 rounded-none border-0 bg-transparent p-0", className)}
    {...props}
  >
    {children}
    {/* 官方 Tabs.Indicator:激活下划线随页签滑动。此前这里靠每个 trigger 各自的
        静态 border-b 着色,且选择器写的是 Radix 的 data-[state=active] ——
        本项目 Tabs 底层是 Base UI(发 data-active),那些类从未命中,
        沙箱页签实际没有激活态。 */}
    <TabsIndicator className="top-auto bottom-0 h-0.5 rounded-full bg-primary" />
  </TabsList>
);

export type SandboxTabsTriggerProps = ComponentProps<typeof TabsTrigger>;

export const SandboxTabsTrigger = ({ className, ...props }: SandboxTabsTriggerProps) => (
  <TabsTrigger
    className={cn(
      "rounded-none border-0 bg-transparent px-4 py-2 font-medium text-muted-foreground text-sm transition-colors data-active:bg-transparent data-active:text-foreground data-active:shadow-none",
      className,
    )}
    {...props}
  />
);

export type SandboxTabContentProps = ComponentProps<typeof TabsContent>;

export const SandboxTabContent = ({ className, ...props }: SandboxTabContentProps) => (
  <TabsContent
    className={cn("mt-0 min-w-0 w-full overflow-hidden text-sm", className)}
    {...props}
  />
);
