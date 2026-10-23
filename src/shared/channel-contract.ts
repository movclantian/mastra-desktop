import { z } from "zod";
import { CredentialStateSchema } from "./credential-contract";

/**
 * 频道(Channels)共享契约。
 * 官方文档:docs/en/docs/channels.mdx(总览 / Webhook / 线程上下文 / 工具审批)、
 * docs/en/reference/agents/channels.mdx(适配器与 handlers 参数)。
 *
 * 本文件只描述"可被 UI 编辑、可被路由校验、可被运行时读取"的数据形状;
 * 适配器实例、凭据解析与 Webhook 分发都在 src/mastra/channels/ 内完成。
 */

/** 桌面端支持的平台。名称即 Mastra `channels.adapters` 的键,也出现在 Webhook 路径里。 */
export const CHANNEL_PLATFORMS = [
  "slack",
  "teams",
  "discord",
  "telegram",
  "whatsapp",
  "github",
  "linear",
] as const;
export type ChannelPlatform = (typeof CHANNEL_PLATFORMS)[number];

/**
 * 平台接入方式。
 * - `webhook`:平台把事件 POST 到本机 `/api/agent-controllers/<id>/channels/<platform>/webhook`,
 *   需要公网可达(开发期用 cloudflared / ngrok 隧道)。
 * - `socket`:长连接主动外拨,不需要公网入口。仅 Slack(Socket Mode)与 Telegram(长轮询)支持。
 */
export const CHANNEL_TRANSPORTS = ["webhook", "socket"] as const;
export type ChannelTransport = (typeof CHANNEL_TRANSPORTS)[number];

/** 回复渲染方式:markdown 走平台原生渲染,plain 原样输出(适配器方言逃生口)。 */
export const CHANNEL_TEXT_FORMATS = ["markdown", "plain"] as const;
export type ChannelTextFormat = (typeof CHANNEL_TEXT_FORMATS)[number];

/** 工具调用展示:`cards` 富卡片、`text` 纯文本、`hidden` 静默。 */
export const CHANNEL_TOOL_DISPLAYS = ["cards", "text", "hidden"] as const;
export type ChannelToolDisplay = (typeof CHANNEL_TOOL_DISPLAYS)[number];

/**
 * 凭据字段。值存放在主进程凭据库,这里只保留引用与提示,
 * 与 provider / MCP / browser 的凭据处理保持一致。
 */
export const ChannelSecretFieldSchema = z
  .object({
    key: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/),
    label: z.string().trim().min(1).max(80),
    required: z.boolean(),
    placeholder: z.string().max(120).optional(),
  })
  .strict();

export type ChannelSecretField = z.infer<typeof ChannelSecretFieldSchema>;

/** 单个凭据槽位的持久化状态:已保存只回引用,不回明文。 */
export const ChannelSecretStateSchema = z.union([
  CredentialStateSchema,
  z.object({ hasCredential: z.literal(false) }).strict(),
]);
export type ChannelSecretState = z.infer<typeof ChannelSecretStateSchema>;

/** 平台静态描述:凭据字段、接入方式、文档链接。由服务端下发,UI 只渲染。 */
export const ChannelPlatformInfoSchema = z
  .object({
    platform: z.enum(CHANNEL_PLATFORMS),
    name: z.string().min(1),
    description: z.string().min(1),
    /** 该平台可用的接入方式;首项为默认值。 */
    transports: z.array(z.enum(CHANNEL_TRANSPORTS)).min(1),
    /** 该平台是否支持交互式审批按钮。不支持时工具自动放行,不留下悬挂的审批门。 */
    approvalButtons: z.boolean(),
    secrets: z.array(ChannelSecretFieldSchema),
    /** 平台侧需要配置的 Webhook / 事件订阅地址说明(含占位符)。 */
    webhookPath: z.string().min(1).nullable(),
    docsUrl: z.string().url(),
  })
  .strict();

export type ChannelPlatformInfo = z.infer<typeof ChannelPlatformInfoSchema>;

/** 单个平台的可编辑配置。 */
export const ChannelAccountSchema = z
  .object({
    platform: z.enum(CHANNEL_PLATFORMS),
    enabled: z.boolean(),
    transport: z.enum(CHANNEL_TRANSPORTS),
    /** 允许触发 Agent 的平台用户 ID;空数组表示不限(单人自托管场景的默认)。 */
    allowedUserIds: z.array(z.string().trim().min(1).max(128)).max(200),
    /** 需要 @ 才响应;关闭后该线程内的所有消息都会进入 Agent。 */
    mentionOnly: z.boolean(),
    textFormat: z.enum(CHANNEL_TEXT_FORMATS),
    toolDisplay: z.enum(CHANNEL_TOOL_DISPLAYS),
    /** 首次被 @ 时回填的历史消息条数;0 关闭。 */
    threadContextMaxMessages: z.number().int().min(0).max(100),
    /** 绑定到哪个 Agent 配置(空表示默认 Agent)。 */
    agentProfileId: z.string().trim().max(160),
    secrets: z.record(z.string(), ChannelSecretStateSchema),
  })
  .strict();

export type ChannelAccount = z.infer<typeof ChannelAccountSchema>;

export const ChannelConfigSchema = z
  .object({
    accounts: z.array(ChannelAccountSchema),
  })
  .strict();

export type ChannelConfig = z.infer<typeof ChannelConfigSchema>;

export const ChannelTestResultSchema = z
  .object({
    ok: z.boolean(),
    /** 已解析到的机器人身份,例如 Slack 的 bot user id。 */
    identity: z.string().max(200).optional(),
    error: z.string().max(2_000).optional(),
  })
  .strict();

export type ChannelTestResult = z.infer<typeof ChannelTestResultSchema>;

/** 运行期状态:哪些平台真正挂上了适配器,以及它们收到的最后一条事件时间。 */
export const ChannelRuntimeStatusSchema = z
  .object({
    platform: z.enum(CHANNEL_PLATFORMS),
    running: z.boolean(),
    webhookUrl: z.string().nullable(),
    lastEventAt: z.string().nullable(),
    lastError: z.string().max(2_000).nullable(),
  })
  .strict();

export type ChannelRuntimeStatus = z.infer<typeof ChannelRuntimeStatusSchema>;

/** 平台凭据字段定义。顺序即 UI 展示顺序。 */
export const CHANNEL_PLATFORM_INFO: Record<ChannelPlatform, ChannelPlatformInfo> = {
  slack: {
    platform: "slack",
    name: "Slack",
    description:
      "在频道或私聊里 @ 机器人。Socket Mode 不需要公网入口;Webhook 模式需要签名密钥校验。",
    transports: ["socket", "webhook"],
    approvalButtons: true,
    secrets: [
      {
        key: "SLACK_BOT_TOKEN",
        label: "Bot token (xoxb-…)",
        required: true,
        placeholder: "xoxb-…",
      },
      {
        key: "SLACK_APP_TOKEN",
        label: "App-level token (xapp-…)",
        required: false,
        placeholder: "xapp-…",
      },
      {
        key: "SLACK_SIGNING_SECRET",
        label: "Signing secret",
        required: false,
      },
    ],
    webhookPath: "/api/agent-controllers/workbench/channels/slack/webhook",
    docsUrl: "https://chat-sdk.dev/adapters",
  },
  teams: {
    platform: "teams",
    name: "Microsoft Teams",
    description: "通过 Azure Bot 的 Webhook 接收频道与私聊消息,支持自适应卡片审批。",
    transports: ["webhook"],
    approvalButtons: true,
    secrets: [
      { key: "TEAMS_APP_ID", label: "App (client) ID", required: true },
      { key: "TEAMS_APP_PASSWORD", label: "Client secret", required: true },
      { key: "TEAMS_APP_TENANT_ID", label: "Tenant ID", required: false },
    ],
    webhookPath: "/api/agent-controllers/workbench/channels/teams/webhook",
    docsUrl: "https://chat-sdk.dev/adapters",
  },
  discord: {
    platform: "discord",
    name: "Discord",
    description: "Discord 机器人:私聊、@ 与斜杠命令。默认走 HTTP Interactions,可选 Gateway。",
    transports: ["webhook"],
    approvalButtons: true,
    secrets: [
      { key: "DISCORD_BOT_TOKEN", label: "Bot token", required: true },
      { key: "DISCORD_APPLICATION_ID", label: "Application ID", required: true },
      { key: "DISCORD_PUBLIC_KEY", label: "Public key", required: true },
    ],
    webhookPath: "/api/agent-controllers/workbench/channels/discord/webhook",
    docsUrl: "https://chat-sdk.dev/adapters",
  },
  telegram: {
    platform: "telegram",
    name: "Telegram",
    description: "BotFather 机器人。长轮询无需公网;Webhook 模式需要 secret token 校验。",
    transports: ["socket", "webhook"],
    approvalButtons: true,
    secrets: [
      { key: "TELEGRAM_BOT_TOKEN", label: "Bot token", required: true },
      {
        key: "TELEGRAM_WEBHOOK_SECRET_TOKEN",
        label: "Webhook secret token",
        required: false,
      },
    ],
    webhookPath: "/api/agent-controllers/workbench/channels/telegram/webhook",
    docsUrl: "https://chat-sdk.dev/adapters",
  },
  whatsapp: {
    platform: "whatsapp",
    name: "WhatsApp",
    description: "WhatsApp Business Cloud API。需要 Meta 侧配置回调地址与校验口令。",
    transports: ["webhook"],
    approvalButtons: false,
    secrets: [
      { key: "WHATSAPP_ACCESS_TOKEN", label: "Access token", required: true },
      { key: "WHATSAPP_PHONE_NUMBER_ID", label: "Phone number ID", required: true },
      { key: "WHATSAPP_APP_SECRET", label: "App secret", required: true },
      { key: "WHATSAPP_VERIFY_TOKEN", label: "Verify token", required: true },
    ],
    webhookPath: "/api/agent-controllers/workbench/channels/whatsapp/webhook",
    docsUrl: "https://chat-sdk.dev/adapters",
  },
  github: {
    platform: "github",
    name: "GitHub",
    description: "在 Issue 与 Pull Request 讨论串里协作。使用 PAT 或 GitHub App 凭据。",
    transports: ["webhook"],
    approvalButtons: false,
    secrets: [
      { key: "GITHUB_TOKEN", label: "Personal access token", required: false },
      { key: "GITHUB_WEBHOOK_SECRET", label: "Webhook secret", required: true },
      { key: "GITHUB_APP_ID", label: "App ID", required: false },
      { key: "GITHUB_PRIVATE_KEY", label: "App private key", required: false },
    ],
    webhookPath: "/api/agent-controllers/workbench/channels/github/webhook",
    docsUrl: "https://chat-sdk.dev/adapters",
  },
  linear: {
    platform: "linear",
    name: "Linear",
    description: "在 Linear 评论串里接活。API key 或 OAuth 凭据加 Webhook secret。",
    transports: ["webhook"],
    approvalButtons: false,
    secrets: [
      { key: "LINEAR_API_KEY", label: "API key", required: false },
      { key: "LINEAR_ACCESS_TOKEN", label: "OAuth access token", required: false },
      { key: "LINEAR_WEBHOOK_SECRET", label: "Webhook secret", required: true },
    ],
    webhookPath: "/api/agent-controllers/workbench/channels/linear/webhook",
    docsUrl: "https://chat-sdk.dev/adapters",
  },
};

export function channelPlatformInfo(platform: ChannelPlatform): ChannelPlatformInfo {
  return CHANNEL_PLATFORM_INFO[platform];
}

/** 未启用任何平台时的默认配置。 */
export const DEFAULT_CHANNEL_CONFIG: ChannelConfig = { accounts: [] };

export function defaultChannelAccount(platform: ChannelPlatform): ChannelAccount {
  const info = channelPlatformInfo(platform);
  return {
    platform,
    enabled: false,
    transport: info.transports[0],
    allowedUserIds: [],
    mentionOnly: true,
    textFormat: "markdown",
    toolDisplay: info.approvalButtons ? "cards" : "hidden",
    threadContextMaxMessages: 10,
    agentProfileId: "",
    secrets: Object.fromEntries(
      info.secrets.map((field) => [field.key, { hasCredential: false } as const]),
    ),
  };
}
