import { motion } from "motion/react";
import type * as React from "react";
import { cn } from "@/lib/utils";

export interface AnimatedTabItem {
  id: string;
  label: React.ReactNode;
  icon?: React.ReactNode;
  badge?: React.ReactNode;
  disabled?: boolean;
}

export interface AnimatedTabsProps {
  tabs: AnimatedTabItem[];
  activeTab: string;
  onChange: (tabId: string) => void;
  className?: string;
  variant?: "pill" | "line" | "segmented";
  layoutId?: string;
}

export function AnimatedTabs({
  tabs,
  activeTab,
  onChange,
  className,
  variant = "pill",
  layoutId = "animated-tab-indicator",
}: AnimatedTabsProps) {
  return (
    <div
      className={cn(
        "relative flex items-center gap-1",
        variant === "pill" && "rounded-lg border bg-muted/40 p-1",
        variant === "segmented" && "rounded-xl border bg-muted/60 p-1 shadow-inner",
        variant === "line" && "border-b border-border bg-transparent gap-2 pb-0.5",
        className,
      )}
    >
      {tabs.map((tab) => {
        const isActive = activeTab === tab.id;
        return (
          <button
            key={tab.id}
            type="button"
            disabled={tab.disabled}
            onClick={() => onChange(tab.id)}
            className={cn(
              "relative flex cursor-pointer items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-colors z-10 select-none",
              isActive
                ? "text-foreground font-semibold"
                : "text-muted-foreground hover:text-foreground",
              tab.disabled && "cursor-not-allowed opacity-50",
            )}
          >
            {isActive && variant !== "line" && (
              <motion.div
                layoutId={layoutId}
                transition={{ type: "spring", stiffness: 380, damping: 30 }}
                className="absolute inset-0 rounded-md bg-background shadow-xs -z-10"
              />
            )}
            {isActive && variant === "line" && (
              <motion.div
                layoutId={layoutId}
                transition={{ type: "spring", stiffness: 380, damping: 30 }}
                className="absolute -bottom-1 inset-x-0 h-0.5 bg-primary -z-10"
              />
            )}
            {tab.icon && <span className="shrink-0">{tab.icon}</span>}
            <span>{tab.label}</span>
            {tab.badge && <span className="ml-1 shrink-0">{tab.badge}</span>}
          </button>
        );
      })}
    </div>
  );
}
