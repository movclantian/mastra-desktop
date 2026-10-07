import { useQueryClient } from "@tanstack/react-query";
import { ExternalLinkIcon, EyeIcon, EyeOffIcon } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { getMcpServer, type McpFormServer } from "@/entities/skill";
import {
  isSearchEngineReady,
  qk,
  type SearchEngine,
  type ToolsConfig,
  useToolsConfigQuery,
} from "@/entities/workbench";
import { useTranslation } from "@/shared/i18n";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { Field, FieldLabel } from "@/shared/ui/field";
import { Input } from "@/shared/ui/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/shared/ui/input-group";
import { McpDialog } from "@/widgets/mcp-dialog";
import { saveSettingsTools } from "../../api/settings-api";
import { SettingCard } from "../controls";

// ---------------------------------------------------------------------------
// 工具:直接 API 检索引擎的密钥；AnySearch 在统一 MCP 连接中管理。
// 引擎与搜索强度由输入区的联网检索菜单逐次选择,服务端据此注入对应工具;
// 工具在每次请求时按当前配置实例化,保存后立即生效、无需重启服务。
// ---------------------------------------------------------------------------

const DEFAULT_TOOLS_CONFIG: ToolsConfig = {
  tavily: { hasCredential: false },
  firecrawl: { hasCredential: false, apiUrl: "" },
  anysearch: { enabled: false },
};

type KeyedSearchEngine = Exclude<SearchEngine, "anysearch">;

const KEYED_ENGINES: KeyedSearchEngine[] = ["tavily", "firecrawl"];

const ENGINE_DOCS_URL: Record<KeyedSearchEngine, string> = {
  tavily: "https://app.tavily.com/home",
  firecrawl: "https://www.firecrawl.dev/app/api-keys",
};

const API_KEY_PLACEHOLDER: Record<KeyedSearchEngine, string> = {
  tavily: "tvly-...",
  firecrawl: "fc-...",
};

/** 密钥输入行:基于 InputGroup 的复合密码框,内置显隐切换按钮 */
function SecretKeyInput({
  engine,
  value,
  onChange,
  show,
  onToggle,
  configuredHint,
}: {
  engine: KeyedSearchEngine;
  value: string;
  onChange: (value: string) => void;
  show: boolean;
  onToggle: () => void;
  configuredHint?: string;
}) {
  const { t } = useTranslation();
  return (
    <InputGroup>
      <InputGroupInput
        autoComplete="off"
        className="font-mono text-xs"
        onChange={(e) => onChange(e.target.value)}
        placeholder={
          configuredHint
            ? t("settings:tools.credentialConfigured", { hint: configuredHint })
            : API_KEY_PLACEHOLDER[engine]
        }
        spellCheck={false}
        type={show ? "text" : "password"}
        value={value}
      />
      <InputGroupAddon align="inline-end">
        <InputGroupButton
          aria-label={show ? t("settings:tools.hideKey") : t("settings:tools.showKey")}
          onClick={onToggle}
          size="icon-xs"
          variant="ghost"
        >
          {show ? <EyeIcon /> : <EyeOffIcon />}
        </InputGroupButton>
      </InputGroupAddon>
    </InputGroup>
  );
}

export function ToolsSection() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const toolsQuery = useToolsConfigQuery();
  const [mcpServer, setMcpServer] = React.useState<McpFormServer | null>(null);
  const [draft, setDraft] = React.useState<ToolsConfig>(DEFAULT_TOOLS_CONFIG);
  const [keyDraft, setKeyDraft] = React.useState<Record<KeyedSearchEngine, string>>({
    tavily: "",
    firecrawl: "",
  });
  const [loaded, setLoaded] = React.useState(false);
  const [dirty, setDirty] = React.useState(false);
  const editVersion = React.useRef(0);
  // 各引擎独立的明文开关
  const [showKeys, setShowKeys] = React.useState<Record<KeyedSearchEngine, boolean>>({
    tavily: false,
    firecrawl: false,
  });

  React.useEffect(() => {
    if (loaded) return;
    if (toolsQuery.data) setDraft(toolsQuery.data);
    setLoaded(!toolsQuery.isPending);
  }, [loaded, toolsQuery.data, toolsQuery.isPending]);

  // 自动保存:任何修改 800ms 无后续变化后静默写入,并刷新工作台配置
  // (输入区的联网检索菜单据此解锁对应引擎)。
  React.useEffect(() => {
    if (!loaded || !dirty) return;
    const version = editVersion.current;
    const timer = window.setTimeout(() => {
      void saveSettingsTools(draft, keyDraft)
        .then((saved) => {
          if (editVersion.current !== version) return;
          setDraft(saved);
          setKeyDraft({ tavily: "", firecrawl: "" });
          setDirty(false);
          queryClient.setQueryData(qk.toolsConfig(), saved);
        })
        .catch(() => toast.error(t("settings:tools.saveFailed")));
    }, 800);
    return () => window.clearTimeout(timer);
  }, [dirty, draft, keyDraft, loaded, queryClient, t]);

  const setApiKey = (engine: KeyedSearchEngine, apiKey: string) => {
    editVersion.current += 1;
    setKeyDraft((prev) => ({ ...prev, [engine]: apiKey }));
    setDirty(true);
  };

  const toggleShow = (engine: KeyedSearchEngine) =>
    setShowKeys((prev) => ({ ...prev, [engine]: !prev[engine] }));

  return (
    <>
      {KEYED_ENGINES.map((engine) => {
        const ready =
          Boolean(keyDraft[engine].trim()) || isSearchEngineReady(engine, loaded ? draft : null);
        return (
          <SettingCard
            action={
              <>
                {ready ? (
                  <Badge className="text-[10px]" variant="secondary">
                    {t("settings:tools.available")}
                  </Badge>
                ) : (
                  <Badge className="text-[10px] text-muted-foreground" variant="outline">
                    {t("settings:tools.unconfigured")}
                  </Badge>
                )}
                <a
                  className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                  href={ENGINE_DOCS_URL[engine]}
                  rel="noreferrer"
                  target="_blank"
                >
                  {t("settings:tools.getKey")}
                  <ExternalLinkIcon className="size-3" />
                </a>
              </>
            }
            key={engine}
            description={t(`chat:search.engines.${engine}.desc`)}
            title={t(`chat:search.engines.${engine}.label`)}
          >
            <div className="space-y-2 py-3">
              <SecretKeyInput
                engine={engine}
                show={showKeys[engine]}
                onChange={(apiKey) => setApiKey(engine, apiKey)}
                onToggle={() => toggleShow(engine)}
                value={keyDraft[engine]}
                configuredHint={
                  draft[engine].hasCredential ? draft[engine].credentialHint : undefined
                }
              />
              {engine === "firecrawl" ? (
                <Field className="pt-1">
                  <FieldLabel
                    htmlFor="firecrawl-api-url"
                    className="text-xs text-muted-foreground font-normal"
                  >
                    {t("settings:tools.selfHostedApiUrl")}
                  </FieldLabel>
                  <Input
                    id="firecrawl-api-url"
                    className="font-mono text-xs"
                    onChange={(e) => {
                      editVersion.current += 1;
                      setDirty(true);
                      setDraft((prev) => ({
                        ...prev,
                        firecrawl: { ...prev.firecrawl, apiUrl: e.target.value },
                      }));
                    }}
                    placeholder={t("settings:tools.serviceAddressPlaceholder")}
                    spellCheck={false}
                    value={draft.firecrawl.apiUrl}
                  />
                </Field>
              ) : null}
            </div>
          </SettingCard>
        );
      })}
      <SettingCard
        title="AnySearch"
        description={t("mcp:anysearchManaged")}
        action={
          <Badge variant={toolsQuery.data?.anysearch.enabled ? "secondary" : "outline"}>
            {toolsQuery.data?.anysearch.enabled ? t("settings:tools.available") : t("mcp:disabled")}
          </Badge>
        }
      >
        <div className="flex min-w-0 flex-wrap items-center gap-2 py-2">
          <Button
            variant="outline"
            size="sm"
            disabled={!toolsQuery.data?.anysearch.connectionId}
            onClick={() => {
              const id = toolsQuery.data?.anysearch.connectionId;
              if (id)
                void getMcpServer(id)
                  .then(setMcpServer)
                  .catch(() => toast.error(t("settings:tools.saveFailed")));
            }}
          >
            {t("mcp:manageConnection")}
          </Button>
        </div>
      </SettingCard>
      <McpDialog
        open={Boolean(mcpServer)}
        server={mcpServer}
        onOpenChange={(open) => {
          if (!open) setMcpServer(null);
        }}
        onSaved={() => {
          void queryClient.invalidateQueries({ queryKey: qk.toolsConfig() });
        }}
      />
    </>
  );
}
