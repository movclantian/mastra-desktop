import {
  ChevronDownIcon,
  Globe2Icon,
  PlugZapIcon,
  SquareTerminalIcon,
  TestTube2Icon,
} from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { getMcpServer, type McpSummary } from "@/entities/skill";
import { apiFetch, MASTRA_SERVER_URL } from "@/shared/api";
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

export interface McpFormServer {
  id: string;
  name: string;
  enabled: boolean;
  transport: "http" | "stdio";
  url?: string;
  headers?: Record<string, string>;
  allowedHosts?: string[];
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  inheritDefaultEnv?: boolean;
  requireToolApproval?: boolean;
  oauth?: {
    enabled: boolean;
    redirectUrl?: string;
    clientName?: string;
    clientId?: string;
    clientSecret?: string;
    scopes?: string[];
  };
}

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
  headers: {},
  allowedHosts: [],
  command: "",
  args: [],
  env: {},
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
  const [form, setForm] = React.useState<McpFormServer>(initial);
  const [headersText, setHeadersText] = React.useState("");
  const [envText, setEnvText] = React.useState("");
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
      setAllowedHostsText("");
      setArgsText("");
      return;
    }

    const initialTransport =
      server.transport || (server as { type?: string }).type === "stdio" ? "stdio" : "http";
    const initialForm: McpFormServer = {
      id: server.id || "",
      name: server.name || "",
      enabled: server.enabled ?? true,
      transport: initialTransport,
      url: server.url ?? "",
      headers: (server as McpFormServer).headers ?? {},
      allowedHosts: (server as { allowedHosts?: string[] }).allowedHosts ?? [],
      command: server.command ?? "",
      args: server.args ?? [],
      env: (server as McpFormServer).env ?? {},
      inheritDefaultEnv: (server as { inheritDefaultEnv?: boolean }).inheritDefaultEnv ?? true,
      requireToolApproval:
        (server as { requireToolApproval?: boolean }).requireToolApproval ?? true,
      oauth: server.oauth ?? { enabled: false },
    };
    setForm(initialForm);
    setArgsText(server.args?.join("\n") ?? "");
    setAllowedHostsText((server as { allowedHosts?: string[] }).allowedHosts?.join("\n") ?? "");

    const headersObj = (server as McpFormServer).headers;
    if (headersObj && typeof headersObj === "object") {
      setHeadersText(
        Object.entries(headersObj)
          .map(([k, v]) => `${k}=${v}`)
          .join("\n"),
      );
    } else {
      setHeadersText("");
    }
    const envObj = (server as McpFormServer).env;
    if (envObj && typeof envObj === "object") {
      setEnvText(
        Object.entries(envObj)
          .map(([k, v]) => `${k}=${v}`)
          .join("\n"),
      );
    } else {
      setEnvText("");
    }

    if (server.id) {
      getMcpServer(server.id)
        .then((full) => {
          setForm({
            id: full.id,
            name: full.name,
            enabled: full.enabled ?? true,
            transport:
              full.transport || ((full as { type?: string }).type === "stdio" ? "stdio" : "http"),
            url: full.url ?? "",
            headers: full.headers ?? {},
            allowedHosts: (full as { allowedHosts?: string[] }).allowedHosts ?? [],
            command: full.command ?? "",
            args: full.args ?? [],
            env: full.env ?? {},
            inheritDefaultEnv: (full as { inheritDefaultEnv?: boolean }).inheritDefaultEnv ?? true,
            requireToolApproval:
              (full as { requireToolApproval?: boolean }).requireToolApproval ?? true,
            oauth: full.oauth ?? { enabled: false },
          });
          setArgsText(full.args?.join("\n") ?? "");
          setAllowedHostsText((full as { allowedHosts?: string[] }).allowedHosts?.join("\n") ?? "");
          if (full.headers) {
            setHeadersText(
              Object.entries(full.headers)
                .map(([k, v]) => `${k}=${v}`)
                .join("\n"),
            );
          }
          if (full.env) {
            setEnvText(
              Object.entries(full.env)
                .map(([k, v]) => `${k}=${v}`)
                .join("\n"),
            );
          }
        })
        .catch(() => {
          // Keep existing values
        });
    }
  }, [open, server]);

  const update = (patch: Partial<McpFormServer>) =>
    setForm((current) => ({ ...current, ...patch }));

  const payload = () => ({
    ...form,
    id: form.id.trim() || generatedServerId(form),
    name: form.name.trim() || generatedServerId(form),
    headers: parseKeyValue(headersText),
    env: parseKeyValue(envText),
    args: parseLines(argsText),
    allowedHosts:
      parseLines(allowedHostsText).length > 0 ? parseLines(allowedHostsText) : undefined,
  });

  const validate = () => {
    if (form.transport === "http" && !form.url?.trim()) {
      toast.error("请输入 MCP URL");
      return false;
    }
    if (form.transport === "stdio" && !form.command?.trim()) {
      toast.error("请输入启动命令");
      return false;
    }
    return true;
  };

  const test = async () => {
    if (!validate()) return;
    setTesting(true);
    try {
      const response = await apiFetch(`${MASTRA_SERVER_URL}/work/mcp/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ server: payload() }),
      });
      const result = (await response.json()) as {
        ok?: boolean;
        toolCount?: number;
        error?: string;
      };
      if (!response.ok || !result.ok) throw new Error(result.error || "MCP 连接失败");
      toast.success(`连接成功，发现 ${result.toolCount ?? 0} 个工具`);
    } catch (error) {
      toastError(error, "MCP 连接失败");
    } finally {
      setTesting(false);
    }
  };

  const save = async () => {
    if (!validate()) return;
    setSaving(true);
    try {
      const response = await apiFetch(`${MASTRA_SERVER_URL}/work/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ server: payload() }),
      });
      const result = (await response.json()) as { error?: string };
      if (!response.ok)
        throw new Error(result.error || (isEditing ? "更新 MCP 失败" : "保存 MCP 失败"));
      toast.success(isEditing ? "MCP 配置已更新" : "MCP 能力已添加");
      onOpenChange(false);
      onSaved();
    } catch (error) {
      toastError(error, isEditing ? "更新 MCP 失败" : "保存 MCP 失败");
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
                {isEditing ? "编辑 MCP 外部能力" : "添加 MCP 外部能力"}
              </DialogTitle>
              <DialogDescription className="mt-0.5 text-xs leading-normal">
                {isEditing
                  ? "修改 MCP 服务的连接协议、运行命令、参数与鉴权配置。"
                  : "连接远程 MCP 服务或本地 stdio 服务。密钥仅保存在本地服务端。"}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>
        <ScrollArea className="min-h-0 flex-1">
          <div className="grid gap-4 px-6 py-4 pb-6">
            <section className="grid gap-3">
              <div>
                <h3 className="text-xs font-semibold text-foreground/90 uppercase tracking-wider">
                  基本信息
                </h3>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  名称可以留空，保存时会根据地址或命令自动生成。
                </p>
              </div>
              <TextField
                id="mcp-name"
                label="连接名称"
                value={form.name}
                onChange={(value) => update({ name: value })}
                placeholder="可选，例如 GitHub / SQLite"
              />
            </section>

            <section className="grid gap-2.5">
              <div>
                <h3 className="text-xs font-semibold text-foreground/90 uppercase tracking-wider">
                  传输方式
                </h3>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  选择服务的连接协议与通信介质。
                </p>
              </div>
              <ToggleGroup
                aria-label="传输方式"
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
                  Streamable HTTP / SSE
                </ToggleGroupItem>
                <ToggleGroupItem className="h-9 justify-start text-xs font-medium" value="stdio">
                  <SquareTerminalIcon className="size-3.5" />
                  本地命令 / stdio
                </ToggleGroupItem>
              </ToggleGroup>
            </section>

            {form.transport === "http" ? (
              <section className="grid gap-3">
                <TextField
                  id="mcp-url"
                  label="MCP 服务端点 URL"
                  value={form.url ?? ""}
                  onChange={(value) => update({ url: value })}
                  placeholder="https://example.com/mcp"
                  required
                />
                <Collapsible defaultOpen={false} className="rounded-lg border bg-muted/20">
                  <CollapsibleTrigger className="group flex w-full items-center justify-between px-3.5 py-2.5 text-left text-xs font-medium">
                    高级连接选项（请求头 / Host 限制 / OAuth）
                    <ChevronDownIcon className="size-3.5 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
                  </CollapsibleTrigger>
                  <CollapsibleContent className="grid gap-3 px-3.5 pt-1 pb-3.5">
                    <TextAreaField
                      label="请求 Headers"
                      value={headersText}
                      onChange={setHeadersText}
                      placeholder="Authorization=Bearer …"
                      hint="每行一个 KEY=VALUE，可留空。"
                    />
                    <TextAreaField
                      label="允许访问的 Host"
                      value={allowedHostsText}
                      onChange={setAllowedHostsText}
                      placeholder="api.example.com"
                      hint="每行一个 Host，可留空。"
                    />
                    <CheckField
                      id="mcp-oauth"
                      title="使用 OAuth 授权"
                      description="需要登录时，保存后可从 MCP 服务卡片启动授权流程。"
                      checked={form.oauth?.enabled === true}
                      onCheckedChange={(checked) =>
                        update({ oauth: { ...(form.oauth ?? {}), enabled: checked } })
                      }
                    />
                  </CollapsibleContent>
                </Collapsible>
              </section>
            ) : (
              <section className="grid gap-3">
                <TextField
                  id="mcp-command"
                  label="启动命令"
                  value={form.command ?? ""}
                  onChange={(value) => update({ command: value })}
                  placeholder="npx"
                  required
                />
                <Collapsible defaultOpen={false} className="rounded-lg border bg-muted/20">
                  <CollapsibleTrigger className="group flex w-full items-center justify-between px-3.5 py-2.5 text-left text-xs font-medium">
                    高级命令选项（参数 / 环境变量）
                    <ChevronDownIcon className="size-3.5 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
                  </CollapsibleTrigger>
                  <CollapsibleContent className="grid gap-3 px-3.5 pt-1 pb-3.5">
                    <TextAreaField
                      label="命令参数"
                      value={argsText}
                      onChange={setArgsText}
                      placeholder={"-y\n@modelcontextprotocol/server-filesystem\nC:\\Projects"}
                      hint="每行一个参数，可留空。"
                    />
                    <TextAreaField
                      label="环境变量"
                      value={envText}
                      onChange={setEnvText}
                      placeholder="API_KEY=…"
                      hint="每行一个 KEY=VALUE，可留空。"
                    />
                    <CheckField
                      id="mcp-inherit-env"
                      title="继承 MCP SDK 默认环境变量"
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
                title="保存后立即启用"
                checked={form.enabled}
                onCheckedChange={(checked) => update({ enabled: checked })}
              />
              <CheckField
                id="mcp-approval"
                title="调用工具前要求批准"
                description="推荐开启，避免高危或自动化工具被静默调用。"
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
            {testing ? "测试中…" : "测试连接"}
          </Button>
          <div className="flex items-center gap-2">
            <DialogClose
              render={
                <Button size="sm" disabled={testing || saving} variant="ghost">
                  取消
                </Button>
              }
            />
            <Button size="sm" disabled={saving || testing} onClick={() => void save()}>
              {saving ? <Dotm3x3_1 size={14} dotSize={2.2} colorPreset="solid-theme" /> : null}
              {saving ? (isEditing ? "更新中…" : "保存中…") : isEditing ? "更新 MCP" : "保存 MCP"}
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
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  required?: boolean;
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
