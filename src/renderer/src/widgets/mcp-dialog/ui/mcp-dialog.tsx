import { useQueryClient } from "@tanstack/react-query";
import {
  ChevronDownIcon,
  Globe2Icon,
  PlugZapIcon,
  SquareTerminalIcon,
  TestTube2Icon,
} from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import type { McpFormServer, McpSummary } from "@/entities/skill";
import { useAssistantDiagnosis } from "@/entities/workbench/model/queries/threads";
import { qk } from "@/entities/workbench/model/query-keys";
import { getAuthToken, useAuth } from "@/features/auth";
import { apiFetch, MASTRA_SERVER_URL } from "@/shared/api";
import { useTranslation } from "@/shared/i18n";
import { toastError } from "@/shared/lib";
import { Button } from "@/shared/ui/button";
import { Checkbox } from "@/shared/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/shared/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { Dotm3x3_1 } from "@/shared/ui/dotm-3x3-1";
import { Field, FieldContent, FieldDescription, FieldLabel } from "@/shared/ui/field";
import { Input } from "@/shared/ui/input";
import { ScrollArea } from "@/shared/ui/scroll-area";
import { Textarea } from "@/shared/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/shared/ui/toggle-group";
import { mcpCredentialPurpose } from "../../../../../shared/credential-contract";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
  server?: McpSummary | McpFormServer | null;
}

const initial = (): McpFormServer => ({
  id: crypto.randomUUID(),
  name: "",
  enabled: true,
  transport: "http",
  url: "",
  headerKeys: [],
  allowedHosts: [],
  command: "",
  args: [],
  envKeys: [],
  inheritDefaultEnv: true,
  requireToolApproval: true,
  oauth: { enabled: false },
});

function parseLines(value: string) {
  return value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseKeyValue(value: string) {
  return Object.fromEntries(
    parseLines(value).flatMap((line) => {
      const index = line.indexOf("=");
      return index > 0 ? [[line.slice(0, index).trim(), line.slice(index + 1)]] : [];
    }),
  );
}

export function McpDialog({ open, onOpenChange, onSaved, server }: Props) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const diagnosis = useAssistantDiagnosis(user?.id ?? "");
  const queryClient = useQueryClient();
  const [form, setForm] = React.useState<McpFormServer>(initial);
  const diagnosticContext = (error: unknown) =>
    `MCP: ${form.name} (${form.id})\nTransport: ${form.transport}\nPlugin: ${form.plugin?.id ?? "standalone"}\nError: ${error instanceof Error ? error.message : String(error)}`;
  const [headersText, setHeadersText] = React.useState("");
  const [anysearchKey, setAnysearchKey] = React.useState("");
  const [envText, setEnvText] = React.useState("");
  const [oauthClientSecret, setOauthClientSecret] = React.useState("");
  const [allowedHostsText, setAllowedHostsText] = React.useState("");
  const [argsText, setArgsText] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [testing, setTesting] = React.useState(false);
  const [dirty, setDirty] = React.useState(false);
  const [saveError, setSaveError] = React.useState("");
  const editVersion = React.useRef(0);
  const savingRef = React.useRef(false);
  const session = React.useRef(getAuthToken());
  const markEdited = () => {
    editVersion.current += 1;
    setDirty(true);
    setSaveError("");
  };

  const isEditing = Boolean(server);

  React.useEffect(() => {
    if (!open) return;
    editVersion.current += 1;
    session.current = getAuthToken();
    setDirty(false);
    setSaveError("");
    setAnysearchKey("");
    if (!server) {
      setForm(initial());
      setHeadersText("");
      setEnvText("");
      setOauthClientSecret("");
      setAllowedHostsText("");
      setArgsText("");
      return;
    }

    const {
      connectionError: _error,
      toolCount: _count,
      configurationError: _configError,
      configurationKeys: _keys,
      ...connection
    } = server as McpSummary;
    setForm({ ...initial(), ...connection });
    setArgsText(server.args?.join("\n") ?? "");
    setAllowedHostsText((server as { allowedHosts?: string[] }).allowedHosts?.join("\n") ?? "");

    setHeadersText("");
    setEnvText("");
    setOauthClientSecret("");
  }, [open, server]);

  const update = (patch: Partial<McpFormServer>) => {
    markEdited();
    setForm((current) => ({ ...current, ...patch }));
  };

  const payload = async () => {
    const id = form.id;
    const created: Array<{ purpose: string; secretRef: string }> = [];
    const headers = parseKeyValue(headersText);
    const env = parseKeyValue(envText);
    let headerCredential = form.headerCredential;
    let headerKeys = form.headerKeys ?? [];
    let envCredential = form.envCredential;
    let envKeys = form.envKeys ?? [];
    let oauth: McpFormServer["oauth"] = form.oauth
      ? { ...form.oauth, clientId: form.oauth.clientId?.trim() }
      : undefined;
    if (form.transport === "http" && Object.keys(headers).length > 0) {
      const purpose = mcpCredentialPurpose(id, "headers");
      headerCredential = await window.api.credentials.put({
        purpose,
        value: JSON.stringify(headers),
      });
      headerKeys = Object.keys(headers);
      created.push({ purpose, secretRef: headerCredential.credentialRef });
    }
    if ((form.transport === "stdio" || form.plugin) && Object.keys(env).length > 0) {
      const purpose = mcpCredentialPurpose(id, "env");
      envCredential = await window.api.credentials.put({ purpose, value: JSON.stringify(env) });
      envKeys = Object.keys(env);
      created.push({ purpose, secretRef: envCredential.credentialRef });
    }
    if (form.transport === "http" && oauthClientSecret.trim()) {
      const purpose = mcpCredentialPurpose(id, "client-secret");
      const clientSecretCredential = await window.api.credentials.put({
        purpose,
        value: oauthClientSecret.trim(),
      });
      oauth = { ...(oauth ?? { enabled: true }), clientSecretCredential };
      created.push({ purpose, secretRef: clientSecretCredential.credentialRef });
    }
    return {
      server: {
        clientId: form.clientId,
        serverName: form.serverName,
        builtin: form.builtin,
        plugin: form.plugin,
        status: form.status,
        version: form.version,
        timeout: form.timeout,
        tools: form.tools,
        id,
        name: form.name.trim() || id,
        enabled: form.enabled,
        transport: form.transport,
        requireToolApproval: form.requireToolApproval,
        inheritDefaultEnv: form.inheritDefaultEnv,
        ...(form.transport === "http"
          ? {
              url: form.url?.trim(),
              headerCredential,
              headerKeys,
              envCredential,
              envKeys,
              oauth,
              allowedHosts: parseLines(allowedHostsText),
            }
          : {
              command: form.command?.trim(),
              args: parseLines(argsText),
              envCredential,
              envKeys,
            }),
      },
      created,
    };
  };

  const validate = () => {
    if (form.transport === "http" && form.oauth?.enabled && !form.oauth.clientId?.trim()) {
      toast.error(t("mcp:pleaseEnterOauthClientId"));
      return false;
    }
    if (form.transport === "http" && !form.url?.trim()) {
      toast.error(t("mcp:pleaseEnterUrl"));
      return false;
    }
    if (form.transport === "stdio" && !form.command?.trim()) {
      toast.error(t("mcp:pleaseEnterCommand"));
      return false;
    }
    return true;
  };

  const test = async () => {
    if (!validate()) return;
    setTesting(true);
    let temporaryCredentials: Array<{ purpose: string; secretRef: string }> = [];
    try {
      const next = await payload();
      temporaryCredentials = next.created;
      const response = await apiFetch(`${MASTRA_SERVER_URL}/work/mcp/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ server: next.server }),
      });
      const result = (await response.json()) as {
        ok?: boolean;
        toolCount?: number;
        error?: string;
      };
      if (!response.ok || !result.ok) throw new Error(result.error || t("mcp:testFailed"));
      toast.success(t("mcp:testSuccess", { count: result.toolCount ?? 0 }));
    } catch (error) {
      toastError(error, t("mcp:testFailed"), diagnosis.action(diagnosticContext(error)));
    } finally {
      await Promise.all(
        temporaryCredentials.map((credential) =>
          window.api.credentials.delete(credential).catch(() => undefined),
        ),
      );
      setTesting(false);
    }
  };

  const save = async (automatic = false) => {
    if (savingRef.current || session.current !== getAuthToken()) return;
    if (!validate()) return;
    savingRef.current = true;
    const version = editVersion.current;
    const token = session.current;
    setSaving(true);
    setSaveError("");
    try {
      const next = await payload();
      if (token !== getAuthToken()) throw new Error("Session changed");
      const response = await apiFetch(`${MASTRA_SERVER_URL}/work/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ server: next.server }),
      });
      const result = (await response.json()) as {
        server?: McpSummary;
        error?: string;
        message?: string;
      };
      if (!response.ok)
        throw new Error(
          result.message ||
            result.error ||
            (isEditing ? t("mcp:updateFailed") : t("mcp:saveFailed")),
        );
      if (token !== getAuthToken()) return;
      if (!automatic) toast.success(isEditing ? t("mcp:updateSuccess") : t("mcp:createSuccess"));
      if (result.server) {
        const saved = result.server;
        // Keep edits made during the request; only advance the saved version and unchanged pointers.
        setForm((current) => ({
          ...current,
          version: saved.version,
          ...(current.headerCredential === form.headerCredential
            ? { headerCredential: saved.headerCredential, headerKeys: saved.headerKeys }
            : {}),
          ...(current.envCredential === form.envCredential
            ? { envCredential: saved.envCredential, envKeys: saved.envKeys }
            : {}),
          ...(current.oauth === form.oauth ? { oauth: saved.oauth } : {}),
        }));
      }
      if (editVersion.current === version) {
        setDirty(false);
        setHeadersText("");
        setEnvText("");
        setOauthClientSecret("");
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["mcp-connections"] }),
        queryClient.invalidateQueries({ queryKey: qk.toolsConfig() }),
      ]);
      if (!automatic) onOpenChange(false);
      onSaved();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : t("mcp:saveFailed"));
      toastError(
        error,
        isEditing ? t("mcp:updateFailed") : t("mcp:saveFailed"),
        diagnosis.action(diagnosticContext(error)),
      );
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const autoSave = React.useEffectEvent(() => void save(true));
  React.useEffect(() => {
    if (!open || !form.plugin || !dirty || saving || testing || saveError) return;
    if (form.oauth?.enabled && !form.oauth.clientId?.trim()) return;
    const timer = window.setTimeout(autoSave, 800);
    return () => window.clearTimeout(timer);
  }, [
    open,
    form,
    dirty,
    saving,
    testing,
    saveError,
    headersText,
    envText,
    oauthClientSecret,
    allowedHostsText,
  ]);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next || (!saving && (!form.plugin || !dirty))) onOpenChange(next);
      }}
    >
      <DialogContent className="flex max-h-[min(88vh,52rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
        <DialogHeader className="shrink-0 border-b bg-background px-5 py-4 pr-12">
          <div className="flex items-start gap-3">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <PlugZapIcon className="size-4" />
            </span>
            <div className="min-w-0">
              <DialogTitle className="text-base font-semibold">
                {isEditing ? t("mcp:editTitle") : t("mcp:addTitle")}
              </DialogTitle>
              <DialogDescription className="mt-0.5 text-xs leading-normal">
                {isEditing ? t("mcp:editDesc") : t("mcp:addDesc")}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>
        <ScrollArea className="min-h-0 flex-1">
          <div className="grid gap-4 px-6 py-4 pb-2">
            <section className="grid gap-3">
              <div>
                <h3 className="text-xs font-semibold text-foreground/90 uppercase tracking-wider">
                  {t("mcp:basicInfo")}
                </h3>
                <p className="mt-0.5 text-xs text-muted-foreground">{t("mcp:basicInfoHint")}</p>
              </div>
              <TextField
                id="mcp-name"
                disabled={Boolean(form.plugin)}
                label={t("mcp:nameLabel")}
                value={form.name}
                onChange={(value) => update({ name: value })}
                placeholder={t("mcp:namePlaceholder")}
              />
            </section>

            <section className="grid gap-2.5">
              <div>
                <h3 className="text-xs font-semibold text-foreground/90 uppercase tracking-wider">
                  {t("mcp:transportLabel")}
                </h3>
                <p className="mt-0.5 text-xs text-muted-foreground">{t("mcp:transportDesc")}</p>
              </div>
              <ToggleGroup
                disabled={Boolean(form.builtin || form.plugin)}
                aria-label={t("mcp:transportLabel")}
                className="grid w-full grid-cols-2 gap-2"
                variant="outline"
                value={[form.transport]}
                onValueChange={(next) => {
                  const value = next[0];
                  if (value === "http" || value === "stdio") update({ transport: value });
                }}
              >
                <ToggleGroupItem className="h-9 justify-start text-xs font-medium" value="http">
                  <Globe2Icon className="size-3.5" />
                  {t("mcp:streamableHttp")}
                </ToggleGroupItem>
                <ToggleGroupItem className="h-9 justify-start text-xs font-medium" value="stdio">
                  <SquareTerminalIcon className="size-3.5" />
                  {t("mcp:stdioCommand")}
                </ToggleGroupItem>
              </ToggleGroup>
            </section>

            {form.transport === "http" ? (
              <section className="grid gap-3">
                {form.plugin ? (
                  <TextAreaField
                    label={t("plugins:variables")}
                    value={envText}
                    onChange={(value) => {
                      markEdited();
                      setEnvText(value);
                    }}
                    placeholder={(server as McpSummary)?.configurationKeys
                      ?.map((key) => `${key}=`)
                      .join("\n")}
                    hint={t("plugins:variablesHint")}
                  />
                ) : null}
                <TextField
                  disabled={Boolean(form.builtin || form.plugin)}
                  id="mcp-url"
                  label={t("mcp:urlLabel")}
                  value={form.url ?? ""}
                  onChange={(value) => update({ url: value })}
                  placeholder={t("mcp:urlPlaceholder")}
                  required
                />
                {form.builtin === "anysearch" ? (
                  <div className="grid min-w-0 gap-2">
                    <TextField
                      id="anysearch-api-key"
                      type="password"
                      label={t("mcp:anysearchApiKey")}
                      value={anysearchKey}
                      placeholder={
                        form.headerCredential
                          ? t("mcp:credentialConfigured", {
                              hint: form.headerCredential.credentialHint,
                            })
                          : "as-..."
                      }
                      onChange={(value) => {
                        setAnysearchKey(value);
                        setHeadersText(value.trim() ? `Authorization=Bearer ${value.trim()}` : "");
                      }}
                    />
                    <p className="break-words text-xs text-muted-foreground">
                      {t("mcp:anysearchKeyHint")}
                    </p>
                    {form.headerCredential ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="justify-self-start"
                        onClick={() => {
                          update({ headerCredential: undefined, headerKeys: [] });
                          setAnysearchKey("");
                          setHeadersText("");
                        }}
                      >
                        {t("mcp:removeCredential")}
                      </Button>
                    ) : null}
                  </div>
                ) : null}
                <Collapsible defaultOpen={false} className="rounded-lg border bg-muted/20">
                  <CollapsibleTrigger className="group flex w-full items-center justify-between px-3.5 py-2.5 text-left text-xs font-medium">
                    {t("mcp:advancedHttpTitle")}
                    <ChevronDownIcon className="size-3.5 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
                  </CollapsibleTrigger>
                  <CollapsibleContent className="grid gap-3 px-3.5 pt-1 pb-3.5">
                    <TextAreaField
                      label={t("mcp:headersLabel")}
                      value={headersText}
                      onChange={(value) => {
                        markEdited();
                        setHeadersText(value);
                      }}
                      placeholder={
                        form.headerKeys?.length
                          ? t("mcp:secretConfigured", { keys: form.headerKeys.join(", ") })
                          : t("mcp:headersPlaceholder")
                      }
                      hint={t("mcp:headersHint")}
                    />
                    <TextAreaField
                      label={t("mcp:allowedHostsLabel")}
                      value={allowedHostsText}
                      onChange={(value) => {
                        markEdited();
                        setAllowedHostsText(value);
                      }}
                      placeholder={t("mcp:allowedHostsPlaceholder")}
                      hint={t("mcp:allowedHostsHint")}
                    />
                    <CheckField
                      disabled={Boolean(form.builtin)}
                      id="mcp-oauth"
                      title={t("mcp:oauthTitle")}
                      description={t("mcp:oauthDesc")}
                      checked={form.oauth?.enabled === true}
                      onCheckedChange={(checked) =>
                        update({ oauth: { ...(form.oauth ?? {}), enabled: checked } })
                      }
                    />
                    {form.oauth?.enabled ? (
                      <>
                        <TextField
                          id="mcp-oauth-client-id"
                          label={t("mcp:oauthClientId")}
                          required
                          value={form.oauth.clientId ?? ""}
                          onChange={(clientId) =>
                            update({
                              oauth: { ...(form.oauth ?? { enabled: true }), clientId },
                            })
                          }
                        />
                        <TextField
                          id="mcp-oauth-client-secret"
                          label={t("mcp:oauthClientSecret")}
                          value={oauthClientSecret}
                          onChange={(value) => {
                            markEdited();
                            setOauthClientSecret(value);
                          }}
                          placeholder={
                            form.oauth.clientSecretCredential
                              ? t("mcp:credentialConfigured", {
                                  hint: form.oauth.clientSecretCredential.credentialHint,
                                })
                              : undefined
                          }
                          type="password"
                        />
                      </>
                    ) : null}
                  </CollapsibleContent>
                </Collapsible>
              </section>
            ) : (
              <section className="grid gap-3">
                <TextField
                  id="mcp-command"
                  disabled={Boolean(form.plugin)}
                  label={t("mcp:commandLabel")}
                  value={form.command ?? ""}
                  onChange={(value) => update({ command: value })}
                  placeholder={t("mcp:commandPlaceholder")}
                  required
                />
                <Collapsible defaultOpen={false} className="rounded-lg border bg-muted/20">
                  <CollapsibleTrigger className="group flex w-full items-center justify-between px-3.5 py-2.5 text-left text-xs font-medium">
                    {t("mcp:advancedStdioTitle")}
                    <ChevronDownIcon className="size-3.5 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
                  </CollapsibleTrigger>
                  <CollapsibleContent className="grid gap-3 px-3.5 pt-1 pb-3.5">
                    <TextAreaField
                      label={t("mcp:argsLabel")}
                      disabled={Boolean(form.plugin)}
                      value={argsText}
                      onChange={setArgsText}
                      placeholder={"-y\n@modelcontextprotocol/server-filesystem\nC:\\Projects"}
                      hint={t("mcp:argsHint")}
                    />
                    <TextAreaField
                      label={t("mcp:envLabel")}
                      value={envText}
                      onChange={(value) => {
                        markEdited();
                        setEnvText(value);
                      }}
                      placeholder={
                        form.envKeys?.length
                          ? t("mcp:secretConfigured", { keys: form.envKeys.join(", ") })
                          : t("mcp:envPlaceholder")
                      }
                      hint={t("mcp:envHint")}
                    />
                    <CheckField
                      id="mcp-inherit-env"
                      title={t("mcp:inheritEnvTitle")}
                      checked={form.inheritDefaultEnv ?? true}
                      onCheckedChange={(checked) => update({ inheritDefaultEnv: checked })}
                    />
                  </CollapsibleContent>
                </Collapsible>
              </section>
            )}

            <section className="grid gap-2.5 rounded-lg border bg-muted/20 p-3">
              <CheckField
                id="mcp-enabled"
                disabled={Boolean(form.plugin)}
                title={t("mcp:enableImmediately")}
                checked={form.enabled}
                onCheckedChange={(checked) => update({ enabled: checked })}
              />
              <CheckField
                id="mcp-approval"
                title={t("mcp:requireApproval")}
                description={t("mcp:requireApprovalDesc")}
                checked={form.requireToolApproval ?? true}
                onCheckedChange={(checked) => update({ requireToolApproval: checked })}
              />
            </section>
            {form.plugin ? (
              <p role="status" className="break-words text-xs text-muted-foreground">
                {t(
                  saving
                    ? "common:saving"
                    : dirty
                      ? "plugins:configDraft"
                      : "plugins:configAutoSave",
                )}
              </p>
            ) : null}
            {(server as McpSummary)?.configurationKeys?.length ? (
              <p className="break-all text-xs text-muted-foreground">
                {t("plugins:requiredVariables")}:{" "}
                {(server as McpSummary).configurationKeys?.join(", ")}
              </p>
            ) : null}
            {saveError ? (
              <p role="alert" className="break-words text-sm text-destructive">
                {saveError}
                <Button
                  size="sm"
                  variant="outline"
                  className="ml-2"
                  onClick={() => void diagnosis.start(diagnosticContext(saveError))}
                >
                  {t("plugins:diagnose")}
                </Button>
              </p>
            ) : null}
          </div>
        </ScrollArea>
        <DialogFooter className="mx-0 mb-0 shrink-0 rounded-none border-0 border-t bg-background px-5 py-3 sm:flex-row sm:items-center sm:justify-between">
          <Button
            size="sm"
            disabled={testing || saving}
            onClick={() => void test()}
            variant="outline"
          >
            <TestTube2Icon className="size-3.5" />
            {testing ? t("mcp:testing") : t("mcp:testConnection")}
          </Button>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              disabled={testing || saving}
              variant="ghost"
              onClick={() => onOpenChange(false)}
            >
              {t("common:cancel")}
            </Button>
            <Button size="sm" disabled={saving || testing} onClick={() => void save()}>
              {saving ? <Dotm3x3_1 size={14} dotSize={2.2} colorPreset="solid-theme" /> : null}
              {saving
                ? isEditing
                  ? t("mcp:updating")
                  : t("mcp:saving")
                : isEditing
                  ? t("mcp:updateAction")
                  : t("mcp:saveAction")}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TextField({
  id,
  label,
  value,
  onChange,
  placeholder,
  required = false,
  disabled,
  type = "text",
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  required?: boolean;
  disabled?: boolean;
  type?: "text" | "password";
}) {
  return (
    <Field className="px-0.5">
      <FieldLabel htmlFor={id}>
        {label}
        {required ? <span className="ml-1 text-destructive">*</span> : null}
      </FieldLabel>
      <Input
        id={id}
        autoComplete="off"
        required={required}
        disabled={disabled}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        type={type}
      />
    </Field>
  );
}

function TextAreaField({
  label,
  value,
  onChange,
  placeholder,
  hint,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  hint?: string;
  disabled?: boolean;
}) {
  const fieldId = React.useId();
  return (
    <Field className="px-0.5">
      <FieldLabel htmlFor={fieldId}>{label}</FieldLabel>
      <Textarea
        id={fieldId}
        disabled={disabled}
        className="min-h-20 resize-y font-mono text-xs"
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        value={value}
        spellCheck={false}
      />
      {hint ? (
        <FieldDescription className="text-xs text-muted-foreground">{hint}</FieldDescription>
      ) : null}
    </Field>
  );
}

function CheckField({
  id,
  title,
  description,
  checked,
  disabled,
  onCheckedChange,
}: {
  id: string;
  title: string;
  description?: string;
  checked: boolean;
  disabled?: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <Field orientation="horizontal" className="gap-3 px-0.5">
      <Checkbox
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={(value) => onCheckedChange(value === true)}
      />
      <FieldContent>
        <FieldLabel htmlFor={id} className="cursor-pointer text-xs font-medium">
          {title}
        </FieldLabel>
        {description ? (
          <FieldDescription className="text-[11px] leading-normal">{description}</FieldDescription>
        ) : null}
      </FieldContent>
    </Field>
  );
}
