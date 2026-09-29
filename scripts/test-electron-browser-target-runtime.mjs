import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createJiti } from "jiti";

const root = path.resolve(import.meta.dirname, "..");
const probeApp = path.join(root, "tests", "electron-native-browser-target");
const managerOnly = process.argv.includes("--manager-only");
const electronPath =
  process.env.MASTRA_TEST_ELECTRON_PATH?.trim() || createRequire(import.meta.url)("electron");

if (managerOnly) {
  await verifyManagerRecovery();
} else {
  await verifyNativeAgentCommands();
}

async function verifyManagerRecovery() {
  const fixture = await startFixture("MANAGER_RECOVERY_PASS");
  try {
    await fixture.ready;
    await fixture.waitForExit();
    assert.equal(fixture.child.exitCode, 0, `Electron manager test failed: ${fixture.output()}`);
    process.stdout.write("Electron browser ensure rollback/retry: PASS\n");
  } finally {
    await fixture.stop();
  }
}

async function verifyNativeAgentCommands() {
  const fixture = await startFixture("AGENT_PROBE_READY", "agent");
  const previousPath = process.env.MASTRA_NATIVE_BROWSER_AGENT_BROKER_PATH;
  const previousToken = process.env.MASTRA_NATIVE_BROWSER_AGENT_BROKER_TOKEN;
  try {
    const line = await fixture.ready;
    const ready = JSON.parse(line);
    process.env.MASTRA_NATIVE_BROWSER_AGENT_BROKER_PATH = ready.endpoint;
    process.env.MASTRA_NATIVE_BROWSER_AGENT_BROKER_TOKEN = ready.token;
    const bridgeJiti = createJiti(import.meta.url, { interopDefault: true, fsCache: false });
    const { executeNativeBrowserCommand } = bridgeJiti(
      path.join(root, "src", "mastra", "native-browser-target.ts"),
    );
    const { NativeElectronAgentBrowser } = bridgeJiti(
      path.join(root, "src", "mastra", "agents", "browser.ts"),
    );
    const session = { resourceId: "probe-user", threadId: "thread-alpha" };
    const ensureFixtureVisible = async () => {
      const response = await fetch(`${ready.origin}/__control/focus-window`);
      assert.equal(response.ok, true, "fixture visibility control must respond successfully");
      const state = await response.json();
      assert.equal(state.visible, true);
      assert.equal(state.minimized, false);
      return state;
    };
    const browser = new NativeElectronAgentBrowser(
      { scope: "shared", headless: true, viewport: { width: 1280, height: 720 }, timeout: 30_000 },
      session.resourceId,
      session.threadId,
    );
    const browserTools = browser.getTools();
    const runTool = async (name, input) => {
      await ensureFixtureVisible();
      const tool = browserTools[name];
      assert.ok(tool?.execute, `AgentBrowser must expose ${name}`);
      const result = await tool.execute(input, { agent: { threadId: session.threadId } });
      if (result?.success === false || result?.error) {
        const visibility = await fetch(`${ready.origin}/__control/visibility`)
          .then((response) => response.json())
          .catch((error) => ({ error: String(error) }));
        assert.fail(
          `${name} failed: ${JSON.stringify(result)}\nVisibility: ${JSON.stringify(visibility)}\nElectron fixture log: ${fixture.output()}`,
        );
      }
      assert.ok(
        result?.success !== false && !result?.error,
        `${name} failed: ${JSON.stringify(result)}\nElectron fixture log: ${fixture.output()}`,
      );
      return result;
    };
    await ensureFixtureVisible();
    await waitFor(
      async () => ((await executeNativeBrowserCommand(session, "state")).visible ? true : null),
      5_000,
      "visible current-thread browser page",
      fixture.child,
      fixture.output,
    );
    const stateResult = await executeNativeBrowserCommand(session, "state");
    assert.equal(
      stateResult.visible,
      true,
      `state must identify the visible current-thread page: ${JSON.stringify(stateResult)}`,
    );
    assert.match(stateResult.state.currentUrl, /\/home$/);

    const initial = await runTool("browser_snapshot", { interactiveOnly: false });
    assert.match(initial.snapshot, /button|textbox|combobox/);
    assert.match(initial.snapshot, /Page text:[\s\S]*Readable page text for probe-home/);
    assert.ok(initial.elementCount > 0);

    const navigation = await runTool("browser_goto", {
      url: `${ready.origin}/form`,
      timeout: 15_000,
    });
    assert.match(navigation.url, /\/form$/);
    const firstSnapshot = await runTool("browser_snapshot", { interactiveOnly: true });
    const firstQueryRef = firstSnapshot.snapshot.match(
      /textbox "Search query".*\[ref=(e\d+)\]/,
    )?.[1];
    const snapshot = await runTool("browser_snapshot", { interactiveOnly: true });
    const queryRef = snapshot.snapshot.match(/textbox "Search query".*\[ref=(e\d+)\]/)?.[1];
    const selectRef = snapshot.snapshot.match(
      /combobox "Category" \[value="docs"\] \[ref=(e\d+)\]/,
    )?.[1];
    const submitRef = snapshot.snapshot.match(/button "Submit search" \[ref=(e\d+)\]/)?.[1];
    const modifierRef = snapshot.snapshot.match(/button "Check modifier" \[ref=(e\d+)\]/)?.[1];
    const removeRef = snapshot.snapshot.match(/button "Remove me" \[ref=(e\d+)\]/)?.[1];
    assert.ok(
      queryRef && selectRef && submitRef && modifierRef && removeRef,
      `snapshot must expose usable refs: ${snapshot.snapshot}`,
    );
    assert.notEqual(queryRef, firstQueryRef, "refreshing a snapshot must not recycle old refs");
    await assert.rejects(
      executeNativeBrowserCommand(session, "click", { ref: firstQueryRef }),
      /stale_ref/,
      "refs from a prior snapshot must be rejected even when the same element remains present",
    );

    const typed = await runTool("browser_type", {
      ref: queryRef,
      text: "mastra browser",
      clear: true,
    });
    assert.equal(typed.value, "mastra browser");
    const inputValue = await runTool("browser_evaluate", {
      script: "document.querySelector('#query').value",
    });
    assert.equal(inputValue.result, "mastra browser", "type must reach the real WebContents DOM");

    const selected = await runTool("browser_select", {
      ref: selectRef,
      value: "code",
    });
    assert.deepEqual(selected.selected, ["code"]);
    const dragged = await runTool("browser_drag", {
      sourceSelector: "#drag-source",
      targetSelector: "#drop-target",
    });
    for (const event of ["dragstart", "dragenter", "dragover", "drop", "dragend"]) {
      assert.ok(
        dragged.observedEvents.includes(event),
        `drag must deliver ${event}: ${JSON.stringify(dragged)}`,
      );
    }
    const dropped = await runTool("browser_evaluate", {
      script: "document.querySelector('#drop-target').textContent",
    });
    assert.equal(dropped.result, "dropped:probe", "drag must cause a real HTML drop on the target");
    await runTool("browser_scroll", { direction: "up", amount: 10_000 });
    const postDragSnapshot = await runTool("browser_snapshot", { interactiveOnly: true });
    const postDragSubmitRef = postDragSnapshot.snapshot.match(
      /button "Submit search" \[ref=(e\d+)\]/,
    )?.[1];
    const postDragModifierRef = postDragSnapshot.snapshot.match(
      /button "Check modifier" \[ref=(e\d+)\]/,
    )?.[1];
    const postDragRemoveRef = postDragSnapshot.snapshot.match(
      /button "Remove me" \[ref=(e\d+)\]/,
    )?.[1];
    assert.ok(
      postDragSubmitRef && postDragModifierRef && postDragRemoveRef,
      "click after drag needs fresh, visible button refs",
    );
    await runTool("browser_click", { ref: postDragSubmitRef });
    const submitted = await runTool("browser_evaluate", {
      script:
        "JSON.stringify({ result: document.querySelector('#result').textContent, dragEvents: window.dragEvents, focused: document.activeElement?.id, submitRect: (() => { const rect = document.querySelector('#submit').getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }; })() })",
    });
    const submittedState = JSON.parse(submitted.result);
    assert.equal(
      submittedState.result,
      "submitted:mastra browser",
      `click must dispatch a page event after drag: ${JSON.stringify({ submittedState, dragged })}`,
    );
    await runTool("browser_click", { ref: postDragModifierRef, modifiers: ["Control"] });
    const modifierResult = await runTool("browser_evaluate", {
      script: "document.querySelector('#result').textContent",
    });
    assert.equal(
      modifierResult.result,
      "ctrl:true",
      "standard AgentBrowser modifier names must be honored",
    );
    await runTool("browser_click", { ref: postDragRemoveRef });
    await runTool("browser_wait", { ref: postDragRemoveRef, state: "detached", timeout: 1_000 });

    const scrolled = await runTool("browser_scroll", {
      direction: "down",
      amount: 500,
    });
    assert.ok(scrolled.position.y > 0, "scroll must change the page position");
    const screenshot = await runTool("browser_screenshot", {});
    assert.equal(
      Buffer.from(screenshot.base64, "base64").subarray(0, 8).toString("hex"),
      "89504e470d0a1a0a",
    );
    assert.ok(screenshot.viewport.width > 0 && screenshot.viewport.height > 0);

    await executeNativeBrowserCommand(session, "goto", { url: `${ready.origin}/next` });
    const back = await runTool("browser_back", {});
    const currentPage = await runTool("browser_evaluate", {
      script: "JSON.stringify({ url: location.href, title: document.title })",
    });
    const currentPageState = JSON.parse(currentPage.result);
    assert.match(back.url, /\/form$/);
    assert.equal(
      back.url,
      currentPageState.url,
      "back must report the page after navigation settles",
    );
    assert.equal(back.title, currentPageState.title);
    await executeNativeBrowserCommand(session, "goto", { url: `${ready.origin}/next` });
    await assert.rejects(
      executeNativeBrowserCommand(session, "click", { ref: submitRef }),
      /stale_ref/,
      "navigation must invalidate old element refs",
    );
    const hiddenThread = await executeNativeBrowserCommand(
      { resourceId: "probe-user", threadId: "thread-beta" },
      "state",
    );
    assert.equal(hiddenThread.visible, false);
    await assert.rejects(
      executeNativeBrowserCommand({ resourceId: "probe-user", threadId: "thread-beta" }, "goto", {
        url: `${ready.origin}/should-not-open`,
      }),
      /session_not_visible/,
      "Agent must not act on a hidden page belonging to another thread",
    );
    await assert.rejects(
      executeNativeBrowserCommand(
        { resourceId: "probe-user", threadId: "thread-missing" },
        "goto",
        { url: `${ready.origin}/should-not-open` },
      ),
      /session_not_found/,
      "Agent must not create an unbound browser session",
    );

    const listedTabs = await runTool("browser_tabs", { action: "list" });
    assert.equal(listedTabs.tabs.length, 1);
    const newTab = await runTool("browser_tabs", {
      action: "new",
      url: `${ready.origin}/second-tab`,
    });
    assert.equal(newTab.index, 1);
    assert.match(newTab.url, /\/second-tab$/);
    const switchedBack = await runTool("browser_tabs", { action: "switch", index: 0 });
    assert.match(switchedBack.url, /\/next$/);
    await runTool("browser_tabs", { action: "switch", index: 1 });
    const closedTab = await runTool("browser_tabs", { action: "close", index: 1 });
    assert.equal(closedTab.remaining, 1, "close must report the actual remaining tab count");
    assert.equal((await runTool("browser_tabs", { action: "list" })).tabs.length, 1);

    const control = async (path) => {
      const response = await fetch(`${ready.origin}/__control/${path}`);
      assert.equal(response.ok, true, `fixture control ${path} must respond successfully`);
      const result = await response.json();
      assert.equal(result.ok, true, `fixture control ${path} failed: ${JSON.stringify(result)}`);
      return result;
    };
    const tabLimit = await control("test-tab-limit");
    assert.equal(tabLimit.error, "tab_limit_reached");

    await runTool("browser_goto", { url: `${ready.origin}/form` });
    const navigationRaceSnapshot = await runTool("browser_snapshot", { interactiveOnly: true });
    const navigationRaceSubmitRef = navigationRaceSnapshot.snapshot.match(
      /button "Submit search" \[ref=(e\d+)\]/,
    )?.[1];
    assert.ok(navigationRaceSubmitRef, "navigation race test needs a fresh submit ref");
    await control("reset-mouse-log");
    await control("pause-next-mouse");
    const racingClick = executeNativeBrowserCommand(session, "click", {
      ref: navigationRaceSubmitRef,
    });
    await waitFor(
      async () => ((await control("mouse-state")).paused ? true : null),
      5_000,
      "Agent mouse dispatch to pause between geometry read and click",
      fixture.child,
      fixture.output,
    );
    const navigationResponse = await fetch(
      `${ready.origin}/__control/navigate-page?path=/navigation-race-target`,
    );
    const navigationResult = await navigationResponse.json();
    assert.equal(navigationResponse.ok, true);
    assert.equal(navigationResult.ok, true, JSON.stringify(navigationResult));
    await control("release-mouse");
    assert.deepEqual(
      (await control("mouse-log")).types,
      ["mouseMoved"],
      "a click must not dispatch mousePressed into the destination document",
    );
    await assert.rejects(
      racingClick,
      /document_changed/,
      "a document navigation after geometry lookup must stop the pending click",
    );
    const afterNavigationRace = await runTool("browser_evaluate", {
      script:
        "JSON.stringify({ path: location.pathname, result: document.querySelector('#result').textContent })",
    });
    assert.deepEqual(JSON.parse(afterNavigationRace.result), {
      path: "/navigation-race-target",
      result: "",
    });

    await control("reset-mouse-log");
    await control("pause-next-mouse");
    const racingDrag = executeNativeBrowserCommand(session, "drag", {
      sourceSelector: "#drag-source",
      targetSelector: "#drop-target",
    });
    await waitFor(
      async () => ((await control("mouse-state")).paused ? true : null),
      5_000,
      "Agent drag dispatch to pause between geometry read and mouse press",
      fixture.child,
      fixture.output,
    );
    const dragNavigationResponse = await fetch(
      `${ready.origin}/__control/navigate-page?path=/drag-navigation-target`,
    );
    const dragNavigationResult = await dragNavigationResponse.json();
    assert.equal(dragNavigationResponse.ok, true);
    assert.equal(dragNavigationResult.ok, true, JSON.stringify(dragNavigationResult));
    await control("release-mouse");
    assert.deepEqual(
      (await control("mouse-log")).types,
      ["mouseMoved"],
      "a drag must not dispatch mousePressed into the destination document",
    );
    await assert.rejects(
      racingDrag,
      /document_changed/,
      "a document navigation during the first drag dispatch must abort the drag",
    );
    const afterDragNavigationRace = await runTool("browser_evaluate", {
      script:
        "JSON.stringify({ path: location.pathname, dropTarget: document.querySelector('#drop-target').textContent, events: window.dragEvents })",
    });
    assert.deepEqual(JSON.parse(afterDragNavigationRace.result), {
      path: "/drag-navigation-target",
      dropTarget: "drop here",
      events: [],
    });

    const uiTabs = await control("new-tab");
    assert.equal(uiTabs.state.activeTabIndex, 1);
    await control("switch-tab?index=0");
    const setupSnapshot = await runTool("browser_snapshot", { interactiveOnly: true });
    const setupInputRef = setupSnapshot.snapshot.match(
      /textbox "Search query".*\[ref=(e\d+)\]/,
    )?.[1];
    assert.ok(setupInputRef, `race test setup requires an input ref: ${setupSnapshot.snapshot}`);
    await runTool("browser_type", {
      ref: setupInputRef,
      text: "preserve this value",
      clear: true,
    });
    const raceSnapshot = await runTool("browser_snapshot", { interactiveOnly: true });
    const raceInputRef = raceSnapshot.snapshot.match(/textbox "Search query".*\[ref=(e\d+)\]/)?.[1];
    assert.ok(raceInputRef, `race test requires a fresh input ref: ${raceSnapshot.snapshot}`);
    await control("pause-next-focus");
    const racingType = runTool("browser_type", {
      ref: raceInputRef,
      text: "MUST_NOT_BE_TYPED",
      clear: true,
    });
    await waitFor(
      async () => ((await control("focus-state")).paused ? true : null),
      5_000,
      "Agent focus operation to pause",
      fixture.child,
      fixture.output,
    );
    const switchResponse = fetch(`${ready.origin}/__control/switch-tab?index=1`).then(
      async (response) => {
        assert.equal(response.ok, true, "queued UI tab switch must respond successfully");
        const result = await response.json();
        assert.equal(result.ok, true, `queued UI tab switch failed: ${JSON.stringify(result)}`);
        return result;
      },
    );
    const switchPending = await waitFor(
      async () => {
        const state = await control("switch-state");
        return state.pending ? state : null;
      },
      5_000,
      "UI tab switch to queue behind the in-flight page command",
      fixture.child,
      fixture.output,
    );
    assert.equal(
      switchPending.activeTabIndex,
      0,
      "UI must not switch the active WebContents while its dispatched page script is unresolved",
    );
    await control("release-focus");
    await assert.rejects(racingType, /session_not_visible/);
    const switchedDuringType = await switchResponse;
    assert.equal(switchedDuringType.state.activeTabIndex, 1);
    await control("switch-tab?index=0");
    const preservedInput = await runTool("browser_evaluate", {
      script: "document.querySelector('#query').value",
    });
    assert.equal(
      preservedInput.result,
      "preserve this value",
      "a tab switch during async focus must prevent the queued clear/type side effect",
    );

    const deadlineSnapshot = await runTool("browser_snapshot", { interactiveOnly: true });
    const deadlineInputRef = deadlineSnapshot.snapshot.match(
      /textbox "Search query".*\[ref=(e\d+)\]/,
    )?.[1];
    assert.ok(deadlineInputRef, "queued deadline test needs an input ref");
    await control("pause-next-focus");
    const blocker = runTool("browser_type", {
      ref: deadlineInputRef,
      text: "queue blocker",
      timeout: 2_000,
    });
    await waitFor(
      async () => ((await control("focus-state")).paused ? true : null),
      5_000,
      "blocking page command to pause before the queue deadline test",
      fixture.child,
      fixture.output,
    );
    const expiredQueuedCommand = executeNativeBrowserCommand(session, "evaluate", {
      script: "document.body.dataset.expiredQueueMutation = 'ran'; 'unexpected'",
      timeout: 50,
    });
    await delay(80);
    await control("release-focus");
    await blocker;
    await assert.rejects(
      expiredQueuedCommand,
      /operation_failed/,
      "a command whose timeout expires in the queue must fail without starting",
    );
    const queuedMutation = await runTool("browser_evaluate", {
      script: "document.body.dataset.expiredQueueMutation || ''",
    });
    assert.equal(queuedMutation.result, "", "expired queued commands must not mutate the page");

    const timeoutStartedAt = Date.now();
    await assert.rejects(
      executeNativeBrowserCommand(session, "evaluate", {
        script: "new Promise(resolve => setTimeout(() => resolve('late'), 250))",
        timeout: 40,
      }),
      /operation_failed/,
      "an evaluate promise that exceeds its deadline must fail instead of holding the browser queue",
    );
    assert.ok(Date.now() - timeoutStartedAt < 1_000, "the operation deadline must be enforced");
    const afterTimedOutEvaluate = await runTool("browser_evaluate", {
      script: "'queue-recovered'",
    });
    assert.equal(
      afterTimedOutEvaluate.result,
      "queue-recovered",
      "a timed-out evaluate must release the per-thread operation queue",
    );

    process.stdout.write(
      "Native Electron Agent browser: PASS (AgentBrowser tools, authenticated IPC, visible WebContents, tab-switch and navigation click/drag race guards, operation deadlines, tabs, stale refs, thread isolation, fail-closed)\n",
    );
  } finally {
    if (previousPath === undefined) delete process.env.MASTRA_NATIVE_BROWSER_AGENT_BROKER_PATH;
    else process.env.MASTRA_NATIVE_BROWSER_AGENT_BROKER_PATH = previousPath;
    if (previousToken === undefined) delete process.env.MASTRA_NATIVE_BROWSER_AGENT_BROKER_TOKEN;
    else process.env.MASTRA_NATIVE_BROWSER_AGENT_BROKER_TOKEN = previousToken;
    await fixture.stop();
  }
}

async function startFixture(readyPrefix, mode = "manager") {
  const userData = await mkdtemp(path.join(tmpdir(), "mastra-native-browser-probe-"));
  const child = spawn(
    electronPath,
    [
      ...(process.platform === "linux" ? ["--no-sandbox"] : []),
      `--user-data-dir=${userData}`,
      probeApp,
    ],
    {
    cwd: probeApp,
    env: {
      ...process.env,
      ...(mode === "agent"
        ? { MASTRA_BROWSER_AGENT_ONLY: "1" }
        : { MASTRA_BROWSER_MANAGER_ONLY: "1" }),
      ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
      ELECTRON_OVERRIDE_DIST_PATH: path.dirname(electronPath),
    },
    stdio: ["pipe", "pipe", "pipe"],
    // The Agent fixture must be a genuinely visible Electron window because
    // desktop Agent commands are intentionally restricted to the visible page.
    windowsHide: mode !== "agent",
    },
  );
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const ready = waitFor(
    () =>
      output.match(new RegExp(`${readyPrefix} (\\{.*\\})`))?.[1] ??
      (output.includes(readyPrefix) ? "" : null),
    30_000,
    `${mode} Electron browser fixture`,
    child,
    () => output,
  ).then((value) => value || undefined);
  return {
    child,
    ready,
    output: () => output,
    waitForExit: async () =>
      Promise.race([new Promise((resolve) => child.once("exit", resolve)), delay(5_000)]),
    stop: async () => {
      if (child.exitCode === null) {
        child.stdin.end("quit\n");
        await Promise.race([new Promise((resolve) => child.once("exit", resolve)), delay(5_000)]);
      }
      if (child.exitCode === null) {
        if (process.platform === "win32" && child.pid) {
          spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
            stdio: "ignore",
            windowsHide: true,
          });
        } else {
          child.kill();
        }
        await Promise.race([new Promise((resolve) => child.once("exit", resolve)), delay(5_000)]);
      }
      await rm(userData, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

async function waitFor(check, timeoutMs, label, child, readOutput) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${label} exited early: ${readOutput()}`);
    try {
      const value = await check();
      if (value !== null && value !== undefined) return value;
    } catch {}
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${label}: ${readOutput()}`);
}
