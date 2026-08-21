import type { KeyboardEventParams, MouseEventParams } from "@mastra/core/browser";
import { type ContextWithMastra, registerApiRoute } from "@mastra/core/server";
import { workBrowser } from "../../agents";
import { getOwnedThread, getWorkMemory, isTrustedLocalRequest } from "./threads/shared";

async function ownedBrowserThread(c: ContextWithMastra) {
  if (!isTrustedLocalRequest(c)) return null;
  const threadId = c.req.param("threadId");
  const resourceId = c.req.query("resourceId");
  if (!threadId || !resourceId) return null;
  const memory = await getWorkMemory();
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

async function ensureBrowserTab(threadId: string): Promise<void> {
  // AgentBrowser 的 thread scope 由 current thread 决定;先显式创建该线程
  // 的 Playwright 会话,再读取状态。仅调用 goto() 会把启动失败伪装成“无标签”。
  workBrowser.setCurrentThread(threadId);
  await workBrowser.ensureReady();
  const state = await workBrowser.getBrowserState(threadId);
  if (!state || state.tabs.length === 0) {
    const result = await workBrowser.goto({ url: "about:blank" }, threadId);
    if (!("success" in result) || result.success !== true) {
      throw new Error(
        "message" in result && typeof result.message === "string"
          ? result.message
          : "Browser tab could not be created",
      );
    }
  }
}

export const browserStateRoute = registerApiRoute("/work/threads/:threadId/browser", {
  method: "GET",
  handler: async (c) => {
    const threadId = await ownedBrowserThread(c);
    if (!threadId) return c.json({ error: "Thread not found" }, 404);
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
      if (!threadId) return c.json({ error: "Thread not found" }, 404);
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
            message: error instanceof Error ? error.message : String(error),
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
          screencast.on("frame", (frame) => send("frame", frame));
          screencast.on("url", (url) => send("url", { url }));
          screencast.on("error", (error) => send("error", { error: error.message }));
          screencast.on("stop", (reason) => {
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
    if (!threadId) return c.json({ error: "Thread not found" }, 404);
    const body = (await c.req.json()) as { url?: string };
    const input = body.url?.trim();
    if (!input) return c.json({ error: "url is required" }, 400);
    const url = /^[a-z][a-z\d+.-]*:/i.test(input) ? input : `https://${input}`;
    try {
      await ensureBrowserTab(threadId);
      const result = await workBrowser.goto({ url }, threadId);
      if (!("success" in result) || result.success !== true) return c.json(result, 400);
      return c.json({ ...result, state: await browserState(threadId) });
    } catch (error) {
      return c.json(
        {
          error: "browser_unavailable",
          message: error instanceof Error ? error.message : String(error),
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
    if (!threadId) return c.json({ error: "Thread not found" }, 404);
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
        case "new-tab":
          await ensureBrowserTab(threadId);
          result = await workBrowser.tabs({ action: "new", url: body.url }, threadId);
          break;
        case "switch-tab":
        case "close-tab":
          if (!Number.isInteger(body.index)) return c.json({ error: "index is required" }, 400);
          result = await workBrowser.tabs(
            { action: body.action === "switch-tab" ? "switch" : "close", index: body.index },
            threadId,
          );
          break;
        default:
          return c.json({ error: "Unsupported browser action" }, 400);
      }
      if (result && typeof result === "object" && "success" in result && result.success !== true) {
        return c.json(result, 400);
      }
      return c.json({ result, state: await browserState(threadId) });
    } catch (error) {
      return c.json(
        {
          error: "browser_unavailable",
          message: error instanceof Error ? error.message : String(error),
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
    if (!threadId) return c.json({ error: "Thread not found" }, 404);
    await workBrowser.injectMouseEvent((await c.req.json()) as MouseEventParams, threadId);
    return c.json({ ok: true });
  },
});

export const browserKeyboardRoute = registerApiRoute("/work/threads/:threadId/browser/keyboard", {
  method: "POST",
  handler: async (c) => {
    const threadId = await ownedBrowserThread(c);
    if (!threadId) return c.json({ error: "Thread not found" }, 404);
    await workBrowser.injectKeyboardEvent((await c.req.json()) as KeyboardEventParams, threadId);
    return c.json({ ok: true });
  },
});

export const browserCloseRoute = registerApiRoute("/work/threads/:threadId/browser", {
  method: "DELETE",
  handler: async (c) => {
    const threadId = await ownedBrowserThread(c);
    if (!threadId) return c.json({ error: "Thread not found" }, 404);
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
