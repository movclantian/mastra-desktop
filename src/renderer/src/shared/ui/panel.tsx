import type * as React from "react";
import { cn } from "@/shared/lib";

/** 面板顶栏:统一高度 h-12、px-3,底色分层与清晰描边 */
export function PanelHeader({ className, ...props }: React.ComponentProps<"header">) {
  return (
    <header
      data-slot="panel-header"
      className={cn(
        "bg-muted/40 border-b border-border flex h-12 w-full shrink-0 items-center gap-2 px-3",
        className,
      )}
      {...props}
    />
  );
}

/** 面板外壳:给聊天、工作台、终端和资料库统一最小尺寸约束 */
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

/** 面板区块标题:内容区内的小节标题,统一字阶与留白 */
