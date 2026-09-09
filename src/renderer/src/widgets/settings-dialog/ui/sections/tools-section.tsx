import { ExternalLinkIcon, EyeIcon, EyeOffIcon } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import {
  isSearchEngineReady,
  SEARCH_ENGINE_META,
  type SearchEngine,
  type ToolsConfig,
  useWorkbench,
} from "@/entities/workbench";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { fetchSettingsTools, saveSettingsTools } from "../../api/settings-api";
import { SettingCard } from "../controls";

// ---------------------------------------------------------------------------
// 工具:联网检索引擎的 API Key(写入数据库 app_config 表,key = "tools")。
// 引擎与搜索强度由输入区的联网检索菜单逐次选择,服务端据此注入对应工具;
// 工具在每次请求时按当前配置实例化,保存后立即生效、无需重启服务。
// ---------------------------------------------------------------------------

const DEFAULT_TOOLS_CONFIG: ToolsConfig = {
  tavily: { apiKey: "" },
  firecrawl: { apiKey: "", apiUrl: "" },
  anysearch: { apiKey: "" },
};

type KeyedSearchEngine = Exclude<SearchEngine, "provider">;

const KEYED_ENGINES: KeyedSearchEngine[] = ["tavily", "firecrawl", "anysearch"];

const ENGINE_DOCS_URL: Record<KeyedSearchEngine, string> = {
  tavily: "https://app.tavily.com/home",
  firecrawl: "https://www.firecrawl.dev/app/api-keys",
  anysearch: "https://www.anysearch.com/docs",
};

const API_KEY_PLACEHOLDER: Record<KeyedSearchEngine, string> = {
  tavily: "tvly-...",
  firecrawl: "fc-...",
  anysearch: "as-...(留空走匿名额度)",
};

/** 密钥输入行:输入框独占一行,右侧眼睛按钮切换明文(各引擎独立,互不影响) */
function SecretKeyInput({
  engine,
  value,
  onChange,
  show,
  onToggle,
}: {
  engine: KeyedSearchEngine;
  value: string;
  onChange: (value: string) => void;
  show: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <Input
        autoComplete="off"
        className="font-mono text-xs"
        onChange={(e) => onChange(e.target.value)}
        placeholder={API_KEY_PLACEHOLDER[engine]}
        spellCheck={false}
        type={show ? "text" : "password"}
        value={value}
      />
      <Button
        aria-label={show ? "隐藏密钥" : "显示密钥"}
        onClick={onToggle}
        size="icon-sm"
        variant="ghost"
      >
        {show ? <EyeIcon /> : <EyeOffIcon />}
      </Button>
    </div>
  );
}

export function ToolsSection() {
  const { refreshToolsConfig } = useWorkbench();
  const [draft, setDraft] = React.useState<ToolsConfig>(DEFAULT_TOOLS_CONFIG);
  const [loaded, setLoaded] = React.useState(false);
  // 各引擎独立的明文开关
  const [showKeys, setShowKeys] = React.useState<Record<KeyedSearchEngine, boolean>>({
    tavily: false,
    firecrawl: false,
    anysearch: false,
  });

  React.useEffect(() => {
    if (loaded) return;
    fetchSettingsTools()
      .then((config) => setDraft(config))
      .catch(() => undefined)
      .finally(() => setLoaded(true));
  }, [loaded]);

  // 自动保存:任何修改 800ms 无后续变化后静默写入,并刷新工作台配置
  // (输入区的联网检索菜单据此解锁对应引擎)。
  React.useEffect(() => {
    if (!loaded) return;
    const timer = window.setTimeout(() => {
      void saveSettingsTools(draft)
        .then(() => refreshToolsConfig())
        .catch(() => toast.error("工具配置自动保存失败,请确认 Mastra 服务已启动"));
    }, 800);
    return () => window.clearTimeout(timer);
  }, [draft, loaded, refreshToolsConfig]);

  const setApiKey = (engine: KeyedSearchEngine, apiKey: string) => {
    setDraft((prev) => {
      if (engine === "tavily") return { ...prev, tavily: { apiKey } };
      if (engine === "firecrawl") return { ...prev, firecrawl: { ...prev.firecrawl, apiKey } };
      return { ...prev, anysearch: { apiKey } };
    });
  };

  const toggleShow = (engine: KeyedSearchEngine) =>
    setShowKeys((prev) => ({ ...prev, [engine]: !prev[engine] }));

  return (
    <>
      {KEYED_ENGINES.map((engine) => {
        const meta = SEARCH_ENGINE_META[engine];
        const ready = isSearchEngineReady(engine, loaded ? draft : null);
        return (
          <SettingCard
            action={
              <>
                {ready ? (
                  <Badge className="text-[10px]" variant="secondary">
                    可用
                  </Badge>
                ) : (
                  <Badge className="text-[10px] text-muted-foreground" variant="outline">
                    未配置
                  </Badge>
                )}
                <a
                  className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                  href={ENGINE_DOCS_URL[engine]}
                  rel="noreferrer"
                  target="_blank"
                >
                  获取 Key
                  <ExternalLinkIcon className="size-3" />
                </a>
              </>
            }
            key={engine}
            description={meta.description}
            title={meta.label}
          >
            <div className="space-y-2 py-3">
              <SecretKeyInput
                engine={engine}
                show={showKeys[engine]}
                onChange={(apiKey) => setApiKey(engine, apiKey)}
                onToggle={() => toggleShow(engine)}
                value={draft[engine].apiKey}
              />
              {engine === "firecrawl" ? (
                <Input
                  className="font-mono text-xs"
                  onChange={(e) =>
                    setDraft((prev) => ({
                      ...prev,
                      firecrawl: { ...prev.firecrawl, apiUrl: e.target.value },
                    }))
                  }
                  placeholder="https://firecrawl.your-domain.com(仅自托管实例需要)"
                  spellCheck={false}
                  value={draft.firecrawl.apiUrl}
                />
              ) : null}
            </div>
          </SettingCard>
        );
      })}
    </>
  );
}
