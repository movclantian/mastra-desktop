import { motion } from "motion/react";
import type * as React from "react";
import { cn } from "@/shared/lib";

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
  /**
   * motion 共享布局的标识,同时用作 tab/panel 的 DOM id 前缀。
   * 必须每组 Tabs 唯一 —— 两组用同一个 layoutId 时,motion 会把它们
   * 当成同一个滑块,切换时滑块会跨组飞过去。
   */
  layoutId?: string;
  "aria-label"?: string;
}

export function animatedTabDomId(layoutId: string, tabId: string): string {
  return `${layoutId}-tab-${tabId}`;
}

export function animatedTabPanelDomId(layoutId: string, tabId: string): string {
  return `${layoutId}-panel-${tabId}`;
}

const SPRING = { type: "spring", stiffness: 380, damping: 30 } as const;

export function AnimatedTabs({
  tabs,
  activeTab,
  onChange,
  className,
  variant = "pill",
  layoutId = "animated-tab-indicator",
  "aria-label": ariaLabel,
}: AnimatedTabsProps) {
  /**
   * 方向键导航 + roving tabindex:替换 Radix Tabs 后这层必须自己补,
   * 否则键盘用户只能 Tab 进第一个触发器,无法在页签间移动。
   */
  const handleKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    const { key } = event;
    if (key !== "ArrowRight" && key !== "ArrowLeft" && key !== "Home" && key !== "End") return;
    const enabled = tabs.filter((tab) => !tab.disabled);
    if (enabled.length === 0) return;
    event.preventDefault();

    let next: AnimatedTabItem;
    if (key === "Home") {
      next = enabled[0];
    } else if (key === "End") {
      next = enabled[enabled.length - 1];
    } else {
      const delta = key === "ArrowRight" ? 1 : -1;
      const current = enabled.findIndex((tab) => tab.id === activeTab);
      next = enabled[(Math.max(0, current) + delta + enabled.length) % enabled.length];
    }

    onChange(next.id);
    // 焦点跟随激活项:元素已在 DOM 中,tabIndex 会在本次状态更新后刷新
    document.getElementById(animatedTabDomId(layoutId, next.id))?.focus();
  };

  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      aria-orientation="horizontal"
      className={cn(
        "relative flex min-w-0 items-center gap-1",
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
            id={animatedTabDomId(layoutId, tab.id)}
            role="tab"
            type="button"
            aria-selected={isActive}
            aria-controls={animatedTabPanelDomId(layoutId, tab.id)}
            tabIndex={isActive ? 0 : -1}
            disabled={tab.disabled}
            onClick={() => onChange(tab.id)}
            onKeyDown={handleKeyDown}
            className={cn(
              "relative z-10 flex shrink-0 cursor-pointer select-none items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-colors",
              "outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-1 focus-visible:ring-offset-background",
              variant === "line" ? "rounded-t-md" : "rounded-md",
              isActive
                ? "text-foreground font-semibold"
                : "text-muted-foreground hover:text-foreground",
              tab.disabled && "cursor-not-allowed opacity-50",
            )}
          >
            {isActive && variant !== "line" && (
              <motion.div
                layoutId={layoutId}
                transition={SPRING}
                className="absolute inset-0 -z-10 rounded-md bg-background shadow-xs"
              />
            )}
            {isActive && variant === "line" && (
              <motion.div
                layoutId={layoutId}
                transition={SPRING}
                className="absolute -bottom-1 inset-x-0 -z-10 h-0.5 bg-primary"
              />
            )}
            {tab.icon && <span className="shrink-0">{tab.icon}</span>}
            <span className="truncate">{tab.label}</span>
            {tab.badge && <span className="ml-1 shrink-0">{tab.badge}</span>}
          </button>
        );
      })}
    </div>
  );
}

export interface AnimatedTabsPanelProps {
  /** 当前激活的 tab id */
  activeTab: string;
  /** 本面板对应的 tab id;与 activeTab 相等时才渲染 */
  value: string;
  /** 必须与配套 AnimatedTabs 的 layoutId 一致,用于 ARIA 关联 */
  layoutId: string;
  className?: string;
  children: React.ReactNode;
}

/**
 * 配套面板。只在激活时挂载并淡入(不做退场动画 —— 退场需要旧面板与新面板
 * 同时在场,会带来一次高度跳动;Radix TabsContent 的默认行为同样是直接切换)。
 */
export function AnimatedTabsPanel({
  activeTab,
  value,
  layoutId,
  className,
  children,
}: AnimatedTabsPanelProps) {
  if (activeTab !== value) return null;
  return (
    <motion.div
      role="tabpanel"
      id={animatedTabPanelDomId(layoutId, value)}
      aria-labelledby={animatedTabDomId(layoutId, value)}
      tabIndex={0}
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, ease: "easeOut" }}
      className={cn("min-w-0 outline-none", className)}
    >
      {children}
    </motion.div>
  );
}
