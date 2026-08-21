import { Mastra } from "@mastra/core/mastra";
import type { Processor } from "@mastra/core/processors";
import { MASTRA_RESOURCE_ID_KEY } from "@mastra/core/request-context";
import type { StorageWorkspaceSnapshotType } from "@mastra/core/storage";
import { askUserTool, submitPlanTool } from "@mastra/core/tools";
import { MastraEditor } from "@mastra/editor";
import { PinoLogger } from "@mastra/loggers";
import { MastraStorageExporter, Observability, SensitiveDataFilter } from "@mastra/observability";
import { ProxyAgent, setGlobalDispatcher } from "undici";
import { mastraWorkAgent } from "./agents";
import { getConfiguredProcessorRegistry } from "./agents/guardrails";
import { WORKBENCH_GATEWAY_ID, WorkbenchGateway } from "./agents/llm";
import { libraryAttachmentProcessor } from "./agents/processors";
import { recoverInterruptedLibraryIndexes } from "./library";
import { ensureLibrarySchema } from "./library/db";
import { getLibrarySettings } from "./library/settings";
import { workChatRoute, workRoutes } from "./server/routes";
import { requestShutdown } from "./server/routes/shutdown";
import { appStorage } from "./storage";
import { getThreadsRoot, getThreadWorkspace } from "./workspace";

// ---------------------------------------------------------------------------
// 出站请求走系统代理(Node 原生 fetch 不读代理)。
// 例如 api.b.ai 国内直连被墙/超时,而本机经代理直通;
// 这里给全局 fetch 挂 ProxyAgent,让模型列表拉取、聊天请求、models.dev
// 目录等所有出站 fetch 走代理。代理地址只从环境变量读取 —— 系统代理的
// 解析由 Electron 主进程用 Chromium 官方 API 完成并注入(见 src/main/index.ts
// 的 resolveSystemProxyUrl),本文件不做任何平台级读取。未配置则保持直连。
// ---------------------------------------------------------------------------
const proxyUrl =
  process.env.HTTPS_PROXY ??
  process.env.https_proxy ??
  process.env.HTTP_PROXY ??
  process.env.http_proxy;
if (proxyUrl) {
  try {
    setGlobalDispatcher(new ProxyAgent(proxyUrl));
    console.log(`[mastra] 出站请求走系统代理: ${proxyUrl}`);
  } catch (error) {
    console.warn(
      `[mastra] 检测到代理 ${proxyUrl} 但启用失败，继续直连: ${
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

export const mastra = new Mastra({
  agents: { mastraWorkAgent },
  processors: processorRegistry,
  /**
   * Editor 可见的项目工具(docs/en/docs/studio/editor.mdx「Project tools」)。
   * 只登记无需 API Key 的静态工具 —— 联网检索工具按请求用当前 Key 实例化
   * (src/mastra/agents/tools.ts 的 resolveWebSearchTools),没有可登记的静态实例,
   * 它们继续只经 Agent 的动态 tools 注入。execute_typescript 同理:
   * 它由 createCodeMode 绑定了沙箱实例,只归 Agent 动态注入。
   */
  tools: {
    ask_user: askUserTool,
    submit_plan: submitPlanTool,
  },
  /**
   * 自定义模型网关:把设置面板存进 app_config 的供应商与 Key 暴露给 model router,
   * 于是 Studio 的模型选择器能直接列出并使用它们,不再要求 env 变量
   * (docs/en/models/gateways/custom-gateways.mdx)。
   */
  gateways: { [WORKBENCH_GATEWAY_ID]: new WorkbenchGateway() },
  /**
   * Editor(docs/en/docs/studio/editor.mdx):默认 source 'db',复用下面的
   * LibSQL 存储,Studio 中出现 instructions/tools 的草稿与发布流程 + 版本化。
   * local filesystem 与 sandbox provider 为内置,无需显式传入。
   */
  editor: new MastraEditor(),
  // Register the configured workspace with Mastra itself as well as the
  // request-scoped Agent workspace. Studio's /workspaces page reads this
  // registry; the Agent still resolves per-thread directories at runtime.
  workspace: getThreadWorkspace(getThreadsRoot()),
  server: {
    // Studio 与桌面工作台共用同一份 LibSQL 数据库。Studio 内置路由不会可靠地
    // 带上桌面自定义的 resourceId query/header,所以不能依赖客户端标记来判断
    // 请求来源;这个单机工作台的所有 Mastra 内置路由都固定到同一个本地资源。
    // 这样 Studio、Editor 触发的 Agent 运行以及桌面线程列表使用同一条线程数据。
    middleware: async (c, next) => {
      c.get("requestContext").set(MASTRA_RESOURCE_ID_KEY, WORKBENCH_RESOURCE_ID);
      await next();
    },
    cors: {
      origin: "*", // Restrict this to your app's origin in production
      allowMethods: ["*"],
      allowHeaders: ["*"],
    },
    apiRoutes: [workChatRoute, ...workRoutes],
  },
  storage: appStorage,
  logger: new PinoLogger({
    name: "Mastra",
    level: "info",
  }),
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

// Studio 的 /workspaces 页面读取 editor workspace domain，而不是 Mastra 的运行时注册表。
// 将同一个线程工作区快照持久化一次，确保桌面 Agent 与 Studio 看到的是同一工作区。
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

// Dynamic processor factories cannot be inferred by Studio during Agent
// construction. Register their resolved configurations explicitly so the
// processor detail page shows the actual MastraWork input/output pipeline.
mastra.addProcessorConfiguration(libraryAttachmentProcessor, mastraWorkAgent.id, "input");
for (const processor of configuredProcessorRegistry.input) {
  if (!("id" in processor) || typeof processor.id !== "string") continue;
  if (
    !(
      "processInput" in processor ||
      "processInputStep" in processor ||
      "processLLMRequest" in processor
    )
  )
    continue;
  mastra.addProcessorConfiguration(processor as Processor, mastraWorkAgent.id, "input");
}
for (const processor of configuredProcessorRegistry.output) {
  if (!("id" in processor) || typeof processor.id !== "string") continue;
  if (
    !(
      "processOutputStream" in processor ||
      "processOutputResult" in processor ||
      "processOutputStep" in processor ||
      "processToolResult" in processor
    )
  )
    continue;
  mastra.addProcessorConfiguration(processor as Processor, mastraWorkAgent.id, "output");
}

// 进程重启后恢复上次中断的索引任务，重新执行完整的文本抽取、分块、Embedding 与向量写入。
void (async () => {
  await ensureLibrarySchema();
  await recoverInterruptedLibraryIndexes(await getLibrarySettings());
})().catch(() => undefined);

// ---------------------------------------------------------------------------
// 优雅退出兜底通路:落盘例程与 HTTP 主通路 /work/shutdown 统一在
// server/routes/shutdown.ts,这里只挂进程级触发器。
// - IPC message:打包态 Electron 主进程 spawn 的就是本 ESM 入口,消息直达
// - SIGTERM / SIGINT:POSIX 信号;Windows 无对应机制,依赖 HTTP 主通路
// 消息名与 src/main/index.ts 的 MASTRA_SHUTDOWN_MESSAGE 必须一致。
// ---------------------------------------------------------------------------

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
