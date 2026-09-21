import { useNavigate, useSearch } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  BarChart3Icon,
  BrainIcon,
  DatabaseIcon,
  FolderCogIcon,
  GlobeIcon,
  LogOutIcon,
  PaletteIcon,
  SearchIcon,
  ServerIcon,
  ShieldCheckIcon,
  SlidersHorizontalIcon,
  WrenchIcon,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import * as React from "react";
import { useAuth } from "@/features/auth";
import { useTranslation } from "@/shared/i18n";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { ScrollArea } from "@/shared/ui/scroll-area";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from "@/shared/ui/sidebar";
import {
  BrowserSection,
  GeneralSection,
  GuardrailsSection,
  MemorySection,
  ProvidersSection,
  StorageSection,
  ThemeSection,
  ToolsSection,
  UsageSection,
  WorkspaceSection,
} from "./sections";

// ---------------------------------------------------------------------------
// 设置页:全局视图(独立于主应用壳),左侧固定菜单 sidebar(不可收起)。
// 顶部 SidebarHeader =「返回应用」;三列对齐基准:所有列 header 统一 h-12。
// ---------------------------------------------------------------------------

const PRIMARY_SECTIONS = [
  { id: "general", icon: SlidersHorizontalIcon },
  { id: "browser", icon: GlobeIcon },
  { id: "memory", icon: BrainIcon },
  { id: "guardrails", icon: ShieldCheckIcon },
  { id: "workspace", icon: FolderCogIcon },
  { id: "tools", icon: WrenchIcon },
] as const;

const ADVANCED_SECTIONS = [
  { id: "providers", icon: ServerIcon },
  { id: "themes", icon: PaletteIcon },
  { id: "storage", icon: DatabaseIcon },
  { id: "usage", icon: BarChart3Icon },
] as const;

const SECTIONS = [...PRIMARY_SECTIONS, ...ADVANCED_SECTIONS] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

const SEARCH_ITEMS: Array<{
  section: SectionId;
  title: string;
  description?: string;
}> = [
  {
    section: "general",
    title: "settings:general.languageTitle",
    description: "settings:general.languageDesc",
  },
  {
    section: "general",
    title: "settings:general.proxyTitle",
    description: "settings:general.proxyDesc",
  },
  {
    section: "browser",
    title: "settings:browser.title",
    description: "settings:browser.desc",
  },
  {
    section: "memory",
    title: "settings:memory.messageHistoryTitle",
    description: "settings:memory.messageHistoryDescNonOm",
  },
  {
    section: "memory",
    title: "settings:memory.semanticRecallTitle",
    description: "settings:memory.semanticRecallDesc",
  },
  {
    section: "memory",
    title: "settings:memory.workingMemoryTitle",
    description: "settings:memory.workingMemoryDesc",
  },
  {
    section: "memory",
    title: "settings:memory.threadTitleCard",
    description: "settings:memory.threadTitleCardDesc",
  },
  { section: "memory", title: "settings:memory.omTitle", description: "settings:memory.omDesc" },
  {
    section: "guardrails",
    title: "settings:guardrails.unicodeTitle",
    description: "settings:guardrails.unicodeDesc",
  },
  {
    section: "guardrails",
    title: "settings:guardrails.regexTitle",
    description: "settings:guardrails.regexDesc",
  },
  {
    section: "guardrails",
    title: "settings:guardrails.injectionTitle",
    description: "settings:guardrails.injectionDesc",
  },
  {
    section: "guardrails",
    title: "settings:guardrails.languageTitle",
    description: "settings:guardrails.languageDesc",
  },
  {
    section: "guardrails",
    title: "settings:guardrails.moderationTitle",
    description: "settings:guardrails.moderationDesc",
  },
  {
    section: "guardrails",
    title: "settings:guardrails.piiTitle",
    description: "settings:guardrails.piiDesc",
  },
  {
    section: "guardrails",
    title: "settings:guardrails.tokenCostTitle",
    description: "settings:guardrails.tokenCostDesc",
  },
  {
    section: "workspace",
    title: "settings:workspace.fsTitle",
    description: "settings:workspace.fsDesc",
  },
  {
    section: "workspace",
    title: "settings:workspace.sandboxTitle",
    description: "settings:workspace.sandboxDesc",
  },
  {
    section: "workspace",
    title: "settings:workspace.searchTitle",
    description: "settings:workspace.searchDesc",
  },
  {
    section: "workspace",
    title: "settings:workspace.toolsTitle",
    description: "settings:workspace.toolsDesc",
  },
  {
    section: "workspace",
    title: "settings:workspace.skillsTitle",
    description: "settings:workspace.skillsDesc",
  },
  { section: "tools", title: "settings:tabs.tools" },
  { section: "providers", title: "settings:tabs.providers" },
  { section: "themes", title: "settings:tabs.themes" },
  { section: "storage", title: "settings:tabs.storage" },
  { section: "usage", title: "settings:tabs.usage" },
];

export function SettingsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { section?: string };
  const settingsSection = search.section;
  const setSettingsSection = (id: string) => {
    void navigate({
      to: "/settings",
      search: (prev) => ({ ...prev, section: id }),
      replace: true,
    });
  };
  const setActiveView = (view: string) => {
    void navigate({ to: `/${view}` });
  };
  const { user, signOut } = useAuth();
  const [query, setQuery] = React.useState("");
  const section = (
    SECTIONS.some((s) => s.id === settingsSection) ? settingsSection : "general"
  ) as SectionId;
  const searchResults = React.useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return [];
    return SEARCH_ITEMS.map((item) => ({
      ...item,
      label: t(item.title),
      detail: item.description ? t(item.description) : "",
    }))
      .filter((item) => `${item.label} ${item.detail}`.toLocaleLowerCase().includes(normalized))
      .slice(0, 12);
  }, [query, t]);

  const renderSectionLinks = (items: ReadonlyArray<(typeof SECTIONS)[number]>) =>
    items.map((item) => (
      <SidebarMenuItem key={item.id}>
        <SidebarMenuButton
          isActive={section === item.id}
          onClick={() => setSettingsSection(item.id)}
        >
          <item.icon />
          <span>{t(`settings:tabs.${item.id}`)}</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    ));

  return (
    <SidebarProvider
      className="h-svh w-full items-stretch"
      style={{ "--sidebar-width": "15rem", minHeight: 0 } as React.CSSProperties}
      disableKeyboardShortcut
    >
      <Sidebar collapsible="none" className="shrink-0 border-r border-border bg-sidebar">
        {/* 与供应商列/详情列的 header 统一 h-12 + border-b,保证水平分割线对齐 */}
        <SidebarHeader className="h-12 border-b border-border p-0!">
          <SidebarMenuButton
            onClick={() => setActiveView("chat")}
            tooltip={t("settings:backToApp")}
            className="h-12 rounded-none px-3 text-sm font-medium"
          >
            <ArrowLeftIcon />
            <span>{t("settings:backToApp")}</span>
          </SidebarMenuButton>
        </SidebarHeader>
        <SidebarContent>
          <div className="shrink-0 border-b border-border/60 p-2">
            <div className="relative">
              <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                aria-label={t("settings:search.label")}
                className="h-8 pl-8 text-xs"
                placeholder={t("settings:search.placeholder")}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
          </div>
          <SidebarGroup className="p-1.5">
            <SidebarGroupContent>
              <SidebarMenu>
                {query.trim() ? (
                  searchResults.length ? (
                    searchResults.map((result) => (
                      <SidebarMenuItem key={`${result.section}:${result.title}`}>
                        <SidebarMenuButton
                          className="h-auto min-h-9 items-start py-2"
                          onClick={() => {
                            setSettingsSection(result.section);
                            setQuery("");
                          }}
                        >
                          <SearchIcon className="mt-0.5" />
                          <span className="min-w-0 whitespace-normal">
                            <span className="block break-words">{result.label}</span>
                            {result.detail ? (
                              <span className="mt-0.5 line-clamp-2 block break-words text-[11px] text-muted-foreground">
                                {result.detail}
                              </span>
                            ) : null}
                          </span>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    ))
                  ) : (
                    <li className="px-2 py-4 text-center text-xs text-muted-foreground">
                      {t("settings:search.empty")}
                    </li>
                  )
                ) : (
                  <>
                    {renderSectionLinks(PRIMARY_SECTIONS)}
                    <li className="px-2 pt-4 pb-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
                      {t("settings:groups.advanced")}
                    </li>
                    {renderSectionLinks(ADVANCED_SECTIONS)}
                  </>
                )}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
        {/* h-12 与供应商列 footer 对齐 */}
        <SidebarFooter className="h-12 shrink-0 border-t border-border px-3!">
          <div className="flex size-full min-w-0 items-center justify-between gap-1.5">
            <div className="flex min-w-0 flex-col">
              <span
                className="truncate text-sm font-medium text-sidebar-foreground"
                title={user?.name ?? user?.email}
              >
                {user?.name || t("common:user")}
              </span>
              <span className="truncate text-xs text-muted-foreground" title={user?.email}>
                {user?.email}
              </span>
            </div>
            <Button
              size="icon-xs"
              variant="ghost"
              title={t("common:logout")}
              aria-label={t("common:logout")}
              className="shrink-0 text-muted-foreground hover:text-destructive"
              onClick={() => signOut()}
            >
              <LogOutIcon className="size-3.5" />
            </Button>
          </div>
        </SidebarFooter>
      </Sidebar>
      <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={section}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.16, ease: "easeOut" }}
              className="flex size-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
            >
              {section === "themes" ? (
                <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
                  <ThemeSection />
                </div>
              ) : section === "providers" ? (
                <ProvidersSection />
              ) : (
                <ScrollArea className="min-h-0 flex-1">
                  <div className="flex min-w-0 flex-col gap-4 p-4">
                    {section === "general" ? <GeneralSection /> : null}
                    {section === "browser" ? <BrowserSection /> : null}
                    {section === "memory" ? <MemorySection /> : null}
                    {section === "tools" ? <ToolsSection /> : null}
                    {section === "guardrails" ? <GuardrailsSection /> : null}
                    {section === "workspace" ? <WorkspaceSection /> : null}
                    {section === "storage" ? <StorageSection /> : null}
                    {section === "usage" ? <UsageSection /> : null}
                  </div>
                </ScrollArea>
              )}
            </motion.div>
          </AnimatePresence>
        </div>
      </main>
    </SidebarProvider>
  );
}
