/**
 * 浏览器自动化路由(/work/browser/*):导航 / 点击 / 输入 / 截图 / 标签页控制。
 * 官方文档:docs/en/docs/browser.mdx、docs/en/reference/browser/;
 * 运行时实例见 src/mastra/agents/browser.ts(AgentBrowser)。
 */
import type { KeyboardEventParams, MouseEventParams } from "@mastra/core/browser";
import { type ContextWithMastra, registerApiRoute } from "@mastra/core/server";
import { workBrowser } from "../agents";
import { errorText, workError } from "../errors";
import { getOwnedThread, getWorkMemoryForThread, isTrustedLocalRequest } from "./threads/shared";

async function ownedBrowserThread(c: ContextWithMastra) {
  if (!isTrustedLocalRequest(c)) return null;
  const threadId = c.req.param("threadId");
  const resourceId = c.req.query("resourceId");
  if (!threadId || !resourceId) return null;
  const memory = await getWorkMemoryForThread(c.get("requestContext"), threadId, resourceId);
  return (await getOwnedThread(memory, threadId, resourceId)) ? threadId : null;
}

function browserState(threadId: string) {
  return Promise.all([
    workBrowser.getBrowserState(threadId),
    workBrowser.getCurrentUrl(threadId),
  ]).then(([state, currentUrl]) => ({
    active: workBrowser.hasThreadSession(threadId),
    status: workBrowser.status,
    currentUrl,
    tabs: state?.tabs ?? [],
    activeTabIndex: state?.activeTabIndex ?? 0,
    closeReason: state?.closeReason,
    activeUrlChangeSource: state?.activeUrlChangeSource,
  }));
}

/** 线程浏览器的首页:首次就绪与新开标签都落在这里 */
const BROWSER_HOME_URL = "https://www.bing.com";

// 首次打开线程时,浏览器 SSE 与标签操作可能同时触发 ensureReady + goto。
// Playwright 对同一个 Page 的并发导航会主动取消其中一次并返回 ERR_ABORTED;
// 按线程串行化这段初始化,避免把正常的重复初始化误报成操作失败。
const browserInitPromises = new Map<string, Promise<boolean>>();

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
  threadId: string,
  url: string = BROWSER_HOME_URL,
): Promise<boolean> {
  // AgentBrowser 的 thread scope 由 current thread 决定;先显式创建该线程
  // 的 Playwright 会话,再读取状态。仅调用 goto() 会把启动失败伪装成“无标签”。
  workBrowser.setCurrentThread(threadId);
  await workBrowser.ensureReady();
  const state = await workBrowser.getBrowserState(threadId);
  if (state?.tabs.some((tab) => tab.url && tab.url !== "about:blank")) return false;
  const result = await workBrowser.goto({ url }, threadId);
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
  threadId: string,
  url: string = BROWSER_HOME_URL,
): Promise<boolean> {
  const pending = browserInitPromises.get(threadId);
  if (pending) {
    await pending;
    const state = await workBrowser.getBrowserState(threadId);
    return !state?.tabs.some((tab) => tab.url && tab.url !== "about:blank");
  }

  const initialization = ensureBrowserTabOnce(threadId, url);
  browserInitPromises.set(threadId, initialization);
  try {
    return await initialization;
  } finally {
    if (browserInitPromises.get(threadId) === initialization) {
      browserInitPromises.delete(threadId);
    }
  }
}

export const browserStateRoute = registerApiRoute("/work/threads/:threadId/browser", {
  method: "GET",
  handler: async (c) => {
    const threadId = await ownedBrowserThread(c);
    if (!threadId) throw workError("THREAD_NOT_FOUND");
    return c.json(await browserState(threadId));
  },
});

/** SSE 桥接 Mastra ScreencastStream；断开时只停画面订阅，不关闭线程浏览器。 */
export const browserScreencastRoute = registerApiRoute(
  "/work/threads/:threadId/browser/screencast",
  {
    method: "GET",
    handler: async (c) => {
      const threadId = await ownedBrowserThread(c);
      if (!threadId) throw workError("THREAD_NOT_FOUND");
      let screencast: Awaited<ReturnType<typeof workBrowser.startScreencast>>;
      try {
        await ensureBrowserTab(threadId);
        screencast = await workBrowser.startScreencast({
          format: "jpeg",
          quality: 78,
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
    const threadId = await ownedBrowserThread(c);
    if (!threadId) throw workError("THREAD_NOT_FOUND");
    const body = (await c.req.json()) as { url?: string };
    const input = body.url?.trim();
    if (!input) throw workError("VALIDATION_FAILED", { text: "url is required" });
    const url = /^[a-z][a-z\d+.-]*:/i.test(input) ? input : `https://${input}`;
    try {
      // 首次就绪时直接落到目标地址,省掉一次多余的首页往返
      const navigated = await ensureBrowserTab(threadId, url);
      const result = navigated ? { success: true } : await workBrowser.goto({ url }, threadId);
      if (!("success" in result) || result.success !== true) return c.json(result, 400);
      return c.json({ ...result, state: await browserState(threadId) });
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
    const threadId = await ownedBrowserThread(c);
    if (!threadId) throw workError("THREAD_NOT_FOUND");
    const body = (await c.req.json()) as {
      action?: "back" | "forward" | "reload" | "new-tab" | "switch-tab" | "close-tab";
      index?: number;
      url?: string;
    };
    try {
      let result: unknown;
      switch (body.action) {
        case "back":
          result = await workBrowser.back(threadId);
          break;
        case "forward":
          result = await workBrowser.evaluate({ script: "history.forward()" }, threadId);
          break;
        case "reload":
          result = await workBrowser.evaluate({ script: "location.reload()" }, threadId);
          break;
        case "new-tab": {
          // 浏览器尚未就绪时,首次导航已经把那个空白初始页变成了目标页面,
          // 此时再 tabs({action:"new"}) 只会凭空多出一个标签。
          // 未指定 url 也要落在首页 —— tabs() 收到 undefined 会开出 about:blank。
          const navigated = await ensureBrowserTab(threadId, body.url);
          result = navigated
            ? { success: true }
            : await workBrowser.tabs(
                { action: "new", url: body.url ?? BROWSER_HOME_URL },
                threadId,
              );
          break;
        }
        case "switch-tab":
        case "close-tab":
          if (!Number.isInteger(body.index))
            throw workError("VALIDATION_FAILED", { text: "index is required" });
          result = await workBrowser.tabs(
            { action: body.action === "switch-tab" ? "switch" : "close", index: body.index },
            threadId,
          );
          break;
        default:
          throw workError("BROWSER_ACTION_UNSUPPORTED");
      }
      if (result && typeof result === "object" && "success" in result && result.success !== true) {
        return c.json(result, 400);
      }
      return c.json({ result, state: await browserState(threadId) });
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
    const threadId = await ownedBrowserThread(c);
    if (!threadId) throw workError("THREAD_NOT_FOUND");
    await workBrowser.injectMouseEvent((await c.req.json()) as MouseEventParams, threadId);
    return c.json({ ok: true });
  },
});

export const browserKeyboardRoute = registerApiRoute("/work/threads/:threadId/browser/keyboard", {
  method: "POST",
  handler: async (c) => {
    const threadId = await ownedBrowserThread(c);
    if (!threadId) throw workError("THREAD_NOT_FOUND");
    await workBrowser.injectKeyboardEvent((await c.req.json()) as KeyboardEventParams, threadId);
    return c.json({ ok: true });
  },
});

export const browserCloseRoute = registerApiRoute("/work/threads/:threadId/browser", {
  method: "DELETE",
  handler: async (c) => {
    const threadId = await ownedBrowserThread(c);
    if (!threadId) throw workError("THREAD_NOT_FOUND");
    workBrowser.markBrowserCloseReason("user", threadId);
    await workBrowser.closeThreadSession(threadId);
    return c.json({ ok: true });
  },
});

export const browserRoutes = [
  browserStateRoute,
  browserScreencastRoute,
  browserNavigateRoute,
  browserActionRoute,
  browserMouseRoute,
  browserKeyboardRoute,
  browserCloseRoute,
];
