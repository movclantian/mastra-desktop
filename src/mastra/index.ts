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
import { mastraWorkAgent, workBrowser } from "./agents";
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
import { WORKBENCH_GATEWAY_ID, WorkbenchGateway } from "./models";

import { workChatRoute, workRoutes } from "./routes";
import { registerShutdownHandlers } from "./routes/shutdown";
import { memoryThreadMiddleware } from "./routes/threads/threads";
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
  browser: workBrowser,
  toolCategoryResolver: (toolName) => toolCategoryOf(toolName),
});

const editorBrowserProvider: BrowserProvider = {
  id: "agent-browser",
  name: "Mastra Agent Browser",
  description: "Thread-scoped browser provided by the desktop workbench.",
  createBrowser: () => workBrowser,
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
    middleware: [
      { path: "/*", handler: workRequestContextMiddleware },
      { path: "/api/memory/*", handler: memoryThreadMiddleware },
    ],
    onError: handleWorkError,
    cors: {
      origin: "*",
      allowMethods: ["*"],
      allowHeaders: ["*"],
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

registerShutdownHandlers();
