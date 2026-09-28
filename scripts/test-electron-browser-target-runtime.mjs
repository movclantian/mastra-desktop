import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { createConnection } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createJiti } from "jiti";
import { chromium } from "playwright-core";
import { BrowserManager } from "agent-browser";

const root = path.resolve(import.meta.dirname, "..");
const probeApp = path.join(root, "tests", "electron-native-browser-target");
const electronPath =
  process.env.MASTRA_TEST_ELECTRON_PATH?.trim() || createRequire(import.meta.url)("electron");
await verifyTargetBridge();
const userData = await mkdtemp(path.join(tmpdir(), "mastra-native-browser-probe-"));
const cdpPort = await getFreePort();
const child = spawn(
  electronPath,
  [
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${userData}`,
    probeApp,
  ],
  {
    cwd: probeApp,
    env: {
      ...process.env,
      MASTRA_BROWSER_PROBE_CDP_PORT: String(cdpPort),
      ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  },
);

let output = "";
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => (output += chunk));
child.stderr.on("data", (chunk) => (output += chunk));

let cdpBrowser;
let manager;
try {
  await waitFor(async () => output.includes("PROBE_READY"), 25_000, "Electron probe startup");
  const origin = JSON.parse(output.match(/PROBE_READY (\{.*\})/)?.[1] ?? "{}").origin;
  assert.ok(origin, "probe host did not report its local test origin");
  const endpoint = `http://127.0.0.1:${cdpPort}`;
  const initial = await getJson(`${origin}/__state`);
  assert.ok(initial.alpha.targetId && initial.beta.targetId);
  assert.notEqual(
    initial.alpha.targetId,
    initial.beta.targetId,
    "threads must own distinct targets",
  );

  cdpBrowser = await chromium.connectOverCDP(endpoint);
  const pages = () => cdpBrowser.contexts().flatMap((context) => context.pages());
  const findPageByTargetId = async (targetId) => {
    for (const page of pages()) {
      if (page.isClosed()) continue;
      const session = await page.context().newCDPSession(page);
      try {
        const { targetInfo } = await session.send("Target.getTargetInfo");
        if (targetInfo.targetId === targetId) return page;
      } finally {
        await session.detach().catch(() => undefined);
      }
    }
    return null;
  };

  const alphaPage = await findPageByTargetId(initial.alpha.targetId);
  const betaPage = await findPageByTargetId(initial.beta.targetId);
  assert.ok(alphaPage && betaPage, "Electron WebContents target IDs must map to Playwright pages");
  assert.equal(await alphaPage.title(), "probe-alpha");
  assert.equal(await betaPage.title(), "probe-beta");

  manager = new BrowserManager();
  await manager.launch({ cdpUrl: endpoint });
  const jiti = createJiti(import.meta.url, { interopDefault: true, fsCache: false });
  const { selectNativeElectronPage } = jiti(
    path.join(root, "src", "mastra", "browser-target-selection.ts"),
  );
  const { withNativeBrowserTargetLock } = jiti(
    path.join(root, "src", "mastra", "native-browser-target-lock.ts"),
  );
  await selectNativeElectronPage(manager, initial.alpha.targetId);
  assert.equal(
    await manager.getPage().title(),
    "probe-alpha",
    "Agent projection should bind alpha only",
  );
  await selectNativeElectronPage(manager, initial.beta.targetId);
  assert.equal(
    await manager.getPage().title(),
    "probe-beta",
    "Agent projection should switch to beta only",
  );
  await assert.rejects(
    selectNativeElectronPage(manager, "not-a-real-target"),
    /not present|ambiguous/,
    "unknown targets must fail closed",
  );
  assert.equal(
    manager.getPages().length,
    0,
    "failed target binding must clear the stale page projection",
  );

  const updateThread = async (thread, targetId, pathName) =>
    withNativeBrowserTargetLock(
      manager,
      thread,
      () => selectNativeElectronPage(manager, targetId),
      async () => {
        await delay(60);
        const page = manager.getPage();
        await page.goto(`${origin}/${pathName}`, { waitUntil: "domcontentloaded" });
        return page.title();
      },
    );
  const concurrent = await Promise.all([
    updateThread("thread-alpha", initial.alpha.targetId, "alpha-concurrent"),
    updateThread("thread-beta", initial.beta.targetId, "beta-concurrent"),
  ]);
  assert.deepEqual(concurrent, ["probe-alpha-concurrent", "probe-beta-concurrent"]);
  const afterConcurrent = await getJson(`${origin}/__state`);
  assert.match(afterConcurrent.alpha.state.currentUrl, /alpha-concurrent/);
  assert.match(afterConcurrent.beta.state.currentUrl, /beta-concurrent/);
  const nestedTitle = await withNativeBrowserTargetLock(
    manager,
    "thread-beta",
    () => selectNativeElectronPage(manager, afterConcurrent.beta.targetId),
    () =>
      withNativeBrowserTargetLock(
        manager,
        "thread-beta",
        async () => assert.fail("same-thread nested operation must not rebind"),
        async () => manager.getPage().title(),
      ),
  );
  assert.equal(nestedTitle, "probe-beta-concurrent");

  await alphaPage.click("#popup");
  const afterPopup = await waitFor(
    async () => {
      const state = await getJson(`${origin}/__state`);
      return state.alpha.state.tabs.length === 2 ? state : null;
    },
    12_000,
    "native popup tab creation",
  );
  assert.equal(afterPopup.alpha.state.activeTabIndex, 1);
  assert.notEqual(afterPopup.alpha.targetId, initial.alpha.targetId);
  assert.equal(
    afterPopup.beta.targetId,
    initial.beta.targetId,
    "popup must not change the other thread target",
  );
  const popupPage = await waitFor(
    () => findPageByTargetId(afterPopup.alpha.targetId),
    12_000,
    `popup target ${afterPopup.alpha.targetId} to appear in Playwright`,
  );
  assert.equal(await popupPage.title(), "probe-popup");

  await selectNativeElectronPage(manager, afterPopup.alpha.targetId);
  await withNativeBrowserTargetLock(
    manager,
    "thread-alpha",
    () => selectNativeElectronPage(manager, afterPopup.alpha.targetId),
    () => manager.getPage().goto(`${origin}/agent-changed`, { waitUntil: "domcontentloaded" }),
  );
  const afterAlphaAction = await getJson(`${origin}/__state`);
  assert.match(afterAlphaAction.alpha.state.currentUrl, /agent-changed/);
  assert.equal(afterAlphaAction.beta.state.currentUrl, afterConcurrent.beta.state.currentUrl);

  process.stdout.write(
    "Electron browser target runtime: PASS (authenticated bridge, Electron↔Playwright IDs, alpha/beta isolation, fail-closed, window.open tab)\n",
  );
} catch (error) {
  process.stderr.write(`${error?.stack || error}\n${output}\n`);
  process.exitCode = 1;
} finally {
  await manager?.close().catch(() => undefined);
  await cdpBrowser?.close().catch(() => undefined);
  child.stdin.end("quit\n");
  await waitForChildExit(5_000);
  if (child.exitCode === null) {
    if (process.platform === "win32" && child.pid) {
      spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } else {
      child.kill();
    }
    await waitForChildExit(5_000);
  }
  await rm(userData, { recursive: true, force: true }).catch(() => undefined);
}

async function waitForChildExit(timeoutMs) {
  if (child.exitCode !== null) return;
  await Promise.race([new Promise((resolve) => child.once("exit", resolve)), delay(timeoutMs)]);
}

async function getFreePort() {
  const net = await import("node:net");
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function getJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
  if (!response.ok) throw new Error(`GET ${url} returned ${response.status}`);
  return response.json();
}

async function waitFor(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Electron probe exited early: ${output}`);
    try {
      const value = await check();
      if (value) return value;
    } catch {}
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${label}: ${output}`);
}

async function verifyTargetBridge() {
  const directory = await mkdtemp(path.join(tmpdir(), "mastra-native-target-bridge-"));
  const brokerModule = createJiti(import.meta.url, { interopDefault: true, fsCache: false });
  const { NativeBrowserTargetBroker } = brokerModule(
    path.join(root, "src", "main", "browser-target-broker.ts"),
  );
  const targets = new Map([["probe-user:thread-alpha", "electron-target-alpha"]]);
  const broker = new NativeBrowserTargetBroker(
    ({ resourceId, threadId }) => targets.get(`${resourceId}:${threadId}`) ?? null,
    directory,
  );
  const previousEndpoint = process.env.MASTRA_NATIVE_BROWSER_TARGET_BROKER_PATH;
  const previousToken = process.env.MASTRA_NATIVE_BROWSER_TARGET_BROKER_TOKEN;
  try {
    await broker.start();
    process.env.MASTRA_NATIVE_BROWSER_TARGET_BROKER_PATH = broker.endpoint;
    process.env.MASTRA_NATIVE_BROWSER_TARGET_BROKER_TOKEN = broker.token;
    const clientModule = createJiti(import.meta.url, { interopDefault: true, fsCache: false });
    const { getNativeBrowserTargetId } = clientModule(
      path.join(root, "src", "mastra", "native-browser-target.ts"),
    );
    assert.equal(
      await getNativeBrowserTargetId({ resourceId: "probe-user", threadId: "thread-alpha" }),
      "electron-target-alpha",
    );
    await assert.rejects(
      getNativeBrowserTargetId({ resourceId: "probe-user", threadId: "thread-beta" }),
      /unavailable/,
      "the bridge must not substitute another thread's target",
    );
    const unauthorized = await sendBridgeRequest(broker.endpoint, {
      resourceId: "probe-user",
      threadId: "thread-alpha",
      token: "x".repeat(43),
    });
    assert.deepEqual(unauthorized, { ok: false, error: "unauthorized" });
  } finally {
    if (previousEndpoint === undefined) delete process.env.MASTRA_NATIVE_BROWSER_TARGET_BROKER_PATH;
    else process.env.MASTRA_NATIVE_BROWSER_TARGET_BROKER_PATH = previousEndpoint;
    if (previousToken === undefined) delete process.env.MASTRA_NATIVE_BROWSER_TARGET_BROKER_TOKEN;
    else process.env.MASTRA_NATIVE_BROWSER_TARGET_BROKER_TOKEN = previousToken;
    await broker.close();
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

function sendBridgeRequest(endpoint, request) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint);
    let response = "";
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk) => {
      response += chunk;
      const newline = response.indexOf("\n");
      if (newline < 0) return;
      socket.end();
      try {
        resolve(JSON.parse(response.slice(0, newline)));
      } catch (error) {
        reject(error);
      }
    });
    socket.once("error", reject);
  });
}
