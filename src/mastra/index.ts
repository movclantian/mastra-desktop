import { DEFAULT_RENDERER_PORT } from "../shared/proxy-contract";
import { mcpManagementMiddleware } from "./connections/mcp";
import { cleanupOrphanedLibraryAssets } from "./rag/storage/assets";
/**
 * Mastra 实例入口:注册 Agent / 网关 / 存储 / 观测 / 编辑器与 /work/* 路由,
 * 并完成进程级初始化(出站代理、处理器登记、索引恢复、优雅退出)。
 * 官方文档:docs/en/docs/mastra-platform/configuration.mdx(配置项)、
 * docs/en/docs/observability/overview.mdx + integrations/exporters/mastra-storage.mdx、
 * docs/en/docs/studio/editor.mdx(编辑器工作区)。
 */

import { AgentController } from "@mastra/core/agent-controller";
import { InMemoryServerCache } from "@mastra/core/cache";
import type { BrowserProvider } from "@mastra/core/editor";
import { EventEmitterPubSub, withCaching } from "@mastra/core/events";
import { Mastra } from "@mastra/core/mastra";
import type { Processor } from "@mastra/core/processors";
import { askUserTool, submitPlanTool } from "@mastra/core/tools";
import { MastraEditor } from "@mastra/editor";
import { PinoLogger } from "@mastra/loggers";
import { MastraStorageExporter, Observability, SensitiveDataFilter } from "@mastra/observability";
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
import { getBrowserConfig, getBrowserForRequest, getBrowserForResource } from "./agents/browser";
import { getConfiguredProcessorRegistry } from "./agents/guardrails";
import { listWorkModes, toolCategoryOf, workbenchSessionStateSchema } from "./agents/permissions";
import { agentsMdProcessor, libraryAttachmentProcessor } from "./agents/processors";
import { workSubagents } from "./agents/subagents";
import { mastraWorkAgent } from "./agents/work-agent";
import { workAuth, workRequestContextMiddleware } from "./auth";
import { handleWorkError } from "./errors";
import { publishDesktopNotification } from "./harness/signals";
import { failInterruptedBackgroundTasksOnStartup } from "./routes/background-tasks";
import { workRoutes } from "./routes/routes";
import { prepareScheduledRun } from "./routes/schedules";
import { registerWorkbenchSessionLifecycle, workbenchControllerMiddleware } from "./routes/session";
import { registerShutdownHandlers, shutdownRequestMiddleware } from "./routes/shutdown";
import { memoryThreadMiddleware } from "./routes/threads/threads";
import { appStorage } from "./storage/database";
import {
  registerWorkspaceLifecycle,
  scheduleIdleWorkspaceCleanup,
} from "./workspace/workspace-manager";

// `mastra dev` sets MASTRA_DEV=true in the runtime child process. That flag is
// intended for Mastra's standalone development playground; this Electron
// service already has its own desktop lifecycle and auth boundary. Clear the
// CLI flag so local auth does not enter Mastra's EE development warning path.
if (process.env.MASTRA_DESKTOP_RUNTIME === "true") {
  process.env.MASTRA_DEV = "false";
  process.env.NODE_ENV = "production";
}

/**
 * Renderer origins that may call the local API. Packaged Electron pages send a
 * `null` origin for their file:// URL; development uses the actual Vite origin
 * inherited from ELECTRON_RENDERER_URL (with the standard fallback ports).
 */
function getRendererCorsOrigins(): Set<string> {
  const origins = new Set([
    "null",
    `http://localhost:${DEFAULT_RENDERER_PORT}`,
    `http://127.0.0.1:${DEFAULT_RENDERER_PORT}`,
  ]);
  const configuredUrl = process.env.ELECTRON_RENDERER_URL;
  if (!configuredUrl) return origins;

  try {
    const url = new URL(configuredUrl);
    if (
      (url.protocol === "http:" || url.protocol === "https:") &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    ) {
      origins.add(url.origin);
    }
  } catch {
    // An invalid renderer URL will be rejected by the Electron main process.
  }
  return origins;
}

const rendererCorsOrigins = getRendererCorsOrigins();

function rendererCorsOrigin(origin: string): string | undefined {
  return rendererCorsOrigins.has(origin) ? origin : undefined;
}

// Electron passes the resolved system proxy through the standard environment variables.
if (
  process.env.http_proxy ||
  process.env.HTTP_PROXY ||
  process.env.https_proxy ||
  process.env.HTTPS_PROXY
) {
  setGlobalDispatcher(new EnvHttpProxyAgent());
}

// Complete GC before accepting requests or starting index recovery.
await appStorage.init();
await cleanupOrphanedLibraryAssets();

const configuredProcessorRegistry = await getConfiguredProcessorRegistry();
const processorRegistry = {
  "library-attachments": libraryAttachmentProcessor,
  "agents-md-injector": agentsMdProcessor as Processor,
  ...configuredProcessorRegistry.processors,
};

const logger = new PinoLogger({
  name: "Mastra",
  level: "info",
});

const workAgentController = new AgentController({
  id: "mastra-work-controller",
  stateSchema: workbenchSessionStateSchema,
  agent: mastraWorkAgent,
  modes: listWorkModes(),
  defaultModeId: "build",
  browser: ({ requestContext }) => getBrowserForRequest(requestContext),
  toolCategoryResolver: (toolName) => toolCategoryOf(toolName),
});

const editorBrowserProvider: BrowserProvider = {
  id: "agent-browser",
  name: "Mastra Agent Browser",
  description: "Thread-scoped browser provided by the desktop workbench.",
  createBrowser: async () => {
    const config = await getBrowserConfig("default");
    if (config.provider === "agent") {
      throw new Error(
        "Mastra Editor browser requires a work thread; use the workspace browser panel",
      );
    }
    return getBrowserForResource("default");
  },
};

const workEditor = new MastraEditor({
  source: "db",
  browsers: { [editorBrowserProvider.id]: editorBrowserProvider },
});

export const mastra = new Mastra({
  agentControllers: { workbench: workAgentController },
  // Delegation and direct registry access share the same Agent instances.
  agents: {
    mastraWorkAgent,
    explorer: workSubagents.explorer,
    reviewer: workSubagents.reviewer,
  },
  backgroundTasks: {
    enabled: true,
    // The original task executor captures request-scoped model, workspace,
    // tools, and result callbacks. Mastra only persists args, so a static
    // executor cannot safely replace that closure after restart.
    recoverStaleTasksOnStart: false,
    globalConcurrency: 10,
    perAgentConcurrency: 5,
    backpressure: "queue",
    defaultTimeoutMs: 300_000,
    onTaskComplete: (task) => {
      logger.info("Background task completed", { taskId: task.id, threadId: task.threadId });
      scheduleIdleWorkspaceCleanup();
    },
    onTaskFailed: (task) => {
      logger.error("Background task failed", {
        taskId: task.id,
        threadId: task.threadId,
        error: task.error,
      });
      scheduleIdleWorkspaceCleanup();
    },
  },
  schedules: {
    prepare: prepareScheduledRun,
    onFinish: ({ agentId, schedule, trigger, outcome, runId, result, effective }) => {
      logger.info("Scheduled agent run finished", {
        agentId,
        scheduleId: schedule.id,
        trigger: trigger.kind,
        outcome,
        runId,
      });
      if (
        (outcome === "succeeded" || outcome === "delivered") &&
        runId &&
        effective.resourceId &&
        effective.threadId
      ) {
        publishDesktopNotification(
          {
            id: `${schedule.id}:${runId}`,
            resourceId: effective.resourceId,
            threadId: effective.threadId,
            kind: "schedule",
            title: (schedule.name || "Mastra").slice(0, 256),
            body: result?.text?.slice(0, 500) ?? "",
          },
          outcome === "delivered" ? runId : undefined,
        );
      }
      scheduleIdleWorkspaceCleanup();
    },
    onError: ({ agentId, schedule, trigger, phase, error }) => {
      logger.error("Scheduled agent run failed", {
        agentId,
        scheduleId: schedule.id,
        trigger: trigger.kind,
        phase,
        error,
      });
      scheduleIdleWorkspaceCleanup();
    },
    onAbort: () => scheduleIdleWorkspaceCleanup(),
  },
  pubsub: withCaching(new EventEmitterPubSub(), new InMemoryServerCache()),
  processors: processorRegistry,
  tools: {
    ask_user: askUserTool,
    submit_plan: submitPlanTool,
  },
  editor: workEditor,
  server: {
    auth: workAuth,
    storedResources: { scope: { metadataKey: "mastra_resource_id" } },
    middleware: [
      { path: "/*", handler: shutdownRequestMiddleware },
      { path: "/*", handler: workRequestContextMiddleware },
      { path: "/api/stored/mcp-clients*", handler: mcpManagementMiddleware },
      { path: "/api/agent-controller/*", handler: workbenchControllerMiddleware },
      { path: "/api/memory/*", handler: memoryThreadMiddleware },
    ],
    onError: handleWorkError,
    cors: {
      origin: rendererCorsOrigin,
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      // SSE 客户端重连会携带 Last-Event-ID，必须允许它通过跨域预检。
      allowHeaders: ["Authorization", "Content-Type", "Last-Event-ID"],
    },
    apiRoutes: workRoutes,
  },
  storage: appStorage,
  logger,
  observability: new Observability({
    configs: {
      default: {
        serviceName: "mastra-work",
        // Include native prepare-tools/prepare-memory steps in the request timeline.
        includeInternalSpans: true,
        exporters: [new MastraStorageExporter()],
        spanOutputProcessors: [new SensitiveDataFilter()],
      },
    },
  }),
});

registerWorkspaceLifecycle(mastra);
registerWorkbenchSessionLifecycle(mastra);

const backgroundTaskManager = mastra.backgroundTaskManager;
if (backgroundTaskManager) {
  try {
    const count = await failInterruptedBackgroundTasksOnStartup(backgroundTaskManager);
    if (count > 0) logger.warn("Interrupted background tasks marked failed", { count });
  } catch (error) {
    logger.error("Interrupted background task reconciliation failed; refusing to start", { error });
    throw error;
  }
}

registerShutdownHandlers(mastra);
