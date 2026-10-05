import { useRouterState } from "@tanstack/react-router";
import * as React from "react";
import { useWorkbenchStore } from "@/entities/workbench/model/workbench-store";
import { useAuth } from "@/features/auth";
import {
  getBrowserSearchEnginePreference,
  subscribeBrowserSearchEnginePreference,
} from "@/shared/browser-search-preference";
import { i18n } from "@/shared/i18n";
import { toastError } from "@/shared/lib";
import {
  type BrowserAction,
  type BrowserKeyboardRequest,
  type BrowserState,
  browserAction,
  browserResourceUrl,
  closeBrowser as closeBrowserRequest,
  connectBrowserScreencast,
  fetchBrowserState,
  navigateBrowser,
  sendBrowserKeyboardBatch,
  sendBrowserMouse,
} from "../api/browser-api";

const EMPTY_BROWSER_STATE: BrowserState = {
  active: false,
  status: "closed",
  currentUrl: null,
  tabs: [],
  activeTabIndex: 0,
};

export function isCurrentBrowserStreamEvent(streamEpoch: number, currentEpoch: number): boolean {
  return streamEpoch === currentEpoch;
}

export function mapBrowserPointerToViewport(
  clientX: number,
  clientY: number,
  bounds: Pick<DOMRect, "left" | "top" | "width" | "height">,
  viewport: { width: number; height: number },
): { x: number; y: number } | undefined {
  if (
    !Number.isFinite(clientX) ||
    !Number.isFinite(clientY) ||
    !Number.isFinite(bounds.left) ||
    !Number.isFinite(bounds.top) ||
    !Number.isFinite(bounds.width) ||
    !Number.isFinite(bounds.height) ||
    bounds.width <= 0 ||
    bounds.height <= 0 ||
    viewport.width <= 0 ||
    viewport.height <= 0
  ) {
    return undefined;
  }
  const localX = clientX - bounds.left;
  const localY = clientY - bounds.top;
  if (localX < 0 || localY < 0 || localX > bounds.width || localY > bounds.height) {
    return undefined;
  }
  return {
    x: Math.max(0, Math.min(viewport.width - 1, (localX / bounds.width) * viewport.width)),
    y: Math.max(0, Math.min(viewport.height - 1, (localY / bounds.height) * viewport.height)),
  };
}

export function useBrowserSession() {
  const { user } = useAuth();
  const userId = user?.id ?? "anonymous";
  const activeThreadId = useRouterState({
    select: (state) => (state.location.search as { thread?: string }).thread ?? null,
  });
  const activePanelTab = useWorkbenchStore((state) => state.activePanelTab);
  const browserRequest = useWorkbenchStore((state) => state.browserRequest);
  const viewActive = activePanelTab.kind === "browser";
  const nativeBrowser = typeof window !== "undefined" ? window.api?.browserView : undefined;
  const nativeAvailable = Boolean(nativeBrowser);
  const [state, setState] = React.useState<BrowserState>(EMPTY_BROWSER_STATE);
  const [searchEngine, setSearchEngine] = React.useState(() =>
    getBrowserSearchEnginePreference(userId),
  );
  const stateRef = React.useRef(state);
  stateRef.current = state;
  const [frame, setFrame] = React.useState<{
    data: string;
    viewport: { width: number; height: number };
  }>();
  const frameRef = React.useRef(frame);
  frameRef.current = frame;
  const pendingFrameRef = React.useRef<typeof frame>(undefined);
  const frameAnimationRef = React.useRef<number | undefined>(undefined);
  const frameStreamEpochRef = React.useRef(0);
  const pendingNavigationRef = React.useRef(false);
  const [busy, setBusy] = React.useState(false);
  const busyRef = React.useRef(false);
  const sessionEpochRef = React.useRef(0);
  const [frameState, setFrameState] = React.useState<"idle" | "connecting" | "connected" | "error">(
    "idle",
  );
  const [screencastAttempt, setScreencastAttempt] = React.useState(0);
  const pointerMoveAtRef = React.useRef(0);
  const keyboardQueueRef = React.useRef<BrowserKeyboardRequest[]>([]);
  const keyboardFlushTimerRef = React.useRef<number | undefined>(undefined);
  const keyboardSendChainRef = React.useRef<Promise<void>>(Promise.resolve());
  const stateUrl = activeThreadId ? browserResourceUrl(activeThreadId, userId) : "";

  React.useEffect(() => {
    setSearchEngine(getBrowserSearchEnginePreference(userId));
    return subscribeBrowserSearchEnginePreference(userId, setSearchEngine);
  }, [userId]);

  const clearFrame = React.useCallback(() => {
    pendingFrameRef.current = undefined;
    if (frameAnimationRef.current !== undefined) {
      window.cancelAnimationFrame(frameAnimationRef.current);
      frameAnimationRef.current = undefined;
    }
    setFrame(undefined);
    setFrameState("idle");
  }, []);

  const invalidateFrame = React.useCallback(() => {
    frameStreamEpochRef.current += 1;
    clearFrame();
  }, [clearFrame]);

  const refreshState = React.useCallback(async () => {
    if (!activeThreadId) return setState(EMPTY_BROWSER_STATE);
    if (busyRef.current) return;
    const epoch = sessionEpochRef.current;
    try {
      const nextState = nativeBrowser
        ? await nativeBrowser.getState({ resourceId: userId, threadId: activeThreadId })
        : await fetchBrowserState(activeThreadId, userId);
      if (sessionEpochRef.current === epoch && !busyRef.current) {
        setState(nextState ?? EMPTY_BROWSER_STATE);
      }
    } catch {
      if (sessionEpochRef.current === epoch && !busyRef.current) {
        setState(EMPTY_BROWSER_STATE);
      }
    }
  }, [activeThreadId, nativeBrowser, userId]);

  React.useEffect(() => {
    if (!nativeBrowser || !activeThreadId) return;
    let disposed = false;
    void nativeBrowser
      .ensure({ resourceId: userId, threadId: activeThreadId })
      .then((nextState) => {
        if (!disposed && !busyRef.current) setState(nextState);
      })
      .catch(() => {
        if (!disposed) setState(EMPTY_BROWSER_STATE);
      });
    return () => {
      disposed = true;
    };
  }, [activeThreadId, nativeBrowser, userId]);

  React.useEffect(() => {
    if (!nativeBrowser) return;
    return nativeBrowser.onEvent((event) => {
      if (event.threadId !== activeThreadId || event.resourceId !== userId) return;
      if (event.type === "state") {
        if (!busyRef.current) setState(event.state);
      } else if (event.type === "url") {
        setState((current) => ({ ...current, currentUrl: event.url }));
      }
    });
  }, [activeThreadId, nativeBrowser, userId]);

  React.useEffect(() => {
    // 浏览器状态属于当前线程;切换线程时先清空旧线程的乐观状态,
    // 再等待新线程的服务端快照,避免侧边栏短暂显示上一个线程的标签页。
    sessionEpochRef.current += 1;
    stateRef.current = EMPTY_BROWSER_STATE;
    invalidateFrame();
    pendingNavigationRef.current = false;
    busyRef.current = false;
    setBusy(false);
    setState(EMPTY_BROWSER_STATE);
    setFrame(undefined);
    setFrameState("idle");
    void refreshState();
    if (!stateUrl) return;
    const timer = window.setInterval(() => void refreshState(), 1_500);
    return () => {
      window.clearInterval(timer);
      keyboardQueueRef.current = [];
      if (keyboardFlushTimerRef.current !== undefined) {
        window.clearTimeout(keyboardFlushTimerRef.current);
        keyboardFlushTimerRef.current = undefined;
      }
    };
  }, [invalidateFrame, refreshState, stateUrl]);

  React.useEffect(() => {
    void screencastAttempt;
    if (nativeAvailable || !viewActive || !stateUrl || !state.active || !activeThreadId) return;
    const threadId = activeThreadId;
    const streamEpoch = ++frameStreamEpochRef.current;
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
            if (!isCurrentBrowserStreamEvent(streamEpoch, frameStreamEpochRef.current)) {
              boundary = buffer.indexOf("\n\n");
              continue;
            }
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
                const navigationPending = pendingNavigationRef.current;
                setState((current) => ({ ...current, currentUrl: payload.url ?? null }));
                if (navigationPending) {
                  // Keep the last decoded frame while the destination paints.
                  // Clearing it here turns a normal navigation into a white
                  // flash on heavy pages; the next frame will replace it.
                  pendingNavigationRef.current = false;
                  setFrameState("connecting");
                }
              }
            } else if (eventName === "stop") {
              const payload = JSON.parse(data) as { reason?: unknown };
              const reason = payload.reason;
              const normalStop =
                reason == null || reason === "closed" || reason === "stopped" || reason === "stop";
              if (!normalStop) {
                setFrame(undefined);
                setFrameState("error");
              } else {
                setFrameState("idle");
              }
              void refreshState();
              return;
            } else if (eventName === "error") {
              throw new Error(i18n.t("workspace:streamError"));
            }
            boundary = buffer.indexOf("\n\n");
          }
          if (done) {
            // A normal close is announced by the explicit `stop` event. An
            // EOF without it means the browser process or SSE bridge died;
            // surface an error so the view offers a retry instead of staying
            // on a permanent blank/connected state.
            if (!disposed) throw new Error(i18n.t("workspace:streamError"));
            return;
          }
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
  }, [
    activeThreadId,
    clearFrame,
    invalidateFrame,
    nativeAvailable,
    refreshState,
    screencastAttempt,
    state.active,
    stateUrl,
    userId,
    viewActive,
  ]);

  const retryFrame = React.useCallback(() => {
    setFrame(undefined);
    setFrameState("connecting");
    setScreencastAttempt((attempt) => attempt + 1);
    void refreshState();
  }, [refreshState]);

  const flushKeyboardQueue = React.useCallback(() => {
    keyboardFlushTimerRef.current = undefined;
    if (
      !activeThreadId ||
      !stateUrl ||
      busyRef.current ||
      !stateRef.current.active ||
      stateRef.current.status === "closing" ||
      keyboardQueueRef.current.length === 0
    ) {
      if (!stateRef.current.active || stateRef.current.status === "closing") {
        keyboardQueueRef.current = [];
      }
      return;
    }
    const events = keyboardQueueRef.current.splice(0, 64);
    const threadId = activeThreadId;
    const resourceId = userId;
    keyboardSendChainRef.current = keyboardSendChainRef.current
      .catch(() => undefined)
      .then(() => sendBrowserKeyboardBatch(threadId, resourceId, { events }))
      .then(() => undefined)
      .catch(() => undefined)
      .finally(() => {
        if (keyboardQueueRef.current.length > 0 && keyboardFlushTimerRef.current === undefined) {
          keyboardFlushTimerRef.current = window.setTimeout(flushKeyboardQueue, 8);
        }
      });
  }, [activeThreadId, stateUrl, userId]);

  const queueKeyboardEvent = React.useCallback(
    (event: BrowserKeyboardRequest) => {
      keyboardQueueRef.current.push(event);
      if (keyboardFlushTimerRef.current === undefined) {
        keyboardFlushTimerRef.current = window.setTimeout(flushKeyboardQueue, 8);
      }
    },
    [flushKeyboardQueue],
  );

  const navigate = React.useCallback(
    async (url: string) => {
      if (!stateUrl || !url.trim() || !activeThreadId || busyRef.current) return false;
      const threadId = activeThreadId;
      const epoch = sessionEpochRef.current;
      pendingNavigationRef.current = true;
      busyRef.current = true;
      setBusy(true);
      let succeeded = false;
      try {
        const payload = nativeBrowser
          ? { state: await nativeBrowser.navigate({ resourceId: userId, threadId }, url) }
          : await navigateBrowser(threadId, userId, url);
        if (sessionEpochRef.current !== epoch) return false;
        if (payload.state) setState(payload.state);
        succeeded = true;
        return payload.state?.currentUrl || url;
      } catch (error) {
        if (sessionEpochRef.current === epoch) {
          toastError(error, i18n.t("workspace:navigateFailed"));
        }
        return false;
      } finally {
        if (sessionEpochRef.current === epoch) {
          if (!succeeded) {
            pendingNavigationRef.current = false;
            clearFrame();
            setScreencastAttempt((attempt) => attempt + 1);
          }
          busyRef.current = false;
          setBusy(false);
          void refreshState();
        }
      }
    },
    [activeThreadId, clearFrame, nativeBrowser, refreshState, stateUrl, userId],
  );

  const action = React.useCallback(
    async (name: BrowserAction, index?: number, url?: string) => {
      if (!stateUrl || !activeThreadId || busyRef.current) return;
      const threadId = activeThreadId;
      const epoch = sessionEpochRef.current;
      pendingNavigationRef.current = true;
      busyRef.current = true;
      setBusy(true);
      let succeeded = false;
      const requestUrl = name === "new-tab" && url !== "about:blank" ? url : undefined;
      if (name === "new-tab") {
        const newUrl = requestUrl ?? "about:blank";
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
        const payload = nativeBrowser
          ? {
              state: await nativeBrowser.action(
                { resourceId: userId, threadId },
                name,
                index,
                requestUrl,
              ),
            }
          : await browserAction(threadId, userId, name, index, requestUrl);
        if (sessionEpochRef.current === epoch && payload.state) setState(payload.state);
        succeeded = true;
      } catch (error) {
        if (sessionEpochRef.current === epoch) {
          toastError(error, i18n.t("workspace:browserOpFailed"));
          void refreshState();
        }
      } finally {
        if (sessionEpochRef.current === epoch) {
          if (!succeeded) {
            pendingNavigationRef.current = false;
            clearFrame();
            setScreencastAttempt((attempt) => attempt + 1);
          }
          busyRef.current = false;
          setBusy(false);
          void refreshState();
        }
      }
    },
    [activeThreadId, clearFrame, nativeBrowser, refreshState, stateUrl, userId],
  );

  // 当处于浏览器面板且无标签时，自动拉起首个空白标签页（0ms 乐观上屏）。
  React.useEffect(() => {
    if (!viewActive || !activeThreadId || busyRef.current) return;
    // The Electron-native path creates its initial about:blank tab in the
    // main-process view manager.  Do not also issue the legacy new-tab action;
    // doing both races the first open and leaves a duplicate hidden tab.
    if (nativeAvailable) return;
    if (state.tabs.length === 0 && state.status !== "closing") {
      void action("new-tab");
    }
  }, [action, activeThreadId, nativeAvailable, state.status, state.tabs.length, viewActive]);

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
      const currentFrame = frameRef.current;
      if (
        !stateUrl ||
        !currentFrame ||
        !activeThreadId ||
        busyRef.current ||
        !stateRef.current.active ||
        stateRef.current.status === "closing"
      ) {
        return;
      }
      const threadId = activeThreadId;
      const coordinates = mapBrowserPointerToViewport(
        event.clientX,
        event.clientY,
        event.currentTarget.getBoundingClientRect(),
        currentFrame.viewport,
      );
      if (!coordinates) return;
      void sendBrowserMouse(threadId, userId, {
        type,
        ...coordinates,
        button: "left",
        clickCount: 1,
      }).catch(() => undefined);
    },
    [activeThreadId, stateUrl, userId],
  );

  const injectMouseMove = React.useCallback(
    (event: React.PointerEvent<HTMLImageElement>) => {
      const now = performance.now();
      if (now - pointerMoveAtRef.current < 30) return;
      pointerMoveAtRef.current = now;
      const currentFrame = frameRef.current;
      if (
        !stateUrl ||
        !currentFrame ||
        !activeThreadId ||
        busyRef.current ||
        !stateRef.current.active ||
        stateRef.current.status === "closing"
      ) {
        return;
      }
      const threadId = activeThreadId;
      const coordinates = mapBrowserPointerToViewport(
        event.clientX,
        event.clientY,
        event.currentTarget.getBoundingClientRect(),
        currentFrame.viewport,
      );
      if (!coordinates) return;
      void sendBrowserMouse(threadId, userId, {
        type: "mouseMoved",
        ...coordinates,
        button: "none",
      }).catch(() => undefined);
    },
    [activeThreadId, stateUrl, userId],
  );

  const injectWheel = React.useCallback(
    (event: React.WheelEvent<HTMLImageElement>) => {
      const currentFrame = frameRef.current;
      if (
        !stateUrl ||
        !currentFrame ||
        !activeThreadId ||
        busyRef.current ||
        !stateRef.current.active ||
        stateRef.current.status === "closing"
      ) {
        return;
      }
      const threadId = activeThreadId;
      const coordinates = mapBrowserPointerToViewport(
        event.clientX,
        event.clientY,
        event.currentTarget.getBoundingClientRect(),
        currentFrame.viewport,
      );
      if (!coordinates) return;
      void sendBrowserMouse(threadId, userId, {
        type: "mouseWheel",
        ...coordinates,
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        modifiers:
          (event.altKey ? 1 : 0) |
          (event.ctrlKey ? 2 : 0) |
          (event.metaKey ? 4 : 0) |
          (event.shiftKey ? 8 : 0),
      }).catch(() => undefined);
    },
    [activeThreadId, stateUrl, userId],
  );

  const injectKey = React.useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (
        !stateUrl ||
        !activeThreadId ||
        busyRef.current ||
        !stateRef.current.active ||
        stateRef.current.status === "closing"
      ) {
        return;
      }
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
      const events: BrowserKeyboardRequest[] = [];
      for (const type of ["keyDown", "keyUp"] as const) {
        events.push({
          ...payload,
          type,
          ...(type === "keyDown" && event.key.length === 1 ? { text: event.key } : {}),
        });
      }
      for (const keyboardEvent of events) queueKeyboardEvent(keyboardEvent);
    },
    [activeThreadId, queueKeyboardEvent, stateUrl],
  );

  const setNativeBounds = React.useCallback(
    (bounds: { x: number; y: number; width: number; height: number }) => {
      if (!nativeBrowser || !activeThreadId) return;
      nativeBrowser.setBounds({ resourceId: userId, threadId: activeThreadId, ...bounds });
    },
    [activeThreadId, nativeBrowser, userId],
  );

  /**
   * 关闭唯一/最后一个标签页：
   * 立即从前端清空标签状态，并让服务端导航到空白页以保留已启动的 Chromium 会话。
   */
  const closeLastBrowserTab = React.useCallback(() => {
    keyboardQueueRef.current = [];
    if (keyboardFlushTimerRef.current !== undefined) {
      window.clearTimeout(keyboardFlushTimerRef.current);
      keyboardFlushTimerRef.current = undefined;
    }
    stateRef.current = EMPTY_BROWSER_STATE;
    setState(EMPTY_BROWSER_STATE);
    setFrame(undefined);
    setFrameState("idle");
    if (activeThreadId && stateUrl) void action("close-tab", 0);
  }, [action, activeThreadId, stateUrl]);

  /** 显式终止浏览器进程（通过工具栏终止按钮或会话结束调用） */
  const closeBrowser = React.useCallback(() => {
    if (!stateUrl || !activeThreadId) return;
    keyboardQueueRef.current = [];
    if (keyboardFlushTimerRef.current !== undefined) {
      window.clearTimeout(keyboardFlushTimerRef.current);
      keyboardFlushTimerRef.current = undefined;
    }
    const threadId = activeThreadId;
    const epoch = ++sessionEpochRef.current;
    stateRef.current = EMPTY_BROWSER_STATE;
    setState(EMPTY_BROWSER_STATE);
    setFrame(undefined);
    setFrameState("idle");
    const closePromise = nativeBrowser
      ? nativeBrowser.close({ resourceId: userId, threadId })
      : closeBrowserRequest(threadId, userId);
    void closePromise
      .then(() => {
        if (sessionEpochRef.current === epoch) {
          void refreshState();
        }
      })
      .catch(() => {});
  }, [activeThreadId, nativeBrowser, refreshState, stateUrl, userId]);

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
    native: nativeAvailable,
    searchEngine,
    setBounds: setNativeBounds,
    state,
    threadKey: activeThreadId,
  };
}
