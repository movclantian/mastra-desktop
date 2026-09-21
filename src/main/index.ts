/**
 * Electron 主进程:窗口生命周期、Mastra 服务子进程管理(启动 / 健康检查 /
 * 优雅退出 / 残留清理)、终端 IPC 桥与存储位置迁移等系统能力 IPC。
 */
import type { ChildProcess } from "node:child_process";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { electronApp, is, optimizer } from "@electron-toolkit/utils";
import { app, BrowserWindow, dialog, ipcMain, safeStorage, screen, session, shell } from "electron";
import icon from "../../resources/icon.png?asset";
import {
  CREDENTIAL_CHANNELS,
  CredentialDeleteRequestSchema,
  CredentialDeleteResultSchema,
  CredentialPutRequestSchema,
  CredentialPutResultSchema,
} from "../shared/credential-contract";
import {
  FILESYSTEM_CHANNELS,
  OpenDirectoryRequestSchema,
  OpenDirectoryResultSchema,
  PickDirectoryRequestSchema,
  PickDirectoryResultSchema,
} from "../shared/filesystem-contract";
import {
  GetProxyRequestSchema,
  GetProxyResultSchema,
  PROXY_CHANNELS,
  type ProxyConfig,
  type ProxyTestResult,
  SetProxyRequestSchema,
  SetProxyResultSchema,
  TestProxyRequestSchema,
  TestProxyResultSchema,
} from "../shared/proxy-contract";
import {
  MigrateStorageRequestSchema,
  MigrateStorageResultSchema,
  ResetAppDataRequestSchema,
  ResetAppDataResultSchema,
  STORAGE_CHANNELS,
} from "../shared/storage-contract";
import {
  TERMINAL_CLOSE_CHANNEL,
  TERMINAL_CREATE_CHANNEL,
  TERMINAL_EVENT_CHANNEL,
  TERMINAL_RESIZE_CHANNEL,
  TERMINAL_WRITE_CHANNEL,
  TerminalCreateRequestSchema,
  TerminalCreateResultSchema,
  TerminalResizeRequestSchema,
  TerminalSessionIdSchema,
  TerminalWriteRequestSchema,
} from "../shared/terminal-contract";
import { SetMinimumWidthRequestSchema, WINDOW_CHANNELS } from "../shared/window-contract";
import {
  type DetectedIde,
  DetectIdesRequestSchema,
  DetectIdesResultSchema,
  ExternalUrlSchema,
  OpenExternalRequestSchema,
  OpenExternalResultSchema,
  OpenInAppRequestSchema,
  OpenInAppResultSchema,
  WORKSPACE_CHANNELS,
} from "../shared/workspace-contract";
import { CredentialBroker, CredentialVault } from "./credential-vault";
import { TerminalSessionRuntime } from "./terminal";

const MASTRA_SERVER_URL = "http://localhost:4111";
const MASTRA_PORT = 4111;
const HEALTH_CHECK_INTERVAL_MS = 500;
const HEALTH_CHECK_TIMEOUT_MS = 120_000;

const MASTRA_SHUTDOWN_ENDPOINT = `${MASTRA_SERVER_URL}/work/shutdown`;
/**
 * 优雅退出令牌:每次启动随机生成,经环境变量随 spawn 链传给服务进程
 * (dev 态 mastra CLI 的服务孙进程会继承 env),/work/shutdown 按请求头校验。
 * 没有令牌随机进程/网页(服务开了 CORS)就杀不掉我们的后端。
 */
const MASTRA_SHUTDOWN_TOKEN = randomUUID();
/** 与服务端落盘上限(SHUTDOWN_FLUSH_TIMEOUT_MS=3s)+ 响应回写时间对应 */
const HTTP_SHUTDOWN_TIMEOUT_MS = 4_500;
/** 强杀(taskkill /T / SIGKILL)后等待进程树退出的上限 */
const FORCE_KILL_WAIT_MS = 3_000;
/** 优雅退出通路生效的等待窗口:HTTP 之外的兜底通路发出后等这么久 */
const GRACEFUL_EXIT_WAIT_MS = 1_500;

/**
 * 优雅退出协议:消息名必须与 src/mastra/index.ts 的 SHUTDOWN_MESSAGE 一致。
 * 打包态主进程 spawn 的就是服务 ESM 入口,IPC 直达(兜底通路)。
 */
const MASTRA_SHUTDOWN_MESSAGE = "mastra-work:shutdown";

const execFileAsync = promisify(execFile);
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 解析服务进程的出站代理地址(供 spawn 时以环境变量注入)。
 * 显式代理环境变量优先;否则用 Chromium 官方的 session.resolveProxy 解析系统代理
 * (Windows/macOS/Linux 统一走系统配置,PAC 脚本也由 Chromium 求值),
 * 避免在服务进程里手工读注册表/scutil —— 服务端只认环境变量。
 *
 * 返回 undefined = 直连:未配置代理、代理已关闭(DIRECT)、不受支持的 SOCKS4
 * 代理,或系统代理规则解析失败。
 */
function getProxyConfigFile(): string {
  const defaultDir = join(homedir(), ".mastrawork");
  return join(defaultDir, "proxy-config.json");
}

async function readAppProxyConfig(): Promise<ProxyConfig> {
  try {
    const file = getProxyConfigFile();
    const content = await readFile(file, "utf-8");
    return GetProxyResultSchema.parse(JSON.parse(content));
  } catch {
    /* 默认跟随系统代理 */
  }
  return { mode: "system" };
}

async function writeAppProxyConfig(config: ProxyConfig): Promise<void> {
  const file = getProxyConfigFile();
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(config, null, 2), "utf-8");
}

async function resolveOutboundProxyUrl(): Promise<string | undefined> {
  const config = await readAppProxyConfig();
  if (config.mode === "direct") {
    return undefined;
  }
  if (config.mode === "manual") return config.url;
  const explicit = (
    process.env.HTTPS_PROXY ??
    process.env.https_proxy ??
    process.env.HTTP_PROXY ??
    process.env.http_proxy ??
    ""
  ).trim();
  if (explicit) return withProxyScheme(explicit, "http");
  return resolveSystemProxyUrl();
}

async function applySessionProxy(config: ProxyConfig): Promise<string | undefined> {
  await app.whenReady();
  let outboundProxy: string | undefined;
  if (config.mode === "direct") {
    await session.defaultSession.setProxy({ mode: "direct" });
    outboundProxy = undefined;
  } else if (config.mode === "manual") {
    await session.defaultSession.setProxy({ proxyRules: config.url });
    outboundProxy = config.url;
  } else {
    await session.defaultSession.setProxy({ mode: "system" });
    outboundProxy = await resolveSystemProxyUrl();
  }

  if (outboundProxy) {
    process.env.HTTPS_PROXY = outboundProxy;
    process.env.HTTP_PROXY = outboundProxy;
    process.env.https_proxy = outboundProxy;
    process.env.http_proxy = outboundProxy;
  } else {
    for (const key of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]) {
      delete process.env[key];
    }
  }

  // 若 Mastra 服务在线，同步通知动态变更 Dispatcher
  if (await isServerUp(300)) {
    try {
      await fetch(`${MASTRA_SERVER_URL}/work/proxy`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-shutdown-token": MASTRA_SHUTDOWN_TOKEN,
        },
        body: JSON.stringify({ mode: config.mode, url: outboundProxy }),
        signal: AbortSignal.timeout(1_500),
      });
    } catch {
      /* 静默忽略通知失败 */
    }
  }
  return outboundProxy;
}

async function testProxyConnectivity(proxyUrl?: string): Promise<ProxyTestResult> {
  await app.whenReady();
  const testUrl = "https://models.dev/api.json";
  const start = Date.now();
  try {
    const testSession = session.fromPartition(`proxy-test-${Date.now()}`);
    if (proxyUrl?.trim()) {
      await testSession.setProxy({ proxyRules: proxyUrl });
    } else {
      await testSession.setProxy({ mode: "system" });
    }
    const resp = await testSession.fetch(testUrl, {
      method: "GET",
      signal: AbortSignal.timeout(8_000),
    });
    const latencyMs = Date.now() - start;
    if (resp.ok || resp.status < 500) {
      return { ok: true, latencyMs };
    }
    return { ok: false, error: `代理连接异常：HTTP 状态码 ${resp.status} ${resp.statusText}` };
  } catch (error) {
    let msg = error instanceof Error ? error.message : String(error);
    if (msg.includes("ERR_PROXY_CONNECTION_FAILED")) {
      msg = "无法连接至代理服务器，请检查代理端口或服务是否开启";
    } else if (msg.includes("ERR_CONNECTION_REFUSED")) {
      msg = "代理连接被拒绝 (ECONNREFUSED)";
    } else if (
      msg.includes("ERR_TIMED_OUT") ||
      msg.includes("timeout") ||
      msg.includes("Timeout")
    ) {
      msg = "连接超时，代理服务器未在预期时间内响应";
    }
    return { ok: false, error: msg };
  }
}

async function resolveSystemProxyUrl(): Promise<string | undefined> {
  try {
    await app.whenReady();
    // resolveProxy 按 URL 匹配代理规则(PAC 可对不同域名走不同代理),因此必须给一个
    // 目标 URL 作探测;用服务端必然要访问的模型目录域名,匹配到的规则最贴近实际。
    const rules = await session.defaultSession.resolveProxy("https://models.dev/api.json");
    // 形如 "PROXY 127.0.0.1:7890;DIRECT"、"HTTPS gw.corp:443" 或 "DIRECT"
    for (const rule of rules.split(";")) {
      const [rawScheme, host] = rule.trim().split(/\s+/, 2);
      if (!host) continue;
      const scheme = rawScheme.toUpperCase();
      if (scheme === "PROXY") return withProxyScheme(host, "http");
      if (scheme === "HTTPS") return withProxyScheme(host, "https");
      if (scheme === "SOCKS" || scheme === "SOCKS5") return withProxyScheme(host, "socks5");
    }
  } catch (error) {
    console.warn(
      `[proxy] 系统代理解析失败：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return undefined;
}

function withProxyScheme(value: string, fallbackScheme: "http" | "https" | "socks5"): string {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `${fallbackScheme}://${value}`;
}

let mastraProcess: ChildProcess | null = null;
let mastraStartPromise: Promise<void> | null = null;
let isMastraStopping = false;
let mainWindow: BrowserWindow | null = null;
let credentialVault: CredentialVault | null = null;
let credentialBroker: CredentialBroker | null = null;
let appShutdownPromise: Promise<void> | null = null;

function isTrustedRendererUrl(value: string): boolean {
  try {
    const expected = new URL(
      is.dev && process.env.ELECTRON_RENDERER_URL
        ? process.env.ELECTRON_RENDERER_URL
        : pathToFileURL(join(__dirname, "../renderer/index.html")),
    );
    const actual = new URL(value);
    return (
      actual.origin === expected.origin &&
      (expected.protocol !== "file:" || actual.pathname === expected.pathname)
    );
  } catch {
    return false;
  }
}

function rendererContentSecurityPolicy(): string {
  const rendererUrl = is.dev ? process.env.ELECTRON_RENDERER_URL : undefined;
  let devConnectSources = "";
  if (rendererUrl) {
    try {
      const devOrigin = new URL(rendererUrl).origin;
      const devWebSocketOrigin = devOrigin.replace(/^http:/i, "ws:").replace(/^https:/i, "wss:");
      devConnectSources = ` ${devOrigin} ${devWebSocketOrigin}`;
    } catch {
      // The renderer URL is still checked by isTrustedRendererUrl before loading.
    }
  }

  const scriptSources = is.dev
    ? "'self' 'unsafe-inline' 'wasm-unsafe-eval'"
    : "'self' 'wasm-unsafe-eval'";
  return [
    "default-src 'self'",
    `connect-src 'self' ${MASTRA_SERVER_URL}${devConnectSources} https://v2.xxapi.cn`,
    `script-src ${scriptSources}`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    `img-src 'self' data: blob: ${MASTRA_SERVER_URL} https://images.xxapi.cn https://models.dev`,
    "font-src 'self' data: https://fonts.gstatic.com",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");
}

function isTrustedIpcSender(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): boolean {
  const window = mainWindow;
  return Boolean(
    window &&
      !window.isDestroyed() &&
      event.sender === window.webContents &&
      event.senderFrame === window.webContents.mainFrame &&
      isTrustedRendererUrl(event.senderFrame.url),
  );
}

function assertTrustedIpcSender(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): void {
  if (!isTrustedIpcSender(event)) throw new Error("unauthorized IPC request");
}

async function isServerUp(timeoutMs = 800): Promise<boolean> {
  try {
    const resp = await fetch(`${MASTRA_SERVER_URL}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

async function healthCheckReady(): Promise<void> {
  const startedAt = Date.now();
  let lastStatus = "no response";
  while (Date.now() - startedAt < HEALTH_CHECK_TIMEOUT_MS) {
    try {
      const resp = await fetch(`${MASTRA_SERVER_URL}/health`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (resp.ok) return;
      lastStatus = `HTTP ${resp.status}`;
    } catch (err) {
      lastStatus = err instanceof Error ? err.message : String(err);
    }
    await delay(HEALTH_CHECK_INTERVAL_MS);
  }
  throw new Error(
    `Mastra 服务未在 ${Math.round(HEALTH_CHECK_TIMEOUT_MS / 1000)}s 内就绪，最后状态：${lastStatus}`,
  );
}

/** 强杀:Windows 用 taskkill 清整棵树(避免 node 包装层残留),POSIX 用 SIGKILL */
function forceKill(proc: ChildProcess): void {
  try {
    if (process.platform === "win32" && proc.pid) {
      spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore" }).on(
        "error",
        () => {
          try {
            proc.kill("SIGKILL");
          } catch {
            /* noop */
          }
        },
      );
    } else {
      proc.kill("SIGKILL");
    }
  } catch {
    /* noop */
  }
}

/** 等进程退出;返回是否在超时前自行退出 */
function waitForExit(proc: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      proc.removeListener("exit", onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    proc.once("exit", onExit);
  });
}

/**
 * 停止 Mastra 进程树,跨平台统一流程:
 * 1. HTTP /work/shutdown(主通路):dev 态服务进程是 mastra CLI 的孙进程
 *    (CLI → .mastra/output/index.mjs),挂在 CLI 上的 IPC/信号送不到真正持有
 *    端口、需要落盘的孙进程,HTTP 直接打给服务本身,dev/打包态行为一致。
 *    响应 200 即代表服务侧 memory.settled() 落盘完成。
 * 2. IPC message + SIGTERM:打包态直连子进程 / POSIX 的兜底通路。
 * 3. 强杀整棵树(清掉 CLI 包装层),Windows taskkill /T、POSIX SIGKILL。
 *
 * 返回的 Promise 在进程树确认退出或强杀已发起并等待后 resolve,调用方必须等
 * 它完成后才允许 app 真正退出,否则子进程变孤儿、4111 端口残留。
 */
async function stopMastra(): Promise<void> {
  const proc = mastraProcess;
  if (isMastraStopping || !proc) return;
  isMastraStopping = true;
  mastraProcess = null;

  try {
    const resp = await fetch(MASTRA_SHUTDOWN_ENDPOINT, {
      method: "POST",
      headers: { "x-shutdown-token": MASTRA_SHUTDOWN_TOKEN },
      signal: AbortSignal.timeout(HTTP_SHUTDOWN_TIMEOUT_MS),
    });
    if (!resp.ok) {
      console.warn(`[Mastra] 优雅退出响应异常：HTTP ${resp.status}`);
    }
  } catch (err) {
    // 服务已死/未就绪都会走到这里,继续走兜底通路
    console.warn(`[Mastra] HTTP 优雅退出失败：${err instanceof Error ? err.message : String(err)}`);
  }

  if (proc.exitCode === null) {
    try {
      if (proc.connected) proc.send({ type: MASTRA_SHUTDOWN_MESSAGE });
    } catch {
      /* 通道已关闭,靠强杀兜底 */
    }
    if (process.platform !== "win32") {
      try {
        proc.kill("SIGTERM");
      } catch {
        /* noop */
      }
    }
    if (!(await waitForExit(proc, GRACEFUL_EXIT_WAIT_MS))) {
      forceKill(proc);
    }
  }
  await waitForExit(proc, FORCE_KILL_WAIT_MS);
}

/** electron-vite dev 的 cwd 即项目根;校验锚文件防御意外 cwd */
function getProjectRoot(): string {
  const cwd = process.cwd();
  if (!existsSync(join(cwd, "pnpm-lock.yaml"))) {
    throw new Error(`项目根定位失败：cwd ${cwd} 下没有 pnpm-lock.yaml`);
  }
  return cwd;
}

/**
 * 解析本地 mastra CLI 的真实 JS 入口(node_modules/mastra 的 bin)。
 * 用 process.execPath(ELECTRON_RUN_AS_NODE)直接执行,不经 npx / shell 包装:
 * 启动更快,直系子进程即 CLI 本体(IPC 可达),进程树干净、可整树回收。
 */
function getMastraCliEntry(projectRoot: string): string {
  const pkgPath = join(projectRoot, "node_modules", "mastra", "package.json");
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
      bin?: Record<string, string>;
    };
    const bin = pkg.bin?.mastra;
    if (!bin) throw new Error("package.json 缺少 bin.mastra");
    return resolve(dirname(pkgPath), bin);
  } catch (err) {
    throw new Error(
      `无法解析 mastra CLI 入口（${pkgPath}）：${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function getPackagedMastraEntry(): string {
  // Keep the ESM entry inside app.asar. Node's ESM resolver can then resolve
  // the bundled production dependencies from app.asar/node_modules. Launching
  // the same file from app.asar.unpacked breaks package resolution after NSIS
  // installation because the unpacked tree intentionally contains only native
  // modules and browser assets.
  return join(app.getAppPath(), ".mastra", "output", "index.mjs");
}

function getPackagedResourceDirectory(): string {
  const appPath = app.getAppPath();
  const unpackedRoot = appPath.endsWith(".asar") ? `${appPath}.unpacked` : appPath;
  return join(unpackedRoot, "resources");
}

/** 按端口找 LISTENING 进程并整树强杀;平台分支只为调对系统命令,行为一致 */
async function killProcessesOnPort(port: number): Promise<void> {
  try {
    let pids: number[] = [];
    if (process.platform === "win32") {
      const { stdout } = await execFileAsync("netstat", ["-ano", "-p", "TCP"]);
      pids = [
        ...new Set(
          stdout
            .split("\n")
            .filter((line) => line.includes("LISTENING"))
            .map((line) => line.trim().split(/\s+/))
            .filter((cols) => (cols[1] ?? "").endsWith(`:${port}`))
            .map((cols) => Number(cols[cols.length - 1])),
        ),
      ].filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
      for (const pid of pids) {
        try {
          await execFileAsync("taskkill", ["/pid", String(pid), "/T", "/F"]);
        } catch {
          /* 进程已退出 */
        }
      }
    } else {
      const { stdout } = await execFileAsync("lsof", [
        "-t",
        "-i",
        `TCP:${port}`,
        "-s",
        "TCP:LISTEN",
      ]);
      pids = stdout
        .split(/\s+/)
        .map(Number)
        .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
      for (const pid of pids) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* 进程已退出 */
        }
      }
    }
  } catch {
    // lsof 不存在/无匹配等,交由调用方的端口复检兜底
  }
}

/**
 * 启动前发现 4111 已有服务在监听:单实例锁保证不是本应用的另一份,只能是上次
 * 异常退出残留的孤儿。整树清掉并等端口释放;仍占用则报错,绝不带着陈旧后端启动
 * (否则健康检查误判为就绪,窗口连上的是孤儿服务,新拉的后端反而起不来)。
 */
async function freeStaleServer(): Promise<void> {
  console.warn("[Mastra] 端口 4111 已被占用,尝试清理残留服务…");
  await killProcessesOnPort(MASTRA_PORT);
  const deadline = Date.now() + 6_000;
  while (Date.now() < deadline) {
    if (!(await isServerUp(500))) return;
    await delay(500);
  }
  throw new Error("端口 4111 被其他进程占用且无法清理,请手动结束该进程后重试");
}

function showCrashDialog(detail: string): void {
  void dialog
    .showMessageBox({
      type: "error",
      title: "Mastra 服务异常退出",
      message: "后端服务已退出，界面功能将不可用。",
      detail,
      buttons: ["重启后端", "退出应用"],
      defaultId: 0,
      cancelId: 1,
    })
    .then(async ({ response }) => {
      if (response === 0) {
        try {
          await stopMastra();
          // stopMastra marks the current process tree as stopping. A crash
          // restart starts a new tree, so clear the guard before spawning it.
          isMastraStopping = false;
          mastraStartPromise = null;
          await ensureMastraRunning();
        } catch (err) {
          showCrashDialog(err instanceof Error ? (err.stack ?? err.message) : String(err));
        }
      } else {
        app.quit();
      }
    })
    .catch(() => {});
}

/**
 * 拉起 Mastra 子进程并等健康检查通过。dev 态跑 mastra dev(保留 watch/热重载),
 * 打包态直接跑 mastra build 产物;两者统一用 process.execPath(Electron 以
 * ELECTRON_RUN_AS_NODE 模式当 Node 解释器),不经 npx / shell 包装。
 */
function ensureMastraRunning(): Promise<void> {
  if (mastraStartPromise) return mastraStartPromise;
  const broker = credentialBroker;
  if (!broker) return Promise.reject(new Error("凭据 Broker 尚未启动"));

  mastraStartPromise = new Promise<void>((resolve, reject) => {
    let settled = false;
    const succeed = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      mastraStartPromise = null;
      void stopMastra();
      reject(err);
    };

    void (async () => {
      // 预检:强力清理上次异常退出/直接关闭终端遗留的孤儿进程
      try {
        await killProcessesOnPort(MASTRA_PORT);
        if (await isServerUp()) await freeStaleServer();
      } catch (err) {
        fail(err instanceof Error ? err : new Error(String(err)));
        return;
      }

      let command: string;
      let args: string[];
      let cwd: string;
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        // The Mastra CLI sets MASTRA_DEV=true for its watcher child. The
        // desktop runtime is production-like even in development, so the
        // service entrypoint clears that CLI-only flag before constructing
        // Mastra. This keeps auth capability checks out of the EE dev path.
        MASTRA_DESKTOP_RUNTIME: "true",
        MASTRA_SHUTDOWN_TOKEN,
        MASTRA_CREDENTIAL_BROKER_PATH: broker.endpoint,
        MASTRA_CREDENTIAL_BROKER_TOKEN: broker.token,
      };

      // 服务进程是纯 Node,原生 fetch 不读系统代理;把解析出的代理以环境变量注入,
      // 经 spawn 链(dev: CLI → 服务孙进程)交给服务端的 EnvHttpProxyAgent。
      const outboundProxy = await resolveOutboundProxyUrl();
      if (outboundProxy) {
        const configuredBypass = (process.env.NO_PROXY ?? process.env.no_proxy ?? "").trim();
        const bypass = Array.from(
          new Set([
            ...configuredBypass.split(/[,\s]+/).filter(Boolean),
            "localhost",
            "127.0.0.1",
            "::1",
          ]),
        ).join(",");
        // 大小写两套都写:各库读取习惯不一(undici 先读小写再读大写)
        env.HTTPS_PROXY = outboundProxy;
        env.HTTP_PROXY = outboundProxy;
        env.https_proxy = outboundProxy;
        env.http_proxy = outboundProxy;
        env.NO_PROXY = bypass;
        env.no_proxy = bypass;
        console.log(`[proxy] Mastra 服务出站代理已启用（绕过 ${bypass}）`);
      } else {
        // 直连:清掉从外层继承来的失效代理变量,否则服务端会照着它把出站全挂死
        for (const key of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]) {
          delete env[key];
        }
        console.log("[proxy] 未检测到可用代理，Mastra 服务直连出站");
      }

      if (is.dev) {
        const projectRoot = getProjectRoot();
        command = process.execPath;
        args = [getMastraCliEntry(projectRoot), "dev"];
        cwd = projectRoot;
        env.FORCE_COLOR = "1";
        env.PLAYWRIGHT_BROWSERS_PATH = join(projectRoot, "resources", "browsers");
      } else {
        command = process.execPath;
        args = [getPackagedMastraEntry()];
        cwd = process.resourcesPath;
        // 不要让 Mastra 又去走 dev 分支找 pnpm-lock.yaml
        env.NODE_ENV = "production";
        env.PLAYWRIGHT_BROWSERS_PATH = join(getPackagedResourceDirectory(), "browsers");
      }

      let proc: ChildProcess;
      try {
        proc = spawn(command, args, {
          cwd,
          env,
          // 直系子进程就是 CLI/服务本体,IPC 通道可用(打包态兜底通路)
          stdio: ["ignore", "pipe", "pipe", "ipc"],
          windowsHide: true,
        });
      } catch (spawnErr) {
        fail(
          new Error(
            `无法启动 Mastra (${command} ${args.join(" ")}):${
              spawnErr instanceof Error ? spawnErr.message : String(spawnErr)
            }`,
          ),
        );
        return;
      }
      mastraProcess = proc;

      proc.stdout?.on("data", (chunk: Buffer | string) => {
        process.stdout.write(`[Mastra] ${String(chunk)}`);
      });
      proc.stderr?.on("data", (chunk: Buffer | string) => {
        process.stderr.write(`[Mastra] ${String(chunk)}`);
      });
      proc.on("error", (err) => {
        fail(new Error(`Mastra 进程错误：${err.message}`));
      });
      proc.on("exit", (code, signal) => {
        if (isMastraStopping) return;
        const msg = `Mastra 进程退出(code=${code ?? "?"}, signal=${signal ?? "?"})`;
        if (settled) {
          console.error(msg);
          showCrashDialog(msg);
        } else {
          fail(new Error(msg));
        }
      });

      // 健康检查:只有 localhost:4111/health 返回 200 才放行 createWindow
      try {
        await healthCheckReady();
        succeed();
      } catch (err) {
        fail(err instanceof Error ? err : new Error(String(err)));
      }
    })();
  });

  return mastraStartPromise;
}

/** 数据落盘目录:优先在服务存活时问 /work/storage,拿不到再用默认位置推算 */
function defaultMastraDataDir(): string {
  try {
    return join(homedir(), ".mastrawork");
  } catch {
    return "";
  }
}

/** DuckDB observability 数据目录,与会话数据库分离且不属于 Mastra public 输出。 */
function defaultMastraObservabilityDir(): string {
  try {
    return join(homedir(), ".mastrawork", "observability");
  } catch {
    return "";
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    // The packaged app uses icon.ico/icon.icns for its shell icon. Reuse the
    // same asset for the Windows/Linux window so dev and packaged runs do not
    // show Electron's default icon. macOS gets its icon from the app bundle.
    ...(process.platform !== "darwin" ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
    },
  });

  const rendererSession = mainWindow.webContents.session;
  const handleRendererHeaders = (
    details: Electron.OnHeadersReceivedListenerDetails,
    callback: (response: Electron.HeadersReceivedResponse) => void,
  ) => {
    if (details.resourceType !== "mainFrame" || !isTrustedRendererUrl(details.url)) {
      callback({});
      return;
    }

    const responseHeaders = { ...details.responseHeaders };
    const hasCsp = Object.keys(responseHeaders).some(
      (name) => name.toLowerCase() === "content-security-policy",
    );
    if (!hasCsp) responseHeaders["Content-Security-Policy"] = [rendererContentSecurityPolicy()];
    callback({ responseHeaders });
  };
  rendererSession.webRequest.onHeadersReceived(handleRendererHeaders);

  const displayMediaSession = mainWindow.webContents.session;
  displayMediaSession.setDisplayMediaRequestHandler((request, callback) => {
    const window = mainWindow;
    if (
      !window ||
      window.isDestroyed() ||
      !request.userGesture ||
      !request.videoRequested ||
      request.frame !== window.webContents.mainFrame
    ) {
      callback({});
      return;
    }
    callback({ video: request.frame });
  });

  const terminal = new TerminalSessionRuntime({
    runtimeRoot: is.dev ? getProjectRoot() : app.getAppPath(),
    defaultCwd: is.dev ? getProjectRoot() : app.getPath("home"),
    send: (event) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(TERMINAL_EVENT_CHANNEL, event);
      }
    },
  });

  const handleTerminalCreate = async (event: Electron.IpcMainInvokeEvent, request: unknown) => {
    assertTrustedIpcSender(event);
    return TerminalCreateResultSchema.parse(
      await terminal.create(TerminalCreateRequestSchema.parse(request)),
    );
  };
  const handleTerminalWrite = (event: Electron.IpcMainEvent, request: unknown) => {
    if (!isTrustedIpcSender(event)) return;
    try {
      terminal.write(TerminalWriteRequestSchema.parse(request));
    } catch {
      // High-frequency input is ignored when it does not match the IPC contract.
    }
  };
  const handleTerminalResize = (event: Electron.IpcMainEvent, request: unknown) => {
    if (!isTrustedIpcSender(event)) return;
    try {
      terminal.resize(TerminalResizeRequestSchema.parse(request));
    } catch {
      // Invalid dimensions are ignored at the trusted boundary.
    }
  };
  const handleTerminalClose = (event: Electron.IpcMainEvent, sessionId: unknown) => {
    if (!isTrustedIpcSender(event)) return;
    try {
      terminal.close(TerminalSessionIdSchema.parse(sessionId));
    } catch {
      // Invalid session ids are ignored at the trusted boundary.
    }
  };
  ipcMain.handle(TERMINAL_CREATE_CHANNEL, handleTerminalCreate);
  ipcMain.on(TERMINAL_WRITE_CHANNEL, handleTerminalWrite);
  ipcMain.on(TERMINAL_RESIZE_CHANNEL, handleTerminalResize);
  ipcMain.on(TERMINAL_CLOSE_CHANNEL, handleTerminalClose);

  mainWindow.on("closed", () => {
    rendererSession.webRequest.onHeadersReceived(null);
    displayMediaSession.setDisplayMediaRequestHandler(null);
    ipcMain.removeHandler(TERMINAL_CREATE_CHANNEL);
    ipcMain.removeListener(TERMINAL_WRITE_CHANNEL, handleTerminalWrite);
    ipcMain.removeListener(TERMINAL_RESIZE_CHANNEL, handleTerminalResize);
    ipcMain.removeListener(TERMINAL_CLOSE_CHANNEL, handleTerminalClose);
    terminal.dispose();
    mainWindow = null;
  });

  mainWindow.on("ready-to-show", () => {
    mainWindow?.show();
  });

  mainWindow.webContents.setWindowOpenHandler((details) => {
    const url = ExternalUrlSchema.safeParse(details.url);
    if (url.success) void shell.openExternal(url.data);
    return { action: "deny" };
  });

  // Keep renderer failures distinguishable from a Mastra/SSE failure.  These
  // diagnostics are deliberately limited to lifecycle/error metadata and do
  // not capture message contents or credentials.
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    console.error(
      `[Renderer] process gone: reason=${details.reason}, exitCode=${details.exitCode}`,
    );
  });
  mainWindow.on("unresponsive", () => {
    console.error("[Renderer] window became unresponsive");
  });
  mainWindow.on("responsive", () => {
    console.info("[Renderer] window became responsive");
  });
  mainWindow.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    if (
      level >= 2 ||
      /maximum update depth|network error|uncaught error/i.test(message)
    ) {
      console.error(`[Renderer] console level=${level} ${sourceId}:${line}: ${message}`);
    }
  });

  const handleUntrustedNavigation = (event: Electron.Event, url: string) => {
    if (isTrustedRendererUrl(url)) return;
    event.preventDefault();
    const externalUrl = ExternalUrlSchema.safeParse(url);
    if (externalUrl.success) void shell.openExternal(externalUrl.data);
  };
  mainWindow.webContents.on("will-navigate", handleUntrustedNavigation);
  mainWindow.webContents.on("will-redirect", handleUntrustedNavigation);

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

/**
 * 动态探测 VS Code 可执行文件绝对路径或启动命令：
 * 1. 跨平台系统 PATH 检测 (where.exe / which)
 * 2. Windows 专属：动态查注册表 App Paths (HKEY_CURRENT_USER / HKEY_LOCAL_MACHINE)
 * 3. macOS 专属：使用 Spotlight 通过 Bundle ID (com.microsoft.VSCode) 动态定位
 */
async function findVSCodeExecutable(): Promise<string | null> {
  // 1. 优先查系统 PATH (跨平台通用)
  try {
    const isWin = process.platform === "win32";
    const lookupTool = isWin ? "where.exe" : "which";
    const commands = isWin ? ["code.cmd", "code.exe", "code"] : ["code"];
    for (const cmd of commands) {
      try {
        const { stdout } = await execFileAsync(lookupTool, [cmd], { timeout: 1500 });
        const firstLine = stdout.trim().split(/\r?\n/)[0]?.trim();
        if (firstLine && existsSync(firstLine)) {
          if (isWin && firstLine.toLowerCase().endsWith(".cmd")) {
            const executable = resolve(dirname(firstLine), "..", "Code.exe");
            if (existsSync(executable)) return executable;
            continue;
          }
          return firstLine;
        }
      } catch {
        // try next command
      }
    }
  } catch {
    // ignore
  }

  // 2. Windows 专属：动态查询注册表 App Paths (无视安装在哪个盘符或非标准路径)
  if (process.platform === "win32") {
    const regKeys = [
      "HKEY_CURRENT_USER\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Code.exe",
      "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Code.exe",
      "HKEY_LOCAL_MACHINE\\SOFTWARE\\Classes\\Applications\\Code.exe\\shell\\open\\command",
    ];
    for (const key of regKeys) {
      try {
        const { stdout } = await execFileAsync("reg.exe", ["query", key, "/ve"], { timeout: 1500 });
        const match = stdout.match(/REG_SZ\s+(?:"([^"]+)"|(\S+))/i);
        const resolvedPath = (match?.[1] || match?.[2] || "").trim();
        if (resolvedPath && existsSync(resolvedPath)) {
          return resolvedPath;
        }
      } catch {
        // try next reg key
      }
    }
  }

  // 3. macOS 专属：通过 Spotlight 搜索 Bundle ID 动态定位 (无论安装到何处)
  if (process.platform === "darwin") {
    try {
      const { stdout } = await execFileAsync(
        "mdfind",
        ["kMDItemCFBundleIdentifier == 'com.microsoft.VSCode'"],
        { timeout: 2000 },
      );
      const firstLine = stdout.trim().split(/\r?\n/)[0]?.trim();
      if (firstLine && existsSync(firstLine)) {
        return firstLine;
      }
    } catch {
      // ignore
    }
  }

  return null;
}

let cachedDetectedIdes: DetectedIde[] | null = null;
let lastDetectionTime = 0;

async function detectInstalledIdes(forceRefresh = false): Promise<DetectedIde[]> {
  if (!forceRefresh && cachedDetectedIdes && Date.now() - lastDetectionTime < 120_000) {
    return cachedDetectedIdes;
  }

  const results: DetectedIde[] = [];

  const vscodePath = await findVSCodeExecutable();
  if (vscodePath) {
    results.push({
      id: "vscode",
      name: "Visual Studio Code",
      command: vscodePath,
      category: "ide",
    });
  }

  results.push({
    id: "terminal",
    name: "终端",
    command: "terminal",
    category: "system",
  });
  results.push({
    id: "explorer",
    name: "文件资源管理器",
    command: "explorer",
    category: "system",
  });

  cachedDetectedIdes = results;
  lastDetectionTime = Date.now();
  return results;
}

function bootstrap(): void {
  // This method will be called when Electron has finished
  // initialization and is ready to create browser windows.
  // Some APIs can only be used after this event occurs.
  app.whenReady().then(async () => {
    // Set app user model id for windows
    electronApp.setAppUserModelId("com.mastra.desktop");

    try {
      const vaultDirectory = join(app.getPath("userData"), "credential-vault");
      credentialVault = new CredentialVault(vaultDirectory, safeStorage);
      await credentialVault.initialize();
      credentialBroker = new CredentialBroker(credentialVault, vaultDirectory);
      await credentialBroker.start();
    } catch (error) {
      await dialog.showMessageBox({
        type: "error",
        title: "凭据金库启动失败",
        message: error instanceof Error ? error.message : String(error),
      });
      app.exit(1);
      return;
    }

    ipcMain.handle(CREDENTIAL_CHANNELS.put, async (event, value: unknown) => {
      assertTrustedIpcSender(event);
      const request = CredentialPutRequestSchema.parse(value);
      if (!credentialVault) throw new Error("凭据金库不可用");
      return CredentialPutResultSchema.parse(
        await credentialVault.put(request.value, request.purpose),
      );
    });

    ipcMain.handle(CREDENTIAL_CHANNELS.delete, async (event, value: unknown) => {
      assertTrustedIpcSender(event);
      const request = CredentialDeleteRequestSchema.parse(value);
      if (!credentialVault) throw new Error("凭据金库不可用");
      await credentialVault.delete(request.secretRef, request.purpose);
      return CredentialDeleteResultSchema.parse(undefined);
    });

    // Default open or close DevTools by F12 in development
    // and ignore CommandOrControl + R in production.
    // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
    app.on("browser-window-created", (_, window) => {
      optimizer.watchWindowShortcuts(window);
    });

    // 窗口最小宽度由渲染进程实测的布局需求决定(见 App.tsx 的 chatMinWidth)——
    // 写死一个数必然要么挡住用户缩窗口、要么挡不住布局被压坏。高度下限保持不变。
    //
    // 传进来的已经含「面板开着时它当前的宽度」,所以这一个值同时充当两个角色:
    // 窗口能缩到的最窄宽度,以及面板展不开时窗口该长到的宽度 —— 不多也不少。
    //
    // 它是**内容区**宽度(渲染进程用 window.innerWidth 度量),而 setMinimumSize 与
    // getBounds 走的是外框,Win11 上两者差十几像素 —— 所以这里换算一次再用。
    ipcMain.on(WINDOW_CHANNELS.setMinimumWidth, (event, value: unknown) => {
      if (!isTrustedIpcSender(event)) return;
      const request = SetMinimumWidthRequestSchema.safeParse(value);
      if (!request.success) return;
      const width = request.data;
      if (!mainWindow || mainWindow.isDestroyed()) return;
      const bounds = mainWindow.getBounds();
      const frame = Math.max(0, mainWindow.getSize()[0] - mainWindow.getContentSize()[0]);
      const target = Math.ceil(width) + frame;
      const [currentMinWidth, currentMinHeight] = mainWindow.getMinimumSize();
      // 拖拽面板时渲染进程每帧都会发一次,同值就别进 native 了
      if (currentMinWidth !== target) mainWindow.setMinimumSize(target, currentMinHeight);

      // 放宽下限时 Electron 不会自动撑大窗口,于是会出现「窗口比下限还窄」——
      // 补上这一次,就是「面板展不开时把窗口长到刚好够」的全部实现。
      if (bounds.width >= target) return;
      // 最大化/全屏时窗口已是最宽,加宽只会打断这个状态
      if (mainWindow.isMaximized() || mainWindow.isFullScreen()) return;
      const { workArea } = screen.getDisplayMatching(bounds);
      const nextWidth = Math.min(target, workArea.width);
      if (nextWidth <= bounds.width) return;
      // 优先原地向右伸展;右侧空间不够就向左挪,始终留在工作区内
      const x = Math.max(workArea.x, Math.min(bounds.x, workArea.x + workArea.width - nextWidth));
      mainWindow.setBounds({ ...bounds, width: nextWidth, x });
    });

    // 打开存储目录(Electron 官方 shell.openPath)
    ipcMain.handle(FILESYSTEM_CHANNELS.openDirectory, async (event, value: unknown) => {
      assertTrustedIpcSender(event);
      const directory = OpenDirectoryRequestSchema.parse(value);
      return OpenDirectoryResultSchema.parse(await shell.openPath(directory));
    });

    // 动态检测用户操作系统中实际安装的各类 IDE 与系统工具
    ipcMain.handle(WORKSPACE_CHANNELS.detectIdes, async (event, value: unknown) => {
      assertTrustedIpcSender(event);
      DetectIdesRequestSchema.parse(value);
      return DetectIdesResultSchema.parse(await detectInstalledIdes());
    });

    // 在本地外部 IDE 或系统工具中打开工作区目录
    ipcMain.handle(WORKSPACE_CHANNELS.openInApp, async (event, value: unknown) => {
      assertTrustedIpcSender(event);
      const { app: appName, targetPath } = OpenInAppRequestSchema.parse(value);

      try {
        if (appName === "explorer") {
          const error = await shell.openPath(targetPath);
          return OpenInAppResultSchema.parse(error ? { ok: false, error } : { ok: true });
        }

        if (appName === "terminal") {
          if (process.platform === "win32") {
            const child = spawn("wt.exe", ["-d", targetPath], {
              detached: true,
              stdio: "ignore",
            });
            child.on("error", () => {
              const fallback = spawn("cmd.exe", ["/K"], {
                cwd: targetPath,
                detached: true,
                stdio: "ignore",
              });
              fallback.unref();
            });
            child.unref();
          } else if (process.platform === "darwin") {
            const child = spawn("open", ["-a", "Terminal", targetPath], {
              detached: true,
              stdio: "ignore",
            });
            child.unref();
          } else {
            const child = spawn("x-terminal-emulator", [], {
              cwd: targetPath,
              detached: true,
              stdio: "ignore",
            });
            child.unref();
          }
          return OpenInAppResultSchema.parse({ ok: true });
        }

        if (appName === "vscode") {
          const vscodeTarget = await findVSCodeExecutable();
          if (!vscodeTarget) {
            return OpenInAppResultSchema.parse({
              ok: false,
              error: "未检测到 Visual Studio Code",
            });
          }
          if (process.platform === "darwin" && vscodeTarget.endsWith(".app")) {
            const child = spawn("open", ["-a", vscodeTarget, targetPath], {
              detached: true,
              stdio: "ignore",
            });
            child.unref();
          } else {
            const child = spawn(vscodeTarget, [targetPath], {
              detached: true,
              stdio: "ignore",
            });
            child.unref();
          }
          return OpenInAppResultSchema.parse({ ok: true });
        }

        return OpenInAppResultSchema.parse({ ok: false, error: `不支持的应用: ${appName}` });
      } catch (error) {
        return OpenInAppResultSchema.parse({
          ok: false,
          error: error instanceof Error ? error.message : "启动应用失败",
        });
      }
    });

    ipcMain.handle(WORKSPACE_CHANNELS.openExternal, async (event, value: unknown) => {
      assertTrustedIpcSender(event);
      await shell.openExternal(OpenExternalRequestSchema.parse(value));
      return OpenExternalResultSchema.parse(undefined);
    });

    // 系统目录选择器(Electron 官方 dialog.showOpenDialog)。
    // 所有路径类设置(存储位置/工作区根目录/额外目录/Skills 目录)统一走此处,不手输路径。
    ipcMain.handle(FILESYSTEM_CHANNELS.pickDirectory, async (event, value: unknown) => {
      assertTrustedIpcSender(event);
      PickDirectoryRequestSchema.parse(value);
      const focused = BrowserWindow.getFocusedWindow();
      const options = {
        properties: ["openDirectory", "createDirectory"] as Array<
          "openDirectory" | "createDirectory"
        >,
      };
      const result = focused
        ? await dialog.showOpenDialog(focused, options)
        : await dialog.showOpenDialog(options);
      return PickDirectoryResultSchema.parse(
        result.canceled || result.filePaths.length === 0 ? "" : result.filePaths[0],
      );
    });

    // 存储位置迁移:数据库文件句柄活跃时只有杀掉进程才能释放 ——
    // 优雅停(含 memory 落盘 + 强杀兜底)→ 搬迁 LibSQL 数据库文件(mastra.db*)
    // → 写 storage-location.json → 重新拉起并等健康检查。任一步失败则保留旧配置、
    // 按旧位置重启服务并向上抛错。storage-location.json 的落点与服务端
    // storage/index.ts 的 STORAGE_CONFIG_FILE 保持一致(dev 项目根 / 打包 resources)。
    ipcMain.handle(STORAGE_CHANNELS.migrate, async (event, value: unknown) => {
      assertTrustedIpcSender(event);
      const directory = MigrateStorageRequestSchema.parse(value);
      const targetDir = resolve(directory);
      let oldDir = "";
      try {
        const resp = await fetch(`${MASTRA_SERVER_URL}/work/storage`, {
          headers: { "x-shutdown-token": MASTRA_SHUTDOWN_TOKEN },
          signal: AbortSignal.timeout(2_000),
        });
        if (resp.ok) {
          oldDir = ((await resp.json()) as { directory?: string }).directory ?? "";
        }
      } catch {
        /* 服务未就绪时 oldDir 为空,跳过文件搬迁仅切换配置 */
      }
      await stopMastra();
      isMastraStopping = false;
      mastraStartPromise = null;
      try {
        if (oldDir && resolve(oldDir) !== targetDir) {
          const entries = await readdir(oldDir).catch(() => [] as string[]);
          await mkdir(targetDir, { recursive: true });
          for (const name of entries) {
            if (!/^mastra\.db/.test(name)) continue;
            await copyFile(join(oldDir, name), join(targetDir, name));
            await rm(join(oldDir, name), { force: true }).catch(() => undefined);
          }
        }
        const url = `file:${join(targetDir, "mastra.db").replace(/\\/g, "/")}`;
        const defaultDir = join(homedir(), ".mastrawork");
        await mkdir(defaultDir, { recursive: true });
        await writeFile(
          join(defaultDir, "storage-location.json"),
          JSON.stringify({ url }, null, 2),
          "utf-8",
        );
        const root = is.dev ? getProjectRoot() : process.resourcesPath;
        await writeFile(
          join(root, "storage-location.json"),
          JSON.stringify({ url }, null, 2),
          "utf-8",
        ).catch(() => undefined);
      } catch (err) {
        // 搬迁/写配置失败:保留旧配置,按旧位置拉回服务,错误交给渲染进程提示
        void ensureMastraRunning().catch(() => {});
        throw err;
      }
      await ensureMastraRunning();
      return MigrateStorageResultSchema.parse(true);
    });

    // 一键重置软件数据:先问服务要实际数据目录 → 停服务(解除数据库文件句柄,
    // Windows 下删打开中的文件会直接失败)→ 清理 → 自动重启。
    // 数据目录必须从服务侧拿,主进程侧 cwd 推算在打包态会落错位置。
    ipcMain.handle(STORAGE_CHANNELS.reset, async (event, value: unknown) => {
      assertTrustedIpcSender(event);
      ResetAppDataRequestSchema.parse(value);
      let dataDir = "";
      try {
        const resp = await fetch(`${MASTRA_SERVER_URL}/work/storage`, {
          headers: { "x-shutdown-token": MASTRA_SHUTDOWN_TOKEN },
          signal: AbortSignal.timeout(2_000),
        });
        if (resp.ok) {
          dataDir = ((await resp.json()) as { directory?: string }).directory ?? "";
        }
      } catch {
        /* 服务未就绪时退回默认目录推算 */
      }
      await stopMastra();
      await credentialBroker?.close();
      credentialBroker = null;
      credentialVault = null;
      const dirsToClean = [
        app.getPath("userData"),
        dataDir || defaultMastraDataDir(),
        defaultMastraObservabilityDir(),
      ];
      for (const dir of dirsToClean) {
        if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      }
      app.relaunch();
      app.exit(0);
      return ResetAppDataResultSchema.parse(true);
    });

    // 初始化应用代理设置(应用到 Chromium Session 与出站环境变量)
    const initialProxyConfig = await readAppProxyConfig();
    await applySessionProxy(initialProxyConfig);

    // 注册网络代理 IPC
    ipcMain.handle(PROXY_CHANNELS.get, async (event, value: unknown) => {
      assertTrustedIpcSender(event);
      GetProxyRequestSchema.parse(value);
      return GetProxyResultSchema.parse(await readAppProxyConfig());
    });

    ipcMain.handle(PROXY_CHANNELS.set, async (event, value: unknown) => {
      assertTrustedIpcSender(event);
      const config = SetProxyRequestSchema.parse(value);
      await writeAppProxyConfig(config);
      const effectiveProxy = await applySessionProxy(config);
      return SetProxyResultSchema.parse({ ok: true, effectiveProxy });
    });

    ipcMain.handle(PROXY_CHANNELS.test, async (event, value: unknown) => {
      assertTrustedIpcSender(event);
      const { url } = TestProxyRequestSchema.parse(value);
      return TestProxyResultSchema.parse(await testProxyConnectivity(url));
    });

    // 先等 Mastra 就绪再开窗,避免首屏接口 404/竞态
    try {
      await ensureMastraRunning();
    } catch (err) {
      const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
      await dialog.showMessageBox({
        type: "error",
        title: "Mastra 启动失败",
        message: err instanceof Error ? err.message : String(err),
        detail: msg,
      });
      await stopMastra();
      app.exit(1);
      return;
    }

    createWindow();

    app.on("activate", () => {
      // On macOS it's common to re-create a window in the app when the
      // dock icon is clicked and there are no other windows open.
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  // 统一退出清理：Mastra 子进程必须杀掉，否则 4111 端口残留。
  // 优雅退出需要时间(服务侧 await memory.settled()),因此拦下第一次退出、
  // 等 stopMastra() 完成后再让 app 真正退出;第二次进来时清理已在进行,直接放行。
  // 拦截必须放在 before-quit(will-quit 阶段窗口已销毁,preventDefault 后重新
  // quit 会走不到这里),同时保留 will-quit 兜底应对未经 before-quit 的退出路径。
  const shutdownApp = () => {
    appShutdownPromise ??= stopMastra().finally(async () => {
      await credentialBroker?.close();
      credentialBroker = null;
      credentialVault = null;
    });
    return appShutdownPromise;
  };
  app.on("before-quit", (e) => {
    if (!mastraProcess && !credentialBroker) return;
    e.preventDefault();
    void shutdownApp().finally(() => app.quit());
  });
  app.on("will-quit", (e) => {
    if (mastraProcess || credentialBroker) {
      e.preventDefault();
      void shutdownApp().finally(() => app.quit());
    }
  });

  // Quit when all windows are closed, except on macOS. There, it's common
  // for applications and their menu bar to stay active until the user quits
  // explicitly with Cmd + Q.
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });

  // 处理终端 Ctrl+C 信号:开发模式下强制回收 Mastra 进程树,防止孤儿进程锁库
  process.on("SIGINT", () => {
    void shutdownApp().finally(() => process.exit(0));
  });
  process.on("SIGTERM", () => {
    void shutdownApp().finally(() => process.exit(0));
  });
}

// 单实例锁:防止第二个实例把第一个实例的后端(4111)当成"残留"清掉
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  bootstrap();
}

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
