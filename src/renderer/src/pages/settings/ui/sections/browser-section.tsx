import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { toast } from "sonner";
import { useAuth } from "@/features/auth";
import { browserConfigQueryOptions, saveBrowserConfig } from "@/shared/api";
import {
  getBrowserSearchEnginePreference,
  setBrowserSearchEnginePreference,
} from "@/shared/browser-search-preference";
import { useTranslation } from "@/shared/i18n";
import { Input } from "@/shared/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/shared/ui/select";
import { Switch } from "@/shared/ui/switch";
import {
  type BrowserConfig,
  BrowserSearchEngineSchema,
  DEFAULT_BROWSER_CONFIG,
} from "../../../../../../shared/browser-contract";
import { browserCredentialPurpose } from "../../../../../../shared/credential-contract";
import { SettingCard, SettingRow } from "../controls";

export function BrowserSection() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const userId = user?.id ?? "anonymous";
  const [searchEngine, setSearchEngine] = React.useState(() =>
    getBrowserSearchEnginePreference(userId),
  );
  const [draft, setDraft] = React.useState(DEFAULT_BROWSER_CONFIG);
  const [firecrawlKey, setFirecrawlKey] = React.useState("");
  const queryClient = useQueryClient();
  const configQuery = useQuery(browserConfigQueryOptions(userId));
  const loaded = configQuery.isSuccess;
  const [saving, setSaving] = React.useState(false);
  const draftRef = React.useRef(draft);
  draftRef.current = draft;
  const [dirty, setDirty] = React.useState(false);

  React.useEffect(() => {
    if (configQuery.data && !dirty) setDraft(configQuery.data);
  }, [configQuery.data, dirty]);

  React.useEffect(() => {
    setSearchEngine(getBrowserSearchEnginePreference(userId));
  }, [userId]);

  React.useEffect(() => {
    if (!loaded || !dirty || saving) return;
    const timer = window.setTimeout(() => {
      setSaving(true);
      void (async () => {
        let next = draft;
        const value = firecrawlKey.trim();
        if (value) {
          const credential = await window.api.credentials.put({
            purpose: browserCredentialPurpose("firecrawl"),
            value,
          });
          next = { ...next, firecrawl: { ...next.firecrawl, credential } };
        }
        const saved = await saveBrowserConfig(userId, next);
        queryClient.setQueryData(browserConfigQueryOptions(userId).queryKey, saved);
        if (draftRef.current === draft) {
          setDraft(saved);
          setFirecrawlKey("");
          setDirty(false);
        }
      })()
        .catch(() => {
          setDirty(false);
          toast.error(t("settings:browser.saveFailed"));
        })
        .finally(() => setSaving(false));
    }, 700);
    return () => window.clearTimeout(timer);
  }, [dirty, draft, firecrawlKey, loaded, saving, t, userId, queryClient]);

  const update = (change: (current: BrowserConfig) => BrowserConfig) => {
    setDraft(change);
    setDirty(true);
  };

  return (
    <>
      <SettingCard title={t("settings:browser.title")} description={t("settings:browser.desc")}>
        <SettingRow
          title={t("settings:browser.provider")}
          description={t("settings:browser.providerDesc")}
        >
          <Select
            value={draft.provider}
            onValueChange={(value) =>
              value &&
              update((current) => ({ ...current, provider: value as BrowserConfig["provider"] }))
            }
          >
            <SelectTrigger className="min-w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="agent">{t("settings:browser.agentProvider")}</SelectItem>
              <SelectItem value="firecrawl">{t("settings:browser.firecrawlProvider")}</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow
          title={t("settings:browser.scope")}
          description={t("settings:browser.scopeDesc")}
        >
          <Select
            value={draft.scope}
            onValueChange={(value) =>
              value && update((current) => ({ ...current, scope: value as BrowserConfig["scope"] }))
            }
          >
            <SelectTrigger className="min-w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="thread">{t("settings:browser.scopeThread")}</SelectItem>
              <SelectItem value="shared">{t("settings:browser.scopeShared")}</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow title={t("settings:browser.timeout")}>
          <Input
            className="w-28"
            type="number"
            value={draft.timeout}
            onChange={(event) =>
              update((current) => ({ ...current, timeout: Number(event.target.value) }))
            }
          />
        </SettingRow>
        <SettingRow
          title={t("settings:browser.searchEngine")}
          description={t("settings:browser.searchEngineDesc")}
        >
          <Select
            value={searchEngine}
            onValueChange={(value) => {
              const parsed = BrowserSearchEngineSchema.safeParse(value);
              if (!parsed.success) return;
              setSearchEngine(parsed.data);
              setBrowserSearchEnginePreference(userId, parsed.data);
            }}
          >
            <SelectTrigger className="min-w-36" aria-label={t("settings:browser.searchEngine")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="bing">{t("settings:browser.searchEngineBing")}</SelectItem>
              <SelectItem value="baidu">{t("settings:browser.searchEngineBaidu")}</SelectItem>
              <SelectItem value="google">{t("settings:browser.searchEngineGoogle")}</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow
          title={t("settings:browser.homeUrl")}
          description={t("settings:browser.homeUrlDesc")}
        >
          <Input
            className="w-72"
            placeholder={t("settings:browser.homeUrlPlaceholder")}
            value={draft.homeUrl}
            onChange={(event) => update((current) => ({ ...current, homeUrl: event.target.value }))}
          />
        </SettingRow>
      </SettingCard>
      <SettingCard
        title={t("settings:browser.firecrawlTitle")}
        description={t("settings:browser.firecrawlDesc")}
      >
        <SettingRow title={t("settings:browser.credential")}>
          <Input
            className="w-56"
            type="password"
            autoComplete="off"
            placeholder={
              draft.firecrawl.credential.hasCredential
                ? t("settings:browser.configured")
                : "API key"
            }
            value={firecrawlKey}
            onChange={(event) => {
              setFirecrawlKey(event.target.value);
              setDirty(true);
            }}
          />
        </SettingRow>
        <SettingRow title={t("settings:browser.apiUrl")}>
          <Input
            className="w-72"
            value={draft.firecrawl.apiUrl}
            onChange={(event) =>
              update((current) => ({
                ...current,
                firecrawl: { ...current.firecrawl, apiUrl: event.target.value },
              }))
            }
          />
        </SettingRow>
        <SettingRow title={t("settings:browser.ttl")}>
          <Input
            className="w-28"
            type="number"
            value={draft.firecrawl.ttl}
            onChange={(event) =>
              update((current) => ({
                ...current,
                firecrawl: { ...current.firecrawl, ttl: Number(event.target.value) },
              }))
            }
          />
        </SettingRow>
        <SettingRow title={t("settings:browser.activityTtl")}>
          <Input
            className="w-28"
            type="number"
            value={draft.firecrawl.activityTtl}
            onChange={(event) =>
              update((current) => ({
                ...current,
                firecrawl: { ...current.firecrawl, activityTtl: Number(event.target.value) },
              }))
            }
          />
        </SettingRow>
        <SettingRow title={t("settings:browser.streamWebView")}>
          <Switch
            checked={draft.firecrawl.streamWebView}
            onCheckedChange={(checked) =>
              update((current) => ({
                ...current,
                firecrawl: { ...current.firecrawl, streamWebView: checked },
              }))
            }
          />
        </SettingRow>
      </SettingCard>
    </>
  );
}
