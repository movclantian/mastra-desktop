import * as React from "react";
import { useWorkbench } from "@/features/workbench";
import { toastError } from "@/lib/errors";
import {
  type BrowserState,
  browserAction,
  browserResourceUrl,
  closeBrowser as closeBrowserRequest,
  connectBrowserScreencast,
  fetchBrowserState,
  navigateBrowser,
  sendBrowserKeyboard,
  sendBrowserMouse,
} from "../browser-api";

const NEW_BROWSER_TAB_URL = "https://www.bing.com";

const EMPTY_BROWSER_STATE: BrowserState = {
  active: false,
  status: "closed",
  currentUrl: null,
  tabs: [],
  activeTabIndex: 0,
};

export function useBrowserSession() {
  const { activeThreadId, activePanelTab, browserRequest, user } = useWorkbench();
  const viewActive = activePanelTab.kind === "browser";
  const [state, setState] = React.useState<BrowserState>(EMPTY_BROWSER_STATE);
  const [frame, setFrame] = React.useState<{
    data: string;
    viewport: { width: number; height: number };
  }>();
  const [busy, setBusy] = React.useState(false);
  const [frameState, setFrameState] = React.useState<"idle" | "connecting" | "connected" | "error">(
    "idle",
  );
  const [screencastAttempt, setScreencastAttempt] = React.useState(0);
  const pointerMoveAtRef = React.useRef(0);
  const stateUrl = activeThreadId ? browserResourceUrl(activeThreadId, user.id) : "";

  const refreshState = React.useCallback(async () => {
    if (!activeThreadId) return setState(EMPTY_BROWSER_STATE);
    try {
      const nextState = await fetchBrowserState(activeThreadId, user.id);
      setState(nextState ?? EMPTY_BROWSER_STATE);
    } catch {
      setState(EMPTY_BROWSER_STATE);
    }
  }, [activeThreadId, user.id]);

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
      const response = await connectBrowserScreencast(threadId, user.id, controller.signal);
      if (!response.ok || !response.body) throw new Error("浏览器画面连接失败");
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
              setFrame(JSON.parse(data) as typeof frame);
              setFrameState("connected");
            } else if (eventName === "url") {
              const payload = JSON.parse(data) as { url?: string };
              if (typeof payload.url === "string") {
                setState((current) => ({ ...current, currentUrl: payload.url ?? null }));
              }
            } else if (eventName === "stop") {
              return;
            } else if (eventName === "error") {
              throw new Error("浏览器画面流发生错误");
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
    };
  }, [activeThreadId, screencastAttempt, state.active, stateUrl, user.id, viewActive]);

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
      setBusy(true);
      try {
        const payload = await navigateBrowser(threadId, user.id, url);
        if (payload.state) setState(payload.state);
        await refreshState();
      } catch (error) {
        toastError(error, "网页导航失败");
      } finally {
        setBusy(false);
      }
    },
    [activeThreadId, refreshState, stateUrl, user.id],
  );

  const action = React.useCallback(
    async (name: string, index?: number, url?: string) => {
      if (!stateUrl || !activeThreadId) return;
      const threadId = activeThreadId;
      setBusy(true);
      if (name === "new-tab") {
        const newUrl = url || NEW_BROWSER_TAB_URL;
        setState((current) => ({
          ...current,
          active: true,
          currentUrl: newUrl,
          tabs: [...current.tabs, { url: newUrl, title: "新标签页" }],
        }));
      } else if (name === "close-tab" && typeof index === "number") {
        setState((current) => {
          const nextTabs = current.tabs.filter((_, i) => i !== index);
          const nextIndex = Math.max(0, Math.min(nextTabs.length - 1, index - 1));
          return {
            ...current,
            currentUrl: nextTabs[nextIndex]?.url ?? "",
            tabs: nextTabs,
          };
        });
      }
      try {
        const payload = await browserAction(threadId, user.id, name, index, url);
        if (payload.state) setState(payload.state);
      } catch (error) {
        toastError(error, "浏览器操作失败");
        void refreshState();
      } finally {
        setBusy(false);
      }
    },
    [activeThreadId, refreshState, stateUrl, user.id],
  );

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
      void sendBrowserMouse(threadId, user.id, {
        type,
        x,
        y,
        button: "left",
        clickCount: 1,
      });
    },
    [activeThreadId, frame, stateUrl, user.id],
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
      void sendBrowserMouse(threadId, user.id, { type: "mouseMoved", x, y, button: "none" });
    },
    [activeThreadId, frame, stateUrl, user.id],
  );

  const injectWheel = React.useCallback(
    (event: React.WheelEvent<HTMLImageElement>) => {
      if (!stateUrl || !frame || !activeThreadId) return;
      const threadId = activeThreadId;
      const bounds = event.currentTarget.getBoundingClientRect();
      const x = ((event.clientX - bounds.left) / bounds.width) * frame.viewport.width;
      const y = ((event.clientY - bounds.top) / bounds.height) * frame.viewport.height;
      void sendBrowserMouse(threadId, user.id, {
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
    [activeThreadId, frame, stateUrl, user.id],
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
        void sendBrowserKeyboard(threadId, user.id, {
          ...payload,
          type,
          ...(type === "keyDown" && event.key.length === 1 ? { text: event.key } : {}),
        });
      }
    },
    [activeThreadId, stateUrl, user.id],
  );

  const closeBrowser = React.useCallback(() => {
    if (!stateUrl || !activeThreadId) return;
    const threadId = activeThreadId;
    setState(EMPTY_BROWSER_STATE);
    setFrame(undefined);
    setFrameState("idle");
    void closeBrowserRequest(threadId, user.id).then(() => {
      void refreshState();
    });
  }, [activeThreadId, refreshState, stateUrl, user.id]);

  return {
    action,
    busy,
    closeBrowser,
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
