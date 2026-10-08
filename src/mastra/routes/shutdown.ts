/**
 * MastraWork 优雅退出(服务进程侧的唯一实现),POST /work/shutdown。
 *
 * 观察记忆的 observe/reflect 循环与 deleteThread/deleteMessages 的向量清理
 * 都在 Agent 运行返回后于后台继续写库(docs/en/docs/memory/observational-memory.mdx),
 * 停止新请求和生产者,中止并等待在途运行,再 await memory.settled()、关闭资源。
 * memory.settled() 为 @mastra/memory 的官方落盘屏障。触发通路:
 * 1. HTTP POST /work/shutdown(主通路):dev 态服务进程是 mastra CLI 的孙进程,
 *    Electron 主进程挂在 CLI 上的 IPC/信号根本到不了这里,HTTP 是唯一能穿透
 *    包装链的方式,dev / 打包态、所有平台统一走这条路(主进程的 stopMastra)。
 * 2. IPC message + SIGTERM/SIGINT 兜底:注册在 src/mastra/index.ts。
 */
import { setTimeout as delay } from "node:timers/promises";
import type { Session } from "@mastra/core/agent-controller";
import type { Mastra } from "@mastra/core/mastra";
import { type ContextWithMastra, registerApiRoute } from "@mastra/core/server";
import { closeAllBrowsers } from "../agents/browser";
import { isDesktopControlRequest } from "../auth";
import { closeComputerConnections } from "../connections/computer";
import { closeMcpConnections } from "../connections/mcp";
import { workPollingSignals, workWebhookSignals } from "../harness/signals";
import { closeMemoryVector, settleAllMemory } from "../memory/memory-runtime";
import { closeLibraryVector, libraryIndexSignals } from "../rag/document/indexing";
import { stopWorkspaceCleanup } from "../workspace/workspace-manager";
import { drainTeamRuns } from "./team-runs";

/** 落盘上限:超时即退出,不能让退出流程挂住(主进程那边还有强杀兜底) */
const SHUTDOWN_FLUSH_TIMEOUT_MS = 3_000;
/** HTTP 响应写出后再 process.exit,给 socket 缓冲留时间 */
const HTTP_EXIT_DELAY_MS = 200;

let shuttingDown = false;
let runtimeMastra: Mastra | undefined;
let shutdownPromise: Promise<boolean> | undefined;
const pendingRequests = new Set<Promise<void>>();
const sessions = new Set<Session>();

/** Track accepted HTTP work, excluding the control request that waits for its completion. */
export async function shutdownRequestMiddleware(c: ContextWithMastra, next: () => Promise<void>) {
  if (c.req.path === "/work/shutdown") return next();
  if (shuttingDown) return c.json({ error: "Service is shutting down" }, 503);
  const pending = next();
  pendingRequests.add(pending);
  try {
    await pending;
  } finally {
    pendingRequests.delete(pending);
  }
}

async function drainRuns(mastra: Mastra, signal: AbortSignal): Promise<void> {
  for (;;) {
    signal.throwIfAborted();
    let active = pendingRequests.size > 0;
    for (const session of sessions) {
      if (!session.run.isRunning() && !session.stream.isActive() && session.run.getRunId() === null)
        continue;
      active = true;
      session.abort();
    }
    for (const agent of Object.values(mastra.listAgents())) {
      for (const run of agent.listActiveThreadRuns()) {
        active = true;
        agent.abortThreadStream({ ...run, clearPendingSignals: true });
      }
    }
    await drainTeamRuns(mastra);
    if (!active) return;
    await delay(20, undefined, { signal });
  }
}

async function drainAndClose(mastra: Mastra, signal: AbortSignal): Promise<void> {
  workPollingSignals.stop();
  workWebhookSignals.stop();
  libraryIndexSignals.stop();
  await Promise.all([
    stopWorkspaceCleanup(),
    mastra.stopWorkers({ drainTimeout: SHUTDOWN_FLUSH_TIMEOUT_MS }),
    mastra.backgroundTaskManager?.shutdown({ deadline: Date.now() + SHUTDOWN_FLUSH_TIMEOUT_MS }),
    ...Object.values(mastra.listAgentControllers()).map((controller) => controller.stopIntervals()),
    workPollingSignals.settled(),
    drainRuns(mastra, signal),
  ]);
  await libraryIndexSignals.settled();
  // Worker/request preparation and pending notifications may have started a final run.
  await drainRuns(mastra, signal);
  await settleAllMemory();
  signal.throwIfAborted();
  await Promise.all([
    closeMemoryVector(),
    closeLibraryVector(),
    closeAllBrowsers(),
    closeComputerConnections(),
    closeMcpConnections(),
  ]);
  signal.throwIfAborted();
  await mastra.shutdown({ drainTimeout: 0 });
}

/**
 * 请求优雅退出:等后台写库落盘(带上限)后退出进程。
 * @param httpExitDelayMs 置 >0 时先延迟再 exit,供 HTTP 路由把响应写出去
 */
function requestShutdown(httpExitDelayMs = 0): Promise<boolean> {
  if (shutdownPromise) return shutdownPromise;
  shuttingDown = true;
  shutdownPromise = (async () => {
    let complete = false;
    const timeout = AbortSignal.timeout(SHUTDOWN_FLUSH_TIMEOUT_MS);
    try {
      if (!runtimeMastra) throw new Error("Mastra shutdown lifecycle is not registered");
      await Promise.race([
        drainAndClose(runtimeMastra, timeout),
        new Promise<never>((_, reject) =>
          timeout.addEventListener("abort", () => reject(timeout.reason), { once: true }),
        ),
      ]);
      complete = true;
    } catch (error) {
      // A timeout exits without closing connections underneath work still in flight.
      runtimeMastra?.getLogger().error("Graceful shutdown did not complete", { error });
    }
    setTimeout(() => process.exit(complete ? 0 : 1), httpExitDelayMs).unref();
    return complete;
  })();
  return shutdownPromise;
}

/**
 * 安全:令牌由 Electron 主进程启动时随机生成、经环境变量注入子进程链
 * (MASTRA_DESKTOP_CONTROL_TOKEN),请求头不匹配一律 404。没有令牌(比如用户在
 * 终端手动跑 mastra dev)时路由禁用,本地任意进程/浏览器页面都无法杀掉后端。
 */
export const shutdownRoute = registerApiRoute("/work/shutdown", {
  method: "POST",
  handler: async (c) => {
    if (!isDesktopControlRequest(c.req.raw)) {
      // 令牌不匹配的伪装 404:刻意保持最简形状,不给探测方任何额外信息
      return c.json({ error: "not found" }, 404);
    }
    const complete = await requestShutdown(HTTP_EXIT_DELAY_MS);
    return c.json({ ok: complete }, complete ? 200 : 503);
  },
});

/** Bind desktop process shutdown signals once at the composition root. */
export function registerShutdownHandlers(mastra: Mastra): void {
  runtimeMastra = mastra;
  for (const controller of Object.values(mastra.listAgentControllers())) {
    controller.onSessionCreated((session) => {
      sessions.add(session);
    });
    controller.onSessionDeleted((session) => {
      sessions.delete(session);
    });
  }
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
