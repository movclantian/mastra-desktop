import {
  ChevronDownIcon,
  Globe2Icon,
  PlugZapIcon,
  SquareTerminalIcon,
  TestTube2Icon,
} from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { getMcpServer, type McpFormServer, type McpSummary } from "@/entities/skill";
import { apiFetch, MASTRA_SERVER_URL } from "@/shared/api";
import { useTranslation } from "@/shared/i18n";
import { toastError } from "@/shared/lib";
import { Button } from "@/shared/ui/button";
import { Checkbox } from "@/shared/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/shared/ui/collapsible";
import {
  Dialog,
  DialogClose,
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
  id: "",
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

function generatedServerId(form: McpFormServer) {
  const source =
    form.name.trim() ||
    (form.transport === "http" ? form.url?.trim() : form.command?.trim()) ||
    "mcp";
  const normalized = source
    .toLocaleLowerCase()
    .replace(/^[a-z]+:\/\//, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 56);
  if (normalized) return normalized;
  let hash = 2166136261;
  for (const character of source) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return `mcp-${(hash >>> 0).toString(36)}`;
}

export function McpDialog({ open, onOpenChange, onSaved, server }: Props) {
  const { t } = useTranslation();
  const [form, setForm] = React.useState<McpFormServer>(initial);
  const [headersText, setHeadersText] = React.useState("");
  const [envText, setEnvText] = React.useState("");
  const [oauthClientSecret, setOauthClientSecret] = React.useState("");
  const [allowedHostsText, setAllowedHostsText] = React.useState("");
  const [argsText, setArgsText] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [testing, setTesting] = React.useState(false);

  const isEditing = Boolean(server);

  React.useEffect(() => {
    if (!open) return;
    if (!server) {
      setForm(initial());
      setHeadersText("");
      setEnvText("");
      setOauthClientSecret("");
      setAllowedHostsText("");
      setArgsText("");
      return;
    }

    const initialTransport = server.transport;
    const initialForm: McpFormServer = {
      id: server.id || "",
      name: server.name || "",
      enabled: server.enabled ?? true,
      transport: initialTransport,
      url: server.url ?? "",
      headerCredential: server.headerCredential,
      headerKeys: server.headerKeys ?? [],
      allowedHosts: (server as { allowedHosts?: string[] }).allowedHosts ?? [],
      command: server.command ?? "",
      args: server.args ?? [],
      envCredential: server.envCredential,
      envKeys: server.envKeys ?? [],
      inheritDefaultEnv: (server as { inheritDefaultEnv?: boolean }).inheritDefaultEnv ?? true,
      requireToolApproval:
        (server as { requireToolApproval?: boolean }).requireToolApproval ?? true,
      oauth: server.oauth ?? { enabled: false },
    };
    setForm(initialForm);
    setArgsText(server.args?.join("\n") ?? "");
    setAllowedHostsText((server as { allowedHosts?: string[] }).allowedHosts?.join("\n") ?? "");

    setHeadersText("");
    setEnvText("");
    setOauthClientSecret("");

    if (server.id) {
      getMcpServer(server.id)
        .then((full) => {
          setForm({
            id: full.id,
            name: full.name,
            enabled: full.enabled ?? true,
            transport: full.transport,
            url: full.url ?? "",
            headerCredential: full.headerCredential,
            headerKeys: full.headerKeys ?? [],
            allowedHosts: (full as { allowedHosts?: string[] }).allowedHosts ?? [],
            command: full.command ?? "",
            args: full.args ?? [],
            envCredential: full.envCredential,
            envKeys: full.envKeys ?? [],
            inheritDefaultEnv: (full as { inheritDefaultEnv?: boolean }).inheritDefaultEnv ?? true,
            requireToolApproval:
              (full as { requireToolApproval?: boolean }).requireToolApproval ?? true,
            oauth: full.oauth ?? { enabled: false },
          });
          setArgsText(full.args?.join("\n") ?? "");
          setAllowedHostsText((full as { allowedHosts?: string[] }).allowedHosts?.join("\n") ?? "");
          setHeadersText("");
          setEnvText("");
          setOauthClientSecret("");
        })
        .catch(() => {
          // Keep existing values
        });
    }
  }, [open, server]);

  const update = (patch: Partial<McpFormServer>) =>
    setForm((current) => ({ ...current, ...patch }));

  const payload = async () => {
    const id = form.id.trim() || generatedServerId(form);
    const created: Array<{ purpose: string; secretRef: string }> = [];
    const headers = parseKeyValue(headersText);
    const env = parseKeyValue(envText);
    let headerCredential = form.headerCredential;
    let headerKeys = form.headerKeys ?? [];
    let envCredential = form.envCredential;
    let envKeys = form.envKeys ?? [];
    let oauth = form.oauth;
    if (Object.keys(headers).length > 0) {
      const purpose = mcpCredentialPurpose(id, "headers");
      headerCredential = await window.api.credentials.put({
        purpose,
        value: JSON.stringify(headers),
      });
      headerKeys = Object.keys(headers);
      created.push({ purpose, secretRef: headerCredential.credentialRef });
    }
    if (Object.keys(env).length > 0) {
      const purpose = mcpCredentialPurpose(id, "env");
      envCredential = await window.api.credentials.put({ purpose, value: JSON.stringify(env) });
      envKeys = Object.keys(env);
      created.push({ purpose, secretRef: envCredential.credentialRef });
    }
    if (oauthClientSecret.trim()) {
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
        ...form,
        id,
        name: form.name.trim() || id,
        headerCredential,
        headerKeys,
        envCredential,
        envKeys,
        oauth,
        args: parseLines(argsText),
        allowedHosts:
          parseLines(allowedHostsText).length > 0 ? parseLines(allowedHostsText) : undefined,
      },
      created,
    };
  };

  const validate = () => {
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
      toastError(error, t("mcp:testFailed"));
    } finally {
      await Promise.all(
        temporaryCredentials.map((credential) =>
          window.api.credentials.delete(credential).catch(() => undefined),
        ),
      );
      setTesting(false);
    }
  };

  const save = async () => {
    if (!validate()) return;
    setSaving(true);
    try {
      const next = await payload();
      const response = await apiFetch(`${MASTRA_SERVER_URL}/work/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ server: next.server }),
      });
      const result = (await response.json()) as { error?: string };
      if (!response.ok)
        throw new Error(result.error || (isEditing ? t("mcp:updateFailed") : t("mcp:saveFailed")));
      toast.success(isEditing ? t("mcp:updateSuccess") : t("mcp:createSuccess"));
      onOpenChange(false);
      onSaved();
    } catch (error) {
      toastError(error, isEditing ? t("mcp:updateFailed") : t("mcp:saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
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
                <TextField
                  id="mcp-url"
                  label={t("mcp:urlLabel")}
                  value={form.url ?? ""}
                  onChange={(value) => update({ url: value })}
                  placeholder={t("mcp:urlPlaceholder")}
                  required
                />
                <Collapsible defaultOpen={false} className="rounded-lg border bg-muted/20">
                  <CollapsibleTrigger className="group flex w-full items-center justify-between px-3.5 py-2.5 text-left text-xs font-medium">
                    {t("mcp:advancedHttpTitle")}
                    <ChevronDownIcon className="size-3.5 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
                  </CollapsibleTrigger>
                  <CollapsibleContent className="grid gap-3 px-3.5 pt-1 pb-3.5">
                    <TextAreaField
                      label={t("mcp:headersLabel")}
                      value={headersText}
                      onChange={setHeadersText}
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
                      onChange={setAllowedHostsText}
                      placeholder={t("mcp:allowedHostsPlaceholder")}
                      hint={t("mcp:allowedHostsHint")}
                    />
                    <CheckField
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
                          onChange={setOauthClientSecret}
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
                      value={argsText}
                      onChange={setArgsText}
                      placeholder={"-y\n@modelcontextprotocol/server-filesystem\nC:\\Projects"}
                      hint={t("mcp:argsHint")}
                    />
                    <TextAreaField
                      label={t("mcp:envLabel")}
                      value={envText}
                      onChange={setEnvText}
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
            <DialogClose
              render={
                <Button size="sm" disabled={testing || saving} variant="ghost">
                  {t("common:cancel")}
                </Button>
              }
            />
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
  type = "text",
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  required?: boolean;
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
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  hint?: string;
}) {
  const fieldId = React.useId();
  return (
    <Field className="px-0.5">
      <FieldLabel htmlFor={fieldId}>{label}</FieldLabel>
      <Textarea
        id={fieldId}
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
  onCheckedChange,
}: {
  id: string;
  title: string;
  description?: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <Field orientation="horizontal" className="gap-3 px-0.5">
      <Checkbox
        id={id}
        checked={checked}
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
