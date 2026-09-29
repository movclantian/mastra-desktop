const http = require("node:http");
const path = require("node:path");
const assert = require("node:assert/strict");
const { app, BrowserWindow, WebContentsView } = require("electron");
const { createJiti } = require("jiti");

const managerOnly = process.env.MASTRA_BROWSER_MANAGER_ONLY === "1";
const agentOnly = process.env.MASTRA_BROWSER_AGENT_ONLY === "1";
if (!managerOnly && !agentOnly) {
  app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
  app.commandLine.appendSwitch("remote-debugging-port", process.env.MASTRA_BROWSER_PROBE_CDP_PORT);
}

const jiti = createJiti(__filename, { interopDefault: true, fsCache: false });
const { NativeBrowserViewManager } = jiti(
  path.resolve(__dirname, "../../src/main/browser-view.ts"),
);
const { NativeBrowserAgentCommandBroker } = jiti(
  path.resolve(__dirname, "../../src/main/browser-target-broker.ts"),
);
const { MAX_NATIVE_BROWSER_TABS } = jiti(
  path.resolve(__dirname, "../../src/shared/browser-contract.ts"),
);

const alpha = { resourceId: "probe-user", threadId: "thread-alpha" };
const beta = { resourceId: "probe-user", threadId: "thread-beta" };
let browserViews;
let window;
let siteServer;
let pauseNextFocus = false;
let focusPaused = false;
let releasePausedFocus;
let pauseNextMouseDispatch = false;
let mouseDispatchPaused = false;
let releasePausedMouseDispatch;
const mouseDispatchTypes = [];
let agentView;
let pendingUiSwitch = false;

function sendJson(response, value) {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

function pageHtml(name) {
  return `<!doctype html>
<html><head><title>probe-${name}</title></head><body>
  <main>Readable page text for probe-${name}.</main>
  <button id="popup" onclick="window.open('/popup', '_blank')">open popup</button>
  <form id="agent-form">
    <label for="query">Search query</label><input id="query" name="query" placeholder="Search query">
    <label for="category">Category</label><select id="category"><option value="docs">Docs</option><option value="code">Code</option></select>
    <button id="submit" type="submit">Submit search</button>
  </form>
  <button id="modifier" onclick="document.querySelector('#result').textContent = 'ctrl:' + event.ctrlKey">Check modifier</button>
  <button id="remove-self" onclick="this.remove()">Remove me</button>
  <p id="result"></p>
  <div id="drag-source" draggable="true" style="width:160px;height:60px;background:#cde">DRAG ME</div>
  <div id="drop-target" style="width:180px;height:80px;margin-top:24px;background:#dec">drop here</div>
  <script>
    window.dragEvents = [];
    for (const type of ['dragstart', 'dragenter', 'dragover', 'drop', 'dragend', 'mousedown', 'mouseup', 'click', 'submit']) {
      window.addEventListener(type, () => window.dragEvents.push(type), true);
    }
    document.querySelector('#drop-target').addEventListener('dragover', event => event.preventDefault());
    document.querySelector('#drop-target').addEventListener('drop', event => {
      event.preventDefault();
      document.querySelector('#drop-target').textContent = 'dropped:' + event.dataTransfer.getData('text/plain');
    });
    document.querySelector('#drag-source').addEventListener('dragstart', event => event.dataTransfer.setData('text/plain', 'probe'));
    document.querySelector('#agent-form').addEventListener('submit', event => {
      event.preventDefault();
      document.querySelector('#result').textContent = 'submitted:' + document.querySelector('#query').value;
    });
  </script>
  <div style="height:1800px"></div>
</body></html>`;
}

app
  .whenReady()
  .then(async () => {
    if (managerOnly) {
      window = new BrowserWindow({
        width: 800,
        height: 600,
        show: false,
        webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
      });
      await window.loadURL("data:text/html,<title>manager-recovery</title>");
      const session = { resourceId: "probe-user", threadId: "thread-recovery" };
      let failFirstCreation = true;
      browserViews = new NativeBrowserViewManager(window, () => {
        if (failFirstCreation) {
          failFirstCreation = false;
          throw new Error("injected transient WebContentsView creation failure");
        }
        return new WebContentsView({
          webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
        });
      });

      await assert.rejects(browserViews.ensure(session), (error) => {
        assert.equal(error.stage, "ensure:create-tab");
        assert.equal(error.cause.stage, "create-tab:create-view");
        return true;
      });
      const recovered = await browserViews.ensure(session);
      assert.equal(recovered.tabs.length, 1, "retry must create one usable tab after rollback");
      const concurrent = await Promise.all([
        browserViews.ensure(session),
        browserViews.ensure(session),
      ]);
      assert.ok(concurrent.every((state) => state.tabs.length === 1));
      assert.equal(browserViews.getState(session).tabs.length, 1);

      const collisionA = { resourceId: "collision:resource", threadId: "thread" };
      const collisionB = { resourceId: "collision", threadId: "resource:thread" };
      await Promise.all([browserViews.ensure(collisionA), browserViews.ensure(collisionB)]);
      assert.notEqual(
        browserViews.getActiveTargetId(collisionA),
        browserViews.getActiveTargetId(collisionB),
        "resource/thread tuples containing separators must not alias the same browser session",
      );

      browserViews.dispose();
      window.destroy();
      process.stdout.write("MANAGER_RECOVERY_PASS\n");
      app.quit();
      return;
    }

    if (agentOnly) {
      siteServer = http.createServer(async (request, response) => {
        const url = new URL(request.url || "/", "http://127.0.0.1");
        if (url.pathname === "/__control/pause-next-focus") {
          pauseNextFocus = true;
          sendJson(response, { ok: true });
          return;
        }
        if (url.pathname === "/__control/focus-state") {
          sendJson(response, { ok: true, paused: focusPaused, pending: pauseNextFocus });
          return;
        }
        if (url.pathname === "/__control/release-focus") {
          releasePausedFocus?.();
          releasePausedFocus = undefined;
          sendJson(response, { ok: true });
          return;
        }
        if (url.pathname === "/__control/pause-next-mouse") {
          pauseNextMouseDispatch = true;
          sendJson(response, { ok: true });
          return;
        }
        if (url.pathname === "/__control/mouse-state") {
          sendJson(response, {
            ok: true,
            paused: mouseDispatchPaused,
            pending: pauseNextMouseDispatch,
          });
          return;
        }
        if (url.pathname === "/__control/release-mouse") {
          releasePausedMouseDispatch?.();
          releasePausedMouseDispatch = undefined;
          sendJson(response, { ok: true });
          return;
        }
        if (url.pathname === "/__control/reset-mouse-log") {
          mouseDispatchTypes.length = 0;
          sendJson(response, { ok: true });
          return;
        }
        if (url.pathname === "/__control/mouse-log") {
          sendJson(response, { ok: true, types: mouseDispatchTypes.slice() });
          return;
        }
        if (url.pathname === "/__control/navigate-page") {
          const pagePath = url.searchParams.get("path") || "/next";
          if (!pagePath.startsWith("/") || !agentView) {
            sendJson(response, { ok: false, error: "invalid page path or missing Agent view" });
            return;
          }
          try {
            await agentView.webContents.loadURL(`${origin}${pagePath}`);
            sendJson(response, { ok: true, url: agentView.webContents.getURL() });
          } catch (error) {
            sendJson(response, { ok: false, error: String(error) });
          }
          return;
        }
        if (url.pathname === "/__control/test-tab-limit") {
          const session = browserViews.sessions.get(
            JSON.stringify([alpha.resourceId, alpha.threadId]),
          );
          const originalTabs = session.tabs;
          session.tabs = Array.from({ length: MAX_NATIVE_BROWSER_TABS }, () => originalTabs[0]);
          try {
            await browserViews.executeAgentCommand(alpha, "tabs", { action: "new" });
            sendJson(response, { ok: false, error: "tab-limit command unexpectedly succeeded" });
          } catch (error) {
            sendJson(response, { ok: true, error: error.reason || String(error) });
          } finally {
            session.tabs = originalTabs;
          }
          return;
        }
        if (url.pathname === "/__control/focus-window") {
          if (window.isMinimized()) window.restore();
          window.show();
          window.focus();
          sendJson(response, {
            ok: true,
            visible: window.isVisible(),
            minimized: window.isMinimized(),
          });
          return;
        }
        if (url.pathname === "/__control/visibility") {
          sendJson(response, {
            ok: true,
            windowVisible: window.isVisible(),
            windowMinimized: window.isMinimized(),
            alpha: browserViews.getState(alpha),
            childBounds: window.contentView.children.map((view) => view.getBounds()),
          });
          return;
        }
        if (url.pathname === "/__control/new-tab") {
          void browserViews
            .action({ ...alpha, request: { action: "new-tab", url: `${origin}/ui-second-tab` } })
            .then((state) => sendJson(response, { ok: true, state }))
            .catch((error) => sendJson(response, { ok: false, error: String(error) }));
          return;
        }
        if (url.pathname === "/__control/switch-tab") {
          const index = Number(url.searchParams.get("index"));
          pendingUiSwitch = true;
          void browserViews
            .action({ ...alpha, request: { action: "switch-tab", index } })
            .then((state) => {
              pendingUiSwitch = false;
              sendJson(response, { ok: true, state });
            })
            .catch((error) => {
              pendingUiSwitch = false;
              sendJson(response, { ok: false, error: String(error) });
            });
          return;
        }
        if (url.pathname === "/__control/switch-state") {
          sendJson(response, {
            ok: true,
            pending: pendingUiSwitch,
            activeTabIndex: browserViews.getState(alpha)?.activeTabIndex,
          });
          return;
        }
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(pageHtml(url.pathname.slice(1) || "home"));
      });
      await new Promise((resolve, reject) => {
        siteServer.once("error", reject);
        siteServer.listen(0, "127.0.0.1", resolve);
      });
      const origin = `http://127.0.0.1:${siteServer.address().port}`;
      window = new BrowserWindow({
        width: 900,
        height: 700,
        show: false,
        webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
      });
      await window.loadURL("data:text/html,<title>probe-shell</title><body>probe shell</body>");
      browserViews = new NativeBrowserViewManager(window, () => {
        const view = new WebContentsView({
          webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
        });
        if (!agentView) {
          agentView = view;
          const debuggerSession = view.webContents.debugger;
          const sendCommand = debuggerSession.sendCommand.bind(debuggerSession);
          debuggerSession.sendCommand = async (method, params) => {
            if (method === "Input.dispatchMouseEvent" && params?.type) {
              mouseDispatchTypes.push(params.type);
            }
            if (
              pauseNextMouseDispatch &&
              method === "Input.dispatchMouseEvent" &&
              params?.type === "mouseMoved"
            ) {
              pauseNextMouseDispatch = false;
              mouseDispatchPaused = true;
              await new Promise((resolve) => {
                releasePausedMouseDispatch = resolve;
              });
              mouseDispatchPaused = false;
            }
            return sendCommand(method, params);
          };
        }
        const executeJavaScript = view.webContents.executeJavaScript.bind(view.webContents);
        Object.defineProperty(view.webContents, "executeJavaScript", {
          configurable: true,
          value: async (code, userGesture) => {
            if (pauseNextFocus) {
              pauseNextFocus = false;
              focusPaused = true;
              await new Promise((resolve) => {
                releasePausedFocus = resolve;
              });
              focusPaused = false;
            }
            return executeJavaScript(code, userGesture);
          },
        });
        return view;
      });
      await browserViews.ensure(alpha);
      await browserViews.setBounds({ ...alpha, x: 0, y: 0, width: 860, height: 640 });
      await browserViews.navigate({ ...alpha, url: `${origin}/home` });
      await browserViews.ensure(beta);
      await browserViews.setBounds({ ...beta, x: 0, y: 0, width: 0, height: 0 });
      window.showInactive();
      const broker = new NativeBrowserAgentCommandBroker(
        (session, operation, input) => browserViews.executeAgentCommand(session, operation, input),
        app.getPath("userData"),
      );
      await broker.start();
      process.stdout.write(
        `AGENT_PROBE_READY ${JSON.stringify({ origin, endpoint: broker.endpoint, token: broker.token })}\n`,
      );
      process.stdin.on("data", () => void broker.close().finally(() => app.quit()));
      setTimeout(() => void broker.close().finally(() => app.quit()), 60_000).unref();
      return;
    }

    siteServer = http.createServer((request, response) => {
      const url = new URL(request.url || "/", "http://127.0.0.1");
      if (url.pathname === "/__state") {
        sendJson(response, {
          alpha: {
            state: browserViews.getState(alpha),
            targetId: browserViews.getActiveTargetId(alpha),
          },
          beta: {
            state: browserViews.getState(beta),
            targetId: browserViews.getActiveTargetId(beta),
          },
        });
        return;
      }
      const name = url.pathname.slice(1) || "empty";
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(pageHtml(name));
    });
    await new Promise((resolve, reject) => {
      siteServer.once("error", reject);
      siteServer.listen(0, "127.0.0.1", resolve);
    });
    const sitePort = siteServer.address().port;
    const origin = `http://127.0.0.1:${sitePort}`;

    window = new BrowserWindow({
      width: 800,
      height: 600,
      show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    await window.loadURL("data:text/html,<title>probe-shell</title><body>probe shell</body>");
    browserViews = new NativeBrowserViewManager(
      window,
      () =>
        new WebContentsView({
          webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
          },
        }),
    );

    await Promise.all([browserViews.ensure(alpha), browserViews.ensure(alpha)]);
    if (browserViews.getState(alpha)?.tabs.length !== 1) {
      throw new Error("concurrent UI and Agent ensure must not create duplicate tabs");
    }
    for (const [session, page] of [
      [alpha, "alpha"],
      [beta, "beta"],
    ]) {
      if (session === beta) await browserViews.ensure(session);
      await browserViews.setBounds({
        ...session,
        x: 0,
        y: 0,
        width: session === alpha ? 780 : 0,
        height: session === alpha ? 520 : 0,
      });
      await browserViews.navigate({ ...session, url: `${origin}/${page}` });
    }
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const states = [browserViews.getState(alpha), browserViews.getState(beta)];
      if (states.every((state) => state?.currentUrl?.includes("/"))) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    process.stdout.write(`PROBE_READY ${JSON.stringify({ origin })}\n`);
    process.stdin.on("data", () => app.quit());
    setTimeout(() => app.quit(), 60_000).unref();
  })
  .catch((error) => {
    process.stderr.write(`${error?.stack || error}\n`);
    let cause = error?.cause;
    while (cause) {
      process.stderr.write(`CAUSE: ${cause?.stack || cause}\n`);
      cause = cause?.cause;
    }
    app.exit(1);
  });

app.on("before-quit", () => {
  browserViews?.dispose();
  siteServer?.close();
});
