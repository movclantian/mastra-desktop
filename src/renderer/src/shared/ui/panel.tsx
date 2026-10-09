import { CopyIcon, MinusIcon, SquareIcon, XIcon } from "lucide-react";
import * as React from "react";
import { useTranslation } from "@/shared/i18n";
import { cn } from "@/shared/lib";
import { toastError } from "@/shared/lib/errors";
import type { WindowState } from "../../../../shared/window-contract";
import { Button } from "./button";

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

/** The navigation row also owns the native window controls on every screen. */
export function WindowTitleBar({ children, className, ...props }: React.ComponentProps<"header">) {
  const { t } = useTranslation();
  const [state, setState] = React.useState<WindowState>({ maximized: false, fullscreen: false });
  React.useEffect(() => {
    let active = true;
    let receivedUpdate = false;
    const unsubscribe = window.api.window.onStateChange((next) => {
      receivedUpdate = true;
      setState(next);
    });
    void window.api.window
      .getState()
      .then((next) => {
        if (active && !receivedUpdate) setState(next);
      })
      .catch((error) => {
        if (active) toastError(error, t("topbar:windowControlError"));
      });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [t]);

  const controls = [
    { action: "minimize", Icon: MinusIcon, label: t("topbar:minimizeWindow") },
    {
      action: "toggleMaximize",
      Icon: state.maximized || state.fullscreen ? CopyIcon : SquareIcon,
      label: state.fullscreen
        ? t("topbar:exitFullscreen")
        : state.maximized
          ? t("topbar:restoreWindow")
          : t("topbar:maximizeWindow"),
    },
    { action: "close", Icon: XIcon, label: t("topbar:closeWindow") },
  ] as const;

  return (
    <PanelHeader
      {...props}
      className={cn("app-drag relative z-50 h-(--app-titlebar-height) pr-0", className)}
    >
      {children ?? <span className="min-w-0 flex-1 truncate text-sm font-medium">MastraWork</span>}
      <div
        role="group"
        aria-label={t("topbar:windowControls")}
        className="app-no-drag ml-2 flex h-full shrink-0 items-stretch border-l border-border"
      >
        {controls.map(({ action, Icon, label }) => (
          <Button
            key={action}
            data-slot="window-control"
            type="button"
            variant="ghost"
            size="icon"
            className={cn(
              "h-full w-11 rounded-none border-0 px-0 active:translate-y-0 active:scale-100 focus-visible:ring-inset",
              action === "close" &&
                "hover:bg-destructive hover:text-white dark:hover:bg-destructive",
            )}
            aria-label={label}
            title={label}
            onClick={() => {
              void window.api.window
                .control(action)
                .catch((error) => toastError(error, t("topbar:windowControlError")));
            }}
          >
            <Icon className="size-4" />
          </Button>
        ))}
      </div>
    </PanelHeader>
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
