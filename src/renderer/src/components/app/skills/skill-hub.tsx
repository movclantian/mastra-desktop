import {
  ArrowLeftIcon,
  ArrowUpRightIcon,
  AwardIcon,
  BookOpenIcon,
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CopyIcon,
  DownloadIcon,
  FileCodeIcon,
  FlameIcon,
  FolderOpenIcon,
  GlobeIcon,
  LoaderCircleIcon,
  PencilIcon,
  PlugZapIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  Settings2Icon,
  ShieldCheckIcon,
  SparklesIcon,
  StoreIcon,
  TerminalIcon,
  Trash2Icon,
  TrendingUpIcon,
  UploadIcon,
  XIcon,
} from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { MessageResponse } from "@/components/ai-elements/message";
import { McpDialog, type McpFormServer } from "@/components/app/integrations";
import { Badge } from "@/components/ui/badge";
import { BlurFade } from "@/components/ui/blur-fade";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
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
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
} from "@/components/ui/pagination";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { apiError, toastError } from "@/lib/errors";
import { MASTRA_SERVER_URL } from "@/lib/providers";
import { cn } from "@/lib/utils";
import { type SkillAuditItem, type SkillMetadata, useWorkbench } from "@/lib/workbench";

interface SkillDetail extends SkillMetadata {
  instructions: string;
  references: string[];
  scripts: string[];
  assets: string[];
  audits?: SkillAuditItem[];
}

interface CuratedSkill {
  id?: string;
  slug: string;
  name: string;
  source: string;
  installs?: number;
  installUrl?: string | null;
  url?: string;
  description?: string;
  change?: number;
  installsYesterday?: number;
  isOfficial?: boolean;
  owner?: string;
}

interface CuratedOwner {
  owner: string;
  totalInstalls: number;
  featuredRepo?: string;
  featuredSkill?: string;
  skills: CuratedSkill[];
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
type MarketCategory = "official" | "leaderboard" | "builtin" | "marketplace";
type LeaderboardView = "all-time" | "trending" | "hot";

const ICONS = ["📦", "📝", "🪟", "📄", "🤖", "📘", "⚡", "🛠️"];

function skillIcon(skill: SkillMetadata, index = 0) {
  const icon = skill.metadata?.icon;
  return typeof icon === "string" && icon.length > 0 ? icon : ICONS[index % ICONS.length];
}

function skillSourceLabel(skill?: SkillMetadata) {
  if (skill?.origin === "builtin") return "Mastra 内置";
  if (skill?.isOfficial) return "官方认证";
  if (skill?.origin === "skills-sh") return "skills.sh";
  return skill?.marketplaceName || "个人技能";
}

function formatInstalls(count?: number): string {
  if (count === undefined || count === null || Number.isNaN(count)) return "0";
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return String(count);
}

let memRegistrySkills: SkillMetadata[] = [];
let memCuratedOwners: CuratedOwner[] = [];
let memInstalledSkills: SkillMetadata[] = [];
let memMcpServers: McpSummary[] = [];
let memMarketplaces: SkillMarketplace[] = [];

function getPaginationRange(current: number, total: number): (number | string)[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  if (current <= 4) return [1, 2, 3, 4, 5, "...", total];
  if (current >= total - 3) return [1, "...", total - 4, total - 3, total - 2, total - 1, total];
  return [1, "...", current - 1, current, current + 1, "...", total];
}

export function SkillHub() {
  const { setPendingPrompt, setSkillOpen, activeSkill, setActiveSkill } = useWorkbench();
  const [section, setSection] = React.useState<Section>("public");
  const [marketCategory, setMarketCategory] = React.useState<MarketCategory>("official");
  const [leaderboardView, setLeaderboardView] = React.useState<LeaderboardView>("all-time");
  const [selectedMaker, setSelectedMaker] = React.useState<string | null>(null);

  const [query, setQuery] = React.useState("");
  const [page, setPage] = React.useState(1);
  const [pageSize, setPageSize] = React.useState(24);
  const scrollAreaRef = React.useRef<HTMLDivElement>(null);
  const searchInputRef = React.useRef<HTMLInputElement>(null);

  // SWR 内存缓存
  const [skills, setSkills] = React.useState<SkillMetadata[]>(memInstalledSkills);
  const [registrySkills, setRegistrySkills] = React.useState<SkillMetadata[]>(memRegistrySkills);
  const [curatedOwners, setCuratedOwners] = React.useState<CuratedOwner[]>(memCuratedOwners);
  const [mcpServers, setMcpServers] = React.useState<McpSummary[]>(memMcpServers);
  const [marketplaces, setMarketplaces] = React.useState<SkillMarketplace[]>(memMarketplaces);

  const [detail, setDetail] = React.useState<SkillDetail | null>(null);
  const [detailLoading, setDetailLoading] = React.useState(false);
  const [detailError, setDetailError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(
    () => memInstalledSkills.length === 0 && memMarketplaces.length === 0,
  );
  const [registryLoading, setRegistryLoading] = React.useState(
    () => memRegistrySkills.length === 0,
  );
  const [curatedLoading, setCuratedLoading] = React.useState(() => memCuratedOwners.length === 0);
  const [installing, setInstalling] = React.useState<string | null>(null);
  const [uploading, setUploading] = React.useState(false);
  const [addSkillOpen, setAddSkillOpen] = React.useState(false);
  const [mcpOpen, setMcpOpen] = React.useState(false);
  const [marketplacesOpen, setMarketplacesOpen] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);

  // 全局快捷键 / 聚焦搜索框
  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "/" && !["INPUT", "TEXTAREA"].includes((e.target as HTMLElement)?.tagName)) {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const loadInstalled = React.useCallback(async () => {
    const response = await fetch(`${MASTRA_SERVER_URL}/work/skills`);
    const payload = (await response.json()) as { skills?: SkillMetadata[]; error?: string };
    if (!response.ok) throw apiError(payload, "读取已安装技能失败");
    const nextSkills = payload.skills ?? [];
    memInstalledSkills = nextSkills;
    setSkills(nextSkills);
  }, []);

  const loadCurated = React.useCallback(async () => {
    if (memCuratedOwners.length === 0) setCuratedLoading(true);
    try {
      const response = await fetch(`${MASTRA_SERVER_URL}/work/skills/skills-sh/curated`);
      const payload = (await response.json()) as { data?: CuratedOwner[] };
      if (payload && Array.isArray(payload.data)) {
        memCuratedOwners = payload.data;
        setCuratedOwners(payload.data);
      }
    } catch {
      // ignore
    } finally {
      setCuratedLoading(false);
    }
  }, []);

  const loadRegistry = React.useCallback(async (search: string, force = false) => {
    if (memRegistrySkills.length === 0) setRegistryLoading(true);
    try {
      const response = await fetch(
        `${MASTRA_SERVER_URL}/work/skills/registry?query=${encodeURIComponent(search)}${
          force ? "&refresh=1" : ""
        }`,
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
    setMarketplaces(nextMarketplaces);
  }, []);

  const refresh = React.useCallback(async () => {
    setLoading(true);
    try {
      await Promise.all([loadInstalled(), loadMcp(), loadMarketplaces(), loadCurated()]);
    } catch (error) {
      toastError(error, "读取技能套件失败");
    } finally {
      setLoading(false);
    }
  }, [loadInstalled, loadMarketplaces, loadMcp, loadCurated]);

  const refreshAll = React.useCallback(async () => {
    await Promise.all([refresh(), loadRegistry(query, true), loadCurated()]);
  }, [loadCurated, loadRegistry, query, refresh]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  React.useEffect(() => {
    if (section !== "public") return;
    const timer = window.setTimeout(() => void loadRegistry(query), 180);
    return () => window.clearTimeout(timer);
  }, [loadRegistry, query, section]);

  React.useEffect(() => {
    if (!activeSkill) {
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
      activeSkill.origin === "marketplace" && activeSkill.marketplaceId && activeSkill.sourcePath
        ? fetch(
            `${MASTRA_SERVER_URL}/work/skills/marketplaces/${encodeURIComponent(activeSkill.marketplaceId)}/skill?path=${encodeURIComponent(activeSkill.sourcePath)}`,
          )
        : activeSkill.origin === "skills-sh" &&
            activeSkill.skillsShSource &&
            activeSkill.skillsShSlug
          ? fetch(
              `${MASTRA_SERVER_URL}/work/skills/skills-sh/skill?source=${encodeURIComponent(activeSkill.skillsShSource)}&slug=${encodeURIComponent(activeSkill.skillsShSlug)}`,
            )
          : activeSkill.origin === "builtin"
            ? fetch(
                `${MASTRA_SERVER_URL}/work/skills/registry/${encodeURIComponent(activeSkill.sourcePath || activeSkill.name)}`,
              )
            : fetch(`${MASTRA_SERVER_URL}/work/skills/${encodeURIComponent(activeSkill.name)}`);
    void detailRequest
      .then(async (response) => {
        const payload = (await response.json()) as { skill?: SkillDetail; error?: string };
        if (!response.ok || !payload.skill) throw apiError(payload, "读取技能详情失败");
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
  }, [activeSkill]);

  const visibleInstalled = React.useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return skills.filter(
      (skill) =>
        !needle || `${skill.name} ${skill.description}`.toLocaleLowerCase().includes(needle),
    );
  }, [query, skills]);

  // 从 curatedOwners 提取所有官方技能
  const officialSkills = React.useMemo(() => {
    if (curatedOwners.length > 0) {
      return curatedOwners.flatMap((owner) =>
        owner.skills.map((s) => ({
          ...s,
          origin: "skills-sh" as const,
          isOfficial: true,
          owner: owner.owner,
          marketplaceName: "官方认证",
          path: `skills-sh:${s.source}/${s.slug}`,
          description: s.description || "来自 skills.sh 的社区技能",
          sourceUrl: s.url || `https://skills.sh/${s.source}/${s.slug}`,
          skillsShSource: s.source,
          skillsShSlug: s.slug,
        })),
      );
    }
    return registrySkills.filter((s) => s.isOfficial || s.origin === "skills-sh");
  }, [curatedOwners, registrySkills]);

  // 当前分类下的技能池
  const currentCategoryPool = React.useMemo(() => {
    if (marketCategory === "official") {
      let pool = officialSkills;
      if (selectedMaker) {
        pool = pool.filter(
          (s) =>
            s.owner?.toLowerCase() === selectedMaker.toLowerCase() ||
            s.skillsShSource?.toLowerCase().startsWith(`${selectedMaker.toLowerCase()}/`),
        );
      }
      return pool;
    }
    if (marketCategory === "leaderboard") {
      const pool = registrySkills.filter((s) => s.origin === "skills-sh");
      if (leaderboardView === "trending") {
        return [...pool].sort(
          (a, b) => (b.change ?? b.installs ?? 0) - (a.change ?? a.installs ?? 0),
        );
      }
      if (leaderboardView === "hot") {
        return [...pool].sort(
          (a, b) => (b.installsYesterday ?? b.change ?? 0) - (a.installsYesterday ?? a.change ?? 0),
        );
      }
      return pool;
    }
    if (marketCategory === "builtin") {
      return registrySkills.filter((s) => s.origin === "builtin");
    }
    if (marketCategory === "marketplace") {
      return registrySkills.filter((s) => s.origin === "marketplace");
    }
    return registrySkills;
  }, [leaderboardView, marketCategory, officialSkills, registrySkills, selectedMaker]);

  // 搜索过滤后的技能列表
  const filteredSkills = React.useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return currentCategoryPool;
    return currentCategoryPool.filter((skill) => {
      const matchName = skill.name.toLocaleLowerCase().includes(needle);
      const matchDesc = (skill.description || "").toLocaleLowerCase().includes(needle);
      const matchOwner = (skill.owner || skill.skillsShSource || "")
        .toLocaleLowerCase()
        .includes(needle);
      return matchName || matchDesc || matchOwner;
    });
  }, [currentCategoryPool, query]);

  const totalPages = Math.max(1, Math.ceil(filteredSkills.length / pageSize));
  const currentSkills = React.useMemo(() => {
    const start = (page - 1) * pageSize;
    return filteredSkills.slice(start, start + pageSize);
  }, [filteredSkills, page, pageSize]);

  const sourceCounts = React.useMemo(() => {
    return {
      all: registrySkills.length,
      official: officialSkills.length || 340,
      skillsSh: registrySkills.filter((s) => s.origin === "skills-sh").length,
      builtin: registrySkills.filter((s) => s.origin === "builtin").length,
      marketplace: registrySkills.filter((s) => s.origin === "marketplace").length,
    };
  }, [officialSkills.length, registrySkills]);

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
      setActiveSkill(payload.skill);
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
      setActiveSkill(payload.skill);
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
      const response =
        skill.origin === "marketplace" && skill.marketplaceId && skill.sourcePath
          ? await fetch(
              `${MASTRA_SERVER_URL}/work/skills/marketplaces/${encodeURIComponent(skill.marketplaceId)}/install`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ path: skill.sourcePath }),
              },
            )
          : skill.origin === "skills-sh" && skill.skillsShSource && skill.skillsShSlug
            ? await fetch(`${MASTRA_SERVER_URL}/work/skills/skills-sh/install`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  source: skill.skillsShSource,
                  slug: skill.skillsShSlug,
                }),
              })
            : await fetch(
                `${MASTRA_SERVER_URL}/work/skills/registry/${encodeURIComponent(skill.sourcePath || skill.name)}/install`,
                { method: "POST" },
              );
      const payload = (await response.json()) as { skill?: SkillMetadata; error?: string };
      if (!response.ok || !payload.skill) throw apiError(payload, "安装技能失败");
      await loadInstalled();
      toast.success(`技能「${payload.skill.name}」已安装`);
    } catch (error) {
      toastError(error, "安装技能失败");
    } finally {
      setInstalling(null);
    }
  };

  const removeSkill = async () => {
    if (!activeSkill || !window.confirm(`确定删除技能「${activeSkill.name}」吗？`)) return;
    const response = await fetch(
      `${MASTRA_SERVER_URL}/work/skills/${encodeURIComponent(activeSkill.name)}`,
      { method: "DELETE" },
    );
    if (!response.ok) {
      toast.error("删除技能失败");
      return;
    }
    setActiveSkill(null);
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

  const authenticateMcp = async (server: McpSummary) => {
    try {
      const response = await fetch(
        `${MASTRA_SERVER_URL}/work/mcp/${encodeURIComponent(server.id)}/authenticate`,
        { method: "POST" },
      );
      const result = (await response.json()) as {
        authorizationUrl?: string;
        authenticated?: boolean;
        error?: string;
      };
      if (!response.ok) throw new Error(result.error || "MCP OAuth 授权失败");
      if (result.authorizationUrl) {
        await window.api.openExternal(result.authorizationUrl);
        toast.success("已打开 MCP 授权页面，完成后服务会自动连接");
      } else if (result.authenticated) {
        toast.success("MCP 已完成授权");
      }
    } catch (error) {
      toastError(error, "MCP OAuth 授权失败");
    }
  };

  if (activeSkill) {
    return (
      <SkillDetailPage
        detail={detail}
        detailError={detailError}
        detailLoading={detailLoading}
        installed={skills.some((skill) => skill.name === activeSkill.name)}
        onBack={() => {
          setActiveSkill(null);
          setDetail(null);
        }}
        onInstall={() => void installBuiltin(activeSkill)}
        onRemove={() => void removeSkill()}
        onUsePrompt={(prompt) => {
          setPendingPrompt(`${activeSkill.name} ${prompt}`);
          setSkillOpen(false);
        }}
        installing={installing === activeSkill.name}
      />
    );
  }

  return (
    <div className="flex size-full min-h-0 flex-col bg-background">
      <ScrollArea className="min-h-0 flex-1" ref={scrollAreaRef}>
        <main className="mx-auto w-full max-w-6xl px-5 py-8">
          {/* 顶栏标题与核心操作 */}
          <header className="flex items-start justify-between gap-4">
            <div>
              <h1 className="text-3xl font-semibold tracking-tight">插件与技能市场</h1>
              <p className="mt-2 text-base text-muted-foreground">
                汇聚技术原厂认证技能、skills.sh 社区生态榜单与 MCP 扩展能力
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Button
                aria-label="管理技能市场"
                onClick={() => setMarketplacesOpen(true)}
                size="icon"
                variant="outline"
                title="管理自定义 GitHub 技能市场"
              >
                <Settings2Icon />
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger render={<Button />}>
                  <PlusIcon />
                  新建 / 导入
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => setAddSkillOpen(true)}>
                    <UploadIcon />
                    导入本地/远程技能
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setMcpOpen(true)}>
                    <PlugZapIcon />
                    添加 MCP 外部工具
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setMarketplacesOpen(true)}>
                    <StoreIcon />
                    管理技能市场源
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </header>

          {/* 已安装快捷栏 */}
          <section className="mt-6">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold tracking-tight text-foreground/90">
                已启用技能
              </h2>
              {skills.length > 0 ? (
                <Badge variant="secondary" className="text-xs">
                  {skills.length} 个
                </Badge>
              ) : null}
            </div>
            <Separator className="mt-3" />
            <ScrollArea className="mt-3 w-full whitespace-nowrap">
              <div className="flex gap-2.5 pb-2">
                {skills.map((skill, index) => (
                  <button
                    className="group flex size-12 shrink-0 items-center justify-center rounded-xl border bg-card text-xl transition-all hover:bg-accent hover:border-primary/40 cursor-pointer shadow-2xs"
                    key={skill.name}
                    onClick={() => {
                      setActiveSkill(skill);
                    }}
                    title={`${skill.name} - ${skill.description || "点击查看详情"}`}
                    type="button"
                  >
                    <span>{skillIcon(skill, index)}</span>
                  </button>
                ))}
                {skills.length === 0 && (
                  <p className="py-2 text-xs text-muted-foreground">
                    暂未安装任何技能，在下方市场中挑选并点击「安装」即可开始使用。
                  </p>
                )}
              </div>
              <ScrollBar orientation="horizontal" />
            </ScrollArea>
          </section>

          {/* 一级功能标签切换 (市场 / 个人 / MCP) */}
          <div className="mt-6 flex items-center justify-between border-b pb-1">
            <Tabs
              onValueChange={(value) => setSection(value as Section)}
              value={section === "mcp" ? "public" : section}
            >
              <TabsList variant="line">
                <TabsTrigger value="public" className="gap-1.5 font-medium">
                  <StoreIcon className="size-4" />
                  探索市场
                </TabsTrigger>
                <TabsTrigger value="personal" className="gap-1.5 font-medium">
                  <SparklesIcon className="size-4" />
                  个人管理
                  {skills.length > 0 ? (
                    <Badge variant="secondary" className="ml-1 text-[10px] h-4 px-1">
                      {skills.length}
                    </Badge>
                  ) : null}
                </TabsTrigger>
              </TabsList>
            </Tabs>
            <Button
              onClick={() => setSection("mcp")}
              variant={section === "mcp" ? "secondary" : "ghost"}
              size="sm"
              className="gap-1.5 h-8"
            >
              <PlugZapIcon className="size-3.5" />
              MCP 外部工具
              {mcpServers.length > 0 ? (
                <Badge variant="outline" className="ml-1 text-[10px] h-4 px-1">
                  {mcpServers.length}
                </Badge>
              ) : null}
            </Button>
          </div>

          {/* 市场 / 个人 / MCP 内容区域 */}
          {section === "mcp" ? (
            <McpSection
              mcpServers={mcpServers}
              onDelete={(server) => void removeMcp(server)}
              onAuthenticate={(server) => void authenticateMcp(server)}
            />
          ) : section === "personal" ? (
            <InstalledSection skills={visibleInstalled} onSelect={setActiveSkill} />
          ) : (
            <div className="mt-6 space-y-5">
              {/* 1. 市场类目导航 */}
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant={marketCategory === "official" ? "secondary" : "outline"}
                  onClick={() => {
                    setMarketCategory("official");
                    setPage(1);
                  }}
                  className="rounded-full text-xs font-medium gap-1.5 h-8"
                >
                  <AwardIcon className="size-3.5 text-amber-500" />
                  <span>⭐ 官方原厂精选</span>
                  <Badge variant="secondary" className="text-[10px] px-1 py-0 h-4 ml-0.5">
                    {sourceCounts.official}
                  </Badge>
                </Button>

                <Button
                  size="sm"
                  variant={marketCategory === "leaderboard" ? "secondary" : "outline"}
                  onClick={() => {
                    setMarketCategory("leaderboard");
                    setPage(1);
                  }}
                  className="rounded-full text-xs font-medium gap-1.5 h-8"
                >
                  <FlameIcon className="size-3.5 text-rose-500" />
                  <span>🔥 社区排行榜</span>
                  <Badge variant="secondary" className="text-[10px] px-1 py-0 h-4 ml-0.5">
                    {sourceCounts.skillsSh}
                  </Badge>
                </Button>

                <Button
                  size="sm"
                  variant={marketCategory === "builtin" ? "secondary" : "outline"}
                  onClick={() => {
                    setMarketCategory("builtin");
                    setPage(1);
                  }}
                  className="rounded-full text-xs font-medium gap-1.5 h-8"
                >
                  <SparklesIcon className="size-3.5 text-blue-500" />
                  <span>✨ Mastra 内置</span>
                  <Badge variant="secondary" className="text-[10px] px-1 py-0 h-4 ml-0.5">
                    {sourceCounts.builtin}
                  </Badge>
                </Button>

                {sourceCounts.marketplace > 0 ? (
                  <Button
                    size="sm"
                    variant={marketCategory === "marketplace" ? "secondary" : "outline"}
                    onClick={() => {
                      setMarketCategory("marketplace");
                      setPage(1);
                    }}
                    className="rounded-full text-xs font-medium gap-1.5 h-8"
                  >
                    <StoreIcon className="size-3.5 text-purple-500" />
                    <span>📦 GitHub 市场</span>
                    <Badge variant="secondary" className="text-[10px] px-1 py-0 h-4 ml-0.5">
                      {sourceCounts.marketplace}
                    </Badge>
                  </Button>
                ) : null}
              </div>

              {/* 2. 官方精选视角：Maker 创作者筛选与介绍 (匹配原图 2) */}
              {marketCategory === "official" ? (
                <div className="flex flex-col gap-2.5 rounded-xl border bg-muted/20 p-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <h3 className="text-sm font-semibold text-foreground flex items-center gap-1.5">
                        <ShieldCheckIcon className="size-4 text-emerald-500" />
                        原厂认证第一方技能（Official Makers）
                      </h3>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        由构建技术与产品的原厂公司及组织官方维护，直接向创造者学习如何使用其生态能力。
                      </p>
                    </div>
                  </div>
                  <ScrollArea className="w-full whitespace-nowrap pt-1">
                    <div className="flex items-center gap-1.5 pb-1">
                      <Button
                        size="xs"
                        variant={selectedMaker === null ? "secondary" : "outline"}
                        className="rounded-full text-xs h-7"
                        onClick={() => {
                          setSelectedMaker(null);
                          setPage(1);
                        }}
                      >
                        全部厂商 ({officialSkills.length})
                      </Button>
                      {curatedOwners.map((owner) => (
                        <Button
                          key={owner.owner}
                          size="xs"
                          variant={selectedMaker === owner.owner ? "secondary" : "outline"}
                          className="rounded-full text-xs h-7 gap-1 font-mono"
                          onClick={() => {
                            setSelectedMaker(selectedMaker === owner.owner ? null : owner.owner);
                            setPage(1);
                          }}
                        >
                          <span>@{owner.owner}</span>
                          <span className="text-[10px] opacity-70">({owner.skills.length})</span>
                        </Button>
                      ))}
                    </div>
                    <ScrollBar orientation="horizontal" />
                  </ScrollArea>
                </div>
              ) : null}

              {/* 3. 社区榜单视角：All Time / Trending / Hot 切换 (匹配原图 1) */}
              {marketCategory === "leaderboard" ? (
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b pb-3">
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant={leaderboardView === "all-time" ? "secondary" : "ghost"}
                      className="text-xs h-7 gap-1.5 rounded-full"
                      onClick={() => {
                        setLeaderboardView("all-time");
                        setPage(1);
                      }}
                    >
                      <AwardIcon className="size-3.5 text-amber-500" />
                      All Time (总榜)
                    </Button>
                    <Button
                      size="sm"
                      variant={leaderboardView === "trending" ? "secondary" : "ghost"}
                      className="text-xs h-7 gap-1.5 rounded-full"
                      onClick={() => {
                        setLeaderboardView("trending");
                        setPage(1);
                      }}
                    >
                      <TrendingUpIcon className="size-3.5 text-blue-500" />
                      Trending 24h (飙升)
                    </Button>
                    <Button
                      size="sm"
                      variant={leaderboardView === "hot" ? "secondary" : "ghost"}
                      className="text-xs h-7 gap-1.5 rounded-full"
                      onClick={() => {
                        setLeaderboardView("hot");
                        setPage(1);
                      }}
                    >
                      <FlameIcon className="size-3.5 text-rose-500" />
                      Hot (实时热门)
                    </Button>
                  </div>
                </div>
              ) : null}

              {/* 4. 市场内嵌搜索框与参数工具栏 */}
              <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 pt-1">
                <div className="relative flex-1">
                  <SearchIcon className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    ref={searchInputRef}
                    className="h-10 rounded-xl pl-10 pr-16 text-sm bg-muted/20 focus-visible:bg-background"
                    onChange={(event) => {
                      setQuery(event.target.value);
                      setPage(1);
                    }}
                    placeholder="搜索技能名称、描述、厂商或关键词..."
                    value={query}
                  />
                  <div className="absolute right-2.5 top-1/2 -translate-y-1/2 flex items-center gap-1">
                    {query ? (
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        className="size-5 text-muted-foreground hover:text-foreground"
                        onClick={() => {
                          setQuery("");
                          setPage(1);
                        }}
                      >
                        <XIcon className="size-3" />
                      </Button>
                    ) : null}
                    <kbd className="hidden sm:inline-flex select-none items-center rounded border bg-muted px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground">
                      /
                    </kbd>
                  </div>
                </div>

                {/* 分页参数与刷新控制 */}
                <div className="flex items-center gap-2 self-end sm:self-auto">
                  <div className="flex items-center rounded-lg border bg-muted/40 p-0.5 text-xs">
                    {[24, 48, 96].map((size) => (
                      <Button
                        key={size}
                        size="xs"
                        variant="ghost"
                        className={cn(
                          "h-6 px-2 text-[11px] font-normal cursor-pointer rounded-md",
                          pageSize === size &&
                            "bg-background shadow-xs text-foreground font-medium",
                        )}
                        onClick={() => {
                          setPageSize(size);
                          setPage(1);
                        }}
                      >
                        {size}条/页
                      </Button>
                    ))}
                  </div>
                  <Button
                    size="icon-sm"
                    variant="outline"
                    className="size-8"
                    onClick={() => void refreshAll()}
                    title="刷新技能数据"
                  >
                    <RefreshCwIcon
                      className={cn(
                        "size-3.5",
                        (registryLoading || curatedLoading) && "animate-spin",
                      )}
                    />
                  </Button>
                </div>
              </div>

              {/* 5. 技能卡片列表展示 */}
              {loading || (registryLoading && registrySkills.length === 0) ? (
                <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
                  <LoaderCircleIcon className="animate-spin size-5" />
                  正在读取技能中心数据…
                </div>
              ) : currentSkills.length === 0 ? (
                <EmptyState
                  label="未找到匹配的技能或插件"
                  icon={<StoreIcon className="size-8" />}
                />
              ) : (
                <div className="grid gap-3.5 md:grid-cols-2">
                  {currentSkills.map((skill, index) => {
                    const isInstalled = skills.some((item) => item.name === skill.name);
                    const rank =
                      marketCategory === "leaderboard"
                        ? (page - 1) * pageSize + index + 1
                        : undefined;
                    return (
                      <SkillCard
                        key={skill.path || skill.name}
                        skill={skill}
                        index={(page - 1) * pageSize + index}
                        rank={rank}
                        installed={isInstalled}
                        installing={installing === skill.name}
                        onInstall={(s) => void installBuiltin(s)}
                        onSelect={setActiveSkill}
                      />
                    );
                  })}
                </div>
              )}

              {/* 6. 完整分页控制栏 */}
              {totalPages > 1 ? (
                <div className="mt-8 flex flex-col sm:flex-row items-center justify-between gap-4 border-t pt-5">
                  <span className="text-xs text-muted-foreground">
                    共 {filteredSkills.length} 个技能 · 第 {page} / {totalPages} 页 · 每页{" "}
                    {pageSize} 条
                  </span>
                  <Pagination className="mx-0 w-auto">
                    <PaginationContent>
                      <PaginationItem>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={page <= 1}
                          onClick={() => {
                            setPage((p) => Math.max(1, p - 1));
                          }}
                          className="gap-1 pl-2.5 h-8 text-xs"
                        >
                          <ChevronLeftIcon className="size-3.5" />
                          <span>上一页</span>
                        </Button>
                      </PaginationItem>

                      {getPaginationRange(page, totalPages).map((item, idx) => (
                        <PaginationItem key={typeof item === "number" ? item : `ellipsis-${idx}`}>
                          {item === "..." ? (
                            <PaginationEllipsis />
                          ) : (
                            <Button
                              variant={page === item ? "outline" : "ghost"}
                              size="icon"
                              className="size-8 text-xs font-mono"
                              onClick={() => setPage(Number(item))}
                            >
                              {item}
                            </Button>
                          )}
                        </PaginationItem>
                      ))}

                      <PaginationItem>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={page >= totalPages}
                          onClick={() => {
                            setPage((p) => Math.min(totalPages, p + 1));
                          }}
                          className="gap-1 pr-2.5 h-8 text-xs"
                        >
                          <span>下一页</span>
                          <ChevronRightIcon className="size-3.5" />
                        </Button>
                      </PaginationItem>
                    </PaginationContent>
                  </Pagination>
                </div>
              ) : null}
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

interface SkillCardProps {
  skill: SkillMetadata;
  index: number;
  rank?: number;
  installed: boolean;
  installing: boolean;
  onInstall: (skill: SkillMetadata) => void;
  onSelect: (skill: SkillMetadata) => void;
}

const SkillCard = React.memo(function SkillCard({
  skill,
  index,
  rank,
  installed,
  installing,
  onInstall,
  onSelect,
}: SkillCardProps) {
  return (
    <ContextMenu>
      <ContextMenuTrigger className="block h-full">
        <MagicCard
          gradientSize={160}
          gradientFrom="var(--primary)"
          gradientTo="var(--accent)"
          className="flex min-w-0 items-center justify-between gap-3 rounded-xl border bg-card/60 p-3.5 transition-all hover:border-primary/40 h-full shadow-xs"
        >
          <button
            aria-label={`查看技能 ${skill.name}`}
            className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 text-left"
            onClick={() => onSelect(skill)}
            type="button"
          >
            {/* 排名序号或技能图标 */}
            <div className="relative shrink-0">
              <span className="flex size-11 items-center justify-center rounded-xl bg-muted text-xl shadow-2xs">
                {skillIcon(skill, index)}
              </span>
              {rank !== undefined ? (
                <span
                  className={cn(
                    "absolute -top-1.5 -left-1.5 flex size-5 items-center justify-center rounded-full text-[10px] font-bold font-mono text-white shadow-xs",
                    rank === 1
                      ? "bg-amber-500"
                      : rank === 2
                        ? "bg-slate-400"
                        : rank === 3
                          ? "bg-amber-700"
                          : "bg-muted-foreground/80",
                  )}
                >
                  {rank}
                </span>
              ) : null}
            </div>

            <span className="min-w-0 flex-1">
              <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                <span
                  className="break-words font-medium text-foreground text-sm"
                  title={skill.name}
                >
                  {skill.name}
                </span>
                {skill.isOfficial ? (
                  <Badge
                    variant="outline"
                    className="text-[10px] px-1.5 py-0 h-4 font-normal text-emerald-600 dark:text-emerald-400 border-emerald-500/30 bg-emerald-500/10 shrink-0 gap-0.5"
                  >
                    <ShieldCheckIcon className="size-2.5" />
                    官方认证
                  </Badge>
                ) : (
                  <Badge
                    variant="outline"
                    className="text-[10px] px-1.5 py-0 h-4 font-normal text-muted-foreground shrink-0"
                  >
                    {skillSourceLabel(skill)}
                  </Badge>
                )}
                {skill.owner ? (
                  <span className="text-[11px] text-muted-foreground font-mono">
                    @{skill.owner}
                  </span>
                ) : null}
              </div>
              <span className="mt-1 line-clamp-2 text-xs text-muted-foreground leading-relaxed">
                {skill.description || "未提供描述"}
              </span>

              {/* 安装量与热度指标 */}
              <div className="mt-2 flex items-center gap-3 text-[11px] text-muted-foreground">
                {skill.installs ? (
                  <span className="flex items-center gap-1 font-mono">
                    <DownloadIcon className="size-3 text-muted-foreground/80" />
                    {formatInstalls(skill.installs)}
                  </span>
                ) : null}
                {skill.change ? (
                  <span className="flex items-center gap-0.5 text-rose-500 font-mono">
                    <FlameIcon className="size-3" />+{skill.change}
                  </span>
                ) : null}
              </div>
            </span>
          </button>
          {installed ? (
            <Badge variant="secondary" className="shrink-0 h-7 text-xs">
              <CheckIcon className="size-3 mr-1 text-emerald-500" />
              已安装
            </Badge>
          ) : (
            <Button
              disabled={installing}
              onClick={(event) => {
                event.stopPropagation();
                onInstall(skill);
              }}
              size="sm"
              variant="outline"
              className="shrink-0 h-7 text-xs"
            >
              {installing ? (
                <LoaderCircleIcon className="animate-spin size-3.5" />
              ) : (
                <PlusIcon className="size-3.5" />
              )}
              安装
            </Button>
          )}
        </MagicCard>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-48">
        <ContextMenuGroup>
          <ContextMenuLabel className="max-w-44 whitespace-normal break-words" title={skill.name}>
            {skill.name}
          </ContextMenuLabel>
          <ContextMenuItem onClick={() => onSelect(skill)}>
            <SparklesIcon className="text-muted-foreground" />
            <span>查看技能详情</span>
          </ContextMenuItem>
          <ContextMenuItem
            onClick={() => {
              void navigator.clipboard.writeText(skill.name);
              toast.success("已复制技能名称");
            }}
          >
            <CopyIcon className="text-muted-foreground" />
            <span>复制技能名称</span>
          </ContextMenuItem>
        </ContextMenuGroup>
        <ContextMenuSeparator />
        <ContextMenuGroup>
          {!installed ? (
            <ContextMenuItem onClick={() => onInstall(skill)}>
              <PlusIcon className="text-muted-foreground" />
              <span>安装此技能</span>
            </ContextMenuItem>
          ) : null}
        </ContextMenuGroup>
      </ContextMenuContent>
    </ContextMenu>
  );
});

function InstalledSection({
  skills,
  onSelect,
}: {
  skills: SkillMetadata[];
  onSelect: (skill: SkillMetadata) => void;
}) {
  return (
    <div className="mt-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">个人技能库</h2>
        <Badge variant="secondary">{skills.length}</Badge>
      </div>
      <Separator className="mt-4" />
      <div className="grid gap-x-12 md:grid-cols-2 mt-2">
        {skills.map((skill, index) => (
          <BlurFade delay={0.03 * index} duration={0.2} blur="3px" key={skill.name}>
            <ContextMenu>
              <ContextMenuTrigger className="w-full block">
                <button
                  className="flex w-full min-w-0 items-center gap-3 rounded-lg py-3 text-left transition-colors hover:bg-muted/40"
                  onClick={() => onSelect(skill)}
                  type="button"
                >
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted text-xl">
                    {skillIcon(skill, index)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block break-words font-medium text-sm" title={skill.name}>
                      {skill.name}
                    </span>
                    <span className="mt-1 block line-clamp-1 text-xs text-muted-foreground">
                      {skill.description || "未提供描述"}
                    </span>
                  </span>
                  <ChevronRightIcon className="ml-auto size-4 shrink-0 text-muted-foreground" />
                </button>
              </ContextMenuTrigger>
              <ContextMenuContent className="w-48">
                <ContextMenuGroup>
                  <ContextMenuLabel
                    className="max-w-44 whitespace-normal break-words"
                    title={skill.name}
                  >
                    {skill.name}
                  </ContextMenuLabel>
                  <ContextMenuItem onClick={() => onSelect(skill)}>
                    <SparklesIcon className="text-muted-foreground" />
                    <span>查看技能详情</span>
                  </ContextMenuItem>
                  <ContextMenuItem
                    onClick={() => {
                      void navigator.clipboard.writeText(skill.name);
                      toast.success("已复制技能名称");
                    }}
                  >
                    <CopyIcon className="text-muted-foreground" />
                    <span>复制技能名称</span>
                  </ContextMenuItem>
                </ContextMenuGroup>
              </ContextMenuContent>
            </ContextMenu>
          </BlurFade>
        ))}
      </div>
    </div>
  );
}

function McpSection({
  mcpServers,
  onDelete,
  onAuthenticate,
}: {
  mcpServers: McpSummary[];
  onDelete: (server: McpSummary) => void;
  onAuthenticate: (server: McpSummary) => void;
}) {
  return (
    <div className="mt-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold">MCP 外部能力</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            连接外部 MCP 服务，为 Agent 提供数据库、文件系统、终端和三方 API 访问支持。
          </p>
        </div>
        <Badge variant="secondary">{mcpServers.length} 个服务</Badge>
      </div>
      <Separator className="mt-4" />
      <div className="grid gap-3.5 md:grid-cols-2 mt-4">
        {mcpServers.map((server) => (
          <div
            className="flex items-start justify-between gap-3 rounded-xl border bg-card/60 p-4"
            key={server.id}
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="font-semibold text-sm">{server.name}</span>
                <Badge variant="outline" className="text-[10px] font-mono uppercase">
                  {server.transport}
                </Badge>
              </div>
              <p className="mt-1 text-xs text-muted-foreground break-all">
                {server.transport === "stdio" ? server.command : server.url}
              </p>
            </div>
            <div className="flex items-center gap-1">
              {server.transport === "http" && server.oauth?.enabled ? (
                <Button
                  size="icon-xs"
                  variant="ghost"
                  className="text-muted-foreground"
                  onClick={() => onAuthenticate(server)}
                  title="OAuth 授权"
                >
                  <ShieldCheckIcon className="size-3.5" />
                </Button>
              ) : null}
              <Button
                size="icon-xs"
                variant="ghost"
                className="text-muted-foreground hover:text-destructive"
                onClick={() => onDelete(server)}
                title="移除 MCP"
              >
                <Trash2Icon className="size-3.5" />
              </Button>
            </div>
          </div>
        ))}
        {mcpServers.length === 0 && (
          <EmptyState label="还没有配置 MCP 外部能力" icon={<PlugZapIcon className="size-8" />} />
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
          <Button className="mb-6" onClick={onBack} variant="ghost" size="sm">
            <ArrowLeftIcon className="size-4 mr-1" />
            返回技能市场
          </Button>
          {detail ? (
            <>
              <header className="flex flex-wrap items-start justify-between gap-5">
                <div className="flex items-start gap-4">
                  <span className="flex size-20 items-center justify-center rounded-2xl bg-muted text-5xl shrink-0 shadow-xs">
                    {skillIcon(detail)}
                  </span>
                  <div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <h1 className="text-3xl font-semibold tracking-tight">{detail.name}</h1>
                      {detail.isOfficial ? (
                        <Badge
                          variant="outline"
                          className="text-xs px-2 py-0.5 font-normal text-emerald-600 dark:text-emerald-400 border-emerald-500/30 bg-emerald-500/10 gap-1"
                        >
                          <ShieldCheckIcon className="size-3.5" />
                          官方原厂认证
                        </Badge>
                      ) : null}
                    </div>
                    <p className="mt-2 max-w-2xl text-base text-muted-foreground">
                      {detail.description || "未提供描述"}
                    </p>
                    <div className="mt-3 flex items-center gap-2 flex-wrap">
                      <Badge variant="outline">{skillSourceLabel(detail)}</Badge>
                      {detail.installs ? (
                        <Badge variant="secondary" className="font-mono text-xs gap-1">
                          <DownloadIcon className="size-3" />
                          {formatInstalls(detail.installs)} 次安装
                        </Badge>
                      ) : null}
                      {detail.sourceUrl ? (
                        <a
                          href={detail.sourceUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="text-xs text-primary hover:underline flex items-center gap-1 ml-2"
                        >
                          <GlobeIcon className="size-3.5" />
                          查看源仓库
                          <ArrowUpRightIcon className="size-3" />
                        </a>
                      ) : null}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {installed ? (
                    <Button onClick={onRemove} variant="outline">
                      <Trash2Icon className="size-4 mr-1 text-destructive" />
                      移除技能
                    </Button>
                  ) : (
                    <Button disabled={installing} onClick={onInstall}>
                      {installing ? (
                        <LoaderCircleIcon className="animate-spin size-4 mr-1" />
                      ) : (
                        <PlusIcon className="size-4 mr-1" />
                      )}
                      安装技能
                    </Button>
                  )}
                </div>
              </header>

              {/* 官方认证说明横幅 */}
              {detail.isOfficial ? (
                <div className="mt-6 flex items-center gap-2.5 rounded-xl bg-emerald-500/10 border border-emerald-500/20 p-3.5 text-xs text-emerald-800 dark:text-emerald-300">
                  <ShieldCheckIcon className="size-5 shrink-0 text-emerald-500" />
                  <span>
                    <strong>技术原厂权威认证</strong>
                    ：该技能由产品官方团队维护，符合第一方工具规范与自动化调用安全要求。
                  </span>
                </div>
              ) : null}

              {/* 安全审计卡片区 */}
              {detail.audits && detail.audits.length > 0 ? (
                <section className="mt-8">
                  <h2 className="text-lg font-semibold flex items-center gap-2">
                    <ShieldCheckIcon className="size-5 text-emerald-500" />
                    多维度安全审计
                  </h2>
                  <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {detail.audits.map((audit) => (
                      <div
                        key={audit.slug || audit.provider}
                        className="rounded-xl border bg-card/60 p-3.5 flex flex-col justify-between"
                      >
                        <div className="flex items-center justify-between">
                          <span className="font-medium text-xs text-foreground uppercase tracking-wide">
                            {audit.provider}
                          </span>
                          <Badge
                            variant="outline"
                            className={cn(
                              "text-[10px] px-1.5 py-0 h-4 font-normal",
                              audit.status === "pass"
                                ? "border-emerald-500/30 text-emerald-600 dark:text-emerald-400 bg-emerald-500/10"
                                : "border-amber-500/30 text-amber-600 dark:text-amber-400 bg-amber-500/10",
                            )}
                          >
                            {audit.status === "pass" ? "Pass (安全通过)" : "Warn (需复核)"}
                          </Badge>
                        </div>
                        <p className="text-xs text-muted-foreground mt-2">{audit.summary}</p>
                        {audit.riskLevel ? (
                          <span className="text-[10px] text-muted-foreground/80 mt-2">
                            风险等级: <span className="font-mono">{audit.riskLevel}</span>
                          </span>
                        ) : null}
                      </div>
                    ))}
                  </div>
                </section>
              ) : null}

              {/* 示例提示词 */}
              <section className="mt-8 w-full min-w-0 rounded-xl border bg-muted/20 p-4 sm:p-5">
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

              {/* 技能说明与系统提示词 */}
              <section className="mt-8 w-full min-w-0">
                <h2 className="text-lg font-semibold">技能指令与执行说明</h2>
                <div className="mt-3 min-w-0 rounded-xl border bg-muted/30 p-4">
                  <MessageResponse className="w-full max-w-none text-sm leading-relaxed">
                    {detail.instructions}
                  </MessageResponse>
                </div>
              </section>

              {/* 关联文件与资源包 */}
              <section className="mt-8">
                <h2 className="text-lg font-semibold">
                  技能关联文件{" "}
                  {detail.references.length + detail.scripts.length + detail.assets.length > 0 ? (
                    <span className="text-sm font-normal text-muted-foreground">
                      ({detail.references.length + detail.scripts.length + detail.assets.length})
                    </span>
                  ) : null}
                </h2>
                <Separator className="mt-3" />
                <div className="divide-y">
                  {detail.references.map((item) => (
                    <div className="flex items-center gap-3 py-3" key={`ref-${item}`}>
                      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-blue-500/10 text-blue-500">
                        <BookOpenIcon className="size-4" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <div className="flex min-w-0 items-center gap-2">
                          <span
                            className="block min-w-0 flex-1 truncate font-medium text-foreground text-sm"
                            title={item}
                          >
                            {item}
                          </span>
                          <Badge
                            variant="outline"
                            className="text-[10px] px-1.5 py-0 h-4 font-normal text-blue-600 dark:text-blue-400"
                          >
                            参考文档
                          </Badge>
                        </div>
                        <span className="mt-0.5 block text-xs text-muted-foreground">
                          技能执行时引用的领域知识、规范说明或 API 参考手册
                        </span>
                      </span>
                    </div>
                  ))}
                  {detail.scripts.map((item) => (
                    <div className="flex items-center gap-3 py-3" key={`script-${item}`}>
                      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-500">
                        <TerminalIcon className="size-4" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <div className="flex min-w-0 items-center gap-2">
                          <span
                            className="block min-w-0 flex-1 truncate font-medium text-foreground text-sm"
                            title={item}
                          >
                            {item}
                          </span>
                          <Badge
                            variant="outline"
                            className="text-[10px] px-1.5 py-0 h-4 font-normal text-emerald-600 dark:text-emerald-400"
                          >
                            执行脚本
                          </Badge>
                        </div>
                        <span className="mt-0.5 block text-xs text-muted-foreground">
                          供 Agent 调用的可执行自动化脚本或分析程序
                        </span>
                      </span>
                    </div>
                  ))}
                  {detail.assets.map((item) => (
                    <div className="flex items-center gap-3 py-3" key={`asset-${item}`}>
                      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-amber-500/10 text-amber-500">
                        <FileCodeIcon className="size-4" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <div className="flex min-w-0 items-center gap-2">
                          <span
                            className="block min-w-0 flex-1 truncate font-medium text-foreground text-sm"
                            title={item}
                          >
                            {item}
                          </span>
                          <Badge
                            variant="outline"
                            className="text-[10px] px-1.5 py-0 h-4 font-normal text-amber-600 dark:text-amber-400"
                          >
                            资源模版
                          </Badge>
                        </div>
                        <span className="mt-0.5 block text-xs text-muted-foreground">
                          模版代码、样式文件、静态数据或媒体资源
                        </span>
                      </span>
                    </div>
                  ))}
                  {detail.references.length + detail.scripts.length + detail.assets.length ===
                    0 && (
                    <div className="py-5 text-sm text-muted-foreground">
                      <p className="font-medium text-foreground/80">此技能为纯指令型技能</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        由 <code className="rounded bg-muted px-1 py-0.5 font-mono">SKILL.md</code>{" "}
                        中的系统提示词与执行规则全权驱动，无需额外附带脚本或资源文件。
                      </p>
                    </div>
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
                <p className="break-words text-sm font-medium" title={marketplace.name}>
                  {marketplace.name}
                </p>
                <p
                  className="break-all text-xs text-muted-foreground"
                  title={`${marketplace.url} · ${marketplace.branch}`}
                >
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
