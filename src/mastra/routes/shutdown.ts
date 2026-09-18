/**
 * MastraWork 优雅退出(服务进程侧的唯一实现),POST /work/shutdown。
 *
 * 观察记忆的 observe/reflect 循环与 deleteThread/deleteMessages 的向量清理
 * 都在 Agent 运行返回后于后台继续写库(docs/en/docs/memory/observational-memory.mdx),
 * 退出前必须 await memory.settled() 等落盘完成,否则强杀会截断这些写入。
 * memory.settled() 为 @mastra/memory 的官方落盘屏障。触发通路:
 * 1. HTTP POST /work/shutdown(主通路):dev 态服务进程是 mastra CLI 的孙进程,
 *    Electron 主进程挂在 CLI 上的 IPC/信号根本到不了这里,HTTP 是唯一能穿透
 *    包装链的方式,dev / 打包态、所有平台统一走这条路(主进程的 stopMastra)。
 * 2. IPC message + SIGTERM/SIGINT 兜底:注册在 src/mastra/index.ts。
 */
import { registerApiRoute } from "@mastra/core/server";
import { closeAllBrowsers } from "../agents/browser";
import { settleAllMemory } from "../memory";

/** 落盘上限:超时即退出,不能让退出流程挂住(主进程那边还有强杀兜底) */
const SHUTDOWN_FLUSH_TIMEOUT_MS = 3_000;
/** HTTP 响应写出后再 process.exit,给 socket 缓冲留时间 */
const HTTP_EXIT_DELAY_MS = 200;

let shuttingDown = false;

/**
 * 请求优雅退出:等后台写库落盘(带上限)后退出进程。
 * @param httpExitDelayMs 置 >0 时先延迟再 exit,供 HTTP 路由把响应写出去
 */
export async function requestShutdown(httpExitDelayMs = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await Promise.race([
      Promise.allSettled([settleAllMemory(), closeAllBrowsers()]),
      new Promise((resolve) => setTimeout(resolve, SHUTDOWN_FLUSH_TIMEOUT_MS)),
    ]);
  } catch {
    // 落盘失败不应阻塞退出
  }
  setTimeout(() => process.exit(0), httpExitDelayMs).unref?.();
}

/**
 * 安全:令牌由 Electron 主进程启动时随机生成、经环境变量注入子进程链
 * (MASTRA_SHUTDOWN_TOKEN),请求头不匹配一律 404。没有令牌(比如用户在
 * 终端手动跑 mastra dev)时路由禁用,本地任意进程/浏览器页面都无法杀掉后端。
 */
export const shutdownRoute = registerApiRoute("/work/shutdown", {
  method: "POST",
  handler: async (c) => {
    const token = process.env.MASTRA_SHUTDOWN_TOKEN;
    if (!token || c.req.header("x-shutdown-token") !== token) {
      // 令牌不匹配的伪装 404:刻意保持最简形状,不给探测方任何额外信息
      return c.json({ error: "not found" }, 404);
    }
    // 先等 memory.settled() 落盘,响应写出后再延迟退出
    await requestShutdown(HTTP_EXIT_DELAY_MS);
    return c.json({ ok: true });
  },
});

/** Bind desktop process shutdown signals once at the composition root. */
export function registerShutdownHandlers(): void {
  process.on("message", (message: unknown) => {
    if (
      typeof message === "object" &&
      message !== null &&
      (message as { type?: unknown }).type === "mastra-work:shutdown"
    )
      void requestShutdown();
  });
  process.on("SIGTERM", () => void requestShutdown());
  process.on("SIGINT", () => void requestShutdown());
}
