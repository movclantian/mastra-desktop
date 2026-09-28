const http = require("node:http");
const path = require("node:path");
const { app, BrowserWindow, WebContentsView } = require("electron");
const { createJiti } = require("jiti");

app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
app.commandLine.appendSwitch("remote-debugging-port", process.env.MASTRA_BROWSER_PROBE_CDP_PORT);

const jiti = createJiti(__filename, { interopDefault: true, fsCache: false });
const { NativeBrowserViewManager } = jiti(
  path.resolve(__dirname, "../../src/main/browser-view.ts"),
);

const alpha = { resourceId: "probe-user", threadId: "thread-alpha" };
const beta = { resourceId: "probe-user", threadId: "thread-beta" };
let browserViews;
let window;
let siteServer;

function sendJson(response, value) {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

function pageHtml(name) {
  return `<!doctype html><html><head><title>probe-${name}</title></head><body><main>probe-${name}</main><button id="popup" onclick="window.open('/popup', '_blank')">open popup</button></body></html>`;
}

app
  .whenReady()
  .then(async () => {
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

    for (const [session, page] of [
      [alpha, "alpha"],
      [beta, "beta"],
    ]) {
      await browserViews.ensure(session);
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
    app.exit(1);
  });

app.on("before-quit", () => {
  browserViews?.dispose();
  siteServer?.close();
});
