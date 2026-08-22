import {
  ArrowLeftIcon,
  ArrowUpRightIcon,
  CheckIcon,
  ChevronRightIcon,
  FolderOpenIcon,
  LoaderCircleIcon,
  PencilIcon,
  PlugZapIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  Settings2Icon,
  SparklesIcon,
  StoreIcon,
  Trash2Icon,
  UploadIcon,
} from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { McpDialog, type McpFormServer } from "@/components/app/integrations";
import { MessageResponse } from "@/components/ai-elements/message";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { MagicCard } from "@/components/ui/magic-card";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { ShimmerButton } from "@/components/ui/shimmer-button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { apiError, toastError } from "@/lib/errors";
import { MASTRA_SERVER_URL } from "@/lib/providers";
import { useWorkbench } from "@/lib/workbench";

interface SkillMetadata {
  name: string;
  path: string;
  description: string;
  metadata?: Record<string, unknown>;
  origin?: "builtin" | "marketplace" | "skills-sh" | "installed";
  marketplaceId?: string;
  marketplaceName?: string;
  sourcePath?: string;
  branch?: string;
  skillsShSource?: string;
  skillsShSlug?: string;
  installs?: number;
  sourceUrl?: string;
}

interface SkillDetail extends SkillMetadata {
  instructions: string;
  references: string[];
  scripts: string[];
  assets: string[];
}

interface McpSummary extends Omit<McpFormServer, "headers" | "env"> {
  headerKeys: string[];
  envKeys: string[];
}

interface SkillMarketplace {
  id: string;
  name: string;
  url: string;
  branch: string;
  path?: string;
  enabled: boolean;
}

type Section = "public" | "personal" | "mcp";

const ICONS = ["📦", "📝", "🪟", "📄", "🤖", "📘", "⚡", "🛠️"];

function skillIcon(skill: SkillMetadata, index = 0) {
  const icon = skill.metadata?.icon;
  return typeof icon === "string" && icon.length > 0 ? icon : ICONS[index % ICONS.length];
}

function skillCategory(skill: SkillMetadata) {
  const category = skill.metadata?.category;
  return typeof category === "string" && category.trim() ? category : "开发者工具";
}

function skillSourceLabel(skill?: SkillMetadata) {
  if (skill?.origin === "builtin") return "Mastra 内置";
  if (skill?.origin === "skills-sh") return "skills.sh";
  return skill?.marketplaceName || "个人技能";
}

const SKILLS_REGISTRY_CACHE_KEY = "mastra_skills_registry_cache";
const SKILLS_INSTALLED_CACHE_KEY = "mastra_skills_installed_cache";
const SKILLS_MCP_CACHE_KEY = "mastra_skills_mcp_cache";
const SKILLS_MARKETPLACES_CACHE_KEY = "mastra_skills_marketplaces_cache";

let memRegistrySkills: SkillMetadata[] = [];
let memInstalledSkills: SkillMetadata[] = [];
let memMcpServers: McpSummary[] = [];
let memMarketplaces: SkillMarketplace[] = [];

function loadStorageCache<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function saveStorageCache(key: string, data: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(data));
  } catch {
    // 忽略 localStorage 容量限制异常
  }
}

export function SkillHub() {
  const { setPendingPrompt, setSkillOpen } = useWorkbench();
  const [section, setSection] = React.useState<Section>("public");
  const [query, setQuery] = React.useState("");

  // SWR 缓存:优先从内存与本地缓存加载,实现 0ms 瞬间打开,后台静默刷新
  const [skills, setSkills] = React.useState<SkillMetadata[]>(() => {
    if (memInstalledSkills.length > 0) return memInstalledSkills;
    const cached = loadStorageCache<SkillMetadata[]>(SKILLS_INSTALLED_CACHE_KEY, []);
    memInstalledSkills = cached;
    return cached;
  });
  const [registrySkills, setRegistrySkills] = React.useState<SkillMetadata[]>(() => {
    if (memRegistrySkills.length > 0) return memRegistrySkills;
    const cached = loadStorageCache<SkillMetadata[]>(SKILLS_REGISTRY_CACHE_KEY, []);
    memRegistrySkills = cached;
    return cached;
  });
  const [mcpServers, setMcpServers] = React.useState<McpSummary[]>(() => {
    if (memMcpServers.length > 0) return memMcpServers;
    const cached = loadStorageCache<McpSummary[]>(SKILLS_MCP_CACHE_KEY, []);
    memMcpServers = cached;
    return cached;
  });
  const [marketplaces, setMarketplaces] = React.useState<SkillMarketplace[]>(() => {
    if (memMarketplaces.length > 0) return memMarketplaces;
    const cached = loadStorageCache<SkillMarketplace[]>(SKILLS_MARKETPLACES_CACHE_KEY, []);
    memMarketplaces = cached;
    return cached;
  });

  const [selectedSkill, setSelectedSkill] = React.useState<SkillMetadata | null>(null);
  const [detail, setDetail] = React.useState<SkillDetail | null>(null);
  const [detailLoading, setDetailLoading] = React.useState(false);
  const [detailError, setDetailError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(
    () => memInstalledSkills.length === 0 && memMarketplaces.length === 0,
  );
  const [registryLoading, setRegistryLoading] = React.useState(
    () => memRegistrySkills.length === 0,
  );
  const [installing, setInstalling] = React.useState<string | null>(null);
  const [uploading, setUploading] = React.useState(false);
  const [addSkillOpen, setAddSkillOpen] = React.useState(false);
  const [mcpOpen, setMcpOpen] = React.useState(false);
  const [marketplacesOpen, setMarketplacesOpen] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const loadInstalled = React.useCallback(async () => {
    const response = await fetch(`${MASTRA_SERVER_URL}/work/skills`);
    const payload = (await response.json()) as { skills?: SkillMetadata[]; error?: string };
    if (!response.ok) throw apiError(payload, "读取已安装技能失败");
    const nextSkills = payload.skills ?? [];
    memInstalledSkills = nextSkills;
    saveStorageCache(SKILLS_INSTALLED_CACHE_KEY, nextSkills);
    setSkills(nextSkills);
  }, []);

  const loadRegistry = React.useCallback(async (search: string) => {
    if (memRegistrySkills.length === 0) setRegistryLoading(true);
    try {
      const response = await fetch(
        `${MASTRA_SERVER_URL}/work/skills/registry?query=${encodeURIComponent(search)}`,
      );
      const payload = (await response.json()) as {
        skills?: SkillMetadata[];
        error?: string;
        skillsShError?: string;
      };
      if (!response.ok) throw apiError(payload, "技能市场暂时不可用");
      const nextSkills = payload.skills ?? [];
      if (!search) {
        memRegistrySkills = nextSkills;
        saveStorageCache(SKILLS_REGISTRY_CACHE_KEY, nextSkills);
      }
      setRegistrySkills(nextSkills);
      if (payload.skillsShError) toast.error(`skills.sh 暂时不可用: ${payload.skillsShError}`);
    } catch (error) {
      if (memRegistrySkills.length === 0) setRegistrySkills([]);
      toastError(error, "技能市场暂时不可用");
    } finally {
      setRegistryLoading(false);
    }
  }, []);

  const loadMcp = React.useCallback(async () => {
    const response = await fetch(`${MASTRA_SERVER_URL}/work/mcp`);
    const payload = (await response.json()) as { servers?: McpSummary[]; error?: string };
    if (!response.ok) throw apiError(payload, "读取 MCP 失败");
    const nextMcp = payload.servers ?? [];
    memMcpServers = nextMcp;
    saveStorageCache(SKILLS_MCP_CACHE_KEY, nextMcp);
    setMcpServers(nextMcp);
  }, []);

  const loadMarketplaces = React.useCallback(async () => {
    const response = await fetch(`${MASTRA_SERVER_URL}/work/skills/marketplaces`);
    const payload = (await response.json()) as {
      marketplaces?: SkillMarketplace[];
      error?: string;
    };
    if (!response.ok) throw apiError(payload, "读取技能市场失败");
    const nextMarketplaces = payload.marketplaces ?? [];
    memMarketplaces = nextMarketplaces;
    saveStorageCache(SKILLS_MARKETPLACES_CACHE_KEY, nextMarketplaces);
    setMarketplaces(nextMarketplaces);
  }, []);

  const refresh = React.useCallback(async () => {
    setLoading(true);
    try {
      await Promise.all([loadInstalled(), loadMcp(), loadMarketplaces()]);
    } catch (error) {
      toastError(error, "读取技能套件失败");
    } finally {
      setLoading(false);
    }
  }, [loadInstalled, loadMarketplaces, loadMcp]);

  const refreshAll = React.useCallback(async () => {
    await Promise.all([refresh(), loadRegistry(query)]);
  }, [loadRegistry, query, refresh]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  React.useEffect(() => {
    if (section !== "public") return;
    const timer = window.setTimeout(() => void loadRegistry(query), 180);
    return () => window.clearTimeout(timer);
  }, [loadRegistry, query, section]);

  React.useEffect(() => {
    if (!selectedSkill) {
      setDetail(null);
      setDetailLoading(false);
      setDetailError(null);
      return;
    }
    let cancelled = false;
    setDetail(null);
    setDetailError(null);
    setDetailLoading(true);
    const detailRequest =
      selectedSkill.origin === "marketplace" &&
      selectedSkill.marketplaceId &&
      selectedSkill.sourcePath
        ? fetch(
            `${MASTRA_SERVER_URL}/work/skills/marketplaces/${encodeURIComponent(selectedSkill.marketplaceId)}/skill?path=${encodeURIComponent(selectedSkill.sourcePath)}`,
          )
        : selectedSkill.origin === "skills-sh" &&
            selectedSkill.skillsShSource &&
            selectedSkill.skillsShSlug
          ? fetch(
              `${MASTRA_SERVER_URL}/work/skills/skills-sh/skill?source=${encodeURIComponent(selectedSkill.skillsShSource)}&slug=${encodeURIComponent(selectedSkill.skillsShSlug)}`,
            )
          : selectedSkill.origin === "builtin"
          ? fetch(
              `${MASTRA_SERVER_URL}/work/skills/registry/${encodeURIComponent(selectedSkill.sourcePath || selectedSkill.name)}`,
            )
          : fetch(`${MASTRA_SERVER_URL}/work/skills/${encodeURIComponent(selectedSkill.name)}`);
    void detailRequest
      .then(async (response) => {
        const payload = (await response.json()) as { skill?: SkillDetail; error?: string };
        if (!response.ok || !payload.skill) {
          throw new Error(payload.error || "读取技能详情失败");
        }
        if (!cancelled) setDetail(payload.skill);
      })
      .catch((error) => {
        if (cancelled) return;
        setDetailError(error instanceof Error ? error.message : "读取技能详情失败");
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedSkill]);

  const visibleRegistry = React.useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return registrySkills.filter(
      (skill) =>
        !needle || `${skill.name} ${skill.description}`.toLocaleLowerCase().includes(needle),
    );
  }, [query, registrySkills]);
  const visibleInstalled = React.useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return skills.filter(
      (skill) =>
        !needle || `${skill.name} ${skill.description}`.toLocaleLowerCase().includes(needle),
    );
  }, [query, skills]);
  const groupedRegistry = React.useMemo(() => {
    const groups = new Map<string, { category: string; skills: SkillMetadata[] }>();
    for (const skill of visibleRegistry) {
      const category = skillCategory(skill);
      const key = `${skillSourceLabel(skill)}:${category}`;
      const current = groups.get(key);
      groups.set(key, { category, skills: [...(current?.skills ?? []), skill] });
    }
    return [...groups.values()];
  }, [visibleRegistry]);

  const uploadSkill = async (file: File | undefined) => {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".zip")) {
      toast.error("技能包必须是 ZIP 文件");
      return;
    }
    setUploading(true);
    try {
      const form = new FormData();
      form.set("archive", file, file.name);
      const response = await fetch(`${MASTRA_SERVER_URL}/work/skills`, {
        method: "POST",
        body: form,
      });
      const payload = (await response.json()) as { skill?: SkillMetadata; error?: string };
      if (!response.ok || !payload.skill) throw apiError(payload, "添加技能失败");
      await loadInstalled();
      setSection("personal");
      setSelectedSkill(payload.skill);
      setAddSkillOpen(false);
      toast.success(`技能「${payload.skill.name}」已添加`);
    } catch (error) {
      toastError(error, "添加技能失败");
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  const importSkill = async (source: string) => {
    setUploading(true);
    try {
      const response = await fetch(`${MASTRA_SERVER_URL}/work/skills/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source }),
      });
      const payload = (await response.json()) as { skill?: SkillMetadata; error?: string };
      if (!response.ok || !payload.skill) throw apiError(payload, "导入技能失败");
      await loadInstalled();
      setSection("personal");
      setSelectedSkill(payload.skill);
      setAddSkillOpen(false);
      toast.success(`技能「${payload.skill.name}」已导入`);
    } catch (error) {
      toastError(error, "导入技能失败");
    } finally {
      setUploading(false);
    }
  };

  const installBuiltin = async (skill: SkillMetadata) => {
    setInstalling(skill.name);
    try {
      const sourceName = skill.sourcePath || skill.path.split(/[\\/]/).at(-1) || skill.name;
      const response =
        skill.origin === "skills-sh" && skill.skillsShSource && skill.skillsShSlug
          ? await fetch(`${MASTRA_SERVER_URL}/work/skills/skills-sh/install`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ source: skill.skillsShSource, slug: skill.skillsShSlug }),
            })
          : skill.origin === "marketplace" && skill.marketplaceId
            ? await fetch(
                `${MASTRA_SERVER_URL}/work/skills/marketplaces/${encodeURIComponent(skill.marketplaceId)}/install`,
                {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify(skill),
                },
              )
            : await fetch(
                `${MASTRA_SERVER_URL}/work/skills/registry/${encodeURIComponent(sourceName)}/install`,
                { method: "POST" },
              );
      const payload = (await response.json()) as { skill?: SkillMetadata; error?: string };
      if (!response.ok || !payload.skill) throw apiError(payload, "安装技能失败");
      await loadInstalled();
      setSelectedSkill(payload.skill);
      setSection("personal");
      toast.success(`技能「${payload.skill.name}」已安装`);
    } catch (error) {
      toastError(error, "安装技能失败");
    } finally {
      setInstalling(null);
    }
  };

  const removeSkill = async () => {
    if (!selectedSkill || !window.confirm(`确定删除技能「${selectedSkill.name}」吗？`)) return;
    const response = await fetch(
      `${MASTRA_SERVER_URL}/work/skills/${encodeURIComponent(selectedSkill.name)}`,
      { method: "DELETE" },
    );
    if (!response.ok) {
      toast.error("删除技能失败");
      return;
    }
    setSelectedSkill(null);
    setDetail(null);
    await loadInstalled();
    toast.success("技能已删除");
  };

  const removeMcp = async (server: McpSummary) => {
    if (!window.confirm(`确定移除 MCP「${server.name}」吗？`)) return;
    const response = await fetch(`${MASTRA_SERVER_URL}/work/mcp/${encodeURIComponent(server.id)}`, {
      method: "DELETE",
    });
    if (!response.ok) {
      toast.error("移除 MCP 失败");
      return;
    }
    await loadMcp();
    toast.success("MCP 已移除");
  };

  if (selectedSkill) {
    return (
      <SkillDetailPage
        detail={detail}
        detailError={detailError}
        detailLoading={detailLoading}
        installed={skills.some((skill) => skill.name === selectedSkill.name)}
        onBack={() => {
          setSelectedSkill(null);
          setDetail(null);
        }}
        onInstall={() => void installBuiltin(selectedSkill)}
        onRemove={() => void removeSkill()}
        onUsePrompt={(prompt) => {
          setPendingPrompt(`${selectedSkill.name} ${prompt}`);
          setSkillOpen(false);
        }}
        installing={installing === selectedSkill.name}
      />
    );
  }

  return (
    <div className="flex size-full min-h-0 flex-col bg-background">
      <ScrollArea className="min-h-0 flex-1">
        <main className="mx-auto w-full max-w-6xl px-5 py-8">
          <header className="flex items-start justify-between gap-4">
            <div>
              <h1 className="text-3xl font-semibold tracking-tight">插件市场</h1>
              <p className="mt-2 text-base text-muted-foreground">
                用插件为 Mastra 扩展技能、命令与 MCP 能力
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Button
                aria-label="刷新"
                onClick={() => void refreshAll()}
                size="icon"
                variant="outline"
              >
                <RefreshCwIcon />
              </Button>
              <Button
                aria-label="管理技能市场"
                onClick={() => setMarketplacesOpen(true)}
                size="icon"
                variant="outline"
              >
                <Settings2Icon />
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger render={<Button />}>
                  <PlusIcon />
                  新建
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => setAddSkillOpen(true)}>
                    <UploadIcon />
                    添加技能
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setMcpOpen(true)}>
                    <PlugZapIcon />
                    添加 MCP 能力
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setMarketplacesOpen(true)}>
                    <StoreIcon />
                    管理技能市场
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </header>
          <div className="relative mt-4">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-4 size-5 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="h-12 rounded-xl pl-12 text-base"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索插件"
              value={query}
            />
          </div>
          <section className="mt-4">
            <div className="flex items-center justify-between">
              <h2 className="text-xl font-semibold">已安装</h2>
              {skills.length > 0 ? <Badge variant="secondary">{skills.length} 个</Badge> : null}
            </div>
            <Separator className="mt-4" />
            <ScrollArea className="mt-4 w-full whitespace-nowrap">
              <div className="flex gap-3 pb-3">
                {skills.map((skill, index) => (
                  <button
                    className="group flex size-14 shrink-0 items-center justify-center rounded-xl border bg-card text-2xl transition-colors hover:bg-accent"
                    key={skill.name}
                    onClick={() => {
                      setSelectedSkill(skill);
                      setSection("personal");
                    }}
                    title={skill.name}
                    type="button"
                  >
                    {skillIcon(skill, index)}
                  </button>
                ))}
                {skills.length === 0 && (
                  <p className="py-3 text-sm text-muted-foreground">
                    还没有安装技能，去技能市场添加一个吧。
                  </p>
                )}
              </div>
              <ScrollBar orientation="horizontal" />
            </ScrollArea>
          </section>
          <div className="flex items-center justify-between">
            <Tabs
              onValueChange={(value) => setSection(value as Section)}
              value={section === "mcp" ? "public" : section}
            >
              <TabsList variant="line">
                <TabsTrigger value="public">市场</TabsTrigger>
                <TabsTrigger value="personal">个人</TabsTrigger>
              </TabsList>
            </Tabs>
            <Button
              onClick={() => setSection("mcp")}
              variant={section === "mcp" ? "secondary" : "ghost"}
            >
              <PlugZapIcon />
              MCP 能力
              {mcpServers.length > 0 ? <Badge variant="outline">{mcpServers.length}</Badge> : null}
            </Button>
          </div>
          {section === "mcp" ? (
            <McpSection
              mcpServers={mcpServers}
              onDelete={(server) => void removeMcp(server)}
            />
          ) : section === "personal" ? (
            <InstalledSection skills={visibleInstalled} onSelect={setSelectedSkill} />
          ) : (
            <div className="mt-8">
              <div className="mb-5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                <StoreIcon className="size-3.5" />
                <span>技能来源</span>
                <Badge variant="outline">Mastra 内置</Badge>
                <Badge variant="outline">skills.sh</Badge>
                <span>内置技能和 skills.sh 社区技能默认可用；已添加的 GitHub 市场也会显示在这里。</span>
              </div>
              {loading || (registryLoading && registrySkills.length === 0) ? (
                <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
                  <LoaderCircleIcon className="animate-spin" />
                  正在读取 Mastra 技能市场…
                </div>
              ) : groupedRegistry.length === 0 ? (
                <EmptyState label="技能市场暂时没有匹配结果" icon={<StoreIcon />} />
              ) : (
                groupedRegistry.map(({ category, skills: categorySkills }) => (
                  <SkillCategory
                    key={`${skillSourceLabel(categorySkills[0])}:${category}`}
                    category={category}
                    installing={installing}
                    installed={skills}
                    onInstall={(skill) => void installBuiltin(skill)}
                    onSelect={setSelectedSkill}
                    skills={categorySkills}
                  />
                ))
              )}
            </div>
          )}
        </main>
      </ScrollArea>
      <SkillAddDialog
        fileInputRef={inputRef}
        onFile={(file) => void uploadSkill(file)}
        onOpenChange={setAddSkillOpen}
        onSource={(source) => void importSkill(source)}
        open={addSkillOpen}
        uploading={uploading}
      />
      <McpDialog onOpenChange={setMcpOpen} onSaved={() => void loadMcp()} open={mcpOpen} />
      <MarketplacesDialog
        marketplaces={marketplaces}
        onOpenChange={setMarketplacesOpen}
        onSaved={() => void Promise.all([loadMarketplaces(), loadRegistry(query)])}
        open={marketplacesOpen}
      />
    </div>
  );
}

function SkillCategory({
  category,
  skills,
  installed,
  installing,
  onInstall,
  onSelect,
}: {
  category: string;
  skills: SkillMetadata[];
  installed: SkillMetadata[];
  installing: string | null;
  onInstall: (skill: SkillMetadata) => void;
  onSelect: (skill: SkillMetadata) => void;
}) {
  return (
    <section className="mt-4">
      <div className="flex items-center justify-between">
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="text-xl font-semibold">{category}</h2>
          <Badge variant="outline">{skillSourceLabel(skills[0])}</Badge>
        </div>
        <span className="text-xs text-muted-foreground">{skills.length} 个技能</span>
      </div>
      <Separator className="mt-4" />
      <div className="mt-2 grid gap-3 md:grid-cols-2">
        {skills.map((skill, index) => {
          const isInstalled = installed.some((item) => item.name === skill.name);
          return (
            <MagicCard
              key={skill.name}
              gradientSize={160}
              gradientFrom="var(--primary)"
              gradientTo="var(--accent)"
              className="flex min-w-0 items-center justify-between gap-3 rounded-xl border bg-card/60 p-3 transition-colors hover:border-primary/40"
            >
              <button
                aria-label={`查看技能 ${skill.name}`}
                className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 text-left"
                onClick={() => onSelect(skill)}
                type="button"
              >
                <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted text-xl">
                  {skillIcon(skill, index)}
                </span>
                <span className="min-w-0">
                  <span className="block truncate font-medium text-foreground">{skill.name}</span>
                  <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                    {skill.description || "未提供描述"}
                  </span>
                </span>
              </button>
              {isInstalled ? (
                <Badge variant="secondary" className="shrink-0">
                  <CheckIcon className="size-3 mr-1" />
                  已安装
                </Badge>
              ) : (
                <Button
                  disabled={installing === skill.name}
                  onClick={(event) => {
                    event.stopPropagation();
                    onInstall(skill);
                  }}
                  size="sm"
                  variant="outline"
                  className="shrink-0 h-7 text-xs"
                >
                  {installing === skill.name ? (
                    <LoaderCircleIcon className="animate-spin size-3.5" />
                  ) : (
                    <PlusIcon className="size-3.5" />
                  )}
                  安装
                </Button>
              )}
            </MagicCard>
          );
        })}
      </div>
    </section>
  );
}

function InstalledSection({
  skills,
  onSelect,
}: {
  skills: SkillMetadata[];
  onSelect: (skill: SkillMetadata) => void;
}) {
  return (
    <div className="mt-8">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">个人技能</h2>
        <Badge variant="secondary">{skills.length}</Badge>
      </div>
      <Separator className="mt-4" />
      <div className="grid gap-x-12 md:grid-cols-2">
        {skills.map((skill, index) => (
          <button
            className="flex min-w-0 items-center gap-3 rounded-lg py-3 text-left transition-colors hover:bg-muted/40"
            key={skill.name}
            onClick={() => onSelect(skill)}
            type="button"
          >
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted text-xl">
              {skillIcon(skill, index)}
            </span>
            <span className="min-w-0">
              <span className="block truncate font-medium">{skill.name}</span>
              <span className="mt-1 block truncate text-sm text-muted-foreground">
                {skill.description || "未提供描述"}
              </span>
            </span>
            <ChevronRightIcon className="ml-auto size-4 shrink-0 text-muted-foreground" />
          </button>
        ))}
        {skills.length === 0 && <EmptyState label="还没有个人技能" icon={<SparklesIcon />} />}
      </div>
    </div>
  );
}

function McpSection({
  mcpServers,
  onDelete,
}: {
  mcpServers: McpSummary[];
  onDelete: (server: McpSummary) => void;
}) {
  return (
    <div className="mt-8">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold">MCP 外部能力</h2>
          <p className="mt-1 text-sm text-muted-foreground">已配置的远程服务和本地工具运行时</p>
        </div>
        <Badge variant="secondary">{mcpServers.length}</Badge>
      </div>
      <Separator className="mt-4" />
      <div className="grid gap-3 py-4 md:grid-cols-2">
        {mcpServers.map((server) => (
          <div
            className="flex items-center gap-3 rounded-xl border p-4"
            key={server.id}
          >
            <div className="flex min-w-0 flex-1 items-center gap-3">
              <span className="flex size-10 items-center justify-center rounded-xl bg-muted text-primary">
                <PlugZapIcon />
              </span>
              <span className="min-w-0">
                <span className="block truncate font-medium">{server.name}</span>
                <span className="mt-1 block truncate text-sm text-muted-foreground">
                  {server.transport === "http"
                    ? server.url
                    : `${server.command} ${server.args?.join(" ")}`}
                </span>
              </span>
            </div>
            <Badge variant={server.enabled ? "secondary" : "outline"}>
              {server.enabled ? "启用" : "停用"}
            </Badge>
            <Button
              aria-label="删除 MCP"
              onClick={() => onDelete(server)}
              size="icon-sm"
              variant="ghost"
            >
              <Trash2Icon />
            </Button>
          </div>
        ))}
        {mcpServers.length === 0 && (
          <EmptyState label="还没有配置 MCP 外部能力" icon={<PlugZapIcon />} />
        )}
      </div>
    </div>
  );
}

function SkillDetailPage({
  detail,
  detailError,
  detailLoading,
  installed,
  installing,
  onBack,
  onInstall,
  onRemove,
  onUsePrompt,
}: {
  detail: SkillDetail | null;
  detailError: string | null;
  detailLoading: boolean;
  installed: boolean;
  installing: boolean;
  onBack: () => void;
  onInstall: () => void;
  onRemove: () => void;
  onUsePrompt: (prompt: string) => void;
}) {
  const examplePrompts = [
    "把我的笔记整理成一份排版好的文档",
    "把这份 PDF 里的表格提取成电子表格",
    "用这份 CSV 做一份带图表的工作簿",
  ];
  return (
    <div className="flex size-full min-h-0 flex-col bg-background">
      <ScrollArea className="min-h-0 flex-1">
        <main className="mx-auto w-full max-w-6xl px-5 py-7 sm:px-8 lg:px-12">
          <Button className="mb-8" onClick={onBack} variant="ghost">
            <ArrowLeftIcon />
            插件市场
          </Button>
          {detail ? (
            <>
              <header className="flex flex-wrap items-start justify-between gap-5">
                <div className="flex items-start gap-4">
                  <span className="flex size-20 items-center justify-center rounded-2xl bg-muted text-5xl">
                    {skillIcon(detail)}
                  </span>
                  <div>
                    <h1 className="text-3xl font-semibold tracking-tight">{detail.name}</h1>
                    <p className="mt-2 max-w-2xl text-base text-muted-foreground">
                      {detail.description || "未提供描述"}
                    </p>
                    <Badge className="mt-3" variant="outline">
                      {skillSourceLabel(detail)}
                    </Badge>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {installed ? (
                    <Button onClick={onRemove} variant="outline">
                      <Trash2Icon />
                      移除
                    </Button>
                  ) : (
                    <Button disabled={installing} onClick={onInstall}>
                      {installing ? <LoaderCircleIcon className="animate-spin" /> : <PlusIcon />}
                      安装
                    </Button>
                  )}
                </div>
              </header>
              <section className="mt-10 w-full min-w-0 rounded-xl border bg-muted/20 p-4 sm:p-5">
                <div className="grid min-w-0 gap-3">
                  <div>
                    <p className="text-xs font-medium text-muted-foreground">使用示例</p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      选择一个示例，将它填入新会话输入框后再按需修改。
                    </p>
                  </div>
                  <div className="grid gap-2">
                    {examplePrompts.map((prompt) => (
                      <button
                        type="button"
                        onClick={() => onUsePrompt(prompt)}
                        className="group flex w-full min-w-0 items-center gap-3 rounded-lg border bg-background px-3 py-2.5 text-left text-sm transition-all hover:border-foreground/30 hover:bg-accent hover:shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-pointer"
                        key={prompt}
                      >
                        <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-base transition-transform group-hover:scale-105">
                          {skillIcon(detail)}
                        </span>
                        <span className="min-w-0 flex-1 break-words text-foreground font-normal">
                          {detail.name} {prompt}
                        </span>
                        <span className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors group-hover:bg-muted group-hover:text-foreground">
                          <ArrowUpRightIcon className="size-4 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              </section>
              <section className="mt-10 w-full min-w-0">
                <h2 className="text-xl font-semibold">技能说明</h2>
                <div className="mt-4 min-w-0 rounded-xl border bg-muted/30 p-4">
                  <MessageResponse className="w-full max-w-none text-sm leading-relaxed">
                    {detail.instructions}
                  </MessageResponse>
                </div>
              </section>
              <section className="mt-10">
                <h2 className="text-xl font-semibold">
                  技能关联文件{" "}
                  {detail.references.length + detail.scripts.length + detail.assets.length > 0 ? (
                    <span className="text-sm font-normal text-muted-foreground">
                      ({detail.references.length + detail.scripts.length + detail.assets.length})
                    </span>
                  ) : null}
                </h2>
                <Separator className="mt-4" />
                <div className="divide-y">
                  {[...detail.references, ...detail.scripts, ...detail.assets].map((item) => (
                    <div className="flex items-center gap-3 py-4" key={item}>
                      <span className="flex size-9 items-center justify-center rounded-lg bg-muted">
                        <SparklesIcon className="size-4" />
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate font-medium">{item}</span>
                        <span className="mt-1 block truncate text-sm text-muted-foreground">
                          该技能附带的参考资料、脚本或资源文件
                        </span>
                      </span>
                    </div>
                  ))}
                  {detail.references.length + detail.scripts.length + detail.assets.length ===
                    0 && (
                    <p className="py-5 text-sm text-muted-foreground">此技能没有额外资源文件。</p>
                  )}
                </div>
              </section>
            </>
          ) : detailLoading ? (
            <div className="flex items-center gap-2 py-16 text-sm text-muted-foreground">
              <LoaderCircleIcon className="animate-spin" />
              正在读取技能详情…
            </div>
          ) : (
            <div className="grid gap-3 py-16 text-sm">
              <p className="text-destructive">{detailError || "读取技能详情失败"}</p>
              <p className="text-muted-foreground">请返回市场后重试。</p>
            </div>
          )}
        </main>
      </ScrollArea>
    </div>
  );
}

function SkillAddDialog({
  open,
  onOpenChange,
  onFile,
  onSource,
  fileInputRef,
  uploading,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onFile: (file: File | undefined) => void;
  onSource: (source: string) => void;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  uploading: boolean;
}) {
  const [source, setSource] = React.useState("");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>添加技能</DialogTitle>
          <DialogDescription>
            粘贴 GitHub/Git 技能包地址，或从本地选择包含 SKILL.md 的 ZIP 文件。
          </DialogDescription>
        </DialogHeader>
        <Input
          onChange={(event) => setSource(event.target.value)}
          placeholder="GitHub 仓库、Git URL、文件或目录"
          value={source}
        />
        <p className="text-sm text-muted-foreground">
          远程地址需要直接返回 ZIP 技能包；本地文件需要是 ZIP 格式。
        </p>
        <DialogFooter>
          <Button onClick={() => fileInputRef.current?.click()} variant="outline">
            <FolderOpenIcon />
            选择文件
          </Button>
          <Button
            disabled={uploading || source.trim().length === 0}
            onClick={() => onSource(source.trim())}
          >
            {uploading ? <LoaderCircleIcon className="animate-spin" /> : <PlusIcon />}添加技能
          </Button>
        </DialogFooter>
        <input
          accept=".zip,application/zip"
          className="hidden"
          onChange={(event) => onFile(event.target.files?.[0])}
          ref={fileInputRef}
          type="file"
        />
      </DialogContent>
    </Dialog>
  );
}

function MarketplacesDialog({
  open,
  onOpenChange,
  marketplaces,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  marketplaces: SkillMarketplace[];
  onSaved: () => void;
}) {
  const [editing, setEditing] = React.useState<SkillMarketplace | null>(null);
  const [name, setName] = React.useState("");
  const [url, setUrl] = React.useState("");
  const [branch, setBranch] = React.useState("main");
  const [saving, setSaving] = React.useState(false);

  const reset = () => {
    setEditing(null);
    setName("");
    setUrl("");
    setBranch("main");
  };
  const edit = (marketplace: SkillMarketplace) => {
    setEditing(marketplace);
    setName(marketplace.name);
    setUrl(marketplace.url);
    setBranch(marketplace.branch);
  };
  const save = async () => {
    setSaving(true);
    try {
      const response = await fetch(`${MASTRA_SERVER_URL}/work/skills/marketplaces`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: editing?.id, name, url, branch, enabled: true }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw apiError(payload, "保存技能市场失败");
      toast.success(editing ? "技能市场已更新" : "技能市场已添加");
      reset();
      onSaved();
    } catch (error) {
      toastError(error, "保存技能市场失败");
    } finally {
      setSaving(false);
    }
  };
  const remove = async (id: string) => {
    if (!window.confirm("确定删除这个技能市场吗？")) return;
    const response = await fetch(
      `${MASTRA_SERVER_URL}/work/skills/marketplaces/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
    if (!response.ok) {
      toast.error("删除技能市场失败");
      return;
    }
    if (editing?.id === id) reset();
    onSaved();
    toast.success("技能市场已删除");
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>技能市场</DialogTitle>
          <DialogDescription>
            添加 GitHub 技能集合仓库。仓库可以在 skills/ 下放置多个包含 SKILL.md 的技能。
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          {marketplaces.map((marketplace) => (
            <div className="flex items-center gap-3 rounded-lg border p-3" key={marketplace.id}>
              <StoreIcon className="size-4 shrink-0 text-primary" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{marketplace.name}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {marketplace.url} · {marketplace.branch}
                </p>
              </div>
              <Button
                aria-label="编辑技能市场"
                onClick={() => edit(marketplace)}
                size="icon-sm"
                variant="ghost"
              >
                <PencilIcon />
              </Button>
              <Button
                aria-label="删除技能市场"
                onClick={() => void remove(marketplace.id)}
                size="icon-sm"
                variant="ghost"
              >
                <Trash2Icon />
              </Button>
            </div>
          ))}
          {marketplaces.length === 0 ? (
            <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
              还没有自定义技能市场。
            </p>
          ) : null}
        </div>
        <Separator />
        <div className="grid gap-3 sm:grid-cols-[1fr_1.5fr_7rem]">
          <Input
            aria-label="市场名称"
            onChange={(event) => setName(event.target.value)}
            placeholder="名称"
            value={name}
          />
          <Input
            aria-label="GitHub 地址"
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://github.com/owner/skills"
            value={url}
          />
          <Input
            aria-label="分支"
            onChange={(event) => setBranch(event.target.value)}
            placeholder="main"
            value={branch}
          />
        </div>
        <DialogFooter>
          <Button onClick={reset} variant="ghost">
            清空
          </Button>
          <Button disabled={saving || !url.trim()} onClick={() => void save()}>
            {saving ? <LoaderCircleIcon className="animate-spin" /> : <PlusIcon />}
            {editing ? "保存修改" : "添加市场"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EmptyState({ label, icon }: { label: string; icon: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 py-16 text-muted-foreground">
      {icon}
      <p className="text-sm">{label}</p>
    </div>
  );
}
