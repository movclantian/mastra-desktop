/**
 * 频道运行时:把 Chat SDK 适配器接到工作台的 AgentController 会话上。
 * 官方文档:docs/en/docs/channels.mdx(Webhook / 线程上下文 / 工具审批 / 多用户)、
 * docs/en/docs/harness/agent-controller.mdx「Connect chat channels」。
 *
 * 设计要点:
 * - 频道是"安装级"能力:一个进程一套适配器,配置存全局 app_config,不按 resourceId 分租。
 * - 频道线程落成普通 Mastra 线程(带 channel_* metadata),因此出现在会话列表里,
 *   也能在桌面端继续同一段对话。
 * - 会话必须由 resolveSession 创建:工作台的会话 id、模式、模型、权限、工作区
 *   都在这里绑定,默认的 createSession 拿不到这些。
 * - Webhook 路由由 workRoutes 注册(见 routes/channels.ts),不依赖 Mastra 在构造期
 *   扫描 channels;这样运行期重建适配器不需要重启进程。
 */

import type { Session as ControllerSession } from "@mastra/core/agent-controller";
import { AgentControllerChannels as ControllerChannels } from "@mastra/core/channels";
import type { Mastra } from "@mastra/core/mastra";
import { MASTRA_RESOURCE_ID_KEY, RequestContext } from "@mastra/core/request-context";
import type { Adapter, Message, Thread } from "chat";
import { workbenchSessionId } from "../../shared/agent-contract";
import {
  CHANNEL_PLATFORMS,
  type ChannelAccount,
  type ChannelConfig,
  type ChannelPlatform,
  type ChannelRuntimeStatus,
  channelPlatformInfo,
} from "../../shared/channel-contract";
import {
  AGENT_PROFILE_CONTEXT_KEY,
  ensureProfileAgentsRegistered,
  getAgentProfile,
} from "../agents/custom";
import {
  MODE_ID_CONTEXT_KEY,
  PERMISSION_RULES_CONTEXT_KEY,
  parsePermissionRules,
  resolveMode,
  SESSION_TOOL_POLICY_CONTEXT_KEY,
  TOOL_CATEGORIES,
} from "../agents/permissions";
import { resolveDefaultModelId } from "../models/providers";
import { LIBRARY_RESOURCE_CONTEXT_KEY, LIBRARY_THREAD_CONTEXT_KEY } from "../rag/types";
import { AUTHENTICATED_USER_ID_CONTEXT_KEY, getAppConfig, setAppConfig } from "../storage/database";
import {
  ensureDirectory,
  implicitThreadWorkspacePath,
  WORKSPACE_PATH_CONTEXT_KEY,
  WORKSPACE_RESOURCE_ID_CONTEXT_KEY,
  WORKSPACE_THREAD_ID_CONTEXT_KEY,
} from "../workspace/workspace-manager";
import { createChannelAdapter } from "./adapters";
import { getChannelConfig, resolveChannelSecrets } from "./config";

/** 频道没有 HTTP 身份,保存配置时记住当前登录用户作为频道线程的归属。 */
const OWNER_KEY = "channels-owner";

export async function setChannelOwner(resourceId: string): Promise<void> {
  if (!resourceId.trim()) return;
  await setAppConfig(OWNER_KEY, resourceId);
}

export async function getChannelOwner(): Promise<string | null> {
  const value = await getAppConfig(OWNER_KEY);
  return value?.trim() ? value.trim() : null;
}

interface RuntimeState {
  channels: ControllerChannels | null;
  accounts: Map<ChannelPlatform, ChannelAccount>;
  errors: Map<ChannelPlatform, string>;
  lastEventAt: Map<ChannelPlatform, string>;
  signature: string;
  building: Promise<void> | null;
}

const state: RuntimeState = {
  channels: null,
  accounts: new Map(),
  errors: new Map(),
  lastEventAt: new Map(),
  signature: "",
  building: null,
};

/** 配置指纹:只有影响适配器的字段变化才重建,避免每次保存都断线重连。 */
function configSignature(config: ChannelConfig): string {
  return JSON.stringify(
    config.accounts.map((account) => ({
      platform: account.platform,
      enabled: account.enabled,
      transport: account.transport,
      mentionOnly: account.mentionOnly,
      allowedUserIds: account.allowedUserIds,
      textFormat: account.textFormat,
      toolDisplay: account.toolDisplay,
      threadContextMaxMessages: account.threadContextMaxMessages,
      agentProfileId: account.agentProfileId,
      secrets: Object.fromEntries(
        Object.entries(account.secrets).map(([field, value]) => [
          field,
          value.hasCredential ? value.credentialRef : "",
        ]),
      ),
    })),
  );
}

/**
 * 频道线程缺少路由层,这里补齐工作台工具依赖的上下文键。
 * 与 routes/session-context.ts 的 sessionFor 对齐,区别只是没有 HTTP 请求。
 */
async function bindThreadContext(
  session: ControllerSession,
  requestContext: RequestContext,
  resourceId: string,
  threadId: string,
  account: ChannelAccount | undefined,
): Promise<void> {
  requestContext.set(AUTHENTICATED_USER_ID_CONTEXT_KEY, resourceId);
  requestContext.set(MASTRA_RESOURCE_ID_KEY, resourceId);
  requestContext.set(WORKSPACE_RESOURCE_ID_CONTEXT_KEY, resourceId);
  requestContext.set(WORKSPACE_THREAD_ID_CONTEXT_KEY, threadId);
  requestContext.set(LIBRARY_RESOURCE_CONTEXT_KEY, resourceId);
  requestContext.set(LIBRARY_THREAD_CONTEXT_KEY, threadId);
  if (account?.agentProfileId)
    requestContext.set(AGENT_PROFILE_CONTEXT_KEY, account.agentProfileId);

  const thread = (await session.thread.getById({ threadId })) as {
    metadata?: Record<string, unknown>;
  } | null;
  const metadata = thread?.metadata ?? {};
  let workspacePath = typeof metadata.workspacePath === "string" ? metadata.workspacePath : "";
  if (!workspacePath) {
    workspacePath = await implicitThreadWorkspacePath(threadId, resourceId);
    ensureDirectory(workspacePath);
    await session.thread.setSettingOn({ threadId, key: "workspacePath", value: workspacePath });
    await session.thread.setSettingOn({ threadId, key: "workspaceExplicit", value: false });
  }
  requestContext.set(WORKSPACE_PATH_CONTEXT_KEY, workspacePath);

  const mode = resolveMode(metadata.currentModeId);
  if (session.mode.get() !== mode.id) await session.mode.switch({ modeId: mode.id });
  requestContext.set(MODE_ID_CONTEXT_KEY, mode.id);
  requestContext.set(SESSION_TOOL_POLICY_CONTEXT_KEY, (toolName: string) =>
    session.resolveToolApproval(toolName),
  );
  const rules = parsePermissionRules(metadata.permissionRules);
  const sessionState = session.state.get() as { permissionRules?: unknown };
  if (sessionState.permissionRules === undefined) {
    const yolo =
      TOOL_CATEGORIES.every((category) => rules.categories[category] === "allow") &&
      Object.values(rules.tools).every((policy) => policy === "allow");
    await session.state.set({ permissionRules: rules, yolo });
  }
  requestContext.set(PERMISSION_RULES_CONTEXT_KEY, session.permissions.getRules());
  if (account?.agentProfileId) {
    await session.thread.setSettingOn({
      threadId,
      key: "agentProfileId",
      value: account.agentProfileId,
    });
  }
}

/** 平台级准入:白名单与 @ 限制统一在这里执行,不依赖各适配器自带的过滤。 */
function isAllowed(account: ChannelAccount, message: Message): boolean {
  if (!account.allowedUserIds.length) return true;
  return account.allowedUserIds.includes(message.author.userId);
}

function platformAccount(platform: string): ChannelAccount | undefined {
  return state.accounts.get(platform as ChannelPlatform);
}

function recordError(platform: ChannelPlatform, error: unknown): void {
  state.errors.set(platform, error instanceof Error ? error.message : String(error));
}

/**
 * 事件门禁。
 * - `mentionOnly` 只对已订阅线程生效:首次 @ 之后线程被订阅,后续消息走 onSubscribedMessage。
 * - 白名单在每类事件上都要过一遍,否则群里任何人 @ 一次就能建立会话。
 */
function channelHandlers() {
  const gate =
    (kind: "dm" | "mention" | "subscribed") =>
    async (
      thread: Thread,
      message: Message,
      defaultHandler: (thread: Thread, message: Message) => Promise<void>,
      ctx: { requestContext: RequestContext },
    ): Promise<void> => {
      const account = platformAccount(thread.adapter.name);
      if (!account) return;
      state.lastEventAt.set(account.platform, new Date().toISOString());
      if (!isAllowed(account, message)) return;
      if (
        kind === "subscribed" &&
        !thread.isDM &&
        account.mentionOnly &&
        message.isMention !== true
      )
        return;
      if (account.agentProfileId) {
        ctx.requestContext.set(AGENT_PROFILE_CONTEXT_KEY, account.agentProfileId);
      }
      try {
        await defaultHandler(thread, message);
      } catch (error) {
        recordError(account.platform, error);
        throw error;
      }
    };

  return {
    onDirectMessage: gate("dm"),
    onMention: gate("mention"),
    onSubscribedMessage: gate("subscribed"),
  };
}

/** 构造适配器集合;单个平台失败只影响该平台,其余照常工作。 */
async function buildAdapters(
  config: ChannelConfig,
): Promise<{ adapters: Record<string, Adapter>; accounts: Map<ChannelPlatform, ChannelAccount> }> {
  const adapters: Record<string, Adapter> = {};
  const accounts = new Map<ChannelPlatform, ChannelAccount>();
  state.errors.clear();
  for (const account of config.accounts) {
    if (!account.enabled) continue;
    const info = channelPlatformInfo(account.platform);
    const missing = info.secrets.filter(
      (field) => field.required && !account.secrets[field.key]?.hasCredential,
    );
    if (missing.length) {
      recordError(
        account.platform,
        `缺少必需凭据:${missing.map((field) => field.label).join("、")}`,
      );
      continue;
    }
    try {
      adapters[account.platform] = createChannelAdapter(
        account,
        await resolveChannelSecrets(account),
      );
      accounts.set(account.platform, account);
    } catch (error) {
      recordError(account.platform, error);
    }
  }
  return { adapters, accounts };
}

/** 线程上下文窗口:取已启用平台里的最大值;没有启用项时用默认 10。 */
function threadContextWindow(config: ChannelConfig): number {
  const enabled = config.accounts.filter((account) => account.enabled);
  if (!enabled.length) return 10;
  return Math.max(...enabled.map((account) => account.threadContextMaxMessages));
}

/**
 * 按当前配置重建适配器并挂到 workbench 控制器上。
 * 幂等:配置指纹未变化直接返回;并发调用共享同一次重建。
 */
export async function syncChannelRuntime(mastra: Mastra): Promise<void> {
  if (state.building) return state.building;
  state.building = (async () => {
    const config = await getChannelConfig();
    const owner = await getChannelOwner();
    const signature = JSON.stringify({ owner, config: configSignature(config) });
    if (signature === state.signature && state.channels) return;
    if (signature === state.signature && !state.channels && !owner) return;
    state.signature = signature;

    const controller = mastra.getAgentController("workbench");
    if (!controller) throw new Error("Workbench AgentController is not registered");
    const { adapters: builtAdapters, accounts } = await buildAdapters(config);

    // 频道没有登录身份时不能安全地建立共享线程;保留空运行时,等桌面保存配置
    // 绑定用户后下一次 sync 再真正挂载适配器。
    if (!owner) {
      await state.channels?.sdk?.shutdown().catch(() => undefined);
      state.channels = null;
      state.accounts = new Map();
      if (Object.keys(builtAdapters).length > 0) {
        for (const platform of Object.keys(builtAdapters) as ChannelPlatform[]) {
          recordError(platform, "请先从桌面设置保存频道配置以绑定当前用户");
        }
      }
      return;
    }

    const adapters = builtAdapters;
    state.accounts = accounts;

    // 先断开旧实例的长连接,避免 Slack Socket / Telegram 轮询出现双份投递。
    await state.channels?.sdk?.shutdown().catch(() => undefined);

    const channels = new ControllerChannels({
      adapters: Object.fromEntries(
        Object.entries(adapters).map(([platform, adapter]) => {
          const account = accounts.get(platform as ChannelPlatform);
          return [
            platform,
            {
              adapter,
              textFormat: account?.textFormat ?? "markdown",
              toolDisplay:
                account?.toolDisplay === "cards" &&
                !channelPlatformInfo(platform as ChannelPlatform).approvalButtons
                  ? "hidden"
                  : (account?.toolDisplay ?? "cards"),
              // 平台画不出按钮时让需审批的工具自动放行,避免留下悬挂的审批门。
              approvalButtons: channelPlatformInfo(platform as ChannelPlatform).approvalButtons,
            },
          ];
        }),
      ),
      handlers: channelHandlers(),
      tools: true,
      // 频道线程复用桌面用户的记忆与工作区,而不是按平台 id 新建租户。
      resolveResourceId: () => owner,
      threadContext: { maxMessages: threadContextWindow(config) },
      inlineMedia: ["image/*", "application/pdf"],
      resolveSession: async ({ controller: sessionController, thread, requestContext }) => {
        const resourceId = thread.resourceId;
        const context = requestContext ?? new RequestContext();
        const channel = context.get("channel") as { platform?: string } | undefined;
        const account = channel?.platform ? platformAccount(channel.platform) : undefined;
        if (account?.agentProfileId) {
          const profile = await getAgentProfile(account.agentProfileId, resourceId);
          const profileMastra = sessionController.getMastra();
          if (!profileMastra) throw new Error("Workbench Mastra instance is unavailable");
          ensureProfileAgentsRegistered(profileMastra, profile, resourceId);
        }
        const session = await sessionController.createSession({
          id: workbenchSessionId(resourceId, thread.id),
          resourceId,
          threadId: thread.id,
          ownerId: sessionController.id,
          requestContext: context,
        });
        await bindThreadContext(session, context, resourceId, thread.id, account);
        await session.model.syncFromPersisted();
        if (!session.model.hasSelection()) {
          const defaultModelId = await resolveDefaultModelId(resourceId, "language");
          if (defaultModelId) await session.model.switch(defaultModelId);
        }
        return session;
      },
    });
    controller.setChannels(channels);
    state.channels = channels;
    await channels.initialize(mastra);
  })().finally(() => {
    state.building = null;
  });
  return state.building;
}

/** Webhook 入口:交给当前适配器实例处理;未启用返回 404。 */
export async function handleChannelWebhook(
  platform: string,
  request: Request,
  waitUntil?: (promise: Promise<unknown>) => void,
): Promise<Response> {
  const channels = state.channels;
  if (!channels?.hasAdapter(platform)) {
    return new Response(JSON.stringify({ error: "Channel is not enabled" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }
  state.lastEventAt.set(platform as ChannelPlatform, new Date().toISOString());
  return channels.handleWebhookEvent(platform, request, waitUntil ? { waitUntil } : undefined);
}

/** 运行期状态:UI 用它显示"已挂上 / 未启用 / 出错"。 */
export function channelRuntimeStatus(): ChannelRuntimeStatus[] {
  return CHANNEL_PLATFORMS.map((platform) => {
    const running = state.channels?.hasAdapter(platform) === true;
    const info = channelPlatformInfo(platform);
    return {
      platform,
      running,
      webhookUrl: running && info.webhookPath ? info.webhookPath : null,
      lastEventAt: state.lastEventAt.get(platform) ?? null,
      lastError: state.errors.get(platform) ?? null,
    };
  });
}

/** 探测:仅构造适配器,不接管 Webhook,用来在保存前验证凭据形状。 */
export async function probeChannelAccount(
  account: ChannelAccount,
): Promise<{ ok: boolean; error?: string }> {
  try {
    createChannelAdapter(account, await resolveChannelSecrets(account));
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** 关闭长连接(Slack Socket / Telegram 轮询),由 shutdown 流程调用。 */
export async function closeChannelRuntime(): Promise<void> {
  await state.channels?.sdk?.shutdown().catch(() => undefined);
  state.channels = null;
  state.signature = "";
}
