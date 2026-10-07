import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLinkIcon, LoaderCircleIcon } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { getAuthToken, useAuth } from "@/features/auth";
import { useTranslation } from "@/shared/i18n";
import { Button } from "@/shared/ui/button";
import { Checkbox } from "@/shared/ui/checkbox";
import { Input } from "@/shared/ui/input";
import { Label } from "@/shared/ui/label";
import { ScrollArea } from "@/shared/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/shared/ui/select";
import { Switch } from "@/shared/ui/switch";
import {
  type ComputerConfig,
  ComputerConfigSchema,
  type ComputerProbe,
} from "../../../../../../shared/computer-contract";
import {
  disconnectComputer,
  fetchComputerConfig,
  probeComputer,
  saveComputerConfig,
} from "../../api/settings-api";
import { SettingCard, SettingRow } from "../controls";

export function ComputerSection() {
  const { t } = useTranslation();
  const { user, token } = useAuth();
  const queryClient = useQueryClient();
  const queryKey = ["computer-config", user?.id];
  const query = useQuery({ queryKey, queryFn: fetchComputerConfig });
  const [draft, setDraft] = React.useState<ComputerConfig | null>(null);
  const draftRef = React.useRef(draft);
  draftRef.current = draft;
  const lastAttempt = React.useRef<ComputerConfig | null>(null);
  const [probe, setProbe] = React.useState<ComputerProbe | null>(null);
  const [filter, setFilter] = React.useState("");
  const config = draft ?? query.data;
  const save = useMutation({
    scope: { id: JSON.stringify(queryKey) },
    mutationFn: (submitted: ComputerConfig) => {
      if (!token || getAuthToken() !== token)
        throw new Error(t("settings:computer.sessionChanged"));
      return saveComputerConfig(ComputerConfigSchema.parse(submitted));
    },
    onMutate: () => queryClient.cancelQueries({ queryKey }),
    onSuccess: (saved, submitted) => {
      queryClient.setQueryData(queryKey, saved);
      setDraft((current) => (current === submitted ? null : current));
    },
    onError: (error) => toast.error(error.message),
  });
  const check = useMutation({
    mutationFn: probeComputer,
    onSuccess: setProbe,
    onError: (error) => setProbe({ ok: false, tools: [], error: error.message }),
  });
  const disconnect = useMutation({
    mutationFn: disconnectComputer,
    onSuccess: () => {
      setProbe(null);
      toast.success(t("settings:computer.disconnected"));
    },
    onError: (error) => toast.error(error.message),
  });
  const permissions = useMutation({
    mutationFn: () => window.api.window.computerPermissions("request"),
    onError: (error) => toast.error(error.message),
  });
  const busy = check.isPending || disconnect.isPending || permissions.isPending;
  const { mutate: persist, isPending: saving } = save;
  React.useEffect(() => {
    if (
      !draft ||
      draft === lastAttempt.current ||
      saving ||
      busy ||
      !ComputerConfigSchema.safeParse(draft).success
    )
      return;
    const timer = window.setTimeout(() => {
      lastAttempt.current = draft;
      persist(draft);
    }, 800);
    return () => window.clearTimeout(timer);
  }, [draft, saving, busy, persist]);

  // Flush a valid unsent edit when leaving this section. The mutation scope also
  // serializes this final write behind a request already in flight.
  const saveOnLeave = React.useRef(() => {});
  saveOnLeave.current = () => {
    const pending = draftRef.current;
    if (
      !pending ||
      pending === lastAttempt.current ||
      !token ||
      getAuthToken() !== token ||
      !ComputerConfigSchema.safeParse(pending).success
    )
      return;
    lastAttempt.current = pending;
    persist(pending);
  };
  React.useEffect(() => () => saveOnLeave.current(), []);
  if (!config)
    return (
      <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
        {query.isError ? (
          <>
            <span className="text-destructive break-words">{query.error.message}</span>
            <Button onClick={() => void query.refetch()}>{t("settings:computer.retry")}</Button>
          </>
        ) : (
          <LoaderCircleIcon className="size-4 animate-spin" />
        )}
      </div>
    );
  const validation = ComputerConfigSchema.safeParse(config);
  const failedSave = save.isError && save.variables === draft;
  const update = (patch: Partial<ComputerConfig>) => {
    if (!busy) setDraft({ ...config, ...patch });
  };
  const toggle = (
    key:
      | "enabled"
      | "requireToolApproval"
      | "approveManifest"
      | "acknowledgeUnrestricted"
      | "includeScreenshot"
      | "includeAccessibilityTree",
  ) => (
    <Switch
      checked={config[key]}
      aria-label={t(`settings:computer.${key}`)}
      onCheckedChange={(checked) => update({ [key]: checked })}
    />
  );
  return (
    <fieldset disabled={busy} className="flex min-w-0 flex-col gap-4 disabled:opacity-70">
      <SettingCard
        title={t("settings:computer.title")}
        description={t("settings:computer.desc")}
        action={
          <a
            className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
            href="https://cua.ai/docs/cua-driver/guides/use-the-sdk"
            target="_blank"
            rel="noreferrer"
          >
            {t("settings:computer.sdkDocs")}
            <ExternalLinkIcon className="size-3" />
          </a>
        }
      >
        <SettingRow
          title={t("settings:computer.enabled")}
          description={t("settings:computer.enabledDesc")}
        >
          {toggle("enabled")}
        </SettingRow>
        <p className="py-3 text-xs text-muted-foreground break-words">
          {t("settings:computer.nativeDesc")}
        </p>
      </SettingCard>
      <SettingCard
        title={t("settings:computer.permissionsTitle")}
        description={t("settings:computer.permissionsDesc")}
      >
        {window.electron.process.platform === "darwin" ? (
          <SettingRow
            title={t("settings:computer.requestPermissions")}
            description={t("settings:computer.requestPermissionsDesc")}
          >
            <Button variant="outline" onClick={() => permissions.mutate()}>
              {t("settings:computer.requestPermissions")}
            </Button>
            {permissions.data ? (
              <p className="text-xs break-words" role="status">
                {t("settings:computer.permissionState", {
                  accessibility: t(
                    permissions.data.accessibility
                      ? "settings:computer.granted"
                      : "settings:computer.missing",
                  ),
                  screenRecording: t(
                    permissions.data.screenRecording
                      ? "settings:computer.granted"
                      : "settings:computer.missing",
                  ),
                })}
              </p>
            ) : null}
          </SettingRow>
        ) : null}
        <SettingRow
          title={t("settings:computer.requireToolApproval")}
          description={t("settings:computer.requireToolApprovalDesc")}
        >
          {toggle("requireToolApproval")}
        </SettingRow>
        <SettingRow title={t("settings:computer.permissionMode")}>
          <Select
            value={config.permissionMode}
            onValueChange={(value) =>
              value &&
              update({
                permissionMode: value as ComputerConfig["permissionMode"],
                acknowledgeUnrestricted: false,
              })
            }
          >
            <SelectTrigger
              className="w-full sm:w-56"
              aria-label={t("settings:computer.permissionMode")}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(["standard", "bounded", "unrestricted"] as const).map((mode) => (
                <SelectItem value={mode} key={mode}>
                  {t(`settings:computer.mode_${mode}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
        {config.permissionMode === "unrestricted" ? (
          <SettingRow
            title={t("settings:computer.acknowledgeUnrestricted")}
            description={t("settings:computer.unrestrictedDesc")}
          >
            {toggle("acknowledgeUnrestricted")}
          </SettingRow>
        ) : null}
        <SettingRow
          title={t("settings:computer.capabilityManifest")}
          description={t("settings:computer.capabilityManifestDesc")}
        >
          <Input
            className="w-full min-w-0 sm:w-72 font-mono text-xs"
            aria-label={t("settings:computer.capabilityManifest")}
            value={config.capabilityManifest}
            spellCheck={false}
            onChange={(event) =>
              update({ capabilityManifest: event.target.value, approveManifest: false })
            }
          />
        </SettingRow>
        {config.capabilityManifest ? (
          <SettingRow title={t("settings:computer.approveManifest")}>
            {toggle("approveManifest")}
          </SettingRow>
        ) : null}
      </SettingCard>
      <SettingCard title={t("settings:computer.runtimeTitle")}>
        {(
          [
            ["timeoutMs", 1000, 300000, 1000],
            ["sessionTtlMs", 60000, 86400000, 60000],
            ["idleTimeoutMs", 60000, 3600000, 60000],
            ["maxImageDimension", 1, 8192, 1],
            ["maxElements", 1, 10000, 1],
            ["maxDepth", 1, 100, 1],
          ] as const
        ).map(([key, min, max, step]) => (
          <SettingRow
            key={key}
            title={t(`settings:computer.${key}`)}
            description={t(`settings:computer.${key}Desc`)}
          >
            <Input
              className="w-32"
              type="number"
              min={min}
              max={max}
              step={step}
              aria-label={t(`settings:computer.${key}`)}
              value={Number.isNaN(config[key]) ? "" : (config[key] ?? "")}
              onChange={(event) =>
                update({
                  [key]:
                    ["maxImageDimension", "maxElements", "maxDepth"].includes(key) &&
                    !event.target.value
                      ? null
                      : event.target.valueAsNumber,
                })
              }
            />
          </SettingRow>
        ))}
        <SettingRow title={t("settings:computer.includeScreenshot")}>
          {toggle("includeScreenshot")}
        </SettingRow>
        <SettingRow title={t("settings:computer.includeAccessibilityTree")}>
          {toggle("includeAccessibilityTree")}
        </SettingRow>
        <SettingRow
          title={t("settings:computer.deliveryMode")}
          description={t("settings:computer.deliveryModeDesc")}
        >
          <Select
            value={config.deliveryMode}
            onValueChange={(value) =>
              value && update({ deliveryMode: value as ComputerConfig["deliveryMode"] })
            }
          >
            <SelectTrigger
              className="w-full sm:w-56"
              aria-label={t("settings:computer.deliveryMode")}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="background">{t("settings:computer.background")}</SelectItem>
              <SelectItem value="foreground">{t("settings:computer.foreground")}</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow
          title={t("settings:computer.cursorEnabled")}
          description={t("settings:computer.cursorEnabledDesc")}
        >
          <Select
            value={config.cursorEnabled === null ? "default" : config.cursorEnabled ? "on" : "off"}
            onValueChange={(value) =>
              value && update({ cursorEnabled: value === "default" ? null : value === "on" })
            }
          >
            <SelectTrigger
              className="w-full sm:w-56"
              aria-label={t("settings:computer.cursorEnabled")}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(["default", "on", "off"] as const).map((value) => (
                <SelectItem value={value} key={value}>
                  {t(`settings:computer.cursor_${value}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
        {config.cursorEnabled === true ? (
          <>
            <SettingRow
              title={t("settings:computer.cursorTheme")}
              description={t("settings:computer.cursorThemeDesc")}
            >
              <Input
                className="w-full sm:w-56"
                aria-label={t("settings:computer.cursorTheme")}
                value={config.cursorTheme}
                onChange={(event) => update({ cursorTheme: event.target.value })}
              />
            </SettingRow>
            <SettingRow title={t("settings:computer.cursorReducedMotion")}>
              <Select
                value={config.cursorReducedMotion}
                onValueChange={(value) =>
                  value &&
                  update({ cursorReducedMotion: value as ComputerConfig["cursorReducedMotion"] })
                }
              >
                <SelectTrigger
                  className="w-full sm:w-56"
                  aria-label={t("settings:computer.cursorReducedMotion")}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(["auto", "on", "off"] as const).map((mode) => (
                    <SelectItem value={mode} key={mode}>
                      {t(`settings:computer.motion_${mode}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </SettingRow>
          </>
        ) : null}
      </SettingCard>
      <SettingCard
        title={t("settings:computer.diagnostics")}
        description={t("settings:computer.diagnosticsDesc")}
      >
        <div className="flex flex-wrap items-center gap-2 py-3">
          <Button
            variant="outline"
            disabled={!validation.success || busy || saving}
            onClick={() => validation.success && check.mutate(validation.data)}
          >
            {check.isPending ? <LoaderCircleIcon className="size-4 animate-spin" /> : null}
            {t("settings:computer.probe")}
          </Button>
          <Button variant="outline" disabled={saving} onClick={() => disconnect.mutate()}>
            {t("settings:computer.disconnect")}
          </Button>
        </div>
        {probe ? (
          <div className="flex min-w-0 flex-col gap-2 py-3" role="status">
            <p className={`text-sm ${probe.ok ? "text-emerald-600" : "text-destructive"}`}>
              {t(probe.ok ? "settings:computer.ready" : "settings:computer.unavailable")}
            </p>
            {probe.error ? (
              <p className="text-xs break-words text-destructive [overflow-wrap:anywhere]">
                {probe.error}
              </p>
            ) : null}
            <p className="text-xs text-muted-foreground">
              {t("settings:computer.probeSnapshotDesc")}
            </p>
            {probe.health ? (
              <ScrollArea className="h-48 rounded-md border bg-muted/30">
                <pre className="whitespace-pre-wrap break-words p-2 text-xs [overflow-wrap:anywhere]">
                  {JSON.stringify(probe.health, null, 2)}
                </pre>
              </ScrollArea>
            ) : null}
          </div>
        ) : null}
        <div className="flex min-w-0 flex-col gap-2 py-3">
          <p className="text-sm font-medium">{t("settings:computer.toolsTitle")}</p>
          <p className="text-xs text-muted-foreground">{t("settings:computer.toolsDesc")}</p>
          {probe?.tools.length ? (
            <>
              <Input
                aria-label={t("settings:computer.filterTools")}
                placeholder={t("settings:computer.filterTools")}
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
              />
              <ScrollArea className="h-64">
                <div className="flex min-w-0 flex-col gap-2 pr-3">
                  {probe.tools
                    .filter((tool) =>
                      `${tool.name} ${tool.description}`
                        .toLowerCase()
                        .includes(filter.toLowerCase()),
                    )
                    .map((tool) => (
                      <Label
                        key={tool.name}
                        className="flex min-w-0 items-start gap-2 rounded-md border p-2"
                      >
                        <Checkbox
                          className="mt-0.5 shrink-0"
                          checked={!config.disabledTools.includes(tool.name)}
                          onCheckedChange={(checked) =>
                            update({
                              disabledTools: checked
                                ? config.disabledTools.filter((name) => name !== tool.name)
                                : [...new Set([...config.disabledTools, tool.name])],
                            })
                          }
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block break-words font-mono text-xs">{tool.name}</span>
                          <span className="block whitespace-pre-wrap break-words text-xs text-muted-foreground [overflow-wrap:anywhere]">
                            {tool.description}
                          </span>
                        </span>
                      </Label>
                    ))}
                </div>
              </ScrollArea>
            </>
          ) : (
            <p className="text-xs text-muted-foreground">{t("settings:computer.discoverFirst")}</p>
          )}
          {config.disabledTools.length ? (
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="break-words">
                {t("settings:computer.disabledTools", { tools: config.disabledTools.join(", ") })}
              </span>
              <Button size="xs" variant="ghost" onClick={() => update({ disabledTools: [] })}>
                {t("settings:computer.enableAll")}
              </Button>
            </div>
          ) : null}
        </div>
      </SettingCard>
      {!validation.success ? (
        <p role="alert" className="text-xs text-destructive break-words">
          {t("settings:computer.invalidConfig")}{" "}
          {validation.error.issues
            .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
            .join("; ")}
        </p>
      ) : null}
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span
          role="status"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground"
        >
          {saving ? <LoaderCircleIcon className="size-3 animate-spin" /> : null}
          {t(
            saving
              ? "common:saving"
              : !draft
                ? "common:saved"
                : failedSave
                  ? "settings:computer.saveFailed"
                  : validation.success
                    ? "settings:computer.savePending"
                    : "settings:computer.unsaved",
          )}
        </span>
        {failedSave ? (
          <>
            <span role="alert" className="min-w-0 break-words text-xs text-destructive">
              {save.error.message}
            </span>
            <Button
              variant="outline"
              disabled={!draft || !validation.success || busy || saving}
              onClick={() => {
                if (draft) {
                  lastAttempt.current = draft;
                  persist(draft);
                }
              }}
            >
              {t("common:retry")}
            </Button>
          </>
        ) : null}
        <p className="min-w-0 text-xs text-muted-foreground break-words">
          {t("settings:computer.saveDesc")}
        </p>
      </div>
    </fieldset>
  );
}
