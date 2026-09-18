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
  const resourceId = c.req.query("resourceId");
  if (!threadId || !resourceId) return null;
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
      const realTabs = rawTabs.filter((tab) => tab.url && tab.url !== "about:blank");
      const hasSession = browser.hasThreadSession(threadId);
      return BrowserStateSchema.parse({
        active: hasSession && realTabs.length > 0,
        status: browser.status,
        currentUrl: currentUrl === "about:blank" ? null : currentUrl,
        tabs: realTabs,
        activeTabIndex: state?.activeTabIndex ?? 0,
        closeReason: state?.closeReason,
        activeUrlChangeSource: state?.activeUrlChangeSource,
      });
    },
  );
}

/** 线程浏览器的首页:首次就绪与新开标签都落在这里 */
const BROWSER_HOME_URL = "https://www.bing.com";

function isAgentBrowser(browser: WorkBrowser): browser is Extract<WorkBrowser, { goto: unknown }> {
  return "goto" in browser;
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
 * 确保线程浏览器就绪,且有一个**已导航**的标签。返回 true 表示本次刚完成首次导航
 * (调用方据此判断还要不要再开标签 / 再导航一次)。
 *
 * 不能只数标签个数:ensureReady() 会为线程建好 Playwright context 和它的初始页,
 * 而那个初始页是 about:blank —— 个数因此永远不为 0,首页导航被整个跳过,面板里
 * 就留下一个空白页。空白页不算"已有标签",直接复用它完成导航(goto 作用于当前
 * 活动页,所以不会多出一个标签)。
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
            error: "browser_unavailable",
            message: errorText(error, "浏览器不可用"),
          },
          503,
        );
      }

      const encoder = new TextEncoder();
      let disposed = false;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const send = (event: string, value: unknown) => {
            if (disposed) return;
            controller.enqueue(
              encoder.encode(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`),
            );
          };
          send("state", { active: true });
          screencast.on("frame", (frame: unknown) => send("frame", frame));
          screencast.on("url", (url: unknown) => send("url", { url }));
          screencast.on("error", (error: { message?: string }) =>
            send("error", { error: error.message }),
          );
          screencast.on("stop", (reason: unknown) => {
            if (disposed) return;
            send("stop", { reason });
            disposed = true;
            controller.close();
          });
        },
        async cancel() {
          disposed = true;
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
          error: "browser_unavailable",
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
            // 关掉的是唯一的标签:不要冷销毁整个 Chromium 进程,而是导航到 about:blank。
            // about:blank 会被 browserState 过滤掉(视为无标签),同时保留 Chromium 温暖就绪。
            // 下次用户再开标签时是 ~50ms 热加载,而不是 3 秒冷启动!
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
          error: "browser_unavailable",
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
