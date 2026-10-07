import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { ToolsInput } from "@mastra/core/agent";
import { toStandardSchema } from "@mastra/core/schema";
import { createTool } from "@mastra/core/tools";
import type { CuaDriverLike, CuaDriverSessionLike, ToolResult } from "@trycua/cua-driver";
import type { JSONSchema7 } from "ai";
import { z } from "zod";
import {
  COMPUTER_TOOL_PREFIX,
  type ComputerConfig,
  ComputerConfigSchema,
  type ComputerProbe,
  DEFAULT_COMPUTER_CONFIG,
} from "../../shared/computer-contract";
import { contentObjectReference, putContentObject } from "../storage/content-objects";
import { getAppConfig, setAppConfig, userIdFromContext } from "../storage/database";
import { WORKSPACE_THREAD_ID_CONTEXT_KEY } from "../workspace/workspace-manager";

const CONFIG_KEY = "computer";
const inventorySchema = z.object({
  tools: z.array(
    z.object({
      name: z.string().regex(/^[a-z][a-z0-9_]*$/),
      description: z.string().optional(),
      inputSchema: z.record(z.string(), z.unknown()),
    }),
  ),
});
const resultSchema = z.object({
  action: z.string(),
  result: z.unknown(),
  text: z.string(),
  degraded: z.boolean(),
  screenshots: z.array(
    z.object({
      objectId: z.string(),
      kind: z.string(),
      threadId: z.string().optional(),
      contentType: z.string(),
      imageUrl: z.string(),
    }),
  ),
});
// Lifecycle and installation are host-owned; agents cannot replace their bound session.
const HOST_TOOLS = new Set([
  "start_session",
  "end_session",
  "get_session",
  "list_sessions",
  "get_session_state",
  "escalate_session",
  "set_config",
  "install_extension",
  "install_ffmpeg",
  "check_for_update",
  "check_permissions",
  "set_agent_cursor_enabled",
  "set_agent_cursor_theme",
  "set_agent_cursor_motion",
]);
const INPUT_ACTIONS = new Set([
  "click",
  "double_click",
  "right_click",
  "drag",
  "scroll",
  "type_text",
  "press_key",
  "hotkey",
]);
type Sdk = typeof import("@trycua/cua-driver");
type Inventory = z.infer<typeof inventorySchema>["tools"];
interface ThreadSession {
  handle: CuaDriverSessionLike;
  abort: AbortController;
  timer?: NodeJS.Timeout;
  expiresAt: number;
  pending: number;
  tail: Promise<unknown>;
  ready: Promise<void>;
}
interface Runtime {
  sdk: Sdk;
  driver: CuaDriverLike;
  config: ComputerConfig;
  tools: Inventory;
  sessions: Map<string, ThreadSession>;
  closed: boolean;
}
const runtimes = new Map<string, Promise<Runtime>>();

export async function getComputerConfig(userId: string): Promise<ComputerConfig> {
  const raw = await getAppConfig(CONFIG_KEY, userId);
  return raw ? ComputerConfigSchema.parse(JSON.parse(raw)) : DEFAULT_COMPUTER_CONFIG;
}

export async function saveComputerConfig(config: ComputerConfig, userId: string) {
  const parsed = ComputerConfigSchema.parse(config);
  if (
    parsed.enabled &&
    parsed.capabilityManifest &&
    (!isAbsolute(parsed.capabilityManifest) || !existsSync(parsed.capabilityManifest))
  )
    throw new Error("Capability manifest must exist at an absolute path");
  if (JSON.stringify(parsed) === JSON.stringify(await getComputerConfig(userId))) return parsed;
  await setAppConfig(CONFIG_KEY, JSON.stringify(parsed), userId);
  await closeComputerConnections(userId);
  return parsed;
}

function permissionMode(sdk: Sdk, config: ComputerConfig) {
  return {
    standard: sdk.SessionPermissionMode.Standard,
    bounded: sdk.SessionPermissionMode.Bounded,
    unrestricted: sdk.SessionPermissionMode.Unrestricted,
  }[config.permissionMode];
}

function checkResult(result: ToolResult): ToolResult {
  if (result.isError) throw new Error(`${result.errorCode ?? "computer_error"}: ${result.text}`);
  return result;
}

function structuredResult(result: ToolResult): unknown {
  if (result.structuredJson) return JSON.parse(result.structuredJson);
  try {
    return JSON.parse(result.text);
  } catch {
    return { message: result.text };
  }
}

async function destroyDriver(driver: CuaDriverLike) {
  // Native shutdown drains admitted calls; only then release the UniFFI handle.
  await driver.shutdown();
  if ("uniffiDestroy" in driver && typeof driver.uniffiDestroy === "function")
    driver.uniffiDestroy();
}

async function createRuntime(config: ComputerConfig): Promise<Runtime> {
  // Loading the package loads its platform library. Disabled modules never import it.
  // FFI opens the shared library itself, so both JS and its platform package must
  // resolve from the physical unpacked tree, not Electron's virtual ASAR paths.
  const entry = import.meta.resolve("@trycua/cua-driver");
  const sdk: Sdk = await import(entry.replace("/app.asar/", "/app.asar.unpacked/"));
  const mode = permissionMode(sdk, config);
  const driver = sdk.CuaDriver.createConfigured({
    claudeCodeCompatibility: false,
    authorization: {
      allowedModes: [mode],
      compatibilityMode: mode,
      compatibilityCapabilityManifestPath: config.capabilityManifest || undefined,
      unrestrictedAcknowledged:
        config.permissionMode === "unrestricted" && config.acknowledgeUnrestricted,
      maxSessionTtlSeconds: BigInt(Math.ceil(config.sessionTtlMs / 1000)),
      maxIdleTtlSeconds: BigInt(Math.ceil(config.idleTimeoutMs / 1000)),
    },
  });
  try {
    const inventory = inventorySchema.parse(
      JSON.parse(await driver.listToolsJson({ signal: AbortSignal.timeout(config.timeoutMs) })),
    );
    return {
      sdk,
      driver,
      config,
      tools: inventory.tools.filter((tool) => !HOST_TOOLS.has(tool.name)),
      sessions: new Map(),
      closed: false,
    };
  } catch (error) {
    await destroyDriver(driver);
    throw error;
  }
}

function closeSession(runtime: Runtime, threadId: string, expected?: ThreadSession) {
  const session = runtime.sessions.get(threadId);
  if (!session || (expected && session !== expected)) return;
  runtime.sessions.delete(threadId);
  clearTimeout(session.timer);
  session.abort.abort();
  session.handle.close();
}

export async function closeComputerConnections(userId?: string, threadId?: string) {
  await Promise.all(
    [...runtimes]
      .filter(([owner]) => !userId || owner === userId)
      .map(async ([owner, pending]) => {
        if (!threadId && runtimes.get(owner) === pending) runtimes.delete(owner);
        const runtime = await pending.catch(() => undefined);
        if (!runtime) return;
        if (threadId) {
          closeSession(runtime, threadId);
          return;
        }
        runtime.closed = true;
        for (const id of runtime.sessions.keys()) closeSession(runtime, id);
        await destroyDriver(runtime.driver);
      }),
  );
}

function getRuntime(userId: string, config: ComputerConfig) {
  const previous = runtimes.get(userId);
  if (previous) return previous;
  const pending = createRuntime(config).catch((error) => {
    if (runtimes.get(userId) === pending) runtimes.delete(userId);
    throw error;
  });
  runtimes.set(userId, pending);
  return pending;
}

function armIdle(runtime: Runtime, threadId: string, session: ThreadSession) {
  clearTimeout(session.timer);
  if (session.abort.signal.aborted || session.pending) return;
  session.timer = setTimeout(
    () => closeSession(runtime, threadId, session),
    Math.max(0, Math.min(runtime.config.idleTimeoutMs, session.expiresAt - Date.now())),
  );
  session.timer.unref();
}

function getSession(runtime: Runtime, threadId: string): ThreadSession {
  const previous = runtime.sessions.get(threadId);
  if (previous && previous.expiresAt > Date.now()) return previous;
  if (previous) closeSession(runtime, threadId);
  const { sdk, config, driver } = runtime;
  const publicSession = `mastra-${randomUUID()}`;
  const handle = sdk.createTrustedSession(driver, {
    publicSession,
    mode: permissionMode(sdk, config),
    ttlSeconds: BigInt(Math.ceil(config.sessionTtlMs / 1000)),
    idleTtlSeconds: BigInt(Math.ceil(config.idleTimeoutMs / 1000)),
    capabilityManifestPath: config.capabilityManifest || undefined,
  });
  const session: ThreadSession = {
    handle,
    abort: new AbortController(),
    pending: 0,
    expiresAt: Date.now() + config.sessionTtlMs,
    tail: Promise.resolve(),
    ready: Promise.resolve(),
  };
  runtime.sessions.set(threadId, session);
  session.ready = (async () => {
    if (config.cursorEnabled !== null) {
      const options = {
        signal: AbortSignal.any([session.abort.signal, AbortSignal.timeout(config.timeoutMs)]),
      };
      checkResult(
        await handle.setAgentCursorEnabled(
          sdk.SetAgentCursorEnabledInput.new({
            session: publicSession,
            enabled: config.cursorEnabled,
          }),
          options,
        ),
      );
      if (config.cursorEnabled) {
        const reducedMotion = {
          auto: sdk.CursorReducedMotion.Auto,
          on: sdk.CursorReducedMotion.On,
          off: sdk.CursorReducedMotion.Off,
        }[config.cursorReducedMotion];
        checkResult(
          await handle.setAgentCursorTheme(
            sdk.SetAgentCursorThemeInput.new({
              session: publicSession,
              themeId: config.cursorTheme,
              reducedMotion,
            }),
            options,
          ),
        );
      }
    }
  })().catch((error) => {
    closeSession(runtime, threadId, session);
    throw error;
  });
  session.tail = session.ready;
  return session;
}

export async function probeComputer(config: ComputerConfig): Promise<ComputerProbe> {
  let runtime: Runtime | undefined;
  let tools: ComputerProbe["tools"] = [];
  try {
    runtime = await createRuntime(config);
    tools = runtime.tools.map(({ name, description }) => ({
      name,
      description: description ?? "",
    }));
    const health = structuredResult(
      checkResult(
        await runtime.driver.callTool("health_report", "{}", {
          signal: AbortSignal.timeout(config.timeoutMs),
        }),
      ),
    );
    // Native health_report includes the platform's permission and desktop probes.
    // check_permissions.prompt is macOS-only; do not send it to Windows/Linux.
    const overall =
      health && typeof health === "object" && "overall" in health ? health.overall : undefined;
    return {
      ok: overall === "ok",
      tools,
      health,
      ...(overall !== "ok"
        ? { error: "Desktop readiness is not confirmed; inspect the native health report." }
        : {}),
    };
  } catch (error) {
    return { ok: false, tools, error: error instanceof Error ? error.message : String(error) };
  } finally {
    if (runtime) await destroyDriver(runtime.driver);
  }
}

/** Native SDK schemas and callTool are in-process FFI; no MCP client or executable. */
export async function getComputerTools(context?: {
  get: (key: string) => unknown;
}): Promise<ToolsInput> {
  const userId = userIdFromContext(context);
  const threadId = context?.get(WORKSPACE_THREAD_ID_CONTEXT_KEY);
  if (!userId || typeof threadId !== "string" || !threadId) return {};
  const config = await getComputerConfig(userId);
  if (!config.enabled) return {};
  let runtime: Runtime;
  try {
    runtime = await getRuntime(userId, config);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      computer_status: createTool({
        id: "computer_status",
        description:
          "Read why the native computer driver is unavailable. Do not bypass it using shell automation.",
        inputSchema: z.object({}),
        execute: async () => ({ available: false, error: message }),
      }),
    };
  }
  const tools: ToolsInput = {};
  for (const tool of runtime.tools) {
    if (config.disabledTools.includes(tool.name)) continue;
    const action = tool.name;
    const name = `${COMPUTER_TOOL_PREFIX}${action}`;
    // The trusted native handle owns session authority; it is never a model argument.
    const properties = { ...(tool.inputSchema.properties as Record<string, unknown> | undefined) };
    delete properties.session;
    delete properties.screenshot_out_file;
    const schema = {
      ...tool.inputSchema,
      properties,
      ...(Array.isArray(tool.inputSchema.required)
        ? {
            required: tool.inputSchema.required.filter(
              (key) => key !== "session" && key !== "screenshot_out_file",
            ),
          }
        : {}),
    };
    tools[name] = createTool({
      id: name,
      description: tool.description ?? action,
      inputSchema: toStandardSchema<Record<string, unknown>>(schema as JSONSchema7),
      outputSchema: resultSchema,
      requireApproval: config.requireToolApproval,
      execute: async (input, toolContext) => {
        const current = await getComputerConfig(userId);
        if (
          runtime.closed ||
          !current.enabled ||
          JSON.stringify(current) !== JSON.stringify(runtime.config)
        )
          throw new Error("Computer settings changed; request fresh tools before continuing.");
        toolContext.abortSignal?.throwIfAborted();
        const session = getSession(runtime, threadId);
        session.pending += 1;
        clearTimeout(session.timer);
        const operation = session.tail.then(async () => {
          await session.ready;
          const signal = AbortSignal.any([
            session.abort.signal,
            AbortSignal.timeout(config.timeoutMs),
            ...(toolContext.abortSignal ? [toolContext.abortSignal] : []),
          ]);
          signal.throwIfAborted();
          const args = { ...input };
          delete args.session;
          delete args.screenshot_out_file;
          if (INPUT_ACTIONS.has(action)) args.delivery_mode ??= config.deliveryMode;
          if (action === "get_window_state") {
            args.include_screenshot = config.includeScreenshot;
            args.include_accessibility_tree = config.includeAccessibilityTree;
            if (config.maxImageDimension !== null) args.max_dimension = config.maxImageDimension;
            if (config.maxElements !== null) args.max_elements = config.maxElements;
            if (config.maxDepth !== null) args.max_depth = config.maxDepth;
          }
          let result: ToolResult;
          try {
            result = checkResult(
              await session.handle.callTool(action, JSON.stringify(args), { signal }),
            );
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const interrupted =
              signal.aborted ||
              (runtime.sdk.DriverError.instanceOf(error) &&
                error.tag === runtime.sdk.DriverError_Tags.ActionInterrupted);
            throw new Error(
              interrupted
                ? `${message}\nAn interrupted action may already have reached the OS. Observe fresh state before considering a retry.`
                : message,
              { cause: error },
            );
          }
          const screenshots = [];
          for (const image of result.images) {
            const saved = await putContentObject(Buffer.from(image.dataBase64, "base64"), {
              userId,
              threadId,
              kind: "screenshot",
              contentType: image.mimeType,
              encoding: "binary",
            });
            screenshots.push({
              ...contentObjectReference(saved),
              imageUrl: `mastra-image:///${encodeURIComponent(userId)}/${encodeURIComponent(threadId)}/${saved.objectId}`,
            });
          }
          return {
            action,
            result: structuredResult(result),
            text: result.text,
            degraded: result.degraded,
            screenshots,
          };
        });
        session.tail = operation.catch(() => undefined);
        try {
          return await operation;
        } finally {
          session.pending -= 1;
          armIdle(runtime, threadId, session);
        }
      },
      toModelOutput: (output) => ({
        type: "content",
        value: [
          {
            type: "text",
            text: JSON.stringify({
              action: output.action,
              result: output.result,
              text: output.text,
              degraded: output.degraded,
            }),
          },
          ...output.screenshots.map((image) => ({
            type: "image-url" as const,
            url: image.imageUrl,
            mediaType: image.contentType,
          })),
        ],
      }),
    });
  }
  return tools;
}
