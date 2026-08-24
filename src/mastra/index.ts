/**
 * Mastra 实例入口:注册 Agent / 网关 / 存储 / 观测 / 编辑器与 /work/* 路由,
 * 并完成进程级初始化(出站代理、处理器登记、索引恢复、优雅退出)。
 * 官方文档:docs/en/docs/mastra-platform/configuration.mdx(配置项)、
 * docs/en/docs/observability/overview.mdx + integrations/exporters/mastra-storage.mdx、
 * docs/en/docs/studio/editor.mdx(编辑器工作区)。
 */

import { InMemoryServerCache } from "@mastra/core/cache";
import { getErrorFromUnknown } from "@mastra/core/error";
import { EventEmitterPubSub, withCaching } from "@mastra/core/events";
import { Mastra } from "@mastra/core/mastra";
import type { Processor } from "@mastra/core/processors";
import { MASTRA_RESOURCE_ID_KEY } from "@mastra/core/request-context";
import type { StorageWorkspaceSnapshotType } from "@mastra/core/storage";
import { askUserTool, submitPlanTool } from "@mastra/core/tools";
import { MastraEditor } from "@mastra/editor";
import { PinoLogger } from "@mastra/loggers";
import { MastraStorageExporter, Observability, SensitiveDataFilter } from "@mastra/observability";
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
import { mastraWorkAgent } from "./agents";
import { getConfiguredProcessorRegistry, getGuardrailsConfig } from "./agents/guardrails";
import {
  agentsMdProcessor,
  editorStateProcessor,
  libraryAttachmentProcessor,
  promptCacheProcessor,
  terminalStateProcessor,
  workbenchStateProcessor,
} from "./agents/processors";
import { workSubagents } from "./agents/subagents";
import { type AuthUser, workAuth } from "./auth";
import { getMcpConfig } from "./connections/mcp";
import { WorkApiError, workError } from "./errors";
import { getMemoryConfig } from "./memory";
import { WORKBENCH_GATEWAY_ID, WorkbenchGateway } from "./models";
import {
  ensureLibrarySchema,
  getLibrarySettings,
  onLibraryIndexSettled,
  recoverInterruptedLibraryIndexes,
} from "./rag";
import { workChatRoute, workRoutes } from "./routes";
import { requestShutdown } from "./routes/shutdown";
import { appStorage, runWithResourceScope } from "./storage";
import { getThreadsRoot, getThreadWorkspace, getWorkspaceConfig } from "./workspace";

// ---------------------------------------------------------------------------
// 出站请求走代理(Node 原生 fetch 不读代理设置)。
// 受限网络下 models.dev 目录、网关 /models、聊天请求直连会全部超时;这里给全局
// fetch 挂 undici 官方的 EnvHttpProxyAgent(docs: https://undici.nodejs.org),它按
// HTTP_PROXY / HTTPS_PROXY / NO_PROXY 分流,回环地址不进代理。
// 代理地址只从环境变量读取:系统代理的解析由 Electron 主进程用 Chromium 官方 API
// 完成后注入(见 src/main/index.ts 的 resolveOutboundProxyUrl),本文件
// 不做任何平台级读取。未配置则保持直连。
// ---------------------------------------------------------------------------
const httpProxy = (process.env.http_proxy ?? process.env.HTTP_PROXY ?? "").trim();
const httpsProxy = (process.env.https_proxy ?? process.env.HTTPS_PROXY ?? "").trim();
const proxyBypass = (process.env.no_proxy ?? process.env.NO_PROXY ?? "").trim();
if (httpProxy || httpsProxy) {
  try {
    setGlobalDispatcher(
      new EnvHttpProxyAgent({
        ...(httpProxy ? { httpProxy } : {}),
        ...(httpsProxy ? { httpsProxy } : {}),
        noProxy: proxyBypass,
      }),
    );
    console.log(`[mastra] 出站请求走代理（绕过 ${proxyBypass || "无"}）`);
  } catch (error) {
    console.warn(
      `[mastra] 检测到出站代理但启用失败，继续直连: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

const STUDIO_WORKSPACE_ID = "mastra-workspace";

await getGuardrailsConfig();
const configuredProcessorRegistry = await getConfiguredProcessorRegistry();
const processorRegistry = {
  "library-attachments": libraryAttachmentProcessor,
  ...configuredProcessorRegistry.processors,
};

const logger = new PinoLogger({
  name: "Mastra",
  level: "info",
});

export const mastra = new Mastra({
  // Keep the built-in delegation targets in the same Mastra registry as
  // dynamically-created Profile and Team member Agents. They remain available
  // to the default Agent through its `agents` resolver, while direct registry
  // lookups and workflow steps resolve the exact same instances.
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
    onTaskComplete: (task) => {
      logger.info("Background task completed", {
        taskId: task.id,
        toolName: task.toolName,
        runId: task.runId,
        resourceId: task.resourceId,
        threadId: task.threadId,
      });
    },
    onTaskFailed: (task) => {
      logger.error("Background task failed", {
        taskId: task.id,
        toolName: task.toolName,
        runId: task.runId,
        resourceId: task.resourceId,
        threadId: task.threadId,
        error: task.error,
      });
    },
  },
  pubsub: withCaching(new EventEmitterPubSub(), new InMemoryServerCache()),
  processors: processorRegistry,
  tools: {
    ask_user: askUserTool,
    submit_plan: submitPlanTool,
  },
  gateways: { [WORKBENCH_GATEWAY_ID]: new WorkbenchGateway() },
  editor: new MastraEditor(),
  workspace: getThreadWorkspace(getThreadsRoot()),
  server: {
    auth: workAuth,
    middleware: async (c, next) => {
      const isWorkRoute = c.req.path.startsWith("/work/");
      const isPublicWorkRoute =
        c.req.path === "/work/auth/login" || c.req.path === "/work/auth/register";
      const requestContext = c.get("requestContext");
      let user = requestContext?.get("user") as AuthUser | undefined;
      if (!user) {
        try {
          user = (await workAuth.authenticateToken("", c.req.raw)) ?? undefined;
          if (user) requestContext?.set("user", user);
        } catch {
          // Treat failed token lookup as anonymous; protected work routes reject below.
        }
      }
      if (!user) {
        if (isWorkRoute && !isPublicWorkRoute) {
          throw workError("AUTH_REQUIRED");
        }
        await next();
        return;
      }

      // The authenticated principal is the only tenant authority. Reject
      // client-supplied ids before any route can query storage with them.
      const queryResource = c.req.query("resourceId");
      if (queryResource && queryResource !== user.id) {
        return c.json({ error: "resourceId does not belong to the authenticated user" }, 403);
      }
      if (["POST", "PUT", "PATCH", "DELETE"].includes(c.req.method)) {
        const contentType = c.req.header("content-type") ?? "";
        if (!contentType.includes("multipart/form-data")) {
          try {
            const body = (await c.req.raw.clone().json()) as Record<string, unknown>;
            const bodyResources = [
              body.resourceId,
              body.memory && typeof body.memory === "object"
                ? (body.memory as Record<string, unknown>).resource
                : undefined,
            ].filter((value) => value !== undefined);
            if (bodyResources.some((value) => typeof value !== "string" || value !== user.id)) {
              return c.json({ error: "resourceId does not belong to the authenticated user" }, 403);
            }
          } catch {
            // Route-level JSON validation returns the canonical error response.
          }
        } else {
          try {
            const form = await c.req.raw.clone().formData();
            const formResource = form.get("resourceId");
            if (typeof formResource === "string" && formResource !== user.id) {
              return c.json({ error: "resourceId does not belong to the authenticated user" }, 403);
            }
          } catch {
            // Route-level multipart validation returns the canonical error response.
          }
        }
      }

      requestContext.set("user", user);
      requestContext.set("userId", user.id);
      requestContext.set(MASTRA_RESOURCE_ID_KEY, user.id);
      await runWithResourceScope(user.id, async () => {
        await Promise.all([
          getWorkspaceConfig(),
          getMemoryConfig(),
          getGuardrailsConfig(),
          getMcpConfig(),
          getLibrarySettings(),
        ]);
        await next();
      });
    },
    // 全局错误出站(docs/en/reference/configuration.mdx「server.onError」):
    // 路由只 throw workError(...),状态码与响应形状在这里统一决定。
    // error 字段保持旧契约,code/domain/category 供渲染层翻译成用户语言。
    onError: (err, c) => {
      if (err instanceof WorkApiError) {
        return c.json(
          {
            error: err.message,
            code: err.id,
            domain: err.domain,
            category: err.category,
            ...(err.details ? { details: err.details } : {}),
          },
          err.status,
        );
      }
      const wrapped = getErrorFromUnknown(err);
      logger.error(`[work-api] ${c.req.method} ${c.req.path} 未处理错误`, {
        message: wrapped.message,
        stack: wrapped.stack,
      });
      return c.json(
        {
          error: wrapped.message,
          code: "INTERNAL_ERROR",
          domain: "MASTRA_SERVER",
          category: "SYSTEM",
        },
        500,
      );
    },
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

// Studio 的 /workspaces 页面读取 editor workspace domain 而非运行时注册表
// (docs/en/docs/studio/editor.mdx)。把线程工作区快照持久化一次,
// 确保桌面 Agent 与 Studio 看到的是同一工作区。
void (async () => {
  try {
    const editor = mastra.getEditor();
    if (!editor) return;
    const existing = await editor.workspace.getById(STUDIO_WORKSPACE_ID);
    if (existing) return;
    const runtimeWorkspace = getThreadWorkspace(getThreadsRoot());
    const snapshotter = editor.workspace as unknown as {
      snapshotFromWorkspace: (
        workspace: ReturnType<typeof getThreadWorkspace>,
      ) => Promise<StorageWorkspaceSnapshotType>;
    };
    const snapshot: StorageWorkspaceSnapshotType =
      await snapshotter.snapshotFromWorkspace(runtimeWorkspace);
    await editor.workspace.create({
      id: STUDIO_WORKSPACE_ID,
      metadata: { source: "mastra-runtime" },
      ...snapshot,
    });
  } catch (error) {
    mastra.getLogger().warn("Failed to persist the MastraWork workspace for Studio", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
})();

// 注册动态处理器配置供 Studio 调试查看(registry 只收集处理器实例,
// buildInput/buildOutput 不会返回 workflow,直接按方向登记即可)
mastra.addProcessorConfiguration(libraryAttachmentProcessor, mastraWorkAgent.id, "input");
mastra.addProcessorConfiguration(editorStateProcessor as Processor, mastraWorkAgent.id, "input");
mastra.addProcessorConfiguration(terminalStateProcessor as Processor, mastraWorkAgent.id, "input");
mastra.addProcessorConfiguration(workbenchStateProcessor as Processor, mastraWorkAgent.id, "input");
mastra.addProcessorConfiguration(agentsMdProcessor as Processor, mastraWorkAgent.id, "input");
for (const processor of configuredProcessorRegistry.input) {
  mastra.addProcessorConfiguration(processor as Processor, mastraWorkAgent.id, "input");
}
// 与 Agent 的 inputProcessors 同序:缓存断点登记在 guardrails 之后
mastra.addProcessorConfiguration(promptCacheProcessor as Processor, mastraWorkAgent.id, "input");
for (const processor of configuredProcessorRegistry.output) {
  mastra.addProcessorConfiguration(processor as Processor, mastraWorkAgent.id, "output");
}

// 进程重启后恢复上次中断的索引任务
void (async () => {
  await ensureLibrarySchema();
  await recoverInterruptedLibraryIndexes();
})().catch(() => undefined);

// ---------------------------------------------------------------------------
// 资料库索引终态 → 通知收件箱(docs/en/docs/harness/signals.mdx)。
//
// 依赖反转的落点:rag/ 不能 import agents/(agent 的检索工具反过来依赖它),
// 所以由本入口把索引事件转成 agent 的通知记录。索引是后台任务,完成时线程
// 可能正在对话、也可能早已空闲 —— 投递时机交给 agent 的默认策略:成功用 low
// (两种情况都攒进 <notification-summary>,不打断用户),失败用 medium(线程
// 空闲时立即送达)。记录全文由 notification_inbox 工具读取。
// ---------------------------------------------------------------------------
onLibraryIndexSettled((event) => {
  const summary =
    event.outcome === "succeeded"
      ? `Library indexing finished for "${event.filename}"${
          event.chunkCount ? ` (${event.chunkCount} chunks)` : ""
        }. It is now retrievable by the library search tools.`
      : event.outcome === "unsupported"
        ? `Library indexing skipped "${event.filename}": no usable text could be extracted, so it is not retrievable.`
        : `Library indexing failed for "${event.filename}"${event.error ? `: ${event.error}` : "."}`;
  for (const threadId of event.threadIds) {
    void mastraWorkAgent
      .sendNotificationSignal(
        {
          source: "library",
          kind: `index-${event.outcome}`,
          priority: event.outcome === "succeeded" ? "low" : "medium",
          summary,
          payload: {
            assetId: event.assetId,
            filename: event.filename,
            outcome: event.outcome,
            ...(event.chunkCount === undefined ? {} : { chunkCount: event.chunkCount }),
            ...(event.error === undefined ? {} : { error: event.error }),
          },
          // 同一份资产反复重建索引时合并成一条待读记录
          dedupeKey: `library:index:${event.assetId}`,
        },
        { resourceId: event.resourceId, threadId },
      )
      .catch(() => undefined);
  }
});

// 优雅退出兜底通路
const SHUTDOWN_MESSAGE = "mastra-work:shutdown";

process.on("message", (message: unknown) => {
  if (
    typeof message === "object" &&
    message !== null &&
    (message as { type?: unknown }).type === SHUTDOWN_MESSAGE
  ) {
    void requestShutdown();
  }
});
process.on("SIGTERM", () => void requestShutdown());
process.on("SIGINT", () => void requestShutdown());
