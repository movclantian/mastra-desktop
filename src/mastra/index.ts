/**
 * Mastra 实例入口:注册 Agent / 网关 / 存储 / 观测 / 编辑器与 /work/* 路由,
 * 并完成进程级初始化(出站代理、处理器登记、索引恢复、优雅退出)。
 * 官方文档:docs/en/docs/mastra-platform/configuration.mdx(配置项)、
 * docs/en/docs/observability/overview.mdx + integrations/exporters/mastra-storage.mdx、
 * docs/en/docs/studio/editor.mdx(编辑器工作区)。
 */

import { getErrorFromUnknown } from "@mastra/core/error";
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
import { initializeAgentProfiles } from "./agents/custom";
import { getConfiguredProcessorRegistry } from "./agents/guardrails";
import {
  agentsMdProcessor,
  editorStateProcessor,
  libraryAttachmentProcessor,
  terminalStateProcessor,
  workbenchStateProcessor,
} from "./agents/processors";
import { WorkApiError } from "./errors";
import { WORKBENCH_GATEWAY_ID, WorkbenchGateway } from "./models";
import {
  ensureLibrarySchema,
  getLibrarySettings,
  onLibraryIndexSettled,
  recoverInterruptedLibraryIndexes,
} from "./rag";
import { workChatRoute, workRoutes } from "./server/routes";
import { requestShutdown } from "./server/routes/shutdown";
import { appStorage } from "./storage";
import { getThreadsRoot, getThreadWorkspace } from "./workspace";

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

const WORKBENCH_RESOURCE_ID = "user-local";
const STUDIO_WORKSPACE_ID = "mastra-workspace";

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
  agents: { mastraWorkAgent },
  processors: processorRegistry,
  tools: {
    ask_user: askUserTool,
    submit_plan: submitPlanTool,
  },
  gateways: { [WORKBENCH_GATEWAY_ID]: new WorkbenchGateway() },
  editor: new MastraEditor(),
  workspace: getThreadWorkspace(getThreadsRoot()),
  server: {
    middleware: async (c, next) => {
      c.get("requestContext").set(MASTRA_RESOURCE_ID_KEY, WORKBENCH_RESOURCE_ID);
      await next();
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

// 用户保存的 Agent/Team 在启动时注册为真正的 Mastra agents，并把 Team
// workflow 作为 dynamic workflow 持久化和恢复。默认 Agent 仍由上面的静态
// registry 提供，避免 profile storage 读取失败时工作台无法启动。
await initializeAgentProfiles(mastra);

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
for (const processor of configuredProcessorRegistry.output) {
  mastra.addProcessorConfiguration(processor as Processor, mastraWorkAgent.id, "output");
}

// 进程重启后恢复上次中断的索引任务
void (async () => {
  await ensureLibrarySchema();
  await recoverInterruptedLibraryIndexes(await getLibrarySettings());
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
