import * as React from "react";
import { toast } from "sonner";
import {
  getModelCapabilities,
  useCatalogQuery,
  useProviderConfigQuery,
} from "@/entities/workbench";
import { useTranslation } from "@/shared/i18n";
import { Input } from "@/shared/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/shared/ui/select";
import { Switch } from "@/shared/ui/switch";
import type { BrowserConfig } from "../../../../../../shared/browser-contract";
import { browserCredentialPurpose } from "../../../../../../shared/credential-contract";
import { fetchBrowserConfig, saveBrowserConfig } from "../../api/settings-api";
import { SettingCard, SettingRow } from "../controls";

const DEFAULT_CONFIG: BrowserConfig = {
  provider: "agent",
  scope: "thread",
  headless: true,
  viewport: { width: 1280, height: 720 },
  timeout: 30_000,
  stagehand: {
    providerId: "",
    modelId: "",
  },
  firecrawl: {
    apiUrl: "",
    ttl: 600,
    activityTtl: 60,
    streamWebView: false,
    credential: { hasCredential: false },
  },
};

export function BrowserSection() {
  const { t } = useTranslation();
  const providers = useProviderConfigQuery().data?.providers ?? [];
  const catalog = useCatalogQuery().data ?? [];
  const [draft, setDraft] = React.useState(DEFAULT_CONFIG);
  const [firecrawlKey, setFirecrawlKey] = React.useState("");
  const [loaded, setLoaded] = React.useState(false);
  const [dirty, setDirty] = React.useState(false);

  React.useEffect(() => {
    void fetchBrowserConfig()
      .then((config) => setDraft(config))
      .catch(() => toast.error(t("settings:browser.loadFailed")))
      .finally(() => setLoaded(true));
  }, [t]);

  React.useEffect(() => {
    if (!loaded || !dirty) return;
    const timer = window.setTimeout(() => {
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
        const saved = await saveBrowserConfig(next);
        setDraft(saved);
        setFirecrawlKey("");
        setDirty(false);
      })().catch(() => toast.error(t("settings:browser.saveFailed")));
    }, 700);
    return () => window.clearTimeout(timer);
  }, [dirty, draft, firecrawlKey, loaded, t]);

  const update = (change: (current: BrowserConfig) => BrowserConfig) => {
    setDraft(change);
    setDirty(true);
  };

  const multimodalModels = React.useMemo(
    () =>
      providers
        .filter((provider) => !provider.disabled && provider.hasCredential)
        .flatMap((provider) =>
          provider.enabledModels
            .filter((model) => getModelCapabilities(provider, model.id, catalog).vision)
            .map((model) => ({
              providerId: provider.id,
              providerName: provider.name,
              modelId: model.id,
              modelName: model.name,
              value: `${provider.id}/${model.id}`,
            })),
        ),
    [catalog, providers],
  );
  const selectedStagehandModel = multimodalModels.find(
    (model) =>
      model.providerId === draft.stagehand.providerId && model.modelId === draft.stagehand.modelId,
  );

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
              <SelectItem value="stagehand">{t("settings:browser.stagehandProvider")}</SelectItem>
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
        <SettingRow title={t("settings:browser.headless")}>
          <Switch
            checked={draft.headless}
            onCheckedChange={(checked) => update((current) => ({ ...current, headless: checked }))}
          />
        </SettingRow>
        <SettingRow title={t("settings:browser.viewport")}>
          <Select
            value={draft.viewport === "window" ? "window" : "fixed"}
            onValueChange={(value) =>
              value &&
              update((current) => ({
                ...current,
                viewport: value === "window" ? "window" : { width: 1280, height: 720 },
              }))
            }
          >
            <SelectTrigger className="min-w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="fixed">{t("settings:browser.viewportFixed")}</SelectItem>
              <SelectItem value="window">{t("settings:browser.viewportWindow")}</SelectItem>
            </SelectContent>
          </Select>
          {draft.viewport !== "window" ? (
            <>
              <Input
                className="w-24"
                type="number"
                value={draft.viewport.width}
                onChange={(event) =>
                  update((current) => ({
                    ...current,
                    viewport: {
                      ...(current.viewport as { width: number; height: number }),
                      width: Number(event.target.value),
                    },
                  }))
                }
              />
              <Input
                className="w-24"
                type="number"
                value={draft.viewport.height}
                onChange={(event) =>
                  update((current) => ({
                    ...current,
                    viewport: {
                      ...(current.viewport as { width: number; height: number }),
                      height: Number(event.target.value),
                    },
                  }))
                }
              />
            </>
          ) : null}
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
      </SettingCard>
      <SettingCard
        title={t("settings:browser.stagehandTitle")}
        description={t("settings:browser.stagehandDesc")}
      >
        <SettingRow title={t("settings:browser.model")}>
          <Select
            disabled={multimodalModels.length === 0}
            value={selectedStagehandModel?.value ?? null}
            onValueChange={(value) => {
              const selected = multimodalModels.find((model) => model.value === value);
              if (selected) {
                update((current) => ({
                  ...current,
                  stagehand: {
                    providerId: selected.providerId,
                    modelId: selected.modelId,
                  },
                }));
              }
            }}
          >
            <SelectTrigger className="w-56" aria-label={t("settings:browser.model")}>
              <SelectValue placeholder={t("settings:browser.noMultimodalModels")} />
            </SelectTrigger>
            <SelectContent>
              {multimodalModels.map((model) => (
                <SelectItem key={model.value} value={model.value}>
                  {model.modelName || model.modelId} - {model.providerName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
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
