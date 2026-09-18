import {
  ActivityIcon,
  AlertCircleIcon,
  CheckCircle2Icon,
  LanguagesIcon,
  LaptopIcon,
  RefreshCwIcon,
  SaveIcon,
  ServerIcon,
  WifiOffIcon,
} from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { useTranslation } from "@/shared/i18n";
import { cn, toastError } from "@/shared/lib";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import {
  fetchProxySettings,
  type ProxyConfig,
  type ProxyMode,
  type ProxyTestResult,
  saveProxySettings,
  testProxyConnectivity,
} from "../../api/settings-api";
import { SettingCard } from "../controls";

export function GeneralSection() {
  const { t, i18n } = useTranslation();
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
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

  const hasDirtyChanges =
    mode !== savedConfig.mode ||
    (mode === "manual" && manualUrl.trim() !== (savedConfig.url ?? ""));

  const handleSave = async () => {
    if (mode === "manual" && !manualUrl.trim()) {
      toast.error(t("settings:general.pleaseEnterValidUrl"));
      return;
    }
    setSaving(true);
    try {
      const newConfig: ProxyConfig = mode === "manual" ? { mode, url: manualUrl.trim() } : { mode };
      await saveProxySettings(newConfig);
      setSavedConfig(newConfig);
      toast.success(t("settings:general.proxyUpdated"));
    } catch (error) {
      toastError(error, t("settings:general.saveProxyFailed"));
    } finally {
      setSaving(false);
    }
  };

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
      {/* 界面语言 */}
      <SettingCard
        title={t("settings:general.languageTitle")}
        description={t("settings:general.languageDesc")}
        action={
          <Badge variant="outline" className="text-[11px] font-normal">
            {t("settings:general.currentLang", {
              lang: i18n.language.startsWith("en")
                ? t("settings:general.langEn")
                : t("settings:general.langZh"),
            })}
          </Badge>
        }
      >
        <div className="py-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {/* 中文 */}
            <div
              role="button"
              tabIndex={0}
              onClick={() => {
                void i18n.changeLanguage("zh");
                toast.success(t("settings:general.switchedToZh"));
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  void i18n.changeLanguage("zh");
                  toast.success(t("settings:general.switchedToZh"));
                }
              }}
              className={cn(
                "relative flex flex-col justify-between rounded-lg border p-3.5 cursor-pointer transition-all select-none",
                !i18n.language.startsWith("en")
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
                        !i18n.language.startsWith("en") ? "text-primary" : "text-muted-foreground",
                      )}
                    />
                    <span className="text-xs font-semibold text-foreground">
                      {t("settings:general.langZh")}
                    </span>
                    <span className="text-[11px] text-muted-foreground">
                      {t("settings:general.langZhSub")}
                    </span>
                  </div>
                  {!i18n.language.startsWith("en") ? (
                    <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4 font-normal">
                      {t("common:selected")}
                    </Badge>
                  ) : null}
                </div>
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  {t("settings:general.langZhDesc")}
                </p>
              </div>
            </div>

            {/* 英文 */}
            <div
              role="button"
              tabIndex={0}
              onClick={() => {
                void i18n.changeLanguage("en");
                toast.success(t("settings:general.switchedToEn"));
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  void i18n.changeLanguage("en");
                  toast.success(t("settings:general.switchedToEn"));
                }
              }}
              className={cn(
                "relative flex flex-col justify-between rounded-lg border p-3.5 cursor-pointer transition-all select-none",
                i18n.language.startsWith("en")
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
                        i18n.language.startsWith("en") ? "text-primary" : "text-muted-foreground",
                      )}
                    />
                    <span className="text-xs font-semibold text-foreground">
                      {t("settings:general.langEn")}
                    </span>
                    <span className="text-[11px] text-muted-foreground">
                      {t("settings:general.langEnSub")}
                    </span>
                  </div>
                  {i18n.language.startsWith("en") ? (
                    <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4 font-normal">
                      {t("common:selected")}
                    </Badge>
                  ) : null}
                </div>
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  {t("settings:general.langEnDesc")}
                </p>
              </div>
            </div>
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
                ? `${t("common:current")}：${t("settings:general.proxySystem")}`
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
            <div
              role="button"
              tabIndex={0}
              onClick={() => {
                setMode("system");
                setTestResult(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  setMode("system");
                  setTestResult(null);
                }
              }}
              className={cn(
                "relative flex flex-col justify-between rounded-lg border p-3.5 cursor-pointer transition-all select-none",
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
                    {t("settings:general.proxySystem")}
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
                  {t("settings:general.proxySystemDesc")}
                </p>
              </div>
            </div>

            {/* 模式 2: 不使用代理 */}
            <div
              role="button"
              tabIndex={0}
              onClick={() => {
                setMode("direct");
                setTestResult(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  setMode("direct");
                  setTestResult(null);
                }
              }}
              className={cn(
                "relative flex flex-col justify-between rounded-lg border p-3.5 cursor-pointer transition-all select-none",
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
            </div>

            {/* 模式 3: 手动输入代理 */}
            <div
              role="button"
              tabIndex={0}
              onClick={() => {
                setMode("manual");
                setTestResult(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  setMode("manual");
                  setTestResult(null);
                }
              }}
              className={cn(
                "relative flex flex-col justify-between rounded-lg border p-3.5 cursor-pointer transition-all select-none",
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
            </div>
          </div>

          {/* 手动模式下的代理地址输入框与测试按钮 */}
          {mode === "manual" ? (
            <div className="rounded-lg border border-border/70 bg-muted/20 p-3.5 space-y-3">
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between">
                  <label htmlFor="proxy-url-input" className="text-xs font-medium text-foreground">
                    {t("settings:general.proxyUrlLabel")}
                  </label>
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

          {/* 保存配置操作行 */}
          <div className="flex items-center justify-between pt-2 border-t border-border/60">
            <p className="text-xs text-muted-foreground">
              {hasDirtyChanges
                ? t("settings:general.proxyStatusChanged")
                : t("settings:general.proxyStatusLatest")}
            </p>
            <Button
              type="button"
              disabled={
                loading || saving || (mode === "manual" && !manualUrl.trim()) || !hasDirtyChanges
              }
              onClick={handleSave}
              className="gap-1.5 text-xs h-8 px-4 cursor-pointer"
            >
              {saving ? (
                <RefreshCwIcon className="size-3.5 animate-spin" />
              ) : (
                <SaveIcon className="size-3.5" />
              )}
              <span>{saving ? t("common:saving") : t("settings:general.proxySave")}</span>
            </Button>
          </div>
        </div>
      </SettingCard>
    </div>
  );
}
