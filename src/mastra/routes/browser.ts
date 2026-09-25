/**
 * 浏览器自动化路由(/work/browser/*):导航 / 点击 / 输入 / 截图 / 标签页控制。
 * 官方文档:docs/en/docs/browser.mdx、docs/en/reference/browser/;
 * 运行时实例见 src/mastra/agents/browser.ts(AgentBrowser)。
 */
import { MASTRA_RESOURCE_ID_KEY } from "@mastra/core/request-context";
import { type ContextWithMastra, registerApiRoute } from "@mastra/core/server";
import {
  BrowserActionRequestSchema,
  BrowserKeyboardRequestSchema,
  BrowserMouseRequestSchema,
  BrowserNavigateRequestSchema,
  BrowserOkResultSchema,
  BrowserResponseSchema,
  BrowserStateSchema,
} from "../../shared/browser-contract";
import {
  getBrowserConfig,
  getBrowserForResource,
  saveBrowserConfig,
  type WorkBrowser,
} from "../agents/browser";
import { errorText, workError } from "../errors";
import { getOwnedThread, getWorkMemoryForThread, isTrustedLocalRequest } from "./threads/shared";

async function ownedBrowserThread(c: ContextWithMastra) {
  if (!isTrustedLocalRequest(c)) return null;
  const threadId = c.req.param("threadId");
  const resourceId = c.get("requestContext").get(MASTRA_RESOURCE_ID_KEY);
  if (!threadId || typeof resourceId !== "string" || !resourceId.trim()) return null;
  const memory = await getWorkMemoryForThread(c.get("requestContext"), threadId, resourceId);
  if (!(await getOwnedThread(memory, threadId, resourceId))) return null;
  return { threadId, resourceId, browser: await getBrowserForResource(resourceId) };
}

function browserState(
  browser: Awaited<ReturnType<typeof getBrowserForResource>>,
  threadId: string,
) {
  return Promise.all([browser.getBrowserState(threadId), browser.getCurrentUrl(threadId)]).then(
    ([state, currentUrl]) => {
      const rawTabs = state?.tabs ?? [];
      const tabs = rawTabs.filter((tab) => typeof tab.url === "string");
      const hasSession = browser.hasThreadSession(threadId);
      return BrowserStateSchema.parse({
        // about:blank 是用户可见的初始标签,不是“浏览器坏了/没有页面”。
        active: hasSession && tabs.length > 0,
        status: browser.status,
        currentUrl: currentUrl === "about:blank" ? null : currentUrl,
        tabs,
        activeTabIndex: state?.activeTabIndex ?? 0,
        closeReason: state?.closeReason,
        activeUrlChangeSource: state?.activeUrlChangeSource,
      });
    },
  );
}

/** 线程浏览器的初始页:由用户或 Agent 显式导航,不主动访问第三方站点。 */
const BROWSER_HOME_URL = "about:blank";

function isAgentBrowser(browser: WorkBrowser): browser is Extract<WorkBrowser, { goto: unknown }> {
  return "goto" in browser;
}

function isScreenshotBrowser(
  browser: WorkBrowser,
): browser is Extract<WorkBrowser, { screenshot: unknown }> {
  return "screenshot" in browser && typeof browser.screenshot === "function";
}

function browserGoto(browser: WorkBrowser, url: string, threadId: string) {
  return isAgentBrowser(browser)
    ? browser.goto({ url }, threadId)
    : browser.navigate({ url }, threadId);
}

function browserTabs(browser: WorkBrowser, input: unknown, threadId: string) {
  return browser.tabs(input as never, threadId);
}

// 首次打开线程时,浏览器 SSE 与标签操作可能同时触发 ensureReady + goto。
// Playwright 对同一个 Page 的并发导航会主动取消其中一次并返回 ERR_ABORTED;
// 按线程串行化这段初始化,避免把正常的重复初始化误报成操作失败。
const browserInitPromises = new Map<string, Promise<boolean>>();
const browserClosingPromises = new Map<string, Promise<void>>();

/**
 * 确保线程浏览器就绪,且有一个标签。返回 true 表示本次刚完成首次导航
 * (调用方据此判断还要不要再开标签 / 再导航一次)。
 *
 * about:blank 不是业务页面,但它是有意展示的初始标签。首次导航时直接复用它,
 * 避免打开浏览器面板就把用户带到固定搜索引擎。
 */
async function ensureBrowserTabOnce(
  browser: Awaited<ReturnType<typeof getBrowserForResource>>,
  threadId: string,
  url: string = BROWSER_HOME_URL,
): Promise<boolean> {
  // AgentBrowser 的 thread scope 由 current thread 决定;先显式创建该线程
  // 的 Playwright 会话,再读取状态。仅调用 goto() 会把启动失败伪装成“无标签”。
  browser.setCurrentThread(threadId);
  await browser.ensureReady();
  const state = await browser.getBrowserState(threadId);
  if (state?.tabs.some((tab) => tab.url && tab.url !== "about:blank")) return false;
  const result = await browserGoto(browser, url, threadId);
  if (!("success" in result) || result.success !== true) {
    throw new Error(
      "message" in result && typeof result.message === "string"
        ? result.message
        : "Browser tab could not be created",
    );
  }
  return true;
}

async function ensureBrowserTab(
  browser: Awaited<ReturnType<typeof getBrowserForResource>>,
  resourceId: string,
  threadId: string,
  url: string = BROWSER_HOME_URL,
): Promise<boolean> {
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
    return !state?.tabs.some((tab) => tab.url && tab.url !== "about:blank");
  }

  const initialization = ensureBrowserTabOnce(browser, threadId, url);
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
        browserConfig.viewport === "window"
          ? { width: 1280, height: 720 }
          : browserConfig.viewport;
      let screencast: Awaited<ReturnType<typeof browser.startScreencast>>;
      try {
        await ensureBrowserTab(browser, resourceId, threadId);
        screencast = await browser.startScreencast({
          format: "jpeg",
          quality: 80,
          maxWidth: 1280,
          maxHeight: 720,
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
      let pendingFrame: Uint8Array | undefined;
      const pendingControls: Array<{ event: string; chunk: Uint8Array }> = [];

      const closeIfDrained = () => {
        if (
          !stopped ||
          closed ||
          !controllerRef ||
          pendingFrame ||
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
          if (!pendingFrame) break;
          const frame = pendingFrame;
          pendingFrame = undefined;
          controllerRef.enqueue(frame);
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
              pendingFrame = encoder.encode(
                `event: ${event}\ndata: ${JSON.stringify(value)}\n\n`,
              );
            } else {
              queueControl(event, value);
            }
            flush();
          };
          send("state", { active: true });
          screencast.on("frame", (frame: unknown) => send("frame", frame));
          screencast.on("url", (url: unknown) => send("url", { url }));
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
          if (isScreenshotBrowser(browser)) {
            void browser
              .screenshot({ fullPage: false }, threadId)
              .then((snapshot) => {
                if (disposed || stopped || !("base64" in snapshot)) return;
                send("frame", {
                  data: snapshot.base64,
                  timestamp: Date.now(),
                  viewport: frameViewport,
                });
              })
              .catch(() => {
                // The live screencast remains the primary source; a snapshot
                // failure must not terminate an otherwise healthy stream.
              });
          }
        },
        pull() {
          flush();
        },
        async cancel() {
          disposed = true;
          pendingFrame = undefined;
          pendingControls.length = 0;
          await screencast.stop();
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
      const result = navigated ? { success: true } : await browserGoto(browser, url, threadId);
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
          if (!isAgentBrowser(browser)) throw workError("BROWSER_ACTION_UNSUPPORTED");
          result = await browser.back(threadId);
          break;
        case "forward":
          if (!isAgentBrowser(browser)) throw workError("BROWSER_ACTION_UNSUPPORTED");
          result = await browser.evaluate({ script: "history.forward()" }, threadId);
          break;
        case "reload":
          if (!isAgentBrowser(browser)) throw workError("BROWSER_ACTION_UNSUPPORTED");
          result = await browser.evaluate({ script: "location.reload()" }, threadId);
          break;
        case "new-tab": {
          // 浏览器尚未就绪时,首次导航已经把那个空白初始页变成了目标页面,
          // 此时再 tabs({action:"new"}) 只会凭空多出一个标签。
          // 未指定 url 也要落在首页 —— tabs() 收到 undefined 会开出 about:blank。
          const navigated = await ensureBrowserTab(browser, resourceId, threadId, body.url);
          result = navigated
            ? { success: true }
            : await browserTabs(
                browser,
                { action: "new", url: body.url ?? BROWSER_HOME_URL },
                threadId,
              );
          break;
        }
        case "switch-tab":
          result = await browserTabs(browser, { action: "switch", index: body.index }, threadId);
          break;
        case "close-tab": {
          const currentState = await browser.getBrowserState(threadId);
          const tabs = currentState?.tabs ?? [];
          if (tabs.length <= 1) {
            // 关掉唯一标签时保留一个可见的空白页,避免把浏览器工具误显示成失效。
            result = await browserGoto(browser, "about:blank", threadId);
          } else {
            result = await browserTabs(browser, { action: "close", index: body.index }, threadId);
          }
          break;
        }
        case "reset-tabs": {
          const currentState = await browser.getBrowserState(threadId);
          const count = currentState?.tabs.length ?? 0;
          for (let i = count - 1; i >= 1; i--) {
            try {
              await browserTabs(browser, { action: "close", index: i }, threadId);
            } catch {}
          }
          result = await browserGoto(browser, "about:blank", threadId);
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
    await browser.injectMouseEvent(request.data, threadId);
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
    await browser.injectKeyboardEvent(request.data, threadId);
    return c.json(BrowserOkResultSchema.parse({ ok: true }));
  },
});

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
  browserCloseRoute,
];
