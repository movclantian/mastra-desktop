/**
 * 频道配置持久化:app_config 表 key = "channels"。
 * 明文凭据只进主进程凭据库,这里只保存 credentialRef / hint;
 * 每次写入都会回源校验凭据仍可解析,避免 UI 显示"已配置"而运行时取不到值。
 */
import {
  CHANNEL_PLATFORMS,
  type ChannelAccount,
  type ChannelConfig,
  ChannelConfigSchema,
  type ChannelPlatform,
  channelPlatformInfo,
  DEFAULT_CHANNEL_CONFIG,
  defaultChannelAccount,
} from "../../shared/channel-contract";
import { channelCredentialPurpose } from "../../shared/credential-contract";
import { deleteCredential, resolveCredential } from "../credential-broker";
import { getAppConfig, setAppConfig } from "../storage/database";

const CONFIG_KEY = "channels";

/** 读取时补齐缺失平台,保证 UI 永远拿到完整的 7 项。 */
function completeChannelConfig(config: ChannelConfig): ChannelConfig {
  const stored = new Map(config.accounts.map((account) => [account.platform, account]));
  return {
    accounts: CHANNEL_PLATFORMS.map(
      (platform) => stored.get(platform) ?? defaultChannelAccount(platform),
    ),
  };
}

export async function getChannelConfig(resourceId?: string): Promise<ChannelConfig> {
  const raw = await getAppConfig(CONFIG_KEY, resourceId);
  if (!raw) return completeChannelConfig(structuredClone(DEFAULT_CHANNEL_CONFIG));
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return completeChannelConfig(structuredClone(DEFAULT_CHANNEL_CONFIG));
  }
  const parsed = ChannelConfigSchema.safeParse(value);
  if (!parsed.success) return completeChannelConfig(structuredClone(DEFAULT_CHANNEL_CONFIG));
  return completeChannelConfig(parsed.data);
}

/** 校验新配置里的每个已保存凭据仍能在金库中取到明文。 */
async function assertSecretsResolvable(account: ChannelAccount): Promise<void> {
  for (const [field, state] of Object.entries(account.secrets)) {
    if (!state.hasCredential) continue;
    await resolveCredential(state.credentialRef, channelCredentialPurpose(account.platform, field));
  }
}

/** 写入配置,并清理被替换或删除的凭据引用。 */
export async function saveChannelConfig(
  config: unknown,
  resourceId?: string,
): Promise<ChannelConfig> {
  const next = completeChannelConfig(ChannelConfigSchema.parse(config));
  const current = await getChannelConfig(resourceId);
  const currentByPlatform = new Map(current.accounts.map((account) => [account.platform, account]));

  for (const account of next.accounts) await assertSecretsResolvable(account);

  await setAppConfig(CONFIG_KEY, JSON.stringify(next, null, 2), resourceId);

  const stale: Array<{ platform: ChannelPlatform; field: string; credentialRef: string }> = [];
  for (const account of next.accounts) {
    const previous = currentByPlatform.get(account.platform);
    for (const [field, state] of Object.entries(account.secrets)) {
      if (!state.hasCredential) continue;
      const before = previous?.secrets[field];
      if (!before?.hasCredential || before.credentialRef === state.credentialRef) continue;
      stale.push({ platform: account.platform, field, credentialRef: before.credentialRef });
    }
  }
  for (const account of current.accounts) {
    const kept = next.accounts.find((candidate) => candidate.platform === account.platform);
    for (const [field, state] of Object.entries(account.secrets)) {
      if (!state.hasCredential) continue;
      if (kept?.secrets[field]?.hasCredential) continue;
      stale.push({ platform: account.platform, field, credentialRef: state.credentialRef });
    }
  }
  await Promise.all(
    stale.map(({ platform, field, credentialRef }) =>
      deleteCredential(credentialRef, channelCredentialPurpose(platform, field)).catch(
        () => undefined,
      ),
    ),
  );
  return next;
}

/** 取某个平台当前启用且必填凭据齐备的账号;未启用或缺凭据返回 null。 */
export async function getEnabledChannelAccount(
  platform: ChannelPlatform,
  resourceId?: string,
): Promise<ChannelAccount | null> {
  const config = await getChannelConfig(resourceId);
  const account = config.accounts.find((candidate) => candidate.platform === platform);
  if (!account?.enabled) return null;
  const info = channelPlatformInfo(platform);
  const missing = info.secrets.filter(
    (field) => field.required && !account.secrets[field.key]?.hasCredential,
  );
  return missing.length ? null : account;
}

/** 解析某个平台的全部凭据明文,供适配器工厂使用。 */
export async function resolveChannelSecrets(
  account: ChannelAccount,
): Promise<Record<string, string>> {
  const entries = await Promise.all(
    Object.entries(account.secrets).map(async ([field, state]) => {
      if (!state.hasCredential) return [field, ""] as const;
      const value = await resolveCredential(
        state.credentialRef,
        channelCredentialPurpose(account.platform, field),
      ).catch(() => "");
      return [field, value] as const;
    }),
  );
  return Object.fromEntries(entries);
}
