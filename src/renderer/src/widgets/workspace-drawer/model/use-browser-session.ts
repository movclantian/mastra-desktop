import { useRouterState } from "@tanstack/react-router";
import * as React from "react";
import { useWorkbenchStore } from "@/entities/workbench/model/workbench-store";
import { useAuth } from "@/features/auth";
import { i18n } from "@/shared/i18n";
import { toastError } from "@/shared/lib";
import {
  type BrowserAction,
  type BrowserState,
  browserAction,
  browserResourceUrl,
  closeBrowser as closeBrowserRequest,
  connectBrowserScreencast,
  fetchBrowserState,
  navigateBrowser,
  sendBrowserKeyboard,
  sendBrowserMouse,
} from "../api/browser-api";

const NEW_BROWSER_TAB_URL = "https://www.bing.com";

const EMPTY_BROWSER_STATE: BrowserState = {
  active: false,
  status: "closed",
  currentUrl: null,
  tabs: [],
  activeTabIndex: 0,
};

export function useBrowserSession() {
  const { user } = useAuth();
  const userId = user?.id ?? "anonymous";
  const activeThreadId = useRouterState({
    select: (state) => (state.location.search as { thread?: string }).thread ?? null,
  });
  const activePanelTab = useWorkbenchStore((state) => state.activePanelTab);
  const browserRequest = useWorkbenchStore((state) => state.browserRequest);
  const viewActive = activePanelTab.kind === "browser";
  const [state, setState] = React.useState<BrowserState>(EMPTY_BROWSER_STATE);
  const [frame, setFrame] = React.useState<{
    data: string;
    viewport: { width: number; height: number };
  }>();
  const pendingFrameRef = React.useRef<typeof frame>(undefined);
  const frameAnimationRef = React.useRef<number | undefined>(undefined);
  const [busy, setBusy] = React.useState(false);
  const busyRef = React.useRef(false);
  const sessionEpochRef = React.useRef(0);
  const [frameState, setFrameState] = React.useState<"idle" | "connecting" | "connected" | "error">(
    "idle",
  );
  const [screencastAttempt, setScreencastAttempt] = React.useState(0);
  const pointerMoveAtRef = React.useRef(0);
  const stateUrl = activeThreadId ? browserResourceUrl(activeThreadId, userId) : "";

  const refreshState = React.useCallback(async () => {
    if (!activeThreadId) return setState(EMPTY_BROWSER_STATE);
    if (busyRef.current) return;
    const epoch = sessionEpochRef.current;
    try {
      const nextState = await fetchBrowserState(activeThreadId, userId);
      if (sessionEpochRef.current === epoch && !busyRef.current) {
        setState(nextState ?? EMPTY_BROWSER_STATE);
      }
    } catch {
      if (sessionEpochRef.current === epoch && !busyRef.current) {
        setState(EMPTY_BROWSER_STATE);
      }
    }
  }, [activeThreadId, userId]);

  React.useEffect(() => {
    setFrame(undefined);
    setFrameState("idle");
    void refreshState();
    if (!stateUrl) return;
    const timer = window.setInterval(() => void refreshState(), 1_500);
    return () => window.clearInterval(timer);
  }, [refreshState, stateUrl]);

  React.useEffect(() => {
    void screencastAttempt;
    if (!viewActive || !stateUrl || !state.active || !activeThreadId) return;
    const threadId = activeThreadId;
    setFrameState("connecting");
    const controller = new AbortController();
    let disposed = false;
    void (async () => {
      const response = await connectBrowserScreencast(threadId, userId, controller.signal);
      if (!response.ok || !response.body) throw new Error(i18n.t("workspace:liveViewFailed"));
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        while (!disposed) {
          const { value, done } = await reader.read();
          buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
          let boundary = buffer.indexOf("\n\n");
          while (boundary >= 0) {
            const block = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const eventName = block.match(/^event:\s*(.+)$/m)?.[1]?.trim() ?? "message";
            const data = block
              .split(/\r?\n/)
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trimStart())
              .join("\n");
            if (eventName === "frame") {
              pendingFrameRef.current = JSON.parse(data) as NonNullable<typeof frame>;
              if (frameAnimationRef.current === undefined) {
                frameAnimationRef.current = window.requestAnimationFrame(() => {
                  frameAnimationRef.current = undefined;
                  const nextFrame = pendingFrameRef.current;
                  pendingFrameRef.current = undefined;
                  if (nextFrame) setFrame(nextFrame);
                });
              }
              setFrameState("connected");
            } else if (eventName === "url") {
              const payload = JSON.parse(data) as { url?: string };
              if (typeof payload.url === "string") {
                setState((current) => ({ ...current, currentUrl: payload.url ?? null }));
              }
            } else if (eventName === "stop") {
              return;
            } else if (eventName === "error") {
              throw new Error(i18n.t("workspace:streamError"));
            }
            boundary = buffer.indexOf("\n\n");
          }
          if (done) return;
        }
      } finally {
        reader.releaseLock();
      }
    })().catch(() => {
      if (!disposed) setFrameState("error");
    });
    return () => {
      disposed = true;
      controller.abort();
      if (frameAnimationRef.current !== undefined) {
        window.cancelAnimationFrame(frameAnimationRef.current);
        frameAnimationRef.current = undefined;
      }
      pendingFrameRef.current = undefined;
    };
  }, [activeThreadId, screencastAttempt, state.active, stateUrl, userId, viewActive]);

  const retryFrame = React.useCallback(() => {
    setFrame(undefined);
    setFrameState("connecting");
    setScreencastAttempt((attempt) => attempt + 1);
    void refreshState();
  }, [refreshState]);

  const navigate = React.useCallback(
    async (url: string) => {
      if (!stateUrl || !url.trim() || !activeThreadId) return;
      const threadId = activeThreadId;
      busyRef.current = true;
      setBusy(true);
      try {
        const payload = await navigateBrowser(threadId, userId, url);
        if (payload.state) setState(payload.state);
        await refreshState();
      } catch (error) {
        toastError(error, i18n.t("workspace:navigateFailed"));
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [activeThreadId, refreshState, stateUrl, userId],
  );

  const action = React.useCallback(
    async (name: BrowserAction, index?: number, url?: string) => {
      if (!stateUrl || !activeThreadId) return;
      const threadId = activeThreadId;
      busyRef.current = true;
      setBusy(true);
      if (name === "new-tab") {
        const newUrl = url || NEW_BROWSER_TAB_URL;
        setState((current) => {
          const nextTabs = [...current.tabs, { url: newUrl, title: i18n.t("workspace:newTab") }];
          return {
            ...current,
            active: true,
            currentUrl: newUrl,
            tabs: nextTabs,
            activeTabIndex: nextTabs.length - 1,
          };
        });
      } else if (name === "switch-tab" && typeof index === "number") {
        setState((current) => ({
          ...current,
          activeTabIndex: index,
          currentUrl: current.tabs[index]?.url ?? current.currentUrl,
        }));
      } else if (name === "close-tab" && typeof index === "number") {
        setState((current) => {
          const nextTabs = current.tabs.filter((_, i) => i !== index);
          const nextIndex = Math.max(0, Math.min(nextTabs.length - 1, index - 1));
          return {
            ...current,
            active: nextTabs.length > 0,
            currentUrl: nextTabs[nextIndex]?.url ?? "",
            tabs: nextTabs,
            activeTabIndex: nextIndex,
          };
        });
      }
      try {
        const payload = await browserAction(threadId, userId, name, index, url);
        if (payload.state) setState(payload.state);
      } catch (error) {
        toastError(error, i18n.t("workspace:browserOpFailed"));
        void refreshState();
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [activeThreadId, refreshState, stateUrl, userId],
  );

  // 当处于浏览器面板且无标签时，自动拉起首个标签页（0ms 乐观上屏）
  React.useEffect(() => {
    if (!viewActive || !activeThreadId || busyRef.current) return;
    if (state.tabs.length === 0 && state.status !== "closing") {
      void action("new-tab", undefined, NEW_BROWSER_TAB_URL);
    }
  }, [action, activeThreadId, state.status, state.tabs.length, viewActive]);

  const consumedBrowserRequestRef = React.useRef(0);
  React.useEffect(() => {
    if (!browserRequest || browserRequest.id === consumedBrowserRequestRef.current) return;
    if (browserRequest.threadId !== activeThreadId) {
      consumedBrowserRequestRef.current = browserRequest.id;
      return;
    }
    if (!activeThreadId) return;
    consumedBrowserRequestRef.current = browserRequest.id;
    if (state.active && browserRequest.newTab) {
      void action("new-tab", undefined, browserRequest.url);
    } else {
      void navigate(browserRequest.url);
    }
  }, [action, activeThreadId, browserRequest, navigate, state.active]);

  const injectMouse = React.useCallback(
    (event: React.PointerEvent<HTMLImageElement>, type: "mousePressed" | "mouseReleased") => {
      if (!stateUrl || !frame || !activeThreadId) return;
      const threadId = activeThreadId;
      const bounds = event.currentTarget.getBoundingClientRect();
      const x = ((event.clientX - bounds.left) / bounds.width) * frame.viewport.width;
      const y = ((event.clientY - bounds.top) / bounds.height) * frame.viewport.height;
      void sendBrowserMouse(threadId, userId, {
        type,
        x,
        y,
        button: "left",
        clickCount: 1,
      });
    },
    [activeThreadId, frame, stateUrl, userId],
  );

  const injectMouseMove = React.useCallback(
    (event: React.PointerEvent<HTMLImageElement>) => {
      const now = performance.now();
      if (now - pointerMoveAtRef.current < 30) return;
      pointerMoveAtRef.current = now;
      if (!stateUrl || !frame || !activeThreadId) return;
      const threadId = activeThreadId;
      const bounds = event.currentTarget.getBoundingClientRect();
      const x = ((event.clientX - bounds.left) / bounds.width) * frame.viewport.width;
      const y = ((event.clientY - bounds.top) / bounds.height) * frame.viewport.height;
      void sendBrowserMouse(threadId, userId, { type: "mouseMoved", x, y, button: "none" });
    },
    [activeThreadId, frame, stateUrl, userId],
  );

  const injectWheel = React.useCallback(
    (event: React.WheelEvent<HTMLImageElement>) => {
      if (!stateUrl || !frame || !activeThreadId) return;
      const threadId = activeThreadId;
      const bounds = event.currentTarget.getBoundingClientRect();
      const x = ((event.clientX - bounds.left) / bounds.width) * frame.viewport.width;
      const y = ((event.clientY - bounds.top) / bounds.height) * frame.viewport.height;
      void sendBrowserMouse(threadId, userId, {
        type: "mouseWheel",
        x,
        y,
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        modifiers:
          (event.altKey ? 1 : 0) |
          (event.ctrlKey ? 2 : 0) |
          (event.metaKey ? 4 : 0) |
          (event.shiftKey ? 8 : 0),
      });
    },
    [activeThreadId, frame, stateUrl, userId],
  );

  const injectKey = React.useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (!stateUrl || !activeThreadId) return;
      const threadId = activeThreadId;
      event.preventDefault();
      const modifiers =
        (event.altKey ? 1 : 0) |
        (event.ctrlKey ? 2 : 0) |
        (event.metaKey ? 4 : 0) |
        (event.shiftKey ? 8 : 0);
      const payload = {
        key: event.key,
        code: event.code,
        modifiers,
        windowsVirtualKeyCode: event.keyCode,
      };
      for (const type of ["keyDown", "keyUp"] as const) {
        void sendBrowserKeyboard(threadId, userId, {
          ...payload,
          type,
          ...(type === "keyDown" && event.key.length === 1 ? { text: event.key } : {}),
        });
      }
    },
    [activeThreadId, stateUrl, userId],
  );

  /**
   * 关闭唯一/最后一个标签页：
   * 立即从前端清空标签状态（0ms 响应，平滑回退），
   * 向后端发送关标签请求让其保持在 about:blank，保留 Chromium 进程常驻预热。
   */
  const closeLastBrowserTab = React.useCallback(() => {
    setState(EMPTY_BROWSER_STATE);
    setFrame(undefined);
    setFrameState("idle");
    if (activeThreadId && stateUrl) {
      void browserAction(activeThreadId, userId, "close-tab", 0).catch(() => {});
    }
  }, [activeThreadId, stateUrl, userId]);

  /** 显式终止浏览器进程（通过工具栏终止按钮或会话结束调用） */
  const closeBrowser = React.useCallback(() => {
    if (!stateUrl || !activeThreadId) return;
    const threadId = activeThreadId;
    const epoch = ++sessionEpochRef.current;
    setState(EMPTY_BROWSER_STATE);
    setFrame(undefined);
    setFrameState("idle");
    void closeBrowserRequest(threadId, userId).then(() => {
      if (sessionEpochRef.current === epoch) {
        void refreshState();
      }
    });
  }, [activeThreadId, refreshState, stateUrl, userId]);

  return {
    action,
    busy,
    closeBrowser,
    closeLastBrowserTab,
    frame,
    frameState,
    hasThread: Boolean(activeThreadId),
    injectKey,
    injectMouse,
    injectMouseMove,
    injectWheel,
    navigate,
    retryFrame,
    state,
    threadKey: activeThreadId,
  };
}
