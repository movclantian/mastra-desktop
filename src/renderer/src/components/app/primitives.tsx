import type * as React from "react";

import { cn } from "@/lib/utils";

/**
 * 面板级共享基元。
 * 分层策略:面板顶栏/底栏用底色(bg-muted)区分层级,不再依赖 border 分隔线;
 * 内容区内确需分隔时使用 ui/separator。所有面板头部/底部统一从这里取样式,
 * 避免各处自行拼 border-b / border-t 造成风格漂移。
 */

/** 面板顶栏:统一高度 h-10、px-3,底色分层 */
export function PanelHeader({ className, ...props }: React.ComponentProps<"header">) {
  return (
    <header
      data-slot="panel-header"
      className={cn("bg-muted/50 flex h-10 shrink-0 items-center gap-2 px-3", className)}
      {...props}
    />
  );
}

/** 面板底栏:状态条/快捷操作,统一 h-7、小号文本 */
export function PanelFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="panel-footer"
      className={cn(
        "bg-muted/40 text-muted-foreground mt-auto flex h-7 shrink-0 items-center gap-2 px-3 text-[11px]",
        className,
      )}
      {...props}
    />
  );
}

/** 面板区块标题:内容区内的小节标题,统一字阶与留白 */
export function PanelSectionLabel({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="panel-section-label"
      className={cn(
        "text-muted-foreground px-3 pt-3 pb-1 text-[11px] font-medium tracking-wide",
        className,
      )}
      {...props}
    />
  );
}
