import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../src/mastra/routes/browser.ts", import.meta.url), "utf8");
const browserAgentSource = readFileSync(
  new URL("../src/mastra/agents/browser.ts", import.meta.url),
  "utf8",
);
const contractSource = readFileSync(
  new URL("../src/shared/browser-contract.ts", import.meta.url),
  "utf8",
);
const previewSource = readFileSync(
  new URL("../src/renderer/src/shared/ui/ai-elements/web-preview.tsx", import.meta.url),
  "utf8",
);
const omniboxSource = readFileSync(
  new URL("../src/renderer/src/widgets/workspace-drawer/model/browser-omnibox.ts", import.meta.url),
  "utf8",
);
const browserSearchPreferenceSource = readFileSync(
  new URL("../src/renderer/src/shared/browser-search-preference.ts", import.meta.url),
  "utf8",
);
const browserSessionSource = readFileSync(
  new URL(
    "../src/renderer/src/widgets/workspace-drawer/model/use-browser-session.ts",
    import.meta.url,
  ),
  "utf8",
);
const browserViewSource = readFileSync(
  new URL("../src/renderer/src/widgets/workspace-drawer/ui/browser-view.tsx", import.meta.url),
  "utf8",
);
const workspaceShellSource = readFileSync(
  new URL(
    "../src/renderer/src/widgets/workspace-drawer/ui/workspace-panel-shell.tsx",
    import.meta.url,
  ),
  "utf8",
);
const threadQueriesSource = readFileSync(
  new URL("../src/renderer/src/entities/workbench/model/queries/threads.ts", import.meta.url),
  "utf8",
);
const threadBrowserCleanupSource = readFileSync(
  new URL(
    "../src/renderer/src/entities/workbench/model/close-deleted-thread-browser-view.ts",
    import.meta.url,
  ),
  "utf8",
);
const browserSessionModelSource = readFileSync(
  new URL(
    "../src/renderer/src/widgets/workspace-drawer/model/use-browser-session.ts",
    import.meta.url,
  ),
  "utf8",
);
const nativeBrowserSource = readFileSync(
  new URL("../src/main/browser-view.ts", import.meta.url),
  "utf8",
);
const appShellSource = readFileSync(
  new URL("../src/renderer/src/app/app-shell.tsx", import.meta.url),
  "utf8",
);

function loadEnsureBrowserTab(browserGoto) {
  const declarations = ["navigateBrowserTab", "ensureBrowserTab"].map((name) => {
    const match = source.match(
      new RegExp(`^(?:export\\s+)?async function ${name}\\b[\\s\\S]*?^}`, "m"),
    );
    assert.ok(match, `${name} must remain a top-level function`);
    return match[0].replace(/^export\s+/, "");
  });
  const code = stripTypeScriptTypes(declarations.join("\n"));
  const browserInitPromises = new Map();
  const context = vm.createContext({
    browserClosingPromises: new Map(),
    browserInitPromises,
    browserGoto,
    ensureBrowserTabOnce: async () => true,
  });
  const helpers = vm.runInContext(`(() => { ${code}; return { ensureBrowserTab }; })()`, context);
  return { ...helpers, browserInitPromises };
}

function loadRouteHelpers(names, globals = {}) {
  const declarations = names.map((name) => {
    const match = source.match(
      new RegExp(`^(?:export\\s+)?(?:async\\s+)?function ${name}\\b[\\s\\S]*?^}`, "m"),
    );
    assert.ok(match, `${name} must remain a top-level function`);
    return match[0].replace(/^export\\s+/, "");
  });
  const code = stripTypeScriptTypes(declarations.join("\n"));
  const context = vm.createContext({
    withBrowserThreadTarget: (_browser, _threadId, operation) => operation(),
    ...globals,
  });
  const helperNames = names.join(", ");
  return vm.runInContext(`(() => { ${code}; return { ${helperNames} }; })()`, context);
}

function loadPreviewNavigationHelper() {
  const match = previewSource.match(
    /^export async function requestWebPreviewNavigation\b[\s\S]*?^}/m,
  );
  assert.ok(match, "requestWebPreviewNavigation must remain a top-level function");
  const code = stripTypeScriptTypes(match[0].replace(/^export\s+/, ""));
  return vm.runInContext(
    `(() => { ${code}; return requestWebPreviewNavigation; })()`,
    vm.createContext({}),
  );
}

function loadPreviewDraftHelper() {
  const match = previewSource.match(/^export function shouldSubmitWebPreviewDraft\b[\s\S]*?^}/m);
  assert.ok(match, "web preview draft helper must remain a top-level function");
  const code = stripTypeScriptTypes(match[0].replace(/^export\s+/, ""));
  return vm.runInContext(
    `(() => { ${code}; return shouldSubmitWebPreviewDraft; })()`,
    vm.createContext({}),
  );
}

function loadOmniboxResolver() {
  const match = omniboxSource.match(/^export function resolveBrowserOmniboxInput\b[\s\S]*?^}/m);
  assert.ok(match, "browser omnibox resolver must remain a top-level function");
  const code = stripTypeScriptTypes(match[0].replace(/^export\s+/, ""));
  return vm.runInContext(
    `(() => { ${code}; return resolveBrowserOmniboxInput; })()`,
    vm.createContext({ URL, encodeURIComponent }),
  );
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("Navigation submitted during blank-page startup navigates the requested URL", async () => {
  const state = { activeTabIndex: 0, tabs: [{ url: "about:blank" }] };
  const navigations = [];
  const { ensureBrowserTab, browserInitPromises } = loadEnsureBrowserTab(async (_browser, url) => {
    navigations.push(url);
    state.tabs[0].url = url;
    return { success: true };
  });
  const startup = deferred();
  browserInitPromises.set("resource:thread", startup.promise);
  const browser = { getBrowserState: async () => state };

  const navigation = ensureBrowserTab(browser, "resource", "thread", "https://example.com/");
  startup.resolve(true);

  assert.equal(await navigation, true);
  assert.deepEqual(navigations, ["https://example.com/"]);
  assert.equal(state.tabs[state.activeTabIndex].url, "https://example.com/");
});

test("Pending startup that already reached the requested URL does not navigate twice", async () => {
  const state = { activeTabIndex: 0, tabs: [{ url: "https://example.com/" }] };
  const navigations = [];
  const { ensureBrowserTab, browserInitPromises } = loadEnsureBrowserTab(async (_browser, url) => {
    navigations.push(url);
    return { success: true };
  });
  const startup = deferred();
  browserInitPromises.set("resource:thread", startup.promise);
  const browser = { getBrowserState: async () => state };

  const navigation = ensureBrowserTab(browser, "resource", "thread", "https://example.com/");
  startup.resolve(true);

  assert.equal(await navigation, true);
  assert.deepEqual(navigations, []);
});

test("Pending startup with another page leaves navigation to the route caller", async () => {
  const state = { activeTabIndex: 0, tabs: [{ url: "https://other.example/" }] };
  const navigations = [];
  const { ensureBrowserTab, browserInitPromises } = loadEnsureBrowserTab(async (_browser, url) => {
    navigations.push(url);
    return { success: true };
  });
  const startup = deferred();
  browserInitPromises.set("resource:thread", startup.promise);
  const browser = { getBrowserState: async () => state };

  const navigation = ensureBrowserTab(browser, "resource", "thread", "https://example.com/");
  startup.resolve(true);

  assert.equal(await navigation, false);
  assert.deepEqual(navigations, []);
});

test("Browser state exposes the blank user tab and preserves its active index", async () => {
  const { browserState } = loadRouteHelpers(["visibleBrowserTabs", "browserState"], {
    BrowserStateSchema: { parse: (value) => value },
  });
  const browser = {
    getBrowserState: async () => ({
      activeTabIndex: 2,
      tabs: [
        { url: "about:blank" },
        { url: "https://one.example/" },
        { url: "https://two.example/" },
      ],
    }),
    getCurrentUrl: async () => "https://two.example/",
    hasThreadSession: () => true,
    status: "ready",
  };

  const state = await browserState(browser, "thread");
  assert.equal(state.active, true);
  assert.deepEqual(
    Array.from(state.tabs, (tab) => tab.url),
    ["about:blank", "https://one.example/", "https://two.example/"],
  );
  assert.equal(state.activeTabIndex, 2);

  browser.getBrowserState = async () => ({
    activeTabIndex: 0,
    tabs: [{ url: "about:blank" }, { url: "https://one.example/" }],
  });
  browser.getCurrentUrl = async () => "about:blank";
  const blankActiveState = await browserState(browser, "thread");
  assert.equal(blankActiveState.currentUrl, null);
  assert.equal(blankActiveState.activeTabIndex, 0);
});

test("Visible tab actions retain the underlying Chromium tab index", () => {
  const { visibleBrowserTabs } = loadRouteHelpers(["visibleBrowserTabs"]);
  const visibleTabs = visibleBrowserTabs({
    tabs: [
      { url: "about:blank" },
      { url: "https://one.example/" },
      { url: "https://two.example/" },
    ],
  });
  assert.equal(visibleTabs.length, 3);
  assert.equal(visibleTabs[0].index, 0);
  assert.equal(visibleTabs[0].tab.url, "about:blank");
  assert.equal(visibleTabs[1].index, 1);
  assert.equal(visibleTabs[1].tab.url, "https://one.example/");
  assert.equal(visibleTabs[2].index, 2);
  assert.equal(visibleTabs[2].tab.url, "https://two.example/");
  assert.match(source, /const rawIndex = visibleTabs\[body\.index\]\?\.index/);
});

test("Forward treats a destroyed context as success only after URL navigation", async () => {
  const { browserForward } = loadRouteHelpers(["browserForward"]);
  const browser = {
    getCurrentUrl: async () => "https://before.example/",
    evaluate: async () => {
      throw new Error("Execution context was destroyed, most likely because of a navigation");
    },
    hasThreadSession: () => true,
    getBrowserState: async () => ({
      activeTabIndex: 0,
      tabs: [{ url: "https://after.example/" }],
    }),
  };

  assert.equal((await browserForward(browser, "thread")).success, true);
  await assert.rejects(
    browserForward(
      { ...browser, getBrowserState: async () => ({ tabs: [{ url: "https://before.example/" }] }) },
      "thread",
    ),
    /Execution context was destroyed/,
  );
  await assert.rejects(
    browserForward({ ...browser, hasThreadSession: () => false }, "thread"),
    /Execution context was destroyed/,
  );
});

test("Reload navigates to the current URL and uses the restored home for blank tabs", async () => {
  const navigations = [];
  const { browserReload } = loadRouteHelpers(["getBrowserHomeUrl", "browserReload"], {
    getBrowserConfig: async () => ({ homeUrl: "https://www.bing.com" }),
    withBrowserThreadTarget: (_browser, _threadId, operation) => operation(),
  });
  const browser = {
    getCurrentUrl: async () => "https://current.example/",
    goto: async ({ url }) => {
      navigations.push(url);
      return { success: true };
    },
  };

  await browserReload(browser, "thread");
  await browserReload(
    {
      getCurrentUrl: async () => "about:blank",
      goto: async ({ url }) => {
        navigations.push(url);
        return { success: true };
      },
    },
    "thread",
  );
  assert.deepEqual(navigations, ["https://current.example/", "https://www.bing.com"]);
});

test("The user panel and Agent reuse one thread browser while Bing stays opt-in", () => {
  assert.match(source, /const FALLBACK_BROWSER_HOME_URL = "about:blank"/);
  assert.match(contractSource, /homeUrl: BrowserHomeUrlSchema\.default\(""\)/);
  assert.match(browserAgentSource, /homeUrl: ""/);
  assert.doesNotMatch(source, /getUserBrowserForResource/);
  assert.doesNotMatch(browserAgentSource, /BrowserSessionKind/);
  assert.match(browserAgentSource, /getBrowserForThread\(/);
  assert.match(browserAgentSource, /getNativeBrowserTargetId/);
  assert.match(browserAgentSource, /selectNativeElectronPage/);
  assert.match(source, /getBrowserForThread\(resourceId, threadId\)/);
  assert.match(nativeBrowserSource, /getActiveTargetId\(/);
});

test("Native browser metadata and restored panel layout stay bounded", () => {
  assert.match(nativeBrowserSource, /MAX_TAB_TITLE_LENGTH = 1_024/);
  assert.match(nativeBrowserSource, /value\.slice\(0, MAX_TAB_TITLE_LENGTH - 1\)/);
  assert.match(nativeBrowserSource, /NativeBrowserEventSchema\.safeParse\(rawEvent\)/);
  assert.match(nativeBrowserSource, /render-process-gone/);
  assert.match(appShellSource, /MAX_RESTORED_WORKSPACE_PERCENT = 42/);
  assert.match(appShellSource, /MAX_WORKSPACE_WIDTH = 760/);
  assert.match(appShellSource, /groupResizeBehavior="preserve-relative-size"/);
});

test("Native browser opens web popups in a new app tab instead of replacing the current page", () => {
  assert.match(nativeBrowserSource, /setWindowOpenHandler\(\(\{ url \}\) => \{/);
  assert.match(
    nativeBrowserSource,
    /if \(isWebUrl\(url\)\) \{\s*void this\.createTab\(current, url\)/,
  );
  assert.match(nativeBrowserSource, /return \{ action: "deny" \};/);
});

test("Address bar commits the navigated URL only after navigation succeeds", async () => {
  const requestNavigation = loadPreviewNavigationHelper();
  assert.equal(
    await requestNavigation("https://github.com/", async () => "https://github.com/"),
    "https://github.com/",
  );
  assert.equal(await requestNavigation("https://github.com/", async () => false), null);
  assert.equal(
    await requestNavigation("https://github.com/", async () => {
      throw new Error("navigation failed");
    }),
    null,
  );
  assert.match(previewSource, /const destination = resolveUrl \? resolveUrl\(newUrl\) : newUrl/);
  assert.match(
    browserViewSource,
    /resolveUrl=\{\(input\) => resolveBrowserOmniboxInput\(input, searchEngine\)\?\.url \?\? null\}/,
  );
});

test("Browser omnibox navigates URLs and searches through the selected engine", () => {
  const resolve = loadOmniboxResolver();
  const assertResolution = (input, expected, engine) =>
    assert.equal(JSON.stringify(resolve(input, engine)), JSON.stringify(expected));
  assertResolution("https://example.com/path", {
    kind: "navigate",
    url: "https://example.com/path",
  });
  assertResolution("github.com/docs", {
    kind: "navigate",
    url: "https://github.com/docs",
  });
  assertResolution("localhost:5173", {
    kind: "navigate",
    url: "http://localhost:5173/",
  });
  assertResolution("github", {
    kind: "search",
    url: "https://www.bing.com/search?q=github",
  });
  assertResolution("如何使用 Mastra", {
    kind: "search",
    url: "https://www.bing.com/search?q=%E5%A6%82%E4%BD%95%E4%BD%BF%E7%94%A8%20Mastra",
  });
  assertResolution("site:github.com electron", {
    kind: "search",
    url: "https://www.bing.com/search?q=site%3Agithub.com%20electron",
  });
  assertResolution(
    "electron 内置浏览器",
    {
      kind: "search",
      url: "https://www.baidu.com/s?wd=electron%20%E5%86%85%E7%BD%AE%E6%B5%8F%E8%A7%88%E5%99%A8",
    },
    "baidu",
  );
  assertResolution(
    "github",
    { kind: "search", url: "https://www.google.com/search?q=github" },
    "google",
  );
  assertResolution("ftp://example.com", {
    kind: "search",
    url: "https://www.bing.com/search?q=ftp%3A%2F%2Fexample.com",
  });
  assert.equal(resolve("https://user:secret@example.com"), null);
  assert.equal(resolve("   "), null);
});

test("Browser search-engine preference is local, user-scoped and live-updated", () => {
  const names = [
    "storageKey",
    "getBrowserSearchEnginePreference",
    "setBrowserSearchEnginePreference",
    "subscribeBrowserSearchEnginePreference",
  ];
  const declarations = names.map((name) => {
    const match = browserSearchPreferenceSource.match(
      new RegExp(`^(?:export\\s+)?function ${name}\\b[\\s\\S]*?^}`, "m"),
    );
    assert.ok(match, `${name} must remain a top-level function`);
    return match[0].replace(/^export\s+/, "");
  });
  const storage = new Map();
  const listeners = new Map();
  const fakeWindow = {
    dispatchEvent(event) {
      for (const listener of listeners.get(event.type) ?? []) listener(event);
    },
    addEventListener(type, listener) {
      const entries = listeners.get(type) ?? [];
      entries.push(listener);
      listeners.set(type, entries);
    },
    removeEventListener(type, listener) {
      listeners.set(
        type,
        (listeners.get(type) ?? []).filter((entry) => entry !== listener),
      );
    },
  };
  class FakeCustomEvent {
    constructor(type, init) {
      this.type = type;
      this.detail = init.detail;
    }
  }
  const schema = {
    safeParse(value) {
      return ["bing", "baidu", "google"].includes(value)
        ? { success: true, data: value }
        : { success: false };
    },
  };
  const code = stripTypeScriptTypes(declarations.join("\n"));
  const context = vm.createContext({
    CHANGE_EVENT: "mastra:browser-search-engine-changed",
    BrowserSearchEngineSchema: schema,
    CustomEvent: FakeCustomEvent,
    STORAGE_KEY_PREFIX: "mastra-work:browser-search-engine",
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
    },
    window: fakeWindow,
  });
  const helpers = vm.runInContext(
    `(() => { ${code}; return { getBrowserSearchEnginePreference, setBrowserSearchEnginePreference, subscribeBrowserSearchEnginePreference }; })()`,
    context,
  );
  let currentEngine = helpers.getBrowserSearchEnginePreference("owner-a");
  assert.equal(currentEngine, "bing");
  const unsubscribe = helpers.subscribeBrowserSearchEnginePreference("owner-a", (engine) => {
    currentEngine = engine;
  });
  helpers.setBrowserSearchEnginePreference("owner-b", "google");
  assert.equal(currentEngine, "bing");
  helpers.setBrowserSearchEnginePreference("owner-a", "baidu");
  assert.equal(currentEngine, "baidu");
  assert.equal(helpers.getBrowserSearchEnginePreference("owner-a"), "baidu");
  assert.equal(helpers.getBrowserSearchEnginePreference("owner-b"), "google");
  unsubscribe();
  assert.match(browserViewSource, /resolveBrowserOmniboxInput\(input, searchEngine\)/);
});

test("Refresh submits a changed address-bar draft before reloading", () => {
  const shouldSubmitDraft = loadPreviewDraftHelper();
  assert.equal(shouldSubmitDraft("https://example.org/", "https://example.com/"), true);
  assert.equal(shouldSubmitDraft("  https://example.com/  ", "https://example.com/"), false);
  assert.equal(shouldSubmitDraft("   ", "https://example.com/"), false);
  assert.match(previewSource, /submitDraft/);
  assert.match(browserViewSource, /if \(shouldSubmitWebPreviewDraft\(draftUrl, url\)\)/);
  assert.match(browserViewSource, /await submitDraft\(\);\s*return;/);
  assert.match(browserViewSource, /await action\("reload"\)/);
});

test("Browser prevents overlapping address navigation and disables the input while busy", () => {
  assert.match(browserSessionSource, /busyRef\.current\) return false/);
  assert.match(browserViewSource, /<WebPreviewUrl disabled=\{busy\} \/>/);
});

test("Navigation keeps the last frame while accepting destination frames from the current stream", () => {
  const helper = browserSessionModelSource.match(
    /^export function isCurrentBrowserStreamEvent\b[\s\S]*?^}/m,
  );
  assert.ok(helper, "browser stream events must be guarded by their stream generation");
  const isCurrentBrowserStreamEvent = vm.runInContext(
    `(() => { ${stripTypeScriptTypes(helper[0].replace(/^export\s+/, ""))}; return isCurrentBrowserStreamEvent; })()`,
    vm.createContext({}),
  );
  assert.equal(isCurrentBrowserStreamEvent(3, 3), true);
  assert.equal(isCurrentBrowserStreamEvent(2, 3), false);
  assert.match(
    browserSessionSource,
    /if \(!isCurrentBrowserStreamEvent\(streamEpoch, frameStreamEpochRef\.current\)\)/,
  );
  assert.match(
    browserSessionSource,
    /const navigate = React\.useCallback\([\s\S]*?pendingNavigationRef\.current = true;[\s\S]*?setBusy\(true\);/,
  );
  const actionStart = browserSessionSource.indexOf("const action = React.useCallback");
  const actionEnd = browserSessionSource.indexOf("// 当处于浏览器面板且无标签时", actionStart);
  const actionBody =
    actionStart >= 0 && actionEnd > actionStart
      ? browserSessionSource.slice(actionStart, actionEnd)
      : undefined;
  assert.ok(actionBody, "browser action callback must remain explicit");
  assert.doesNotMatch(actionBody, /pendingNavigationRef\.current = true;\s*clearFrame\(\)/);
  const navigationBranch = browserSessionSource.match(
    /if \(navigationPending\) \{[\s\S]*?\n\s+\}/,
  )?.[0];
  assert.ok(navigationBranch, "navigation URL event branch must remain explicit");
  assert.doesNotMatch(navigationBranch, /clearFrame\(\)/);
  const urlEventBranch = browserSessionSource.match(
    /if \(navigationPending\) \{[\s\S]*?\n\s+\} else if \(eventName === "stop"\)/,
  )?.[0];
  assert.ok(urlEventBranch, "URL event branch must remain explicit");
  assert.doesNotMatch(urlEventBranch, /urlChanged/);
  assert.doesNotMatch(urlEventBranch, /setScreencastAttempt/);
  assert.match(browserViewSource, /items-start justify-center/);
  assert.match(source, /BROWSER_STREAM_QUALITY = 60/);
  assert.match(source, /maxWidth: BROWSER_STREAM_MAX_WIDTH/);
  assert.match(source, /maxHeight: BROWSER_STREAM_MAX_HEIGHT/);
  assert.match(source, /scheduleSnapshot\(350\)/);
  assert.match(source, /scheduleSnapshot\(250\)/);
});

test("Screencast throttles frames and serializes only the newest frame when flushing", () => {
  assert.match(source, /everyNthFrame: 2/);
  assert.match(source, /if \(event === "frame"\) \{[\s\S]*?pendingFrame = value;/);
  assert.match(source, /JSON\.stringify\(frame\)/);
});

test("Browser input batches key events and decodes frames before swapping them", () => {
  assert.match(source, /browserKeyboardBatchRoute/);
  assert.match(
    contractSource,
    /events: z\.array\(BrowserKeyboardRequestSchema\)\.min\(1\)\.max\(64\)/,
  );
  assert.match(browserSessionSource, /sendBrowserKeyboardBatch/);
  assert.match(browserSessionSource, /keyboardQueueRef/);
  assert.match(browserSessionSource, /setTimeout\(flushKeyboardQueue, 8\)/);
  assert.match(browserViewSource, /const BrowserLiveFrame = React\.memo/);
  assert.match(browserViewSource, /image\.onload = \(\) =>/);
  assert.match(previewSource, /WebPreviewUrl = memo\(function WebPreviewUrl/);
  assert.match(previewSource, /const isEditing = document\.activeElement === inputRef\.current/);
  assert.match(previewSource, /onChange=\{handleChange\}/);
});

test("Browser actions reject overlapping operations and keep tabs readable", () => {
  assert.match(
    browserSessionSource,
    /if \(!stateUrl \|\| !activeThreadId \|\| busyRef\.current\) return;/,
  );
  assert.match(workspaceShellSource, /min-w-0 shrink-0 items-center gap-1\.5/);
  assert.match(workspaceShellSource, /NEW_TAB_MENU_OVERLAY_INSET = 64/);
  assert.match(workspaceShellSource, /onOpenChange=\{setNewTabMenuOpen\}/);
  assert.match(browserViewSource, /nativeOverlayInsetTop/);
});

test("Deleting a thread closes its native browser target without failing deletion UI", async () => {
  const helper = threadBrowserCleanupSource.match(
    /^export async function closeDeletedThreadBrowserView\b[\s\S]*?^}/m,
  );
  assert.ok(helper, "thread deletion must use a testable native-view cleanup helper");
  const closeDeletedThreadBrowserView = vm.runInContext(
    `(() => { ${stripTypeScriptTypes(helper[0].replace(/^export\s+/, ""))}; return closeDeletedThreadBrowserView; })()`,
    vm.createContext({ console: { error() {} } }),
  );

  const closed = [];
  await closeDeletedThreadBrowserView(
    { close: async (session) => closed.push(session) },
    { resourceId: "owner-a", threadId: "deleted-thread" },
  );
  assert.deepEqual(closed, [{ resourceId: "owner-a", threadId: "deleted-thread" }]);
  await closeDeletedThreadBrowserView(undefined, {
    resourceId: "owner-a",
    threadId: "legacy-thread",
  });
  await closeDeletedThreadBrowserView(
    {
      close: async () => {
        throw new Error("window already closed");
      },
    },
    { resourceId: "owner-a", threadId: "closed-window-thread" },
  );
  assert.match(
    threadQueriesSource,
    /closeDeletedThreadBrowserView\(window\.api\?\.browserView,\s*\{[\s\S]*?resourceId: userId,[\s\S]*?threadId,/,
  );
});

test("Browser pointer input rejects stale geometry and clamps valid viewport coordinates", () => {
  const helper = browserSessionSource.match(
    /^export function mapBrowserPointerToViewport\b[\s\S]*?^}/m,
  );
  assert.ok(helper, "pointer mapping must remain a pure helper");
  const mapBrowserPointerToViewport = vm.runInContext(
    `(() => { ${stripTypeScriptTypes(helper[0].replace(/^export\s+/, ""))}; return mapBrowserPointerToViewport; })()`,
    vm.createContext({}),
  );
  const bounds = { left: 100, top: 50, width: 200, height: 100 };
  const coordinates = mapBrowserPointerToViewport(200, 100, bounds, {
    width: 1000,
    height: 500,
  });
  assert.ok(coordinates);
  assert.equal(coordinates.x, 500);
  assert.equal(coordinates.y, 250);
  assert.equal(
    mapBrowserPointerToViewport(99, 100, bounds, { width: 1000, height: 500 }),
    undefined,
  );
  assert.equal(
    mapBrowserPointerToViewport(200, 100, { ...bounds, width: 0 }, { width: 1000, height: 500 }),
    undefined,
  );
  assert.match(browserSessionSource, /stateRef\.current\.status === "closing"/);
  assert.match(browserSessionSource, /void sendBrowserMouse[\s\S]*?catch\(\(\) => undefined\)/);
});

test("Native browser disposal tolerates already-destroyed windows and webContents", () => {
  const declaration = nativeBrowserSource.match(/^ {2}dispose\(\): void \{[\s\S]*?^ {2}\}/m);
  assert.ok(declaration, "native browser manager must expose a testable dispose method");
  const dispose = vm.runInNewContext(
    `({${declaration[0].replace("dispose(): void", "dispose()")}}).dispose`,
    vm.createContext({}),
  );

  const runDispose = (windowDestroyed, webContentsDestroyed) => {
    const calls = [];
    const tab = {
      view: {
        webContents: {
          isDestroyed: () => webContentsDestroyed,
          close: () => calls.push("close"),
        },
      },
    };
    const window = {
      isDestroyed: () => windowDestroyed,
      contentView: { removeChildView: () => calls.push("remove") },
    };
    dispose.call({
      window,
      sessions: new Map([["session", { tabs: [tab] }]]),
      ensurePromises: new Map([["session", Promise.resolve()]]),
    });
    return calls;
  };

  assert.deepEqual(runDispose(true, true), []);
  assert.deepEqual(runDispose(true, false), ["close"]);
  assert.deepEqual(runDispose(false, false), ["remove", "close"]);
});

test("Closed CDP pages do not turn stale input into unhandled route failures", () => {
  assert.match(source, /function isClosedBrowserContextError/);
  assert.match(source, /if \(!isClosedBrowserContextError\(error\)\) throw error/);
  assert.match(source, /screencast\.stop\(\)\.catch\(\(\) => undefined\)/);
});
