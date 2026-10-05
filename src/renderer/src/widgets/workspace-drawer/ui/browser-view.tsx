import {
  ArrowLeftIcon,
  ArrowRightIcon,
  BotIcon,
  ExternalLinkIcon,
  Globe2Icon,
  RefreshCwIcon,
  SquareIcon,
} from "lucide-react";
import * as React from "react";
import { useTranslation } from "@/shared/i18n";
import { cn } from "@/shared/lib";
import {
  shouldSubmitWebPreviewDraft,
  useWebPreview,
  WebPreview,
  WebPreviewNavigation,
  WebPreviewNavigationButton,
  WebPreviewUrl,
} from "@/shared/ui/ai-elements/web-preview";
import { Button } from "@/shared/ui/button";
import { DotmCircular4 } from "@/shared/ui/dotm-circular-4";
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from "@/shared/ui/empty";
import type { BrowserSearchEngine } from "../../../../../shared/browser-contract";
import type { BrowserAction, BrowserState } from "../api/browser-api";
import { resolveBrowserOmniboxInput } from "../model/browser-omnibox";

export interface BrowserSessionViewState {
  action: (name: BrowserAction, index?: number, url?: string) => Promise<void>;
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
  navigate: (url: string) => Promise<string | false>;
  native: boolean;
  retryFrame: () => void;
  searchEngine: BrowserSearchEngine;
  setBounds: (bounds: { x: number; y: number; width: number; height: number }) => void;
  state: BrowserState;
  threadKey: string | null;
}

function BrowserRefreshButton({
  action,
  busy,
  active,
  label,
}: {
  action: BrowserSessionViewState["action"];
  busy: boolean;
  active: boolean;
  label: string;
}) {
  const { draftUrl, submitDraft, url } = useWebPreview();

  return (
    <WebPreviewNavigationButton
      disabled={!active || busy}
      onClick={async () => {
        if (shouldSubmitWebPreviewDraft(draftUrl, url)) {
          await submitDraft();
          return;
        }
        await action("reload");
      }}
      tooltip={label}
    >
      <RefreshCwIcon className={cn(busy && "animate-spin")} />
    </WebPreviewNavigationButton>
  );
}

const BrowserLiveFrame = React.memo(function BrowserLiveFrame({
  frame,
  injectMouse,
  injectMouseMove,
  injectWheel,
  label,
}: {
  frame: NonNullable<BrowserSessionViewState["frame"]>;
  injectMouse: BrowserSessionViewState["injectMouse"];
  injectMouseMove: BrowserSessionViewState["injectMouseMove"];
  injectWheel: BrowserSessionViewState["injectWheel"];
  label: string;
}) {
  const [visibleFrame, setVisibleFrame] = React.useState(frame);
  const visibleFrameRef = React.useRef(visibleFrame);
  const loadIdRef = React.useRef(0);
  visibleFrameRef.current = visibleFrame;

  React.useEffect(() => {
    if (visibleFrameRef.current.data === frame.data) return;
    const loadId = ++loadIdRef.current;
    const image = new Image();
    image.decoding = "async";
    image.onload = () => {
      if (loadId === loadIdRef.current) setVisibleFrame(frame);
    };
    image.src = `data:image/jpeg;base64,${frame.data}`;
    return () => {
      image.onload = null;
    };
  }, [frame]);

  return (
    <img
      alt={label}
      className="max-h-full max-w-full cursor-default object-contain select-none"
      decoding="async"
      draggable={false}
      onPointerDown={(event) => {
        injectMouse(event, "mousePressed");
        event.currentTarget.parentElement?.focus();
      }}
      onPointerMove={injectMouseMove}
      onPointerUp={(event) => injectMouse(event, "mouseReleased")}
      onWheel={injectWheel}
      src={`data:image/jpeg;base64,${visibleFrame.data}`}
    />
  );
});

export function BrowserView({
  onCloseBrowser,
  nativeOverlayInsetTop = 0,
  session,
}: {
  onCloseBrowser: () => void;
  nativeOverlayInsetTop?: number;
  session: BrowserSessionViewState;
}) {
  const { t } = useTranslation();
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
    native,
    retryFrame,
    searchEngine,
    state,
    setBounds,
    threadKey,
  } = session;
  const nativeSurfaceRef = React.useRef<HTMLDivElement>(null);

  React.useLayoutEffect(() => {
    if (!native) return;
    const surface = nativeSurfaceRef.current;
    if (!surface) return;

    let lastBounds = "";
    const syncBounds = () => {
      const rect = surface.getBoundingClientRect();
      const next = {
        x: Math.max(0, Math.round(rect.left)),
        y: Math.max(0, Math.round(rect.top)),
        width: Math.max(0, Math.round(rect.width)),
        height: Math.max(0, Math.round(rect.height)),
      };
      const signature = `${next.x}:${next.y}:${next.width}:${next.height}`;
      if (signature === lastBounds) return;
      lastBounds = signature;
      setBounds(next);
    };

    syncBounds();
    const resizeObserver =
      typeof ResizeObserver !== "undefined" ? new ResizeObserver(syncBounds) : undefined;
    resizeObserver?.observe(surface);
    window.addEventListener("resize", syncBounds);
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", syncBounds);
      setBounds({ x: 0, y: 0, width: 0, height: 0 });
    };
  }, [native, setBounds, threadKey]);

  if (!hasThread) {
    return (
      <Empty className="h-full">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Globe2Icon />
          </EmptyMedia>
          <EmptyTitle>{t("workspace:noSessionSelected")}</EmptyTitle>
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
      resolveUrl={(input) => resolveBrowserOmniboxInput(input, searchEngine)?.url ?? null}
    >
      <WebPreviewNavigation className="h-10 shrink-0 gap-0.5 p-1">
        <WebPreviewNavigationButton
          disabled={!state.active || busy}
          onClick={() => void action("back")}
          tooltip={t("workspace:back")}
        >
          <ArrowLeftIcon />
        </WebPreviewNavigationButton>
        <WebPreviewNavigationButton
          disabled={!state.active || busy}
          onClick={() => void action("forward")}
          tooltip={t("workspace:forward")}
        >
          <ArrowRightIcon />
        </WebPreviewNavigationButton>
        <BrowserRefreshButton
          action={action}
          active={state.active || state.tabs.length > 0}
          busy={busy}
          label={t("workspace:refresh")}
        />
        <WebPreviewUrl disabled={busy} />
        <WebPreviewNavigationButton
          disabled={!state.currentUrl}
          onClick={() => {
            if (state.currentUrl) void window.api.workspace.openExternal(state.currentUrl);
          }}
          tooltip={t("workspace:openInSystemBrowser")}
        >
          <ExternalLinkIcon />
        </WebPreviewNavigationButton>
        <WebPreviewNavigationButton
          disabled={!state.active && state.tabs.length === 0}
          onClick={onCloseBrowser}
          tooltip={t("workspace:closeBrowser")}
        >
          <SquareIcon />
        </WebPreviewNavigationButton>
      </WebPreviewNavigation>
      <div
        className={cn(
          "relative flex min-h-0 flex-1 items-start justify-center overflow-hidden bg-muted/30 pt-2",
          native && "bg-background p-0",
        )}
        style={
          native && nativeOverlayInsetTop > 0 ? { marginTop: nativeOverlayInsetTop } : undefined
        }
        onKeyDown={native ? undefined : injectKey}
        ref={nativeSurfaceRef}
        role="application"
        tabIndex={native ? -1 : 0}
      >
        {native ? null : frame ? (
          <BrowserLiveFrame
            frame={frame}
            injectMouse={injectMouse}
            injectMouseMove={injectMouseMove}
            injectWheel={injectWheel}
            label={t("workspace:browserLiveView")}
          />
        ) : (state.active || state.tabs.length > 0) && frameState === "error" ? (
          <div className="flex flex-col items-center gap-3 text-sm text-muted-foreground">
            <span>{t("workspace:liveViewFailed")}</span>
            <Button onClick={retryFrame} size="sm" variant="outline">
              {t("workspace:retryConnection")}
            </Button>
          </div>
        ) : state.active || state.tabs.length > 0 || busy ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <DotmCircular4 size={16} dotSize={1.8} colorPreset="solid-theme" />
            {frameState === "connecting"
              ? t("workspace:connectingLiveView")
              : busy
                ? t("workspace:loadingBrowserPage")
                : t("workspace:waitingBrowserView")}
          </div>
        ) : (
          <Empty className="text-muted-foreground">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <BotIcon />
              </EmptyMedia>
              <EmptyTitle className="text-zinc-200">{t("workspace:browserNotStarted")}</EmptyTitle>
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
