import {
  ArrowLeftIcon,
  ArrowRightIcon,
  BotIcon,
  ExternalLinkIcon,
  Globe2Icon,
  RefreshCwIcon,
  SquareIcon,
} from "lucide-react";
import type * as React from "react";
import { cn } from "@/shared/lib";
import {
  WebPreview,
  WebPreviewNavigation,
  WebPreviewNavigationButton,
  WebPreviewUrl,
} from "@/shared/ui/ai-elements/web-preview";
import { Button } from "@/shared/ui/button";
import { DotmCircular4 } from "@/shared/ui/dotm-circular-4";
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from "@/shared/ui/empty";
import type { BrowserState } from "../api/browser-api";

export interface BrowserSessionViewState {
  action: (name: string, index?: number, url?: string) => Promise<void>;
  busy: boolean;
  frame?: { data: string; viewport: { width: number; height: number } };
  frameState: "idle" | "connecting" | "connected" | "error";
  hasThread: boolean;
  injectKey: (event: React.KeyboardEvent<HTMLDivElement>) => void;
  injectMouse: (
    event: React.PointerEvent<HTMLImageElement>,
    type: "mousePressed" | "mouseReleased",
  ) => void;
  injectMouseMove: (event: React.PointerEvent<HTMLImageElement>) => void;
  injectWheel: (event: React.WheelEvent<HTMLImageElement>) => void;
  navigate: (url: string) => Promise<void>;
  retryFrame: () => void;
  state: BrowserState;
  threadKey: string | null;
}

export function BrowserView({
  onCloseBrowser,
  session,
}: {
  onCloseBrowser: () => void;
  session: BrowserSessionViewState;
}) {
  const {
    action,
    busy,
    frame,
    frameState,
    hasThread,
    injectKey,
    injectMouse,
    injectMouseMove,
    injectWheel,
    navigate,
    retryFrame,
    state,
    threadKey,
  } = session;

  if (!hasThread) {
    return (
      <Empty className="h-full">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Globe2Icon />
          </EmptyMedia>
          <EmptyTitle>未选择会话</EmptyTitle>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <WebPreview
      className="rounded-none border-0"
      defaultUrl={state.currentUrl ?? ""}
      key={threadKey ?? ""}
      onUrlChange={navigate}
    >
      <WebPreviewNavigation className="h-10 shrink-0 gap-0.5 p-1">
        <WebPreviewNavigationButton
          disabled={!state.active || busy}
          onClick={() => void action("back")}
          tooltip="后退"
        >
          <ArrowLeftIcon />
        </WebPreviewNavigationButton>
        <WebPreviewNavigationButton
          disabled={!state.active || busy}
          onClick={() => void action("forward")}
          tooltip="前进"
        >
          <ArrowRightIcon />
        </WebPreviewNavigationButton>
        <WebPreviewNavigationButton
          disabled={!state.active || busy}
          onClick={() => void action("reload")}
          tooltip="刷新"
        >
          <RefreshCwIcon className={cn(busy && "animate-spin")} />
        </WebPreviewNavigationButton>
        <WebPreviewUrl />
        <WebPreviewNavigationButton
          disabled={!state.currentUrl}
          onClick={() => {
            if (state.currentUrl) void window.api.workspace.openExternal(state.currentUrl);
          }}
          tooltip="在系统浏览器中打开"
        >
          <ExternalLinkIcon />
        </WebPreviewNavigationButton>
        <WebPreviewNavigationButton
          disabled={!state.active}
          onClick={onCloseBrowser}
          tooltip="关闭浏览器"
        >
          <SquareIcon />
        </WebPreviewNavigationButton>
      </WebPreviewNavigation>
      <div
        className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-muted/30"
        onKeyDown={injectKey}
        role="application"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: The preview is the keyboard target for browser input injection.
        tabIndex={0}
      >
        {frame ? (
          <img
            alt="Agent 浏览器实时画面"
            className="max-h-full max-w-full cursor-default object-contain select-none"
            draggable={false}
            onPointerDown={(event) => {
              injectMouse(event, "mousePressed");
              event.currentTarget.parentElement?.focus();
            }}
            onPointerMove={injectMouseMove}
            onPointerUp={(event) => injectMouse(event, "mouseReleased")}
            onWheel={injectWheel}
            src={`data:image/jpeg;base64,${frame.data}`}
          />
        ) : state.active && frameState === "error" ? (
          <div className="flex flex-col items-center gap-3 text-sm text-muted-foreground">
            <span>实时画面连接失败</span>
            <Button onClick={retryFrame} size="sm" variant="outline">
              重试连接
            </Button>
          </div>
        ) : state.active ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <DotmCircular4 size={16} dotSize={1.8} colorPreset="solid-theme" />
            {frameState === "connecting" ? "正在连接实时画面" : "等待浏览器画面"}
          </div>
        ) : (
          <Empty className="text-muted-foreground">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <BotIcon />
              </EmptyMedia>
              <EmptyTitle className="text-zinc-200">浏览器未启动</EmptyTitle>
            </EmptyHeader>
          </Empty>
        )}
        {busy ? (
          <div className="absolute inset-x-0 top-0 h-0.5 overflow-hidden bg-zinc-800">
            <span className="block h-full w-1/3 animate-pulse bg-sky-500" />
          </div>
        ) : null}
      </div>
    </WebPreview>
  );
}
