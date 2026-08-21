import type { ChildProcess } from "node:child_process";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { electronApp, is, optimizer } from "@electron-toolkit/utils";
import { app, BrowserWindow, dialog, ipcMain, session, shell } from "electron";
import icon from "../../resources/icon.png?asset";

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
 * 把系统代理解析结果注入服务进程环境。
 * 用 Chromium 官方的 session.resolveProxy 解析系统代理(Windows/macOS/Linux
 * 统一走系统配置),避免在服务进程里手工读注册表/scutil;服务端只认环境变量。
 * 已有显式代理环境变量时不覆盖;解析失败或代理关闭(DIRECT)时返回 undefined。
 */
async function resolveSystemProxyUrl(): Promise<string | undefined> {
  const explicit =
    process.env.HTTPS_PROXY ??
    process.env.https_proxy ??
    process.env.HTTP_PROXY ??
    process.env.http_proxy;
  if (explicit) return undefined;
  try {
    // resolveProxy 按 URL 匹配代理规则(PAC 可对不同域名走不同代理),因此必须给
    // 一个目标 URL 作探测;这里用中立占位域名,与任何具体供应商/业务域名无关。
    const rules = await session.defaultSession.resolveProxy("https://example.com");
    // 形如 "PROXY 127.0.0.1:7890;DIRECT" 或 "DIRECT"
    const proxy = rules
      .split(";")
      .map((rule) => rule.trim())
      .find((rule) => rule.startsWith("PROXY "));
    if (!proxy) return undefined;
    const host = proxy.slice("PROXY ".length).trim();
    if (!host) return undefined;
    return /^https?:\/\//i.test(host) ? host : `http://${host}`;
  } catch {
    return undefined;
  }
}

let mastraProcess: ChildProcess | null = null;
let mastraStartPromise: Promise<void> | null = null;
let isMastraStopping = false;
let mainWindow: BrowserWindow | null = null;

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
 * 直接用 process.execPath(ELECTRON_RUN_AS_NODE)跑它,而不是套 npx/.cmd:
 * - 去掉 npx 解析与批处理包装层,启动更快
 * - 直系子进程就是 CLI 本体,不再需要 shell:true(Windows spawn .cmd 会抛
 *   EINVAL 的 workaround 随之删除),进程树干净、可整树回收
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
  // asarUnpack 的产物位于 app.asar.unpacked/ 下，路径与 asar 内部相对结构一致
  const appPath = app.getAppPath();
  const unpackedRoot = appPath.endsWith(".asar") ? `${appPath}.unpacked` : appPath;
  return join(unpackedRoot, ".mastra", "output", "index.mjs");
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
      ].filter((pid) => Number.isInteger(pid) && pid > 0);
      for (const pid of pids) {
        spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" }).on(
          "error",
          () => {
            /* noop */
          },
        );
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
        .filter((pid) => Number.isInteger(pid) && pid > 0);
      for (const pid of pids) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* noop */
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
 * ELECTRON_RUN_AS_NODE 模式当 Node 解释器),不再经过 npx / shell 包装。
 */
function ensureMastraRunning(): Promise<void> {
  if (mastraStartPromise) return mastraStartPromise;

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
      // 预检:已有服务在 4111 上响应 → 上次残留的孤儿,先清掉
      try {
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
        MASTRA_SHUTDOWN_TOKEN,
      };

      // 服务进程是纯 Node,原生 fetch 不读系统代理;把 Chromium 解析出的系统
      // 代理以环境变量注入,经 spawn 链(dev: CLI → 服务孙进程)传给服务端。
      const systemProxy = await resolveSystemProxyUrl();
      if (systemProxy) {
        env.HTTPS_PROXY = systemProxy;
        env.HTTP_PROXY = systemProxy;
        env.NO_PROXY = "localhost,127.0.0.1,::1";
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
    return is.dev
      ? join(getProjectRoot(), "src/mastra/public")
      : join(process.resourcesPath, "src/mastra/public");
  } catch {
    return "";
  }
}

/** DuckDB observability 数据目录,与会话数据库分离且不属于 Mastra public 输出。 */
function defaultMastraObservabilityDir(): string {
  try {
    return is.dev
      ? join(getProjectRoot(), ".mastra", "observability")
      : join(process.resourcesPath, ".mastra", "observability");
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
    ...(process.platform === "linux" ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: false,
    },
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  mainWindow.on("ready-to-show", () => {
    mainWindow?.show();
  });

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url);
    return { action: "deny" };
  });

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

function bootstrap(): void {
  // 提前拉起 Mastra,与 Electron 自身初始化并行;窗口仍要等健康检查通过才创建,
  // 保证"后端就绪 → 前端加载"的顺序。失败在 whenReady 里统一弹窗。
  void ensureMastraRunning().catch(() => {});

  // This method will be called when Electron has finished
  // initialization and is ready to create browser windows.
  // Some APIs can only be used after this event occurs.
  app.whenReady().then(async () => {
    // Set app user model id for windows
    electronApp.setAppUserModelId("com.mastra.desktop");

    // Default open or close DevTools by F12 in development
    // and ignore CommandOrControl + R in production.
    // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
    app.on("browser-window-created", (_, window) => {
      optimizer.watchWindowShortcuts(window);
    });

    // IPC test
    ipcMain.on("ping", () => console.log("pong"));

    // 打开存储目录(Electron 官方 shell.openPath)
    ipcMain.handle("open-directory", (_event, directory: string) => shell.openPath(directory));

    // 系统目录选择器(Electron 官方 dialog.showOpenDialog)。
    // 所有路径类设置(存储位置/工作区根目录/额外目录/Skills 目录)统一走此处,不手输路径。
    ipcMain.handle("pick-directory", async () => {
      const focused = BrowserWindow.getFocusedWindow();
      const options = {
        properties: ["openDirectory", "createDirectory"] as Array<
          "openDirectory" | "createDirectory"
        >,
      };
      const result = focused
        ? await dialog.showOpenDialog(focused, options)
        : await dialog.showOpenDialog(options);
      if (result.canceled || result.filePaths.length === 0) return "";
      return result.filePaths[0];
    });

    // 存储位置迁移:数据库文件句柄活跃时只有杀掉进程才能释放 ——
    // 优雅停(含 memory 落盘 + 强杀兜底)→ 搬迁 LibSQL 数据库文件(mastra.db*)
    // → 写 storage-location.json → 重新拉起并等健康检查。任一步失败则保留旧配置、
    // 按旧位置重启服务并向上抛错。storage-location.json 的落点与服务端
    // storage/index.ts 的 STORAGE_CONFIG_FILE 保持一致(dev 项目根 / 打包 resources)。
    ipcMain.handle("migrate-storage", async (_event, directory: string) => {
      if (!directory) throw new Error("directory is required");
      const targetDir = resolve(directory);
      let oldDir = "";
      try {
        const resp = await fetch(`${MASTRA_SERVER_URL}/work/storage`, {
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
        const root = is.dev ? getProjectRoot() : process.resourcesPath;
        await writeFile(
          join(root, "storage-location.json"),
          JSON.stringify({ url }, null, 2),
          "utf-8",
        );
      } catch (err) {
        // 搬迁/写配置失败:保留旧配置,按旧位置拉回服务,错误交给渲染进程提示
        void ensureMastraRunning().catch(() => {});
        throw err;
      }
      await ensureMastraRunning();
      return true;
    });

    // 一键重置软件数据:先问服务要实际数据目录 → 停服务(解除数据库文件句柄,
    // Windows 下删打开中的文件会直接失败)→ 清理 → 自动重启。
    // 数据目录必须从服务侧拿,主进程侧 cwd 推算在打包态会落错位置。
    ipcMain.handle("reset-app-data", async () => {
      let dataDir = "";
      try {
        const resp = await fetch(`${MASTRA_SERVER_URL}/work/storage`, {
          signal: AbortSignal.timeout(2_000),
        });
        if (resp.ok) {
          dataDir = ((await resp.json()) as { directory?: string }).directory ?? "";
        }
      } catch {
        /* 服务未就绪时退回默认目录推算 */
      }
      await stopMastra();
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
      return true;
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
  app.on("before-quit", (e) => {
    if (isMastraStopping || !mastraProcess) return;
    e.preventDefault();
    void stopMastra().finally(() => app.quit());
  });
  app.on("will-quit", (e) => {
    if (mastraProcess && !isMastraStopping) {
      e.preventDefault();
      void stopMastra().finally(() => app.quit());
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
