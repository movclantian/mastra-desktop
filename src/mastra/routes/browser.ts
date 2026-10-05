/**
 * 浏览器自动化路由(/work/browser/*):导航 / 点击 / 输入 / 截图 / 标签页控制。
 * 官方文档:docs/en/docs/browser.mdx、docs/en/reference/browser/;
 * 运行时实例见 src/mastra/agents/browser.ts(AgentBrowser)。
 */
import { MASTRA_RESOURCE_ID_KEY } from "@mastra/core/request-context";
import { type ContextWithMastra, registerApiRoute } from "@mastra/core/server";
import {
  BrowserActionRequestSchema,
  BrowserKeyboardBatchRequestSchema,
  BrowserKeyboardRequestSchema,
  BrowserMouseRequestSchema,
  BrowserNavigateRequestSchema,
  BrowserOkResultSchema,
  BrowserResponseSchema,
  BrowserStateSchema,
} from "../../shared/browser-contract";
import {
  getBrowserConfig,
  getBrowserForThread,
  saveBrowserConfig,
  type WorkBrowser,
} from "../agents/browser";
import { errorText, workError } from "../errors";
import { getOwnedThread, getWorkMemory, isTrustedLocalRequest } from "./threads/shared";

async function ownedBrowserThread(c: ContextWithMastra) {
  if (!isTrustedLocalRequest(c)) return null;
  const threadId = c.req.param("threadId");
  const resourceId = c.get("requestContext").get(MASTRA_RESOURCE_ID_KEY);
  if (!threadId || typeof resourceId !== "string" || !resourceId.trim()) return null;
  const memory = await getWorkMemory(c.get("requestContext"));
  if (!(await getOwnedThread(memory, threadId, resourceId))) return null;
  return { threadId, resourceId, browser: await getBrowserForThread(resourceId, threadId) };
}

function browserState(browser: WorkBrowser, threadId: string) {
  return Promise.all([browser.getBrowserState(threadId), browser.getCurrentUrl(threadId)]).then(
    ([state, currentUrl]) => {
      const visibleTabs = visibleBrowserTabs(state);
      const tabs = visibleTabs.map(({ tab }) => tab);
      const hasSession = browser.hasThreadSession(threadId);
      const selectedTabIndex = visibleTabs.findIndex(
        ({ index }) => index === (state?.activeTabIndex ?? 0),
      );
      const activeVisibleTab = visibleTabs[selectedTabIndex >= 0 ? selectedTabIndex : 0];
      return BrowserStateSchema.parse({
        active: hasSession && tabs.length > 0,
        status: browser.status,
        currentUrl:
          activeVisibleTab?.tab.url && activeVisibleTab.tab.url !== "about:blank"
            ? activeVisibleTab.tab.url
            : currentUrl === "about:blank"
              ? null
              : currentUrl,
        tabs,
        activeTabIndex: selectedTabIndex >= 0 ? selectedTabIndex : 0,
        closeReason: state?.closeReason,
        activeUrlChangeSource: state?.activeUrlChangeSource,
      });
    },
  );
}

/** 用户浏览器默认保持轻量空白起始页；Bing 等首页通过设置显式配置。 */
const FALLBACK_BROWSER_HOME_URL = "about:blank";
const BROWSER_STREAM_QUALITY = 60;
const BROWSER_STREAM_MAX_WIDTH = 960;
const BROWSER_STREAM_MAX_HEIGHT = 540;

async function browserForward(browser: WorkBrowser, threadId: string) {
  const previousUrl = await browser.getCurrentUrl(threadId);
  try {
    return await browser.evaluate({ script: "history.forward()" }, threadId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/execution context was destroyed.*navigation/i.test(message)) throw error;
    if (!browser.hasThreadSession(threadId)) throw error;

    // history.forward() 会销毁旧页面的 JS context。仅当同一浏览器会话已切到
    // 另一条有效 URL 时，将它认作成功导航；其他错误仍按失败上报。
    const state = await browser.getBrowserState(threadId);
    const activeTab = state?.tabs[state.activeTabIndex ?? 0];
    if (!activeTab?.url || activeTab.url === "about:blank" || activeTab.url === previousUrl) {
      throw error;
    }
    return { success: true };
  }
}

async function browserReload(browser: WorkBrowser, threadId: string, resourceId: string) {
  const currentUrl = await browser.getCurrentUrl(threadId);
  const targetUrl =
    currentUrl && currentUrl !== "about:blank" ? currentUrl : await getBrowserHomeUrl(resourceId);
  return browser.goto({ url: targetUrl }, threadId);
}

async function getBrowserHomeUrl(resourceId: string): Promise<string> {
  const { homeUrl } = await getBrowserConfig(resourceId);
  return homeUrl || FALLBACK_BROWSER_HOME_URL;
}

async function navigateBrowserTab(
  browser: WorkBrowser,
  url: string,
  threadId: string,
): Promise<void> {
  const result = await browser.goto({ url: url }, threadId);
  if (!("success" in result) || result.success !== true) {
    throw new Error(
      "message" in result && typeof result.message === "string"
        ? result.message
        : "Browser tab could not be created",
    );
  }
}

function isClosedBrowserContextError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /target page, context or browser has been closed|target closed|browser has been closed/i.test(
    message,
  );
}

function visibleBrowserTabs(state: { tabs?: Array<{ url?: unknown }> } | null | undefined) {
  return (state?.tabs ?? []).flatMap((tab, index) =>
    typeof tab.url === "string" ? [{ tab, index }] : [],
  );
}

// 首次打开线程时,浏览器 SSE 与标签操作可能同时触发 ensureReady + goto。
// Playwright 对同一个 Page 的并发导航会主动取消其中一次并返回 ERR_ABORTED;
// 按线程串行化这段初始化,避免把正常的重复初始化误报成操作失败。
const browserInitPromises = new Map<string, Promise<boolean>>();
const browserClosingPromises = new Map<string, Promise<void>>();

/**
 * 确保线程浏览器就绪,且有一个标签。返回 true 表示目标 URL 已由本次或并发
 * 初始化导航完成,调用方无需再导航 / 新建标签。
 *
 * about:blank 是用户浏览器的轻量新标签页。配置首页时复用它导航到目标首页,
 * 避免额外创建标签页。
 */
async function ensureBrowserTabOnce(
  browser: WorkBrowser,
  threadId: string,
  url: string,
): Promise<boolean> {
  // AgentBrowser 的 thread scope 由 current thread 决定;先显式创建该线程
  // 的 Playwright 会话,再读取状态。仅调用 goto() 会把启动失败伪装成“无标签”。
  browser.setCurrentThread(threadId);
  await browser.ensureReady();
  const state = await browser.getBrowserState(threadId);
  if (state?.tabs.some((tab) => tab.url && tab.url !== "about:blank")) return false;
  await navigateBrowserTab(browser, url, threadId);
  return true;
}

async function ensureBrowserTab(
  browser: WorkBrowser,
  resourceId: string,
  threadId: string,
  url?: string,
): Promise<boolean> {
  const targetUrl = url ?? (await getBrowserHomeUrl(resourceId));
  // 若当前正在执行异步销毁,必须等待销毁完成再重新就绪,避免并发销毁导致连接被断开
  const key = `${resourceId}:${threadId}`;
  const closing = browserClosingPromises.get(key);
  if (closing) {
    try {
      await closing;
    } catch {}
  }
  const pending = browserInitPromises.get(key);
  if (pending) {
    await pending;
    const state = await browser.getBrowserState(threadId);
    const activeUrl = state?.tabs[state.activeTabIndex ?? 0]?.url;
    if (activeUrl === targetUrl) return true;

    const hasNavigatedTab = state?.tabs.some((tab) => tab.url && tab.url !== "about:blank");
    if (!hasNavigatedTab) {
      await navigateBrowserTab(browser, targetUrl, threadId);
      return true;
    }
    return false;
  }

  const initialization = ensureBrowserTabOnce(browser, threadId, targetUrl);
  browserInitPromises.set(key, initialization);
  try {
    return await initialization;
  } finally {
    if (browserInitPromises.get(key) === initialization) {
      browserInitPromises.delete(key);
    }
  }
}

export const browserStateRoute = registerApiRoute("/work/threads/:threadId/browser", {
  method: "GET",
  handler: async (c) => {
    const owned = await ownedBrowserThread(c);
    if (!owned) throw workError("THREAD_NOT_FOUND");
    return c.json(await browserState(owned.browser, owned.threadId));
  },
});

/** SSE 桥接 Mastra ScreencastStream；断开时只停画面订阅，不关闭线程浏览器。 */
export const browserScreencastRoute = registerApiRoute(
  "/work/threads/:threadId/browser/screencast",
  {
    method: "GET",
    handler: async (c) => {
      const owned = await ownedBrowserThread(c);
      if (!owned) throw workError("THREAD_NOT_FOUND");
      const { browser, threadId, resourceId } = owned;
      const browserConfig = await getBrowserConfig(resourceId);
      const frameViewport =
        browserConfig.viewport === "window" ? { width: 1280, height: 720 } : browserConfig.viewport;
      let screencast: Awaited<ReturnType<typeof browser.startScreencast>>;
      try {
        await ensureBrowserTab(browser, resourceId, threadId);
        screencast = await browser.startScreencast({
          format: "jpeg",
          quality: BROWSER_STREAM_QUALITY,
          maxWidth: BROWSER_STREAM_MAX_WIDTH,
          maxHeight: BROWSER_STREAM_MAX_HEIGHT,
          everyNthFrame: 2,
          threadId,
        });
      } catch (error) {
        return c.json(
          {
            error: "browser_start_failed",
            message: errorText(error, "浏览器不可用"),
          },
          503,
        );
      }

      const encoder = new TextEncoder();
      let disposed = false;
      let stopped = false;
      let closed = false;
      let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined;
      let pendingFrame: unknown;
      const pendingControls: Array<{ event: string; chunk: Uint8Array }> = [];
      let snapshotTimer: ReturnType<typeof setTimeout> | undefined;

      const closeIfDrained = () => {
        if (
          !stopped ||
          closed ||
          !controllerRef ||
          pendingFrame !== undefined ||
          pendingControls.length > 0
        ) {
          return;
        }
        closed = true;
        controllerRef.close();
      };

      const flush = () => {
        if (disposed || closed || !controllerRef) return;
        while ((controllerRef.desiredSize ?? 0) > 0) {
          const nextControl = pendingControls.shift();
          if (nextControl) {
            controllerRef.enqueue(nextControl.chunk);
            continue;
          }
          if (pendingFrame === undefined) break;
          const frame = pendingFrame;
          pendingFrame = undefined;
          controllerRef.enqueue(encoder.encode(`event: frame\ndata: ${JSON.stringify(frame)}\n\n`));
        }
        closeIfDrained();
      };

      const queueControl = (event: string, value: unknown) => {
        const chunk = encoder.encode(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
        const existing = pendingControls.findIndex((item) => item.event === event);
        if (existing >= 0 && event !== "stop") {
          pendingControls[existing] = { event, chunk };
          return;
        }
        // Only state/url/error/stop exist today; coalescing by event keeps the
        // control queue bounded even if the browser emits noisy URL/error events.
        if (pendingControls.length >= 4 && event !== "stop") {
          const replaceable = pendingControls.findIndex(
            (item) => item.event === "url" || item.event === "error",
          );
          if (replaceable >= 0) pendingControls.splice(replaceable, 1);
          else return;
        }
        pendingControls.push({ event, chunk });
      };

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controllerRef = controller;
          const send = (event: string, value: unknown) => {
            if (disposed || stopped) return;
            if (event === "frame") {
              // A frame is a replaceable preview, not a durable event. Keep
              // only the newest one while a slow client drains the stream.
              pendingFrame = value;
            } else {
              queueControl(event, value);
            }
            flush();
          };
          const sendSnapshot = async () => {
            if (disposed || stopped) return;
            try {
              const snapshot = await browser.screenshot({ fullPage: false }, threadId);
              if (disposed || stopped || !("base64" in snapshot)) return;
              send("frame", {
                data: snapshot.base64,
                timestamp: Date.now(),
                viewport: frameViewport,
              });
            } catch {
              // The live screencast remains the primary source. A snapshot
              // retry must not terminate an otherwise healthy stream.
            }
          };
          const scheduleSnapshot = (delay: number) => {
            if (snapshotTimer !== undefined) clearTimeout(snapshotTimer);
            snapshotTimer = setTimeout(() => {
              snapshotTimer = undefined;
              void sendSnapshot();
            }, delay);
          };
          send("state", { active: true });
          screencast.on("frame", (frame: unknown) => send("frame", frame));
          screencast.on("url", (url: unknown) => {
            send("url", { url });
            // Navigation can emit its URL before Chromium has painted the
            // destination. A delayed snapshot fixes the static-page race
            // without clearing the previous frame or restarting the stream.
            scheduleSnapshot(250);
          });
          screencast.on("error", (error: { message?: string }) =>
            send("error", { error: "browser_stream_failed", message: error.message }),
          );
          screencast.on("stop", (reason: unknown) => {
            if (disposed || stopped) return;
            stopped = true;
            pendingFrame = undefined;
            queueControl("stop", { reason });
            flush();
            closeIfDrained();
          });

          // startScreencast() starts CDP before returning the stream. For a
          // static page such as about:blank, its only frame can arrive before
          // the route attaches listeners. Take one explicit snapshot so the
          // UI cannot remain in a permanent white "waiting" state.
          // Retry after a short paint window. This covers about:blank and
          // static pages whose only screencast frame arrived before the SSE
          // listeners attached.
          scheduleSnapshot(350);
        },
        pull() {
          flush();
        },
        async cancel() {
          disposed = true;
          if (snapshotTimer !== undefined) {
            clearTimeout(snapshotTimer);
            snapshotTimer = undefined;
          }
          pendingFrame = undefined;
          pendingControls.length = 0;
          await screencast.stop().catch(() => undefined);
        },
      });
      return new Response(stream, {
        headers: {
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "Content-Type": "text/event-stream",
        },
      });
    },
  },
);

export const browserNavigateRoute = registerApiRoute("/work/threads/:threadId/browser/navigate", {
  method: "POST",
  handler: async (c) => {
    const owned = await ownedBrowserThread(c);
    if (!owned) throw workError("THREAD_NOT_FOUND");
    const { browser, threadId, resourceId } = owned;
    const request = BrowserNavigateRequestSchema.safeParse(await c.req.json());
    if (!request.success) {
      throw workError("VALIDATION_FAILED", { text: request.error.issues[0]?.message });
    }
    const { url } = request.data;
    try {
      // 首次就绪时直接落到目标地址,省掉一次多余的首页往返
      const navigated = await ensureBrowserTab(browser, resourceId, threadId, url);
      const result = navigated ? { success: true } : await browser.goto({ url: url }, threadId);
      if (!("success" in result) || result.success !== true) return c.json(result, 400);
      return c.json(BrowserResponseSchema.parse({ state: await browserState(browser, threadId) }));
    } catch (error) {
      return c.json(
        {
          error: "browser_navigation_failed",
          message: errorText(error, "浏览器不可用"),
        },
        503,
      );
    }
  },
});

export const browserActionRoute = registerApiRoute("/work/threads/:threadId/browser/action", {
  method: "POST",
  handler: async (c) => {
    const owned = await ownedBrowserThread(c);
    if (!owned) throw workError("THREAD_NOT_FOUND");
    const { browser, threadId, resourceId } = owned;
    const request = BrowserActionRequestSchema.safeParse(await c.req.json());
    if (!request.success) {
      throw workError("VALIDATION_FAILED", { text: request.error.issues[0]?.message });
    }
    const body = request.data;
    try {
      let result: unknown;
      switch (body.action) {
        case "back":
          result = await browser.back(threadId);
          break;
        case "forward":
          result = await browserForward(browser, threadId);
          break;
        case "reload":
          result = await browserReload(browser, threadId, resourceId);
          break;
        case "new-tab": {
          // 浏览器尚未就绪时,首次导航已经把那个空白初始页变成了目标页面,
          // 此时再 tabs({action:"new"}) 只会凭空多出一个标签。
          // 未指定 url 也要落在首页 —— tabs() 收到 undefined 会开出 about:blank。
          const homeUrl = body.url ?? (await getBrowserHomeUrl(resourceId));
          const navigated = await ensureBrowserTab(browser, resourceId, threadId, homeUrl);
          result = navigated
            ? { success: true }
            : await browser.tabs(
                {
                  action: "new",
                  url: homeUrl === FALLBACK_BROWSER_HOME_URL ? undefined : homeUrl,
                },
                threadId,
              );
          break;
        }
        case "switch-tab":
          {
            const currentState = await browser.getBrowserState(threadId);
            const visibleTabs = visibleBrowserTabs(currentState);
            const rawIndex = visibleTabs[body.index]?.index;
            if (rawIndex === undefined) throw workError("VALIDATION_FAILED");
            result = await browser.tabs({ action: "switch", index: rawIndex }, threadId);
          }
          break;
        case "close-tab": {
          const currentState = await browser.getBrowserState(threadId);
          const visibleTabs = visibleBrowserTabs(currentState);
          const rawIndex = visibleTabs[body.index]?.index;
          if (rawIndex === undefined) throw workError("VALIDATION_FAILED");
          if (visibleTabs.length <= 1) {
            // 关掉唯一标签时保留空白页让 Chromium 保持就绪;状态接口会隐藏它,
            // 下次打开时可直接复用,不必冷启动浏览器进程。
            if (currentState?.activeTabIndex !== rawIndex) {
              await browser.tabs({ action: "switch", index: rawIndex }, threadId);
            }
            result = await browser.goto({ url: "about:blank" }, threadId);
          } else {
            result = await browser.tabs({ action: "close", index: rawIndex }, threadId);
          }
          break;
        }
        case "reset-tabs": {
          const currentState = await browser.getBrowserState(threadId);
          const count = currentState?.tabs.length ?? 0;
          for (let i = count - 1; i >= 1; i--) {
            try {
              await browser.tabs({ action: "close", index: i }, threadId);
            } catch {}
          }
          result = await browser.goto({ url: "about:blank" }, threadId);
          break;
        }
        default:
          throw workError("BROWSER_ACTION_UNSUPPORTED");
      }
      if (result && typeof result === "object" && "success" in result && result.success !== true) {
        return c.json(result, 400);
      }
      return c.json(BrowserResponseSchema.parse({ state: await browserState(browser, threadId) }));
    } catch (error) {
      return c.json(
        {
          error: "browser_action_failed",
          message: errorText(error, "浏览器不可用"),
        },
        503,
      );
    }
  },
});

export const browserMouseRoute = registerApiRoute("/work/threads/:threadId/browser/mouse", {
  method: "POST",
  handler: async (c) => {
    const owned = await ownedBrowserThread(c);
    if (!owned) throw workError("THREAD_NOT_FOUND");
    const { browser, threadId } = owned;
    const request = BrowserMouseRequestSchema.safeParse(await c.req.json());
    if (!request.success) {
      throw workError("VALIDATION_FAILED", { text: request.error.issues[0]?.message });
    }
    try {
      await browser.injectMouseEvent(request.data, threadId);
    } catch (error) {
      if (!isClosedBrowserContextError(error)) throw error;
    }
    return c.json(BrowserOkResultSchema.parse({ ok: true }));
  },
});

export const browserKeyboardRoute = registerApiRoute("/work/threads/:threadId/browser/keyboard", {
  method: "POST",
  handler: async (c) => {
    const owned = await ownedBrowserThread(c);
    if (!owned) throw workError("THREAD_NOT_FOUND");
    const { browser, threadId } = owned;
    const request = BrowserKeyboardRequestSchema.safeParse(await c.req.json());
    if (!request.success) {
      throw workError("VALIDATION_FAILED", { text: request.error.issues[0]?.message });
    }
    try {
      await browser.injectKeyboardEvent(request.data, threadId);
    } catch (error) {
      if (!isClosedBrowserContextError(error)) throw error;
    }
    return c.json(BrowserOkResultSchema.parse({ ok: true }));
  },
});

export const browserKeyboardBatchRoute = registerApiRoute(
  "/work/threads/:threadId/browser/keyboard/batch",
  {
    method: "POST",
    handler: async (c) => {
      const owned = await ownedBrowserThread(c);
      if (!owned) throw workError("THREAD_NOT_FOUND");
      const { browser, threadId } = owned;
      const request = BrowserKeyboardBatchRequestSchema.safeParse(await c.req.json());
      if (!request.success) {
        throw workError("VALIDATION_FAILED", { text: request.error.issues[0]?.message });
      }
      try {
        for (const event of request.data.events) {
          await browser.injectKeyboardEvent(event, threadId);
        }
      } catch (error) {
        if (!isClosedBrowserContextError(error)) throw error;
      }
      return c.json(BrowserOkResultSchema.parse({ ok: true }));
    },
  },
);

export const browserCloseRoute = registerApiRoute("/work/threads/:threadId/browser", {
  method: "DELETE",
  handler: async (c) => {
    const owned = await ownedBrowserThread(c);
    if (!owned) throw workError("THREAD_NOT_FOUND");
    const { browser, threadId, resourceId } = owned;
    const key = `${resourceId}:${threadId}`;
    const pendingInit = browserInitPromises.get(key);
    if (pendingInit) {
      try {
        await pendingInit;
      } catch {}
    }
    try {
      browser.markBrowserCloseReason("user", threadId);
      const closePromise = browser.closeThreadSession(threadId);
      browserClosingPromises.set(key, closePromise);
      try {
        await closePromise;
      } finally {
        if (browserClosingPromises.get(key) === closePromise) {
          browserClosingPromises.delete(key);
        }
      }
    } finally {
      if (!browser.hasThreadSession(threadId)) browserClosingPromises.delete(key);
    }
    return c.json(BrowserOkResultSchema.parse({ ok: true }));
  },
});

export const browserConfigRoute = registerApiRoute("/work/browser/config", {
  method: "GET",
  handler: async (c) => {
    const resourceId = c.get("requestContext").get(MASTRA_RESOURCE_ID_KEY) as string;
    return c.json(await getBrowserConfig(resourceId));
  },
});

export const saveBrowserConfigRoute = registerApiRoute("/work/browser/config", {
  method: "POST",
  handler: async (c) => {
    try {
      const resourceId = c.get("requestContext").get(MASTRA_RESOURCE_ID_KEY) as string;
      return c.json(await saveBrowserConfig(await c.req.json(), resourceId));
    } catch (error) {
      return c.json({ error: errorText(error, "浏览器配置无效") }, 400);
    }
  },
});

export const browserRoutes = [
  browserConfigRoute,
  saveBrowserConfigRoute,
  browserStateRoute,
  browserScreencastRoute,
  browserNavigateRoute,
  browserActionRoute,
  browserMouseRoute,
  browserKeyboardRoute,
  browserKeyboardBatchRoute,
  browserCloseRoute,
];
