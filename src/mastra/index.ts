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
import type { RequestContext } from "@mastra/core/request-context";
import { askUserTool, submitPlanTool } from "@mastra/core/tools";
import { MastraEditor } from "@mastra/editor";
import { PinoLogger } from "@mastra/loggers";
import { MastraStorageExporter, Observability, SensitiveDataFilter } from "@mastra/observability";
import type { Memory } from "@mastra/memory";
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
import { mastraWorkAgent } from "./agents";
import { getBrowserForRequest, getBrowserForResource } from "./agents/browser";
import { getConfiguredProcessorRegistry, getGuardrailsConfig } from "./agents/guardrails";
import { listWorkModes } from "./agents/modes";
import { toolCategoryOf } from "./agents/permissions";
import {
  agentsMdProcessor,
  editorStateProcessor,
  libraryAttachmentProcessor,
  terminalStateProcessor,
  workbenchStateProcessor,
} from "./agents/processors";
import { workSubagents } from "./agents/subagents";
import { workAuth, workRequestContextMiddleware } from "./auth";
import { handleWorkError } from "./errors";
import { failInterruptedBackgroundTasksOnStartup } from "./routes/background-tasks";
import { WORKBENCH_GATEWAY_ID, WorkbenchGateway } from "./models";

import { workChatRoute, workRoutes } from "./routes";
import { registerShutdownHandlers } from "./routes/shutdown";
import { memoryThreadMiddleware } from "./routes/threads/threads";
import { recoverPendingThreadTransfers } from "./routes/threads/transfer-recovery";
import { appStorage } from "./storage";
import { getThreadsRoot, getThreadWorkspace } from "./workspace";

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
  const origins = new Set(["null", "http://localhost:5173", "http://127.0.0.1:5173"]);
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

await getGuardrailsConfig();
const configuredProcessorRegistry = await getConfiguredProcessorRegistry();
const processorRegistry = {
  "library-attachments": libraryAttachmentProcessor,
  "editor-state": editorStateProcessor as Processor,
  "terminal-state": terminalStateProcessor as Processor,
  "workbench-state": workbenchStateProcessor as Processor,
  "agents-md-injector": agentsMdProcessor as Processor,
  ...configuredProcessorRegistry.processors,
};

const logger = new PinoLogger({
  name: "Mastra",
  level: "info",
});

const workAgentController = new AgentController({
  id: "mastra-work-controller",
  agent: mastraWorkAgent,
  modes: listWorkModes(),
  defaultModeId: "plan",
  browser: ({ requestContext }) => getBrowserForRequest(requestContext),
  toolCategoryResolver: (toolName) => toolCategoryOf(toolName),
});

const editorBrowserProvider: BrowserProvider = {
  id: "agent-browser",
  name: "Mastra Agent Browser",
  description: "Thread-scoped browser provided by the desktop workbench.",
  createBrowser: () => getBrowserForResource("default"),
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
    onTaskComplete: (task) =>
      logger.info("Background task completed", { taskId: task.id, threadId: task.threadId }),
    onTaskFailed: (task) =>
      logger.error("Background task failed", {
        taskId: task.id,
        threadId: task.threadId,
        error: task.error,
      }),
  },
  schedules: {
    onFinish: ({ agentId, schedule, trigger, outcome, runId }) =>
      logger.info("Scheduled agent run finished", {
        agentId,
        scheduleId: schedule.id,
        trigger: trigger.kind,
        outcome,
        runId,
      }),
    onError: ({ agentId, schedule, trigger, phase, error }) =>
      logger.error("Scheduled agent run failed", {
        agentId,
        scheduleId: schedule.id,
        trigger: trigger.kind,
        phase,
        error,
      }),
  },
  pubsub: withCaching(new EventEmitterPubSub(), new InMemoryServerCache()),
  processors: processorRegistry,
  tools: {
    ask_user: askUserTool,
    submit_plan: submitPlanTool,
  },
  gateways: { [WORKBENCH_GATEWAY_ID]: new WorkbenchGateway() },
  editor: workEditor,
  workspace: getThreadWorkspace(getThreadsRoot()),
  server: {
    auth: workAuth,
    storedResources: { scope: { metadataKey: "mastra_resource_id" } },
    middleware: [
      { path: "/*", handler: workRequestContextMiddleware },
      { path: "/api/memory/*", handler: memoryThreadMiddleware },
    ],
    onError: handleWorkError,
    cors: {
      origin: rendererCorsOrigin,
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowHeaders: ["Authorization", "Content-Type"],
    },
    apiRoutes: [workChatRoute, ...workRoutes],
  },
  storage: appStorage,
  logger,
  observability: new Observability({
    configs: {
      default: {
        serviceName: "mastra-work",
        exporters: [new MastraStorageExporter()],
        spanOutputProcessors: [new SensitiveDataFilter()],
      },
    },
  }),
});

// Reconcile the durable cross-store transfer journal before the service begins
// accepting requests. Otherwise startup recovery can mistake a transfer that
// was just accepted by a live request for an abandoned operation and roll its
// library assets back while Memory is being moved.
await recoverPendingThreadTransfers({
  throwOnError: true,
  getMemory: async (requestContext: RequestContext) => {
    const memory = await mastra
      .getAgentById("mastra-work-agent")
      .getMemory({ requestContext });
    if (!memory) throw new Error("Agent memory is not configured");
    return memory as Memory;
  },
});

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

registerShutdownHandlers();
