import { LoaderCircleIcon, PlugZapIcon, TestTube2Icon } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
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
    id: form.id.trim(),
    name: form.name.trim() || form.id.trim(),
    headers: parseKeyValue(headersText),
    env: parseKeyValue(envText),
    args: parseLines(argsText),
    allowedHosts:
      parseLines(allowedHostsText).length > 0 ? parseLines(allowedHostsText) : undefined,
  });

  const test = async () => {
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
      <DialogContent className="max-h-[min(90vh,46rem)] max-w-2xl overflow-hidden p-0">
        <DialogHeader className="border-b px-5 py-4">
          <DialogTitle className="flex items-center gap-2">
            <PlugZapIcon className="size-4 text-primary" />
            添加 MCP 外部能力
          </DialogTitle>
          <DialogDescription>
            连接远程 MCP 服务或本地 stdio 服务。密钥只保存在本地服务端。
          </DialogDescription>
        </DialogHeader>
        <ScrollArea className="min-h-0 flex-1">
          <div className="grid gap-4 px-5 py-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="grid gap-1.5 text-sm" htmlFor="mcp-name">
                <span className="text-xs font-medium">显示名称</span>
                <Input
                  id="mcp-name"
                  value={form.name}
                  onChange={(event) => update({ name: event.target.value })}
                  placeholder="例如 GitHub"
                />
              </label>
              <label className="grid gap-1.5 text-sm" htmlFor="mcp-id">
                <span className="text-xs font-medium">唯一 ID</span>
                <Input
                  id="mcp-id"
                  value={form.id}
                  onChange={(event) => update({ id: event.target.value })}
                  placeholder="github"
                />
              </label>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <Button
                type="button"
                variant={form.transport === "http" ? "default" : "outline"}
                onClick={() => update({ transport: "http" })}
              >
                Streamable HTTP / SSE
              </Button>
              <Button
                type="button"
                variant={form.transport === "stdio" ? "default" : "outline"}
                onClick={() => update({ transport: "stdio" })}
              >
                本地命令 / stdio
              </Button>
            </div>
            {form.transport === "http" ? (
              <>
                <label className="grid gap-1.5 text-sm" htmlFor="mcp-url">
                  <span className="text-xs font-medium">MCP URL</span>
                  <Input
                    id="mcp-url"
                    value={form.url}
                    onChange={(event) => update({ url: event.target.value })}
                    placeholder="https://example.com/mcp"
                  />
                </label>
                <Field
                  label="请求 Headers（每行 KEY=VALUE）"
                  value={headersText}
                  onChange={setHeadersText}
                  placeholder="Authorization=Bearer ..."
                  secret
                />
                <Field
                  label="允许访问的 Host（每行一个，可留空）"
                  value={allowedHostsText}
                  onChange={setAllowedHostsText}
                  placeholder="api.example.com"
                />
              </>
            ) : (
              <>
                <label className="grid gap-1.5 text-sm" htmlFor="mcp-command">
                  <span className="text-xs font-medium">启动命令</span>
                  <Input
                    id="mcp-command"
                    value={form.command}
                    onChange={(event) => update({ command: event.target.value })}
                    placeholder="npx"
                  />
                </label>
                <Field
                  label="命令参数（每行一个）"
                  value={argsText}
                  onChange={setArgsText}
                  placeholder="-y\n@modelcontextprotocol/server-filesystem\nC:\\Projects"
                />
                <Field
                  label="环境变量（每行 KEY=VALUE）"
                  value={envText}
                  onChange={setEnvText}
                  placeholder="API_KEY=..."
                  secret
                />
                <label className="flex items-center gap-2 text-sm">
                  <input
                    checked={form.inheritDefaultEnv}
                    onChange={(event) => update({ inheritDefaultEnv: event.target.checked })}
                    type="checkbox"
                  />
                  继承 MCP SDK 默认环境变量
                </label>
              </>
            )}
            <div className="grid gap-2 rounded-lg border bg-muted/20 p-3 text-sm">
              <label className="flex items-center gap-2">
                <input
                  checked={form.enabled}
                  onChange={(event) => update({ enabled: event.target.checked })}
                  type="checkbox"
                />
                保存后启用
              </label>
              <label className="flex items-center gap-2">
                <input
                  checked={form.requireToolApproval}
                  onChange={(event) => update({ requireToolApproval: event.target.checked })}
                  type="checkbox"
                />
                调用此 MCP 的工具前要求批准（推荐）
              </label>
            </div>
          </div>
        </ScrollArea>
        <DialogFooter className="flex-row justify-end">
          <Button disabled={testing || saving} onClick={() => void test()} variant="outline">
            <TestTube2Icon />
            {testing ? "测试中…" : "测试连接"}
          </Button>
          <Button disabled={saving || testing} onClick={() => void save()}>
            {saving ? <LoaderCircleIcon className="animate-spin" /> : null}
            {saving ? "保存中…" : "保存 MCP"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  secret = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  secret?: boolean;
}) {
  const fieldId = React.useId();
  return (
    <label className="grid gap-1.5 text-sm" htmlFor={fieldId}>
      <span className="text-xs font-medium">{label}</span>
      <Textarea
        id={fieldId}
        className="min-h-20 font-mono text-xs"
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        value={value}
        {...(secret ? { spellCheck: false } : {})}
      />
    </label>
  );
}
