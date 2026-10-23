import {
  ActivityIcon,
  AlertCircleIcon,
  CheckCircle2Icon,
  LanguagesIcon,
  LaptopIcon,
  RefreshCwIcon,
  ServerIcon,
  WifiOffIcon,
} from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import {
  useDesktopSettingsQuery,
  useProviderConfigQuery,
  useSuggestionConfigQuery,
  useUpdateDesktopSettings,
  useUpdateSuggestionConfig,
} from "@/entities/workbench/model/queries/config";
import {
  getInterfaceLanguageMode,
  type InterfaceLanguageMode,
  i18n,
  setInterfaceLanguageMode,
  useTranslation,
} from "@/shared/i18n";
import { cn, toastError } from "@/shared/lib";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { Label } from "@/shared/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/shared/ui/select";
import { Switch } from "@/shared/ui/switch";
import {
  DEFAULT_SUGGESTION_CONFIG,
  type SuggestionConfig,
} from "../../../../../../shared/agent-contract";
import {
  fetchProxySettings,
  type ProxyConfig,
  type ProxyMode,
  type ProxyTestResult,
  saveProxySettings,
  testProxyConnectivity,
} from "../../api/settings-api";
import { SettingCard, SettingRow } from "../controls";

export function GeneralSection() {
  const { t } = useTranslation();
  const [languageMode, setLanguageMode] =
    React.useState<InterfaceLanguageMode>(getInterfaceLanguageMode);
  const desktopSettings = useDesktopSettingsQuery();
  const updateDesktopSettings = useUpdateDesktopSettings();
  const [loading, setLoading] = React.useState(true);
  const [applying, setApplying] = React.useState(false);
  const [testing, setTesting] = React.useState(false);
  const [mode, setMode] = React.useState<ProxyMode>("system");
  const [manualUrl, setManualUrl] = React.useState("");
  const [savedConfig, setSavedConfig] = React.useState<ProxyConfig>({ mode: "system" });
  const [testResult, setTestResult] = React.useState<ProxyTestResult | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const config = await fetchProxySettings();
        if (!cancelled) {
          setMode(config.mode);
          setManualUrl(config.url ?? "");
          setSavedConfig(config);
        }
      } catch (error) {
        if (!cancelled) {
          toastError(error, t("settings:general.fetchProxyError"));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [t]);

  /**
   * 立即下发并持久化代理配置(无手动保存步骤)。
   * 主进程会同步应用到 Chromium Session、出站环境变量与 Mastra Dispatcher。
   * 失败时回滚草稿到当前已生效配置。
   */
  const applyConfig = React.useCallback(
    async (next: ProxyConfig) => {
      setApplying(true);
      try {
        await saveProxySettings(next);
        setSavedConfig(next);
      } catch (error) {
        toastError(error, t("settings:general.saveProxyFailed"));
        setMode(savedConfig.mode);
        setManualUrl(savedConfig.url ?? "");
      } finally {
        setApplying(false);
      }
    },
    [savedConfig, t],
  );

  const selectMode = (next: ProxyMode) => {
    if (loading || applying) return;
    setMode(next);
    setTestResult(null);
    if (next === "manual") {
      const url = manualUrl.trim();
      if (url) void applyConfig({ mode: "manual", url });
      return;
    }
    void applyConfig({ mode: next });
  };

  // 手动地址输入防抖后自动生效,无需点击保存。
  React.useEffect(() => {
    if (loading || applying || mode !== "manual") return;
    const url = manualUrl.trim();
    if (!url) return;
    if (savedConfig.mode === "manual" && (savedConfig.url ?? "") === url) return;
    const timer = setTimeout(() => {
      void applyConfig({ mode: "manual", url });
    }, 600);
    return () => clearTimeout(timer);
  }, [loading, applying, mode, manualUrl, savedConfig, applyConfig]);

  const handleTest = async () => {
    const urlToTest = mode === "manual" ? manualUrl.trim() : undefined;
    if (mode === "manual" && !urlToTest) {
      toast.error(t("settings:general.pleaseEnterUrlFirst"));
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      const result = await testProxyConnectivity(urlToTest);
      setTestResult(result);
      if (result.ok) {
        toast.success(t("settings:general.testProxySuccess", { latency: result.latencyMs }));
      } else {
        toast.error(
          t("settings:general.testProxyError", { error: result.error || t("common:error") }),
        );
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      setTestResult({ ok: false, error: msg });
      toast.error(t("settings:general.proxyTestException", { error: msg }));
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <SettingCard
        title={t("settings:general.behaviorTitle")}
        description={t("settings:general.behaviorDesc")}
      >
        {desktopSettings.isError ? (
          <Button onClick={() => void desktopSettings.refetch()} variant="outline" size="sm">
            {t("common:retry")}
          </Button>
        ) : desktopSettings.data ? (
          (
            [
              "showWorkDetails",
              "scheduledTaskNotifications",
              "desktopNotifications",
              "launchAtLogin",
              "openLocalLinksInBrowser",
            ] as const
          ).map((key) => (
            <SettingRow
              key={key}
              title={t(`settings:general.${key}`)}
              description={t(
                key === "launchAtLogin" && !desktopSettings.data.launchAtLoginSupported
                  ? "settings:general.launchAtLoginUnavailable"
                  : `settings:general.${key}Desc`,
              )}
            >
              <Switch
                aria-label={t(`settings:general.${key}`)}
                checked={desktopSettings.data[key]}
                disabled={
                  updateDesktopSettings.isPending ||
                  (key === "launchAtLogin" && !desktopSettings.data.launchAtLoginSupported) ||
                  ((key === "desktopNotifications" || key === "scheduledTaskNotifications") &&
                    !desktopSettings.data.notificationsSupported)
                }
                onCheckedChange={(checked) =>
                  updateDesktopSettings.mutate(
                    { [key]: checked },
                    {
                      onError: (error) => toastError(error, t("common:error")),
                    },
                  )
                }
              />
            </SettingRow>
          ))
        ) : (
          <p className="text-xs text-muted-foreground">{t("common:loading")}</p>
        )}
      </SettingCard>
      <SuggestionSettingsCard />
      {/* 界面语言 */}
      <SettingCard
        title={t("settings:general.languageTitle")}
        description={t("settings:general.languageDesc")}
        action={
          <Badge variant="outline" className="text-[11px] font-normal">
            {t("settings:general.currentLang", {
              lang:
                languageMode === "auto"
                  ? t("settings:general.languageAuto") +
                    " · " +
                    (i18n.language.startsWith("en")
                      ? t("settings:general.langEn")
                      : t("settings:general.langZh"))
                  : languageMode === "en"
                    ? t("settings:general.langEn")
                    : t("settings:general.langZh"),
            })}
          </Badge>
        }
      >
        <div className="py-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {/* 中文 */}
            <Button
              variant="ghost"
              aria-pressed={languageMode === "zh"}
              onClick={() => {
                setLanguageMode("zh");
                void setInterfaceLanguageMode("zh");
                toast.success(t("settings:general.switchedToZh"));
              }}
              className={cn(
                "relative flex h-auto min-w-0 flex-col items-stretch justify-between text-left whitespace-normal rounded-lg border p-3.5 cursor-pointer transition-all select-none",
                languageMode === "zh"
                  ? "border-primary bg-primary/5 text-foreground ring-1 ring-primary/40 shadow-xs"
                  : "border-border hover:bg-muted/50 text-muted-foreground hover:text-foreground",
              )}
            >
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <div className="flex items-center gap-2">
                    <LanguagesIcon
                      className={cn(
                        "size-4",
                        languageMode === "zh" ? "text-primary" : "text-muted-foreground",
                      )}
                    />
                    <span className="text-xs font-semibold text-foreground">
                      {t("settings:general.langZh")}
                    </span>
                    <span className="text-[11px] text-muted-foreground">
                      {t("settings:general.langZhSub")}
                    </span>
                  </div>
                  {languageMode === "zh" ? (
                    <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4 font-normal">
                      {t("common:selected")}
                    </Badge>
                  ) : null}
                </div>
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  {t("settings:general.langZhDesc")}
                </p>
              </div>
            </Button>

            {/* 英文 */}
            <Button
              variant="ghost"
              aria-pressed={languageMode === "en"}
              onClick={() => {
                setLanguageMode("en");
                void setInterfaceLanguageMode("en");
                toast.success(t("settings:general.switchedToEn"));
              }}
              className={cn(
                "relative flex h-auto min-w-0 flex-col items-stretch justify-between text-left whitespace-normal rounded-lg border p-3.5 cursor-pointer transition-all select-none",
                languageMode === "en"
                  ? "border-primary bg-primary/5 text-foreground ring-1 ring-primary/40 shadow-xs"
                  : "border-border hover:bg-muted/50 text-muted-foreground hover:text-foreground",
              )}
            >
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <div className="flex items-center gap-2">
                    <LanguagesIcon
                      className={cn(
                        "size-4",
                        languageMode === "en" ? "text-primary" : "text-muted-foreground",
                      )}
                    />
                    <span className="text-xs font-semibold text-foreground">
                      {t("settings:general.langEn")}
                    </span>
                    <span className="text-[11px] text-muted-foreground">
                      {t("settings:general.langEnSub")}
                    </span>
                  </div>
                  {languageMode === "en" ? (
                    <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4 font-normal">
                      {t("common:selected")}
                    </Badge>
                  ) : null}
                </div>
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  {t("settings:general.langEnDesc")}
                </p>
              </div>
            </Button>
            <Button
              variant="ghost"
              aria-pressed={languageMode === "auto"}
              onClick={() => {
                setLanguageMode("auto");
                void setInterfaceLanguageMode("auto");
                toast.success(t("settings:general.switchedToAuto"));
              }}
              className={cn(
                "relative flex h-auto min-w-0 flex-col items-stretch justify-between text-left whitespace-normal rounded-lg border p-3.5 cursor-pointer transition-all select-none",
                languageMode === "auto"
                  ? "border-primary bg-primary/5 text-foreground ring-1 ring-primary/40 shadow-xs"
                  : "border-border hover:bg-muted/50 text-muted-foreground hover:text-foreground",
              )}
            >
              <div className="w-full">
                <div className="mb-1.5 flex items-center gap-2">
                  <LanguagesIcon
                    className={cn(
                      "size-4",
                      languageMode === "auto" ? "text-primary" : "text-muted-foreground",
                    )}
                  />
                  <span className="text-xs font-semibold text-foreground">
                    {t("settings:general.languageAuto")}
                  </span>
                  {languageMode === "auto" ? (
                    <Badge
                      variant="secondary"
                      className="ml-auto h-4 px-1.5 py-0 text-[10px] font-normal"
                    >
                      {t("common:selected")}
                    </Badge>
                  ) : null}
                </div>
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  {t("settings:general.languageAutoDesc")}
                </p>
              </div>
            </Button>
          </div>
        </div>
      </SettingCard>

      <SettingCard
        title={t("settings:general.proxyTitle")}
        description={t("settings:general.proxyDesc")}
        action={
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="text-[11px] font-normal">
              {savedConfig.mode === "system"
                ? `${t("common:current")}：${t("settings:general.proxyAuto")}`
                : savedConfig.mode === "direct"
                  ? `${t("common:current")}：${t("settings:general.proxyDirect")}`
                  : `${t("common:current")}：${t("settings:general.proxyManual")} (${savedConfig.url || t("common:empty")})`}
            </Badge>
          </div>
        }
      >
        <div className="space-y-4 py-4">
          {/* 三种代理模式选择卡片 */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {/* 模式 1: 系统代理 */}
            <Button
              variant="ghost"
              aria-pressed={mode === "system"}
              onClick={() => selectMode("system")}
              className={cn(
                "relative flex h-auto min-w-0 flex-col items-stretch justify-between text-left whitespace-normal rounded-lg border p-3.5 cursor-pointer transition-all select-none",
                mode === "system"
                  ? "border-primary bg-primary/5 text-foreground ring-1 ring-primary/40 shadow-xs"
                  : "border-border hover:bg-muted/50 text-muted-foreground hover:text-foreground",
              )}
            >
              <div>
                <div className="flex items-center gap-2 mb-1.5">
                  <LaptopIcon
                    className={cn(
                      "size-4",
                      mode === "system" ? "text-primary" : "text-muted-foreground",
                    )}
                  />
                  <span className="text-xs font-semibold text-foreground">
                    {t("settings:general.proxyAuto")}
                  </span>
                  {mode === "system" ? (
                    <Badge
                      variant="secondary"
                      className="ml-auto text-[10px] px-1.5 py-0 h-4 font-normal"
                    >
                      {t("settings:general.selectedBadge")}
                    </Badge>
                  ) : null}
                </div>
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  {t("settings:general.proxyAutoDesc")}
                </p>
              </div>
            </Button>

            {/* 模式 2: 不使用代理 */}
            <Button
              variant="ghost"
              aria-pressed={mode === "direct"}
              onClick={() => selectMode("direct")}
              className={cn(
                "relative flex h-auto min-w-0 flex-col items-stretch justify-between text-left whitespace-normal rounded-lg border p-3.5 cursor-pointer transition-all select-none",
                mode === "direct"
                  ? "border-primary bg-primary/5 text-foreground ring-1 ring-primary/40 shadow-xs"
                  : "border-border hover:bg-muted/50 text-muted-foreground hover:text-foreground",
              )}
            >
              <div>
                <div className="flex items-center gap-2 mb-1.5">
                  <WifiOffIcon
                    className={cn(
                      "size-4",
                      mode === "direct" ? "text-primary" : "text-muted-foreground",
                    )}
                  />
                  <span className="text-xs font-semibold text-foreground">
                    {t("settings:general.proxyDirect")}
                  </span>
                  {mode === "direct" ? (
                    <Badge
                      variant="secondary"
                      className="ml-auto text-[10px] px-1.5 py-0 h-4 font-normal"
                    >
                      {t("settings:general.selectedBadge")}
                    </Badge>
                  ) : null}
                </div>
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  {t("settings:general.proxyDirectDesc")}
                </p>
              </div>
            </Button>

            {/* 模式 3: 手动输入代理 */}
            <Button
              variant="ghost"
              aria-pressed={mode === "manual"}
              onClick={() => selectMode("manual")}
              className={cn(
                "relative flex h-auto min-w-0 flex-col items-stretch justify-between text-left whitespace-normal rounded-lg border p-3.5 cursor-pointer transition-all select-none",
                mode === "manual"
                  ? "border-primary bg-primary/5 text-foreground ring-1 ring-primary/40 shadow-xs"
                  : "border-border hover:bg-muted/50 text-muted-foreground hover:text-foreground",
              )}
            >
              <div>
                <div className="flex items-center gap-2 mb-1.5">
                  <ServerIcon
                    className={cn(
                      "size-4",
                      mode === "manual" ? "text-primary" : "text-muted-foreground",
                    )}
                  />
                  <span className="text-xs font-semibold text-foreground">
                    {t("settings:general.proxyManual")}
                  </span>
                  {mode === "manual" ? (
                    <Badge
                      variant="secondary"
                      className="ml-auto text-[10px] px-1.5 py-0 h-4 font-normal"
                    >
                      {t("settings:general.selectedBadge")}
                    </Badge>
                  ) : null}
                </div>
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  {t("settings:general.proxyManualDesc")}
                </p>
              </div>
            </Button>
          </div>

          {/* 手动模式下的代理地址输入框与测试按钮 */}
          {mode === "manual" ? (
            <div className="rounded-lg border border-border/70 bg-muted/20 p-3.5 space-y-3">
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between">
                  <Label htmlFor="proxy-url-input" className="text-xs font-medium text-foreground">
                    {t("settings:general.proxyUrlLabel")}
                  </Label>
                  <span className="text-[11px] text-muted-foreground">
                    {t("settings:general.supportedProtocols")}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <Input
                    id="proxy-url-input"
                    placeholder={t("settings:general.proxyUrlPlaceholder")}
                    value={manualUrl}
                    onChange={(e) => {
                      setManualUrl(e.target.value);
                      setTestResult(null);
                    }}
                    className="font-mono text-xs h-9"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={testing || !manualUrl.trim()}
                    onClick={handleTest}
                    className="shrink-0 gap-1.5 text-xs h-9 px-3 cursor-pointer"
                  >
                    {testing ? (
                      <RefreshCwIcon className="size-3.5 animate-spin" />
                    ) : (
                      <ActivityIcon className="size-3.5 text-primary" />
                    )}
                    <span>{testing ? t("common:testing") : t("settings:general.proxyTest")}</span>
                  </Button>
                </div>
              </div>

              {/* 连通性测试结果面板 */}
              {testResult ? (
                <div
                  className={cn(
                    "flex items-start gap-2.5 rounded-md px-3 py-2.5 text-xs border transition-colors",
                    testResult.ok
                      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                      : "border-destructive/30 bg-destructive/10 text-destructive",
                  )}
                >
                  {testResult.ok ? (
                    <>
                      <CheckCircle2Icon className="size-4 shrink-0 text-emerald-500 mt-0.5" />
                      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="font-medium">
                          {t("settings:general.proxyConnectedSuccess")}
                        </span>
                        <span className="text-[11px] opacity-90">
                          {t("settings:general.roundTripLatency")}
                          <strong>{testResult.latencyMs} ms</strong>
                        </span>
                      </div>
                    </>
                  ) : (
                    <>
                      <AlertCircleIcon className="size-4 shrink-0 text-destructive mt-0.5" />
                      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="font-medium">
                          {t("settings:general.testProxyFailedTitle")}
                        </span>
                        <span className="text-[11px] opacity-90 break-all">
                          {testResult.error || t("settings:general.testProxyFailedDesc")}
                        </span>
                      </div>
                    </>
                  )}
                </div>
              ) : null}
            </div>
          ) : mode === "system" ? (
            <div className="flex items-center justify-between rounded-lg border border-border/60 bg-muted/10 px-3.5 py-2.5">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <ActivityIcon className="size-3.5 text-muted-foreground" />
                <span>{t("settings:general.testProxySystemDesc")}</span>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={testing}
                onClick={handleTest}
                className="h-8 gap-1.5 text-xs px-2.5 cursor-pointer"
              >
                {testing ? (
                  <RefreshCwIcon className="size-3.5 animate-spin" />
                ) : (
                  <ActivityIcon className="size-3.5 text-primary" />
                )}
                <span>{testing ? t("common:testing") : t("settings:general.testProxySystem")}</span>
              </Button>
            </div>
          ) : null}
        </div>
      </SettingCard>
    </div>
  );
}

/**
 * 提示建议:输入区上方的一排可点击短提示(官方 Suggestion pattern)。
 * 开关与生成模型存在服务端 app_config,因此与本地桌面设置分开成卡。
 */
function SuggestionSettingsCard() {
  const { t } = useTranslation();
  const suggestionConfig = useSuggestionConfigQuery();
  const updateSuggestionConfig = useUpdateSuggestionConfig();
  const providers = useProviderConfigQuery().data?.providers ?? [];

  const config = suggestionConfig.data ?? DEFAULT_SUGGESTION_CONFIG;
  const modelItems = React.useMemo(
    () => [
      { value: "", label: t("settings:general.suggestions.modelRequest") },
      ...providers
        .filter((provider) => !provider.disabled && provider.enabledModels.length > 0)
        .flatMap((provider) =>
          provider.enabledModels.map((model) => ({
            value: `${provider.id}/${model.id}`,
            label: `${provider.name} · ${model.name}`,
          })),
        ),
    ],
    [providers, t],
  );

  const save = (patch: Partial<SuggestionConfig>) => {
    updateSuggestionConfig.mutate(
      { ...config, ...patch },
      { onError: (error) => toastError(error, t("common:error")) },
    );
  };

  return (
    <SettingCard
      title={t("settings:general.suggestions.title")}
      description={t("settings:general.suggestions.desc")}
    >
      {suggestionConfig.isError ? (
        <Button onClick={() => void suggestionConfig.refetch()} variant="outline" size="sm">
          {t("common:retry")}
        </Button>
      ) : suggestionConfig.data ? (
        <>
          <SettingRow
            title={t("settings:general.suggestions.enabled")}
            description={t("settings:general.suggestions.enabledDesc")}
          >
            <Switch
              aria-label={t("settings:general.suggestions.enabled")}
              checked={config.enabled}
              disabled={updateSuggestionConfig.isPending}
              onCheckedChange={(checked) => save({ enabled: checked })}
            />
          </SettingRow>
          <SettingRow
            title={t("settings:general.suggestions.strategy")}
            description={t("settings:general.suggestions.strategyDesc")}
          >
            <Select
              items={[
                {
                  value: "request",
                  label: t("settings:general.suggestions.strategyRequest"),
                },
                {
                  value: "turn",
                  label: t("settings:general.suggestions.strategyTurn"),
                },
              ]}
              value={config.strategy}
              onValueChange={(value) => {
                if (value === "request" || value === "turn") save({ strategy: value });
              }}
            >
              <SelectTrigger className="w-64 max-w-full shrink-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="request">
                  {t("settings:general.suggestions.strategyRequest")}
                </SelectItem>
                <SelectItem value="turn">
                  {t("settings:general.suggestions.strategyTurn")}
                </SelectItem>
              </SelectContent>
            </Select>
          </SettingRow>
          <SettingRow
            title={t("settings:general.suggestions.model")}
            description={t("settings:general.suggestions.modelDesc")}
          >
            <Select
              items={modelItems}
              onValueChange={(value) => value !== null && save({ model: value })}
              value={config.model}
            >
              <SelectTrigger className="w-64 max-w-full shrink-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {modelItems.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingRow>
        </>
      ) : (
        <p className="text-xs text-muted-foreground">{t("common:loading")}</p>
      )}
    </SettingCard>
  );
}
