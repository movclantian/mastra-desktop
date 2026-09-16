import {
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
  LayoutGridIcon,
  ListIcon,
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
import { createPortal } from "react-dom";
import { toast } from "sonner";
import type {
  LeaderboardView,
  MarketCategory,
  McpSummary,
  SkillDetail,
  SkillMarketplace,
  SkillSection,
} from "@/entities/skill";
import {
  deleteSkillMarketplace,
  fetchSkillDetail,
  formatInstalls,
  getPaginationRange,
  type SkillMetadata,
  saveSkillMarketplace,
  skillIcon,
  skillSourceLabel,
} from "@/entities/skill";
import { useWorkbench } from "@/entities/workbench";
import { useSkillActions, useSkillHubData } from "@/features/skill-actions";
import { cn, toastError } from "@/shared/lib";
import { MessageResponse } from "@/shared/ui/ai-elements/message";
import { AnimatedGradientText } from "@/shared/ui/animated-gradient-text";
import { AnimatedTabs } from "@/shared/ui/animated-tabs";
import { Badge } from "@/shared/ui/badge";
import { BlurFade } from "@/shared/ui/blur-fade";
import { Button } from "@/shared/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/shared/ui/context-menu";
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
import { Dotm3x3_11 } from "@/shared/ui/dotm-3x3-11";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/shared/ui/field";
import { Input } from "@/shared/ui/input";
import { InteractiveHoverButton } from "@/shared/ui/interactive-hover-button";
import { MagicCard } from "@/shared/ui/magic-card";
import { Marquee } from "@/shared/ui/marquee";
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
} from "@/shared/ui/pagination";
import { ScrollArea, ScrollBar } from "@/shared/ui/scroll-area";
import { Separator } from "@/shared/ui/separator";
import { Textarea } from "@/shared/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/shared/ui/toggle-group";
import { McpDialog } from "@/widgets/mcp-dialog";

export function SkillHubPage() {
  const { setPendingPrompt, setActiveView, activeSkill, setActiveSkill } = useWorkbench();
  const [section, setSection] = React.useState<SkillSection>("public");
  const [marketCategory, setMarketCategory] = React.useState<MarketCategory>("leaderboard");
  const [leaderboardView, setLeaderboardView] = React.useState<LeaderboardView>("all-time");
  const [selectedMaker, setSelectedMaker] = React.useState<string | null>(null);

  const [query, setQuery] = React.useState("");
  const [page, setPage] = React.useState(1);
  const [pageSize, setPageSize] = React.useState(24);
  const scrollAreaRef = React.useRef<HTMLDivElement>(null);
  const searchInputRef = React.useRef<HTMLInputElement>(null);

  const {
    skills,
    displaySkills,
    totalSkillsCount,
    registrySkills,
    curatedOwners,
    mcpServers,
    marketplaces,
    detail,
    setDetail,
    detailLoading,
    detailError,
    loading,
    listLoading,
    registryLoading,
    curatedLoading,
    loadInstalled,
    loadMcp,
    loadMarketplaces,
    loadRegistry,
    refreshAll,
  } = useSkillHubData({
    activeSkill,
    query,
    section,
    marketCategory,
    leaderboardView,
    selectedMaker,
    page,
    pageSize,
  });
  const [addSkillOpen, setAddSkillOpen] = React.useState(false);
  const [mcpOpen, setMcpOpen] = React.useState(false);
  const [editingMcp, setEditingMcp] = React.useState<McpSummary | null>(null);
  const [editingSkill, setEditingSkill] = React.useState<SkillMetadata | null>(null);
  const [marketplacesOpen, setMarketplacesOpen] = React.useState(false);
  const {
    inputRef,
    installing,
    uploading,
    uploadSkill,
    importSkill,
    installBuiltin,
    removeSkill,
    updateSkill,
    removeMcp,
    authenticateMcp,
  } = useSkillActions({
    activeSkill,
    setActiveSkill,
    setDetail,
    setSection,
    setAddSkillOpen,
    loadInstalled,
    loadMcp,
  });

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
          isOfficial: s.isOfficial ?? true,
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

  const totalPages = Math.max(1, Math.ceil(totalSkillsCount / pageSize));
  const currentSkills = displaySkills;

  const sourceCounts = React.useMemo(() => {
    return {
      all: registrySkills.length,
      official: officialSkills.length || 340,
      skillsSh: registrySkills.filter((s) => s.origin === "skills-sh").length,
      builtin: registrySkills.filter((s) => s.origin === "builtin").length,
      marketplace: registrySkills.filter((s) => s.origin === "marketplace").length,
    };
  }, [officialSkills.length, registrySkills]);

  if (activeSkill) {
    return (
      <>
        <SkillDetailPage
          detail={detail}
          detailError={detailError}
          detailLoading={detailLoading}
          installed={skills.some((skill) => skill.name === activeSkill.name)}
          onInstall={() => void installBuiltin(activeSkill)}
          onRemove={() => void removeSkill()}
          onEdit={() => setEditingSkill(activeSkill)}
          onUsePrompt={(prompt) => {
            setPendingPrompt(`${activeSkill.name} ${prompt}`);
            setActiveView("chat");
          }}
          installing={installing === activeSkill.name}
        />
        <SkillEditDialog
          open={Boolean(editingSkill)}
          onOpenChange={(open) => {
            if (!open) setEditingSkill(null);
          }}
          skill={editingSkill}
          onSave={async (name, patch) => {
            await updateSkill(name, patch);
          }}
        />
      </>
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
          <section className="mt-2">
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

          {/* 官方精选滚动带:被动浏览发现新技能 —— 悬停暂停后仍可点击进详情。
              与上方「已启用技能」的手动横滚分工明确:那边是找我装过的,这里是逛新的。 */}
          {officialSkills.length > 0 ? (
            <section className="mt-2">
              <div className="flex items-center justify-between">
                <AnimatedGradientText
                  className="text-sm font-semibold tracking-tight"
                  colorFrom="var(--primary)"
                  colorTo="var(--accent)"
                >
                  精选推荐
                </AnimatedGradientText>
              </div>
              <Marquee className="mt-2 [--duration:52s] [--gap:0.625rem]" pauseOnHover repeat={3}>
                {officialSkills.slice(0, 14).map((skill, index) => (
                  <button
                    key={skill.path ?? skill.name}
                    type="button"
                    onClick={() => setActiveSkill(skill)}
                    title={skill.description || skill.name}
                    className="flex w-56 shrink-0 cursor-pointer items-center gap-2.5 rounded-xl border bg-card p-2.5 text-left shadow-2xs transition-colors hover:border-primary/40 hover:bg-accent"
                  >
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-base">
                      {skillIcon(skill, index)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-medium">{skill.name}</span>
                      <span className="block truncate text-[11px] text-muted-foreground">
                        {skill.description || "官方认证技能"}
                      </span>
                    </span>
                  </button>
                ))}
              </Marquee>
            </section>
          ) : null}

          {/* 一级功能标签切换 (探索市场 / 个人管理 / MCP 外部能力) */}
          <div className="mt-2 flex items-center justify-between border-b pb-1">
            <AnimatedTabs
              activeTab={section}
              onChange={(value) => setSection(value as SkillSection)}
              layoutId="skill-hub-section"
              variant="line"
              aria-label="技能中心分区"
              className="border-b-0 pb-0 text-sm"
              tabs={[
                {
                  id: "public",
                  label: "探索市场",
                  icon: <StoreIcon className="size-4" />,
                },
                {
                  id: "personal",
                  label: "个人管理",
                  icon: <SparklesIcon className="size-4" />,
                  badge:
                    skills.length > 0 ? (
                      <Badge variant="secondary" className="h-4 px-1 text-[10px]">
                        {skills.length}
                      </Badge>
                    ) : null,
                },
                {
                  id: "mcp",
                  label: "MCP 外部工具",
                  icon: <PlugZapIcon className="size-4" />,
                  badge:
                    mcpServers.length > 0 ? (
                      <Badge variant="secondary" className="h-4 px-1 text-[10px]">
                        {mcpServers.length}
                      </Badge>
                    ) : null,
                },
              ]}
            />
          </div>

          {/* 市场 / 个人 / MCP 内容区域 */}
          {section === "mcp" ? (
            <McpSection
              mcpServers={mcpServers}
              onDelete={(server) => void removeMcp(server)}
              onAuthenticate={(server) => void authenticateMcp(server)}
              onEdit={(server) => {
                setEditingMcp(server);
                setMcpOpen(true);
              }}
              onAddMcp={() => {
                setEditingMcp(null);
                setMcpOpen(true);
              }}
            />
          ) : section === "personal" ? (
            <InstalledSection
              skills={visibleInstalled}
              onSelect={setActiveSkill}
              onEdit={(skill) => setEditingSkill(skill)}
              onDelete={(skill) => void removeSkill(skill)}
              onAddSkill={() => setAddSkillOpen(true)}
              onExploreMarket={() => setSection("public")}
            />
          ) : (
            <div className="mt-2 space-y-4">
              {/* 1. 市场类目与厂商导航栏 (排版：社区排行榜 -> 原厂认证与各厂商标签 -> Mastra 内置 -> GitHub 市场) */}
              <ScrollArea className="w-full whitespace-nowrap">
                <div className="flex items-center gap-2 pb-1">
                  {/* 社区排行榜 */}
                  <Button
                    size="sm"
                    variant={marketCategory === "leaderboard" ? "secondary" : "outline"}
                    onClick={() => {
                      setMarketCategory("leaderboard");
                      setSelectedMaker(null);
                      setPage(1);
                    }}
                    className="rounded-full text-xs font-medium gap-1.5 h-8 shrink-0"
                  >
                    <FlameIcon className="size-3.5 text-rose-500" />
                    <span>🔥 社区排行榜</span>
                    <Badge variant="secondary" className="text-[10px] px-1 py-0 h-4 ml-0.5">
                      {sourceCounts.skillsSh}
                    </Badge>
                  </Button>

                  {/* 官方原厂认证 */}
                  <Button
                    size="sm"
                    variant={
                      marketCategory === "official" && selectedMaker === null
                        ? "secondary"
                        : "outline"
                    }
                    onClick={() => {
                      setMarketCategory("official");
                      setSelectedMaker(null);
                      setPage(1);
                    }}
                    className="rounded-full text-xs font-medium gap-1.5 h-8 shrink-0"
                  >
                    <ShieldCheckIcon className="size-3.5 text-emerald-500" />
                    <span>⭐ 原厂认证</span>
                    <Badge variant="secondary" className="text-[10px] px-1 py-0 h-4 ml-0.5">
                      {sourceCounts.official}
                    </Badge>
                  </Button>

                  {/* 紧随在后面的各官方与创作者厂商标签 */}
                  {curatedOwners.map((owner) => (
                    <Button
                      key={owner.owner}
                      size="sm"
                      variant={
                        marketCategory === "official" && selectedMaker === owner.owner
                          ? "secondary"
                          : "outline"
                      }
                      className="rounded-full text-xs h-8 font-mono gap-1 shrink-0"
                      onClick={() => {
                        setMarketCategory("official");
                        setSelectedMaker(selectedMaker === owner.owner ? null : owner.owner);
                        setPage(1);
                      }}
                    >
                      <span>@{owner.owner}</span>
                      {owner.skills?.length > 0 ? (
                        <span className="text-[10px] opacity-70">({owner.skills.length})</span>
                      ) : null}
                    </Button>
                  ))}

                  {/* Mastra 内置 */}
                  <Button
                    size="sm"
                    variant={marketCategory === "builtin" ? "secondary" : "outline"}
                    onClick={() => {
                      setMarketCategory("builtin");
                      setSelectedMaker(null);
                      setPage(1);
                    }}
                    className="rounded-full text-xs font-medium gap-1.5 h-8 shrink-0"
                  >
                    <SparklesIcon className="size-3.5 text-blue-500" />
                    <span>✨ Mastra 内置</span>
                    <Badge variant="secondary" className="text-[10px] px-1 py-0 h-4 ml-0.5">
                      {sourceCounts.builtin}
                    </Badge>
                  </Button>

                  {/* GitHub 市场 */}
                  {sourceCounts.marketplace > 0 ? (
                    <Button
                      size="sm"
                      variant={marketCategory === "marketplace" ? "secondary" : "outline"}
                      onClick={() => {
                        setMarketCategory("marketplace");
                        setSelectedMaker(null);
                        setPage(1);
                      }}
                      className="rounded-full text-xs font-medium gap-1.5 h-8 shrink-0"
                    >
                      <StoreIcon className="size-3.5 text-purple-500" />
                      <span>📦 GitHub 市场</span>
                      <Badge variant="secondary" className="text-[10px] px-1 py-0 h-4 ml-0.5">
                        {sourceCounts.marketplace}
                      </Badge>
                    </Button>
                  ) : null}
                </div>
                <ScrollBar orientation="horizontal" />
              </ScrollArea>

              {/* 2. 社区排行榜子榜单切换 (总榜 / 飙升 / 热门) */}
              {marketCategory === "leaderboard" ? (
                <div className="flex items-center gap-2 border-b pb-3">
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
              ) : null}

              {/* 3. 官方厂商选定时提示与快速清除 */}
              {marketCategory === "official" && selectedMaker ? (
                <div className="flex items-center justify-between border-b pb-2 text-xs text-muted-foreground">
                  <span>
                    已筛选厂商：
                    <strong className="font-mono text-foreground">@{selectedMaker}</strong> (
                    {currentSkills.length} 个技能)
                  </span>
                  <Button
                    size="xs"
                    variant="ghost"
                    className="h-6 text-xs text-muted-foreground hover:text-foreground"
                    onClick={() => {
                      setSelectedMaker(null);
                      setPage(1);
                    }}
                  >
                    清除厂商筛选
                  </Button>
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
              {loading || listLoading || (registryLoading && registrySkills.length === 0) ? (
                <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
                  <Dotm3x3_1 size={18} dotSize={2.6} colorPreset="solid-theme" />
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
                <div className="mt-2 flex flex-col sm:flex-row items-center justify-between gap-4 border-t pt-5">
                  <span className="text-xs text-muted-foreground">
                    共 {totalSkillsCount} 个技能 · 第 {page} / {totalPages} 页 · 每页 {pageSize} 条
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
      <McpDialog
        open={mcpOpen}
        onOpenChange={(open) => {
          setMcpOpen(open);
          if (!open) setEditingMcp(null);
        }}
        onSaved={() => void loadMcp()}
        server={editingMcp}
      />
      <SkillEditDialog
        open={Boolean(editingSkill)}
        onOpenChange={(open) => {
          if (!open) setEditingSkill(null);
        }}
        skill={editingSkill}
        onSave={async (name, patch) => {
          await updateSkill(name, patch);
        }}
      />
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
          gradientSize={190}
          gradientFrom="var(--primary)"
          gradientTo="var(--accent)"
          className="flex h-full min-w-0 items-center justify-between gap-3 rounded-xl border border-border bg-card p-3.5 shadow-xs transition-colors duration-200 hover:border-primary/40"
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
            <InteractiveHoverButton
              className="h-7 shrink-0 border-primary/30 px-4 py-0 text-xs font-medium"
              onClick={(event) => {
                event.stopPropagation();
                if (!installing) onInstall(skill);
              }}
            >
              {installing ? "安装中" : "安装"}
            </InteractiveHoverButton>
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
  onEdit,
  onDelete,
  onAddSkill,
  onExploreMarket,
}: {
  skills: SkillMetadata[];
  onSelect: (skill: SkillMetadata) => void;
  onEdit?: (skill: SkillMetadata) => void;
  onDelete?: (skill: SkillMetadata) => void;
  onAddSkill?: () => void;
  onExploreMarket?: () => void;
}) {
  const [viewMode, setViewMode] = React.useState<"grid" | "list">("grid");
  const [page, setPage] = React.useState(1);
  const pageSize = 12;

  const totalPages = Math.max(1, Math.ceil(skills.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const paginated = React.useMemo(() => {
    return skills.slice((safePage - 1) * pageSize, safePage * pageSize);
  }, [skills, safePage, pageSize]);

  return (
    <div className="mt-2">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-xl font-semibold">个人技能库</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            当前已安装到本机的技能与插件，可在与 Agent 对话时直接调度。
          </p>
        </div>
        <div className="flex items-center gap-2.5">
          <Badge variant="secondary">{skills.length} 个技能</Badge>
          <ToggleGroup
            className="h-8"
            variant="outline"
            value={[viewMode]}
            onValueChange={(next) => {
              const value = next[0];
              if (value === "grid" || value === "list") setViewMode(value);
            }}
          >
            <ToggleGroupItem value="grid" aria-label="网格视图" className="size-8 p-0">
              <LayoutGridIcon className="size-3.5" />
            </ToggleGroupItem>
            <ToggleGroupItem value="list" aria-label="列表视图" className="size-8 p-0">
              <ListIcon className="size-3.5" />
            </ToggleGroupItem>
          </ToggleGroup>
          {onAddSkill ? (
            <Button size="sm" onClick={onAddSkill} className="gap-1.5 h-8">
              <PlusIcon className="size-3.5" />
              导入本地技能
            </Button>
          ) : null}
        </div>
      </div>
      <Separator className="mt-4" />
      {skills.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <span className="flex size-14 items-center justify-center rounded-2xl bg-muted/60 text-muted-foreground mb-3 shadow-2xs">
            <SparklesIcon className="size-7" />
          </span>
          <h3 className="text-base font-semibold">暂未安装任何技能</h3>
          <p className="mt-1 max-w-sm text-xs text-muted-foreground">
            你可以在「探索市场」中直接一键安装社区或官方认证技能，也可以导入本地包含 SKILL.md 的 ZIP
            技能包。
          </p>
          <div className="mt-2 flex items-center gap-3">
            {onExploreMarket ? (
              <Button size="sm" onClick={onExploreMarket} className="gap-1.5 cursor-pointer">
                <StoreIcon className="size-3.5" />
                去市场挑选
              </Button>
            ) : null}
            {onAddSkill ? (
              <Button
                size="sm"
                variant="outline"
                onClick={onAddSkill}
                className="gap-1.5 cursor-pointer"
              >
                <FolderOpenIcon className="size-3.5" />
                导入本地技能
              </Button>
            ) : null}
          </div>
        </div>
      ) : viewMode === "grid" ? (
        <div className="grid gap-3.5 md:grid-cols-2 mt-4">
          {paginated.map((skill, index) => (
            <BlurFade delay={0.02 * index} duration={0.2} blur="3px" key={skill.name}>
              <ContextMenu>
                <ContextMenuTrigger className="w-full block">
                  <div
                    className="group relative flex w-full min-w-0 items-center justify-between gap-3 rounded-xl border border-border bg-card p-3.5 text-left transition-all duration-200 hover:border-primary/40 hover:bg-card/90 cursor-pointer shadow-xs"
                    onClick={() => onSelect(skill)}
                  >
                    <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted text-xl shadow-2xs">
                      {skillIcon(skill, index)}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span
                          className="block truncate font-medium text-sm text-foreground"
                          title={skill.name}
                        >
                          {skill.name}
                        </span>
                        <Badge variant="outline" className="text-[10px] px-1 py-0 h-4">
                          {skillSourceLabel(skill)}
                        </Badge>
                      </div>
                      <span className="mt-0.5 block line-clamp-1 text-xs text-muted-foreground">
                        {skill.description || "未提供描述"}
                      </span>
                    </div>
                    <div
                      className="flex items-center gap-1 shrink-0"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {onEdit ? (
                        <Button
                          size="icon-xs"
                          variant="ghost"
                          className="size-7 text-muted-foreground hover:text-foreground cursor-pointer"
                          onClick={() => onEdit(skill)}
                          title="编辑技能配置"
                        >
                          <PencilIcon className="size-3.5" />
                        </Button>
                      ) : null}
                      {onDelete ? (
                        <Button
                          size="icon-xs"
                          variant="ghost"
                          className="size-7 text-muted-foreground hover:text-destructive cursor-pointer"
                          onClick={() => onDelete(skill)}
                          title="删除技能"
                        >
                          <Trash2Icon className="size-3.5" />
                        </Button>
                      ) : null}
                      <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground ml-0.5" />
                    </div>
                  </div>
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
                    {onEdit ? (
                      <ContextMenuItem onClick={() => onEdit(skill)}>
                        <PencilIcon className="text-muted-foreground" />
                        <span>编辑技能配置</span>
                      </ContextMenuItem>
                    ) : null}
                    <ContextMenuItem
                      onClick={() => {
                        void navigator.clipboard.writeText(skill.name);
                        toast.success("已复制技能名称");
                      }}
                    >
                      <CopyIcon className="text-muted-foreground" />
                      <span>复制技能名称</span>
                    </ContextMenuItem>
                    {onDelete ? (
                      <>
                        <ContextMenuSeparator />
                        <ContextMenuItem
                          className="text-destructive focus:text-destructive"
                          onClick={() => onDelete(skill)}
                        >
                          <Trash2Icon className="text-destructive" />
                          <span>删除技能</span>
                        </ContextMenuItem>
                      </>
                    ) : null}
                  </ContextMenuGroup>
                </ContextMenuContent>
              </ContextMenu>
            </BlurFade>
          ))}
        </div>
      ) : (
        <div className="flex flex-col gap-2 mt-4">
          {paginated.map((skill, index) => (
            <BlurFade delay={0.02 * index} duration={0.2} blur="3px" key={skill.name}>
              <ContextMenu>
                <ContextMenuTrigger className="w-full block">
                  <div
                    className="group flex items-center justify-between gap-4 rounded-xl border border-border bg-card/60 px-4 py-3 text-left transition-all duration-200 hover:border-primary/40 hover:bg-card shadow-2xs cursor-pointer"
                    onClick={() => onSelect(skill)}
                  >
                    <div className="flex items-center gap-3 min-w-0 flex-1">
                      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-lg shadow-2xs">
                        {skillIcon(skill, index)}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span
                            className="truncate font-medium text-sm text-foreground"
                            title={skill.name}
                          >
                            {skill.name}
                          </span>
                          <Badge variant="outline" className="text-[10px] px-1 py-0 h-4">
                            {skillSourceLabel(skill)}
                          </Badge>
                        </div>
                        <p
                          className="mt-0.5 truncate text-xs text-muted-foreground"
                          title={skill.description}
                        >
                          {skill.description || "未提供描述"}
                        </p>
                      </div>
                    </div>
                    <div
                      className="flex items-center gap-1 shrink-0"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {onEdit ? (
                        <Button
                          size="icon-xs"
                          variant="ghost"
                          className="size-7 text-muted-foreground hover:text-foreground cursor-pointer"
                          onClick={() => onEdit(skill)}
                          title="编辑技能配置"
                        >
                          <PencilIcon className="size-3.5" />
                        </Button>
                      ) : null}
                      {onDelete ? (
                        <Button
                          size="icon-xs"
                          variant="ghost"
                          className="size-7 text-muted-foreground hover:text-destructive cursor-pointer"
                          onClick={() => onDelete(skill)}
                          title="删除技能"
                        >
                          <Trash2Icon className="size-3.5" />
                        </Button>
                      ) : null}
                      <ChevronRightIcon className="size-4 text-muted-foreground ml-1 transition-transform group-hover:translate-x-0.5" />
                    </div>
                  </div>
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
                    {onEdit ? (
                      <ContextMenuItem onClick={() => onEdit(skill)}>
                        <PencilIcon className="text-muted-foreground" />
                        <span>编辑技能配置</span>
                      </ContextMenuItem>
                    ) : null}
                    <ContextMenuItem
                      onClick={() => {
                        void navigator.clipboard.writeText(skill.name);
                        toast.success("已复制技能名称");
                      }}
                    >
                      <CopyIcon className="text-muted-foreground" />
                      <span>复制技能名称</span>
                    </ContextMenuItem>
                    {onDelete ? (
                      <>
                        <ContextMenuSeparator />
                        <ContextMenuItem
                          className="text-destructive focus:text-destructive"
                          onClick={() => onDelete(skill)}
                        >
                          <Trash2Icon className="text-destructive" />
                          <span>删除技能</span>
                        </ContextMenuItem>
                      </>
                    ) : null}
                  </ContextMenuGroup>
                </ContextMenuContent>
              </ContextMenu>
            </BlurFade>
          ))}
        </div>
      )}

      {totalPages > 1 ? (
        <div className="mt-4 flex flex-col sm:flex-row items-center justify-between gap-3 border-t pt-4">
          <span className="text-xs text-muted-foreground">
            第 {safePage} / {totalPages} 页 · 共 {skills.length} 个技能 · 每页 {pageSize} 条
          </span>
          <Pagination className="mx-0 w-auto">
            <PaginationContent>
              <PaginationItem>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={safePage <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  className="gap-1 pl-2.5 h-8 text-xs cursor-pointer"
                >
                  <ChevronLeftIcon className="size-3.5" />
                  <span>上一页</span>
                </Button>
              </PaginationItem>
              {getPaginationRange(safePage, totalPages).map((item, idx) => (
                <PaginationItem key={typeof item === "number" ? item : `ellipsis-${idx}`}>
                  {item === "..." ? (
                    <PaginationEllipsis />
                  ) : (
                    <Button
                      variant={safePage === item ? "outline" : "ghost"}
                      size="icon"
                      className="size-8 text-xs font-mono cursor-pointer"
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
                  disabled={safePage >= totalPages}
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  className="gap-1 pr-2.5 h-8 text-xs cursor-pointer"
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
  );
}

function McpSection({
  mcpServers,
  onDelete,
  onAuthenticate,
  onEdit,
  onAddMcp,
}: {
  mcpServers: McpSummary[];
  onDelete: (server: McpSummary) => void;
  onAuthenticate: (server: McpSummary) => void;
  onEdit?: (server: McpSummary) => void;
  onAddMcp?: () => void;
}) {
  const [viewMode, setViewMode] = React.useState<"grid" | "list">("grid");
  const [page, setPage] = React.useState(1);
  const pageSize = 10;

  const totalPages = Math.max(1, Math.ceil(mcpServers.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const paginated = React.useMemo(() => {
    return mcpServers.slice((safePage - 1) * pageSize, safePage * pageSize);
  }, [mcpServers, safePage, pageSize]);

  return (
    <div className="mt-2">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-xl font-semibold">MCP 外部能力</h2>
            <Badge variant="secondary">{mcpServers.length} 个服务</Badge>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            连接外部 MCP 服务，为 Agent 提供数据库、文件系统、终端和三方 API 访问支持。
          </p>
        </div>
        <div className="flex items-center gap-2.5">
          <ToggleGroup
            className="h-8"
            variant="outline"
            value={[viewMode]}
            onValueChange={(next) => {
              const value = next[0];
              if (value === "grid" || value === "list") setViewMode(value);
            }}
          >
            <ToggleGroupItem value="grid" aria-label="网格视图" className="size-8 p-0">
              <LayoutGridIcon className="size-3.5" />
            </ToggleGroupItem>
            <ToggleGroupItem value="list" aria-label="列表视图" className="size-8 p-0">
              <ListIcon className="size-3.5" />
            </ToggleGroupItem>
          </ToggleGroup>
          {onAddMcp ? (
            <Button size="sm" onClick={onAddMcp} className="gap-1.5 h-8 cursor-pointer">
              <PlusIcon className="size-3.5" />
              添加 MCP
            </Button>
          ) : null}
        </div>
      </div>
      <Separator className="mt-4" />
      {mcpServers.length === 0 ? (
        <div className="py-16 flex flex-col items-center justify-center text-center">
          <span className="flex size-14 items-center justify-center rounded-2xl bg-muted/60 text-muted-foreground mb-3 shadow-2xs">
            <PlugZapIcon className="size-7" />
          </span>
          <h3 className="text-base font-semibold">还没有配置 MCP 外部能力</h3>
          <p className="mt-1 max-w-sm text-xs text-muted-foreground">
            你可以连接远程 Streamable HTTP / SSE 服务或本地 stdio 进程，为 Agent 扩展工具库。
          </p>
          {onAddMcp ? (
            <Button size="sm" onClick={onAddMcp} className="gap-1.5 mt-4 cursor-pointer">
              <PlusIcon className="size-3.5" />
              添加第一个 MCP 服务
            </Button>
          ) : null}
        </div>
      ) : viewMode === "grid" ? (
        <div className="grid gap-3.5 md:grid-cols-2 mt-4">
          {paginated.map((server) => (
            <div
              className="flex items-start justify-between gap-3 rounded-xl border bg-card/60 p-4 shadow-xs hover:border-primary/40 transition-colors"
              key={server.id}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-sm">{server.name}</span>
                  <Badge variant="outline" className="text-[10px] font-mono uppercase">
                    {server.transport}
                  </Badge>
                </div>
                <p className="mt-1 text-xs text-muted-foreground break-all font-mono">
                  {server.transport === "stdio" ? server.command : server.url}
                </p>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                {server.transport === "http" && server.oauth?.enabled ? (
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    className="text-muted-foreground hover:text-foreground cursor-pointer"
                    onClick={() => onAuthenticate(server)}
                    title="OAuth 授权"
                  >
                    <ShieldCheckIcon className="size-3.5" />
                  </Button>
                ) : null}
                {onEdit ? (
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    className="text-muted-foreground hover:text-foreground cursor-pointer"
                    onClick={() => onEdit(server)}
                    title="编辑 MCP 配置"
                  >
                    <PencilIcon className="size-3.5" />
                  </Button>
                ) : null}
                <Button
                  size="icon-xs"
                  variant="ghost"
                  className="text-muted-foreground hover:text-destructive cursor-pointer"
                  onClick={() => onDelete(server)}
                  title="移除 MCP"
                >
                  <Trash2Icon className="size-3.5" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="flex flex-col gap-2 mt-4">
          {paginated.map((server) => (
            <div
              className="flex items-center justify-between gap-4 rounded-xl border bg-card/60 px-4 py-3 shadow-2xs transition-all duration-200 hover:border-primary/40 hover:bg-card"
              key={server.id}
            >
              <div className="flex items-center gap-3 min-w-0 flex-1">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-primary shadow-2xs">
                  <PlugZapIcon className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-sm truncate" title={server.name}>
                      {server.name}
                    </span>
                    <Badge variant="outline" className="text-[10px] font-mono uppercase">
                      {server.transport}
                    </Badge>
                  </div>
                  <p
                    className="mt-0.5 truncate text-xs text-muted-foreground font-mono"
                    title={server.transport === "stdio" ? server.command : server.url}
                  >
                    {server.transport === "stdio" ? server.command : server.url}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                {server.transport === "http" && server.oauth?.enabled ? (
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    className="text-muted-foreground hover:text-foreground cursor-pointer"
                    onClick={() => onAuthenticate(server)}
                    title="OAuth 授权"
                  >
                    <ShieldCheckIcon className="size-3.5" />
                  </Button>
                ) : null}
                {onEdit ? (
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    className="text-muted-foreground hover:text-foreground cursor-pointer"
                    onClick={() => onEdit(server)}
                    title="编辑 MCP 配置"
                  >
                    <PencilIcon className="size-3.5" />
                  </Button>
                ) : null}
                <Button
                  size="icon-xs"
                  variant="ghost"
                  className="text-muted-foreground hover:text-destructive cursor-pointer"
                  onClick={() => onDelete(server)}
                  title="移除 MCP"
                >
                  <Trash2Icon className="size-3.5" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {totalPages > 1 ? (
        <div className="mt-4 flex flex-col sm:flex-row items-center justify-between gap-3 border-t pt-4">
          <span className="text-xs text-muted-foreground">
            第 {safePage} / {totalPages} 页 · 共 {mcpServers.length} 个服务 · 每页 {pageSize} 条
          </span>
          <Pagination className="mx-0 w-auto">
            <PaginationContent>
              <PaginationItem>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={safePage <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  className="gap-1 pl-2.5 h-8 text-xs cursor-pointer"
                >
                  <ChevronLeftIcon className="size-3.5" />
                  <span>上一页</span>
                </Button>
              </PaginationItem>
              {getPaginationRange(safePage, totalPages).map((item, idx) => (
                <PaginationItem key={typeof item === "number" ? item : `ellipsis-${idx}`}>
                  {item === "..." ? (
                    <PaginationEllipsis />
                  ) : (
                    <Button
                      variant={safePage === item ? "outline" : "ghost"}
                      size="icon"
                      className="size-8 text-xs font-mono cursor-pointer"
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
                  disabled={safePage >= totalPages}
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  className="gap-1 pr-2.5 h-8 text-xs cursor-pointer"
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
  );
}

function SkillTopBarActions({
  visible,
  installed,
  installing,
  onInstall,
  onRemove,
  onEdit,
}: {
  visible: boolean;
  installed: boolean;
  installing: boolean;
  onInstall: () => void;
  onRemove: () => void;
  onEdit?: () => void;
}) {
  const [container, setContainer] = React.useState<HTMLElement | null>(null);

  React.useEffect(() => {
    setContainer(document.getElementById("app-top-bar-actions"));
  }, []);

  if (!container) return null;

  return createPortal(
    <div
      className={cn(
        "flex items-center gap-2 transition-all duration-200 ease-out",
        visible
          ? "opacity-100 translate-y-0 pointer-events-auto"
          : "opacity-0 -translate-y-1 pointer-events-none",
      )}
    >
      {installed ? (
        <>
          {onEdit ? (
            <Button
              onClick={onEdit}
              variant="outline"
              size="sm"
              className="h-7 cursor-pointer gap-1 px-2.5 text-xs"
            >
              <PencilIcon className="size-3.5" />
              编辑配置
            </Button>
          ) : null}
          <Button
            onClick={onRemove}
            variant="outline"
            size="sm"
            className="h-7 cursor-pointer gap-1 px-2.5 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive hover:border-destructive/30"
          >
            <Trash2Icon className="size-3.5 text-destructive" />
            移除技能
          </Button>
        </>
      ) : (
        <Button
          onClick={onInstall}
          size="sm"
          disabled={installing}
          className="h-7 cursor-pointer gap-1 px-2.5 text-xs"
        >
          {installing ? (
            <Dotm3x3_11 size={14} dotSize={2.2} colorPreset="solid-theme" />
          ) : (
            <PlusIcon className="size-3.5" />
          )}
          {installing ? "正在安装…" : "安装技能"}
        </Button>
      )}
    </div>,
    container,
  );
}

function SkillDetailPage({
  detail,
  detailError,
  detailLoading,
  installed,
  installing,
  onInstall,
  onRemove,
  onEdit,
  onUsePrompt,
}: {
  detail: SkillDetail | null;
  detailError: string | null;
  detailLoading: boolean;
  installed: boolean;
  installing: boolean;
  onInstall: () => void;
  onRemove: () => void;
  onEdit?: () => void;
  onUsePrompt: (prompt: string) => void;
}) {
  const [showTopBarButton, setShowTopBarButton] = React.useState(false);
  const heroActionRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    setShowTopBarButton(false);
  }, [detail?.name]);

  React.useEffect(() => {
    const el = heroActionRef.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        // 当页面主体内的操作按钮完全滑出顶栏下沿视野时，才在顶栏出现
        setShowTopBarButton(!entry.isIntersecting);
      },
      {
        threshold: 0,
        rootMargin: "-48px 0px 0px 0px", // 避开 48px 高度的 AppTopBar
      },
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [detail?.name]);

  const examplePrompts = [
    "把我的笔记整理成一份排版好的文档",
    "把这份 PDF 里的表格提取成电子表格",
    "用这份 CSV 做一份带图表的工作簿",
  ];
  return (
    <div className="flex size-full min-h-0 flex-col bg-background">
      {/* 传送顶栏操作按钮至主外壳 PanelHeader (AppTopBar)，仅在页面内按钮滚出视野后显现 */}
      <SkillTopBarActions
        visible={showTopBarButton}
        installed={installed}
        installing={installing}
        onInstall={onInstall}
        onRemove={onRemove}
        onEdit={onEdit}
      />
      <ScrollArea
        className="min-h-0 flex-1"
        onScrollCapture={(e) => {
          const target = e.target as HTMLElement;
          if (target && typeof target.scrollTop === "number") {
            if (target.scrollTop === 0) {
              setShowTopBarButton(false);
            }
          }
        }}
      >
        <main className="mx-auto w-full max-w-6xl px-5 pt-6 pb-12 sm:px-8 lg:px-12">
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

                {/* 页面主操作按钮 */}
                <div ref={heroActionRef} className="flex items-center gap-2 shrink-0 sm:self-start">
                  {installed ? (
                    <>
                      {onEdit ? (
                        <Button
                          onClick={onEdit}
                          variant="outline"
                          size="sm"
                          className="cursor-pointer gap-1.5"
                        >
                          <PencilIcon className="size-4" />
                          编辑配置
                        </Button>
                      ) : null}
                      <Button
                        onClick={onRemove}
                        variant="outline"
                        size="sm"
                        className="cursor-pointer gap-1.5 text-destructive hover:bg-destructive/10 hover:text-destructive hover:border-destructive/30"
                      >
                        <Trash2Icon className="size-4 text-destructive" />
                        移除技能
                      </Button>
                    </>
                  ) : (
                    <Button
                      disabled={installing}
                      onClick={onInstall}
                      size="sm"
                      className="cursor-pointer gap-1.5"
                    >
                      {installing ? (
                        <Dotm3x3_11 size={14} dotSize={2.2} colorPreset="solid-theme" />
                      ) : (
                        <PlusIcon className="size-4" />
                      )}
                      {installing ? "正在安装…" : "安装技能"}
                    </Button>
                  )}
                </div>
              </header>

              {/* 官方认证说明横幅 */}
              {detail.isOfficial ? (
                <div className="mt-2 flex items-center gap-2.5 rounded-xl bg-emerald-500/10 border border-emerald-500/20 p-3.5 text-xs text-emerald-800 dark:text-emerald-300">
                  <ShieldCheckIcon className="size-5 shrink-0 text-emerald-500" />
                  <span>
                    <strong>技术原厂权威认证</strong>
                    ：该技能由产品官方团队维护，符合第一方工具规范与自动化调用安全要求。
                  </span>
                </div>
              ) : null}

              {/* 安全审计卡片区 */}
              {detail.audits && detail.audits.length > 0 ? (
                <section className="mt-2">
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
              <section className="mt-2 w-full min-w-0 rounded-xl border bg-muted/20 p-4 sm:p-5">
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
              <section className="mt-2 w-full min-w-0">
                <h2 className="text-lg font-semibold">技能指令与执行说明</h2>
                <div className="mt-3 min-w-0 rounded-xl border bg-muted/30 p-4">
                  <MessageResponse className="w-full max-w-none text-sm leading-relaxed">
                    {detail.instructions}
                  </MessageResponse>
                </div>
              </section>

              {/* 关联文件与资源包 */}
              <section className="mt-2">
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
              <Dotm3x3_1 size={16} dotSize={2.4} colorPreset="solid-theme" />
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

function SkillEditDialog({
  open,
  onOpenChange,
  skill,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  skill: SkillMetadata | null;
  onSave: (name: string, patch: { description?: string; instructions?: string }) => Promise<void>;
}) {
  const [description, setDescription] = React.useState("");
  const [instructions, setInstructions] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    if (!open || !skill) {
      setDescription("");
      setInstructions("");
      return;
    }
    setDescription(skill.description || "");
    setLoading(true);
    fetchSkillDetail(skill)
      .then((detail) => {
        if (detail) {
          setDescription(detail.description || "");
          setInstructions(detail.instructions || "");
        }
      })
      .catch((err) => {
        toastError(err, "获取技能详情失败");
      })
      .finally(() => {
        setLoading(false);
      });
  }, [open, skill]);

  const handleSave = async () => {
    if (!skill) return;
    setSaving(true);
    try {
      await onSave(skill.name, {
        description: description.trim(),
        instructions: instructions.trim(),
      });
      onOpenChange(false);
    } catch {
      // Handled in onSave / updateSkill
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[min(88vh,52rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
        <DialogHeader className="shrink-0 border-b bg-background px-5 py-4 pr-12">
          <div className="flex items-start gap-3">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-xl shadow-2xs">
              {skill ? skillIcon(skill) : "✨"}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <DialogTitle className="text-base font-semibold">编辑技能配置</DialogTitle>
                {skill ? (
                  <Badge variant="outline" className="font-mono text-xs">
                    {skill.name}
                  </Badge>
                ) : null}
              </div>
              <DialogDescription className="mt-0.5 text-xs">
                修改该技能在本地的简要描述及 SKILL.md 中的执行说明指令。
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <ScrollArea className="min-h-0 flex-1">
          <div className="grid gap-4 px-6 py-4 pb-6">
            {loading ? (
              <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
                <Dotm3x3_1 size={16} dotSize={2.4} colorPreset="solid-theme" />
                正在读取技能详情…
              </div>
            ) : (
              <>
                <Field>
                  <FieldLabel className="text-xs font-medium">技能简要描述</FieldLabel>
                  <Textarea
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="简述该技能的功能与触发场景..."
                    className="resize-none text-xs"
                    rows={2}
                  />
                  <FieldDescription className="text-[11px]">
                    用于在技能列表或 Agent 工具栏中快速展示功能摘要。
                  </FieldDescription>
                </Field>

                <Field>
                  <FieldLabel className="text-xs font-medium">
                    执行说明与系统提示词 (SKILL.md)
                  </FieldLabel>
                  <Textarea
                    value={instructions}
                    onChange={(e) => setInstructions(e.target.value)}
                    placeholder="输入该技能的详细执行指引、约束与系统提示词..."
                    className="font-mono text-xs leading-relaxed resize-y min-h-[220px]"
                    rows={10}
                  />
                  <FieldDescription className="text-[11px]">
                    当调用此技能时，这些指令将被注入给 Agent 作为执行指引。
                  </FieldDescription>
                </Field>
              </>
            )}
          </div>
        </ScrollArea>

        <DialogFooter className="mx-0 mb-0 shrink-0 rounded-none border-0 border-t bg-background px-5 py-3 sm:flex-row sm:items-center sm:justify-end gap-2">
          <DialogClose render={<Button variant="ghost" size="sm" />}>取消</DialogClose>
          <Button
            size="sm"
            disabled={loading || saving}
            onClick={() => void handleSave()}
            className="gap-1.5 cursor-pointer"
          >
            {saving ? (
              <Dotm3x3_1 size={14} dotSize={2.2} colorPreset="solid-theme" />
            ) : (
              <CheckIcon className="size-3.5" />
            )}
            {saving ? "正在保存…" : "保存修改"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SkillAddDialog({
  open,
  onOpenChange,
  onFile,
  fileInputRef,
  uploading,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onFile: (file: File | undefined) => void;
  onSource?: (source: string) => void;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  uploading: boolean;
}) {
  const [selectedFile, setSelectedFile] = React.useState<File | null>(null);

  React.useEffect(() => {
    if (!open) setSelectedFile(null);
  }, [open]);

  const handleSelectFile = (file?: File) => {
    if (file) {
      setSelectedFile(file);
    }
  };

  const handleConfirm = () => {
    if (selectedFile) {
      onFile(selectedFile);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <div className="flex items-start gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground">
              <FolderOpenIcon className="size-4" />
            </span>
            <div>
              <DialogTitle className="text-base font-semibold">导入本地技能</DialogTitle>
              <DialogDescription className="mt-0.5 text-xs">
                从本地选择包含 SKILL.md 的 ZIP 技能压缩包导入到个人技能库。
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="grid gap-3 py-1">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className={cn(
              "flex w-full flex-col items-center justify-center gap-2.5 rounded-xl border-2 border-dashed p-6 text-center transition-all cursor-pointer",
              selectedFile
                ? "border-primary/60 bg-primary/5"
                : "border-border hover:border-primary/50 hover:bg-muted/30",
            )}
          >
            <span className="flex size-11 items-center justify-center rounded-xl bg-muted text-muted-foreground shadow-2xs">
              <FolderOpenIcon className="size-5" />
            </span>
            {selectedFile ? (
              <div className="min-w-0 max-w-full px-2">
                <p className="truncate text-xs font-semibold text-foreground">
                  {selectedFile.name}
                </p>
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  {(selectedFile.size / 1024).toFixed(1)} KB · 准备导入
                </p>
              </div>
            ) : (
              <div>
                <p className="text-xs font-semibold text-foreground">点击选择本地 ZIP 技能包</p>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  支持包含 SKILL.md 及相关脚本/文档资源的标准压缩包
                </p>
              </div>
            )}
          </button>
        </div>

        <DialogFooter className="mt-2 flex items-center justify-between sm:justify-end gap-2">
          <DialogClose render={<Button variant="ghost" size="sm" />}>取消</DialogClose>
          <Button
            size="sm"
            disabled={uploading || !selectedFile}
            onClick={handleConfirm}
            className="gap-1.5"
          >
            {uploading ? (
              <Dotm3x3_11 size={14} dotSize={2.2} colorPreset="solid-theme" />
            ) : (
              <PlusIcon className="size-3.5" />
            )}
            {uploading ? "正在解压导入…" : "确认导入"}
          </Button>
        </DialogFooter>
        <input
          accept=".zip,application/zip"
          className="hidden"
          onChange={(event) => handleSelectFile(event.target.files?.[0])}
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

  const handleUrlChange = (val: string) => {
    setUrl(val);
    if (!name.trim() || editing === null) {
      try {
        const parsed = new URL(val);
        const segments = parsed.pathname.split("/").filter(Boolean);
        if (segments.length >= 2) {
          setName(segments[1].replace(/\.git$/i, ""));
        }
      } catch {
        // ignore
      }
    }
  };

  const save = async () => {
    if (!url.trim()) return;
    setSaving(true);
    try {
      await saveSkillMarketplace({
        id: editing?.id,
        name: name.trim() || "GitHub 技能市场",
        url: url.trim(),
        branch: branch.trim() || "main",
        enabled: true,
      });
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
    try {
      await deleteSkillMarketplace(id);
    } catch {
      toast.error("删除技能市场失败");
      return;
    }
    if (editing?.id === id) reset();
    onSaved();
    toast.success("技能市场已删除");
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <div className="flex items-start gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground">
              <StoreIcon className="size-4" />
            </span>
            <div>
              <DialogTitle className="text-base font-semibold">技能市场源管理</DialogTitle>
              <DialogDescription className="mt-0.5 text-xs leading-normal">
                添加 GitHub 技能合集仓库。仓库可在根目录或 skills/ 下放置多个包含 SKILL.md 的技能。
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {/* 已配置的技能市场列表 */}
        <div className="grid gap-2 max-h-48 overflow-y-auto pr-1">
          {marketplaces.map((marketplace) => (
            <div
              className="flex items-center justify-between gap-3 rounded-xl border border-border bg-card/60 p-3 shadow-2xs"
              key={marketplace.id}
            >
              <StoreIcon className="size-4 shrink-0 text-primary/70" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <p
                    className="truncate text-xs font-semibold text-foreground"
                    title={marketplace.name}
                  >
                    {marketplace.name}
                  </p>
                  <Badge variant="outline" className="text-[10px] font-mono px-1 py-0 h-4">
                    {marketplace.branch}
                  </Badge>
                </div>
                <p
                  className="truncate text-[11px] text-muted-foreground mt-0.5"
                  title={marketplace.url}
                >
                  {marketplace.url}
                </p>
              </div>
              <div className="flex items-center gap-1">
                <Button
                  aria-label="编辑技能市场"
                  onClick={() => edit(marketplace)}
                  size="icon-xs"
                  variant="ghost"
                >
                  <PencilIcon className="size-3.5" />
                </Button>
                <Button
                  aria-label="删除技能市场"
                  onClick={() => void remove(marketplace.id)}
                  size="icon-xs"
                  variant="ghost"
                  className="hover:text-destructive"
                >
                  <Trash2Icon className="size-3.5" />
                </Button>
              </div>
            </div>
          ))}
          {marketplaces.length === 0 ? (
            <div className="rounded-xl border border-dashed p-4 text-center text-xs text-muted-foreground">
              还没有添加任何第三方 GitHub 技能市场源。
            </div>
          ) : null}
        </div>

        <Separator />

        {/* 添加/编辑表单 */}
        <FieldGroup className="gap-3">
          <div>
            <span className="text-xs font-semibold text-foreground/90">
              {editing ? "编辑市场源" : "添加新市场源"}
            </span>
          </div>

          <Field>
            <FieldLabel htmlFor="market-url" className="text-xs">
              GitHub 仓库地址 <span className="text-destructive">*</span>
            </FieldLabel>
            <Input
              id="market-url"
              className="w-full text-xs font-mono"
              onChange={(event) => handleUrlChange(event.target.value)}
              placeholder="https://github.com/owner/repository"
              value={url}
            />
          </Field>

          <div className="grid grid-cols-1 sm:grid-cols-[1fr_8rem] gap-2.5">
            <Field>
              <FieldLabel htmlFor="market-name" className="text-xs">
                市场显示名称
              </FieldLabel>
              <Input
                id="market-name"
                className="text-xs"
                onChange={(event) => setName(event.target.value)}
                placeholder="例如：Anthropic 官方技能"
                value={name}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="market-branch" className="text-xs">
                分支 (Branch)
              </FieldLabel>
              <Input
                id="market-branch"
                className="text-xs font-mono"
                onChange={(event) => setBranch(event.target.value)}
                placeholder="main"
                value={branch}
              />
            </Field>
          </div>
        </FieldGroup>

        <DialogFooter className="mt-1 flex items-center justify-between sm:justify-end gap-2">
          {editing ? (
            <Button onClick={reset} variant="ghost" size="sm">
              取消编辑
            </Button>
          ) : (
            <DialogClose render={<Button variant="ghost" size="sm" />}>关闭</DialogClose>
          )}
          <Button
            size="sm"
            disabled={saving || !url.trim()}
            onClick={() => void save()}
            className="gap-1.5"
          >
            {saving ? (
              <Dotm3x3_1 size={14} dotSize={2.2} colorPreset="solid-theme" />
            ) : (
              <PlusIcon className="size-3.5" />
            )}
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

export { SkillHubPage as SkillHub };
