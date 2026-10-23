/**
 * 适配器工厂:把"配置 + 金库凭据"变成 Chat SDK Adapter 实例。
 * 官方文档:docs/en/docs/channels.mdx「Configure an agent」、
 * docs/en/reference/agents/channels.mdx(适配器工厂与参数)。
 *
 * 只有凭据齐备的平台才会被构造;构造失败一律抛错,由上层记录为运行期错误,
 * 不静默降级 —— 一个"看起来启用但收不到消息"的频道比明确的失败更难排查。
 */
import { createDiscordAdapter } from "@chat-adapter/discord";
import { createGitHubAdapter } from "@chat-adapter/github";
import { createLinearAdapter } from "@chat-adapter/linear";
import { createSlackAdapter } from "@chat-adapter/slack";
import { createTeamsAdapter } from "@chat-adapter/teams";
import { createTelegramAdapter } from "@chat-adapter/telegram";
import { createWhatsAppAdapter } from "@chat-adapter/whatsapp";
import type { Adapter } from "chat";
import type { ChannelAccount, ChannelPlatform } from "../../shared/channel-contract";

type SecretReader = (field: string) => string;

function required(secrets: Record<string, string>, field: string, platform: string): string {
  const value = secrets[field]?.trim();
  if (!value) throw new Error(`${platform} 缺少必需凭据 ${field}`);
  return value;
}

function optional(secrets: Record<string, string>, field: string): string | undefined {
  const value = secrets[field]?.trim();
  return value ? value : undefined;
}

/**
 * 构造单个平台的适配器。
 * `transport === "socket"` 只对 Slack / Telegram 有意义,其余平台恒走 Webhook。
 */
export function createChannelAdapter(
  account: ChannelAccount,
  secrets: Record<string, string>,
): Adapter {
  const read: SecretReader = (field) => secrets[field] ?? "";
  switch (account.platform) {
    case "slack": {
      const appToken = optional(secrets, "SLACK_APP_TOKEN");
      const signingSecret = optional(secrets, "SLACK_SIGNING_SECRET");
      if (account.transport === "socket" && !appToken)
        throw new Error("Slack Socket Mode 需要 App-level token (xapp-…)");
      if (account.transport === "webhook" && !signingSecret)
        throw new Error("Slack Webhook 模式需要 Signing secret");
      return createSlackAdapter({
        botToken: required(secrets, "SLACK_BOT_TOKEN", "Slack"),
        ...(appToken ? { appToken } : {}),
        ...(signingSecret ? { signingSecret } : {}),
        ...(account.transport === "socket" ? { mode: "socket" as const } : {}),
      });
    }
    case "teams":
      return createTeamsAdapter({
        appId: required(secrets, "TEAMS_APP_ID", "Teams"),
        appPassword: required(secrets, "TEAMS_APP_PASSWORD", "Teams"),
        ...(optional(secrets, "TEAMS_APP_TENANT_ID")
          ? { appTenantId: read("TEAMS_APP_TENANT_ID") }
          : {}),
      });
    case "discord":
      return createDiscordAdapter({
        botToken: required(secrets, "DISCORD_BOT_TOKEN", "Discord"),
        applicationId: required(secrets, "DISCORD_APPLICATION_ID", "Discord"),
        publicKey: required(secrets, "DISCORD_PUBLIC_KEY", "Discord"),
      });
    case "telegram": {
      const secretToken = optional(secrets, "TELEGRAM_WEBHOOK_SECRET_TOKEN");
      if (account.transport === "webhook" && !secretToken)
        throw new Error("Telegram Webhook 模式需要 secret token");
      return createTelegramAdapter({
        botToken: required(secrets, "TELEGRAM_BOT_TOKEN", "Telegram"),
        mode: account.transport === "socket" ? "polling" : "webhook",
        ...(secretToken ? { secretToken } : {}),
      });
    }
    case "whatsapp":
      return createWhatsAppAdapter({
        accessToken: required(secrets, "WHATSAPP_ACCESS_TOKEN", "WhatsApp"),
        phoneNumberId: required(secrets, "WHATSAPP_PHONE_NUMBER_ID", "WhatsApp"),
        appSecret: required(secrets, "WHATSAPP_APP_SECRET", "WhatsApp"),
        verifyToken: required(secrets, "WHATSAPP_VERIFY_TOKEN", "WhatsApp"),
      });
    case "github": {
      const token = optional(secrets, "GITHUB_TOKEN");
      const appId = optional(secrets, "GITHUB_APP_ID");
      const privateKey = optional(secrets, "GITHUB_PRIVATE_KEY");
      const webhookSecret = required(secrets, "GITHUB_WEBHOOK_SECRET", "GitHub");
      if (token) return createGitHubAdapter({ token, webhookSecret });
      if (appId && privateKey) return createGitHubAdapter({ appId, privateKey, webhookSecret });
      throw new Error("GitHub 需要 Personal access token,或 App ID + Private key");
    }
    case "linear": {
      const apiKey = optional(secrets, "LINEAR_API_KEY");
      const accessToken = optional(secrets, "LINEAR_ACCESS_TOKEN");
      const webhookSecret = required(secrets, "LINEAR_WEBHOOK_SECRET", "Linear");
      if (apiKey) return createLinearAdapter({ apiKey, webhookSecret });
      if (accessToken) return createLinearAdapter({ accessToken, webhookSecret });
      throw new Error("Linear 需要 API key 或 OAuth access token");
    }
    default: {
      const exhaustive: never = account.platform;
      throw new Error(`未知频道平台: ${String(exhaustive)}`);
    }
  }
}

export const CHANNEL_ADAPTER_PLATFORMS: readonly ChannelPlatform[] = [
  "slack",
  "teams",
  "discord",
  "telegram",
  "whatsapp",
  "github",
  "linear",
];
