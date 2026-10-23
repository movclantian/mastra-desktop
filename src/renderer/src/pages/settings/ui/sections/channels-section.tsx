import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2Icon,
  CircleAlertIcon,
  ExternalLinkIcon,
  RadioIcon,
  SaveIcon,
  XIcon,
} from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { useTranslation } from "@/shared/i18n";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/shared/ui/select";
import { Switch } from "@/shared/ui/switch";
import type {
  ChannelConfig,
  ChannelPlatform,
  ChannelPlatformInfo,
  ChannelRuntimeStatus,
} from "../../../../../../shared/channel-contract";
import { channelCredentialPurpose } from "../../../../../../shared/credential-contract";
import { fetchChannels, saveChannelsConfig } from "../../api/settings-api";
import { SettingCard, SettingRow } from "../controls";

interface ChannelsPayload {
  config: ChannelConfig;
  platforms: ChannelPlatformInfo[];
  runtime: ChannelRuntimeStatus[];
}

const CHANNEL_QUERY_KEY = ["channels-config"] as const;

function accountFor(config: ChannelConfig, platform: ChannelPlatform) {
  return config.accounts.find((account) => account.platform === platform);
}

function copyConfig(config: ChannelConfig): ChannelConfig {
  return structuredClone(config);
}

export function ChannelsSection() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: CHANNEL_QUERY_KEY, queryFn: fetchChannels });
  const [draft, setDraft] = React.useState<ChannelConfig | null>(null);
  const [platform, setPlatform] = React.useState<ChannelPlatform>("slack");
  const [secretDraft, setSecretDraft] = React.useState<Record<string, string>>({});
  const [clearedSecrets, setClearedSecrets] = React.useState<Set<string>>(new Set());
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    if (!query.data || draft) return;
    setDraft(copyConfig(query.data.config));
    setPlatform(query.data.platforms[0]?.platform ?? "slack");
  }, [draft, query.data]);

  const payload = query.data as ChannelsPayload | undefined;
  const config = draft ?? payload?.config;
  const info = payload?.platforms.find((item) => item.platform === platform);
  const account = config ? accountFor(config, platform) : undefined;
  const runtime = payload?.runtime.find((item) => item.platform === platform);

  const updateAccount = React.useCallback(
    (update: (current: NonNullable<typeof account>) => NonNullable<typeof account>) => {
      setDraft((current) => {
        if (!current) return current;
        const next = copyConfig(current);
        const index = next.accounts.findIndex((candidate) => candidate.platform === platform);
        if (index < 0) return current;
        next.accounts[index] = update(next.accounts[index]);
        return next;
      });
    },
    [platform],
  );

  const secretKey = (field: string) => `${platform}:${field}`;

  const save = async () => {
    if (!config || !account || !info) return;
    setSaving(true);
    try {
      const next = copyConfig(config);
      const nextAccount = accountFor(next, platform);
      if (!nextAccount) return;
      for (const field of info.secrets) {
        const key = secretKey(field.key);
        if (clearedSecrets.has(key)) {
          nextAccount.secrets[field.key] = { hasCredential: false };
          continue;
        }
        const value = secretDraft[key]?.trim();
        if (!value) continue;
        nextAccount.secrets[field.key] = await window.api.credentials.put({
          purpose: channelCredentialPurpose(platform, field.key),
          value,
        });
      }
      const saved = await saveChannelsConfig(next);
      setDraft(copyConfig(saved.config));
      setSecretDraft((current) => {
        const remaining = { ...current };
        for (const field of info.secrets) delete remaining[secretKey(field.key)];
        return remaining;
      });
      setClearedSecrets(new Set());
      queryClient.setQueryData(CHANNEL_QUERY_KEY, saved);
      toast.success(t("settings:channels.saved"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("settings:channels.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  if (query.isPending || !config || !account || !info) {
    return <div className="p-4 text-sm text-muted-foreground">{t("common:loading")}</div>;
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <SettingCard
        title={t("settings:channels.title")}
        description={t("settings:channels.desc")}
        action={
          <Button disabled={saving} onClick={() => void save()} size="sm">
            <SaveIcon />
            {saving ? t("settings:channels.saving") : t("settings:channels.save")}
          </Button>
        }
      >
        <SettingRow
          title={t("settings:channels.platform")}
          description={t("settings:channels.platformDesc")}
        >
          <Select
            value={platform}
            onValueChange={(value) => value && setPlatform(value as ChannelPlatform)}
          >
            <SelectTrigger className="min-w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {payload?.platforms.map((item) => (
                <SelectItem key={item.platform} value={item.platform}>
                  {item.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow
          title={t("settings:channels.enabled")}
          description={t("settings:channels.enabledDesc")}
        >
          <Switch
            checked={account.enabled}
            onCheckedChange={(checked) =>
              updateAccount((current) => ({ ...current, enabled: checked }))
            }
          />
        </SettingRow>
        <SettingRow
          title={t("settings:channels.transport")}
          description={t("settings:channels.transportDesc")}
        >
          <Select
            value={account.transport}
            onValueChange={(value) =>
              value &&
              updateAccount((current) => ({
                ...current,
                transport: value as typeof current.transport,
              }))
            }
          >
            <SelectTrigger className="min-w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {info.transports.map((value) => (
                <SelectItem key={value} value={value}>
                  {value === "socket"
                    ? t("settings:channels.socket")
                    : t("settings:channels.webhook")}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow
          title={t("settings:channels.mentionOnly")}
          description={t("settings:channels.mentionOnlyDesc")}
        >
          <Switch
            checked={account.mentionOnly}
            onCheckedChange={(checked) =>
              updateAccount((current) => ({ ...current, mentionOnly: checked }))
            }
          />
        </SettingRow>
        <SettingRow
          title={t("settings:channels.allowedUsers")}
          description={t("settings:channels.allowedUsersDesc")}
        >
          <Input
            className="w-64 max-w-full"
            placeholder={t("settings:channels.allowedUsersPlaceholder")}
            value={account.allowedUserIds.join(", ")}
            onChange={(event) =>
              updateAccount((current) => ({
                ...current,
                allowedUserIds: event.target.value
                  .split(",")
                  .map((value) => value.trim())
                  .filter(Boolean),
              }))
            }
          />
        </SettingRow>
        <SettingRow
          title={t("settings:channels.agentProfile")}
          description={t("settings:channels.agentProfileDesc")}
        >
          <Input
            className="w-64 max-w-full"
            placeholder="mastra-work-agent"
            value={account.agentProfileId}
            onChange={(event) =>
              updateAccount((current) => ({ ...current, agentProfileId: event.target.value }))
            }
          />
        </SettingRow>
      </SettingCard>

      <SettingCard
        title={t("settings:channels.credentials")}
        description={t("settings:channels.credentialsDesc")}
      >
        {info.secrets.map((field) => {
          const key = secretKey(field.key);
          const state = account.secrets[field.key];
          const configured = state?.hasCredential && !clearedSecrets.has(key);
          return (
            <SettingRow
              key={field.key}
              title={field.label}
              description={
                field.required ? t("settings:channels.required") : t("settings:channels.optional")
              }
            >
              <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
                <Input
                  className="w-64 max-w-full font-mono text-xs"
                  placeholder={configured ? t("settings:channels.configured") : field.placeholder}
                  type="password"
                  value={secretDraft[key] ?? ""}
                  onChange={(event) => {
                    setSecretDraft((current) => ({ ...current, [key]: event.target.value }));
                    setClearedSecrets((current) => {
                      const next = new Set(current);
                      next.delete(key);
                      return next;
                    });
                  }}
                />
                {configured ? (
                  <Button
                    aria-label={t("settings:channels.clearCredential")}
                    onClick={() => setClearedSecrets((current) => new Set(current).add(key))}
                    size="icon-xs"
                    title={t("settings:channels.clearCredential")}
                    variant="ghost"
                  >
                    <XIcon />
                  </Button>
                ) : null}
              </div>
            </SettingRow>
          );
        })}
      </SettingCard>

      <SettingCard
        title={t("settings:channels.delivery")}
        description={t("settings:channels.deliveryDesc")}
      >
        <SettingRow title={t("settings:channels.textFormat")}>
          <Select
            value={account.textFormat}
            onValueChange={(value) =>
              value &&
              updateAccount((current) => ({
                ...current,
                textFormat: value as typeof current.textFormat,
              }))
            }
          >
            <SelectTrigger className="min-w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="markdown">Markdown</SelectItem>
              <SelectItem value="plain">{t("settings:channels.plain")}</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow title={t("settings:channels.toolDisplay")}>
          <Select
            value={account.toolDisplay}
            onValueChange={(value) =>
              value &&
              updateAccount((current) => ({
                ...current,
                toolDisplay: value as typeof current.toolDisplay,
              }))
            }
          >
            <SelectTrigger className="min-w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="cards">{t("settings:channels.cards")}</SelectItem>
              <SelectItem value="text">{t("settings:channels.text")}</SelectItem>
              <SelectItem value="hidden">{t("settings:channels.hidden")}</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow
          title={t("settings:channels.threadContext")}
          description={t("settings:channels.threadContextDesc")}
        >
          <Input
            className="w-24"
            min={0}
            max={100}
            onChange={(event) =>
              updateAccount((current) => ({
                ...current,
                threadContextMaxMessages: Math.max(
                  0,
                  Math.min(100, Number(event.target.value) || 0),
                ),
              }))
            }
            type="number"
            value={account.threadContextMaxMessages}
          />
        </SettingRow>
        <div className="flex flex-wrap items-center gap-2 border-t border-border/60 pt-3 text-xs text-muted-foreground">
          {runtime?.running ? (
            <>
              <CheckCircle2Icon className="size-4 text-emerald-600" />
              <Badge variant="secondary">{t("settings:channels.running")}</Badge>
            </>
          ) : runtime?.lastError ? (
            <>
              <CircleAlertIcon className="size-4 text-destructive" />
              <Badge variant="destructive">{t("settings:channels.error")}</Badge>
              <span className="max-w-full break-words">{runtime.lastError}</span>
            </>
          ) : (
            <>
              <RadioIcon className="size-4" />
              <Badge variant="outline">{t("settings:channels.notRunning")}</Badge>
            </>
          )}
          {runtime?.webhookUrl && account.transport === "webhook" ? (
            <span className="ml-auto flex min-w-0 items-center gap-1 break-all">
              <ExternalLinkIcon className="size-3.5 shrink-0" />
              {runtime.webhookUrl}
            </span>
          ) : null}
        </div>
      </SettingCard>

      <div className="rounded-lg border border-border/60 bg-muted/30 p-3 text-xs text-muted-foreground">
        <p className="break-words">{info.description}</p>
        <p className="mt-1 break-words">{t("settings:channels.webhookHint")}</p>
      </div>
    </div>
  );
}
