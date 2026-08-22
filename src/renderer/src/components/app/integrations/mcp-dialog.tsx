import {
  ChevronDownIcon,
  Globe2Icon,
  LoaderCircleIcon,
  PlugZapIcon,
  SquareTerminalIcon,
  TestTube2Icon,
} from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { toastError } from "@/lib/errors";
import { MASTRA_SERVER_URL } from "@/lib/providers";

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
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
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

export function McpDialog({ open, onOpenChange, onSaved }: Props) {
  const [form, setForm] = React.useState<McpFormServer>(initial);
  const [headersText, setHeadersText] = React.useState("");
  const [envText, setEnvText] = React.useState("");
  const [allowedHostsText, setAllowedHostsText] = React.useState("");
  const [argsText, setArgsText] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [testing, setTesting] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    setForm(initial());
    setHeadersText("");
    setEnvText("");
    setAllowedHostsText("");
    setArgsText("");
  }, [open]);

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
    if (!form.name.trim()) {
      toast.error("请输入连接名称");
      return false;
    }
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
      const response = await fetch(`${MASTRA_SERVER_URL}/work/mcp/test`, {
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
      const response = await fetch(`${MASTRA_SERVER_URL}/work/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ server: payload() }),
      });
      const result = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(result.error || "保存 MCP 失败");
      toast.success("MCP 能力已添加");
      onOpenChange(false);
      onSaved();
    } catch (error) {
      toastError(error, "保存 MCP 失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(46rem,calc(100dvh-2rem))] max-h-[calc(100dvh-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl">
        <DialogHeader className="shrink-0 border-b bg-background px-6 py-5 pr-14">
          <div className="flex items-start gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <PlugZapIcon className="size-4" />
            </span>
            <div className="min-w-0">
              <DialogTitle className="text-lg">添加 MCP 外部能力</DialogTitle>
              <DialogDescription className="mt-1 leading-5">
                连接远程 MCP 服务或本地 stdio 服务。密钥只保存在本地服务端。
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>
        <ScrollArea className="min-h-0 flex-1">
          <div className="grid gap-6 px-6 py-6">
            <section className="grid gap-4">
              <div>
                <h3 className="text-sm font-medium">基本信息</h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  给这个连接一个容易识别的名称，唯一 ID 会自动生成。
                </p>
              </div>
              <div className="grid gap-4">
                <TextField
                  id="mcp-name"
                  label="连接名称"
                  value={form.name}
                  onChange={(value) => update({ name: value })}
                  placeholder="例如 GitHub"
                  required
                />
              </div>
            </section>

            <section className="grid gap-3">
              <div>
                <h3 className="text-sm font-medium">传输方式</h3>
                <p className="mt-1 text-xs text-muted-foreground">选择服务的连接协议。</p>
              </div>
              <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="传输方式">
                <Button
                  aria-pressed={form.transport === "http"}
                  className="h-10 justify-start"
                  type="button"
                  variant={form.transport === "http" ? "default" : "outline"}
                  onClick={() => update({ transport: "http" })}
                >
                  <Globe2Icon className="size-4" />
                  Streamable HTTP / SSE
                </Button>
                <Button
                  aria-pressed={form.transport === "stdio"}
                  className="h-10 justify-start"
                  type="button"
                  variant={form.transport === "stdio" ? "default" : "outline"}
                  onClick={() => update({ transport: "stdio" })}
                >
                  <SquareTerminalIcon className="size-4" />
                  本地命令 / stdio
                </Button>
              </div>
            </section>

            {form.transport === "http" ? (
              <section className="grid gap-4">
                <TextField
                  id="mcp-url"
                  label="MCP URL"
                  value={form.url ?? ""}
                  onChange={(value) => update({ url: value })}
                  placeholder="https://example.com/mcp"
                  required
                />
                <Collapsible defaultOpen={false} className="rounded-lg border bg-muted/20 px-4">
                  <CollapsibleTrigger className="group flex w-full items-center justify-between py-3 text-left text-sm font-medium">
                    高级连接选项
                    <ChevronDownIcon className="size-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
                  </CollapsibleTrigger>
                  <CollapsibleContent className="grid gap-4 pb-4">
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
                  </CollapsibleContent>
                </Collapsible>
              </section>
            ) : (
              <section className="grid gap-4">
                <TextField
                  id="mcp-command"
                  label="启动命令"
                  value={form.command ?? ""}
                  onChange={(value) => update({ command: value })}
                  placeholder="npx"
                  required
                />
                <Collapsible defaultOpen={false} className="rounded-lg border bg-muted/20 px-4">
                  <CollapsibleTrigger className="group flex w-full items-center justify-between py-3 text-left text-sm font-medium">
                    高级命令选项
                    <ChevronDownIcon className="size-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
                  </CollapsibleTrigger>
                  <CollapsibleContent className="grid gap-4 pb-4">
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
                      checked={form.inheritDefaultEnv ?? true}
                      onCheckedChange={(checked) => update({ inheritDefaultEnv: checked })}
                    >
                      继承 MCP SDK 默认环境变量
                    </CheckField>
                  </CollapsibleContent>
                </Collapsible>
              </section>
            )}

            <section className="grid gap-3 rounded-lg border bg-muted/20 p-4">
              <CheckField
                id="mcp-enabled"
                checked={form.enabled}
                onCheckedChange={(checked) => update({ enabled: checked })}
              >
                <span className="font-medium">保存后启用</span>
              </CheckField>
              <CheckField
                id="mcp-approval"
                checked={form.requireToolApproval ?? true}
                onCheckedChange={(checked) => update({ requireToolApproval: checked })}
              >
                <span className="font-medium">调用工具前要求批准</span>
                <span className="text-xs text-muted-foreground">推荐开启，避免工具被意外调用。</span>
              </CheckField>
            </section>
          </div>
        </ScrollArea>
        <DialogFooter className="mx-0 mb-0 shrink-0 rounded-none border-0 border-t bg-background px-6 py-4 sm:flex-row sm:items-center sm:justify-between">
          <Button disabled={testing || saving} onClick={() => void test()} variant="outline">
            <TestTube2Icon />
            {testing ? "测试中…" : "测试连接"}
          </Button>
          <div className="flex items-center gap-2">
            <Button disabled={testing || saving} onClick={() => onOpenChange(false)} variant="ghost">
              取消
            </Button>
            <Button disabled={saving || testing || !form.name.trim()} onClick={() => void save()}>
              {saving ? <LoaderCircleIcon className="animate-spin" /> : null}
              {saving ? "保存中…" : "保存 MCP"}
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
    <label className="grid gap-1.5 text-sm" htmlFor={id}>
      <span className="font-medium">
        {label}
        {required ? <span className="ml-1 text-destructive">*</span> : null}
      </span>
      <Input
        id={id}
        autoComplete="off"
        required={required}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
      />
    </label>
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
    <label className="grid gap-1.5 text-sm" htmlFor={fieldId}>
      <span className="font-medium">{label}</span>
      <Textarea
        id={fieldId}
        className="min-h-20 resize-y font-mono text-xs"
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        value={value}
        spellCheck={false}
      />
      {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
    </label>
  );
}

function CheckField({
  id,
  checked,
  onCheckedChange,
  children,
}: {
  id: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-3">
      <Checkbox
        id={id}
        checked={checked}
        onCheckedChange={(value) => onCheckedChange(value === true)}
      />
      <label className="grid cursor-pointer gap-0.5 text-sm leading-5" htmlFor={id}>
        {children}
      </label>
    </div>
  );
}
