import type * as React from "react";

import { cn } from "@/lib/utils";

/**
 * 面板级共享基元。
 * 分层策略:面板顶栏/底栏用底色(bg-muted)区分层级,不再依赖 border 分隔线;
 * 内容区内确需分隔时使用 ui/separator。所有面板头部/底部统一从这里取样式,
 * 避免各处自行拼 border-b / border-t 造成风格漂移。
 */

/** 面板顶栏:统一高度 h-12、px-3,底色分层与清晰描边 */
export function PanelHeader({ className, ...props }: React.ComponentProps<"header">) {
  return (
    <header
      data-slot="panel-header"
      className={cn("bg-muted/40 border-b border-border flex h-12 shrink-0 items-center gap-2 px-3", className)}
      {...props}
    />
  );
}

/**
 * 面板外壳:给聊天、工作台、终端和资料库统一最小尺寸约束。
 * 横向面板的分隔交给 ResizableHandle 与背景层,内容本身不再堆叠 border。
 */
export function PanelSurface({ className, ...props }: React.ComponentProps<"section">) {
  return (
    <section
      data-slot="panel-surface"
      className={cn("flex size-full min-h-0 min-w-0 flex-col bg-background", className)}
      {...props}
    />
  );
}

/** 面板底栏:状态条/快捷操作,统一 h-7、小号文本与顶边描边 */
export function PanelFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="panel-footer"
      className={cn(
        "bg-muted/40 border-t border-border text-muted-foreground mt-auto flex h-7 shrink-0 items-center gap-2 px-3 text-[11px]",
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
