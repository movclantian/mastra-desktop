import {
  ArrowLeftIcon,
  BarChart3Icon,
  BrainIcon,
  DatabaseIcon,
  FolderCogIcon,
  LogOutIcon,
  PaletteIcon,
  ServerIcon,
  ShieldCheckIcon,
  WrenchIcon,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import type * as React from "react";
import { useWorkbench } from "@/entities/workbench";
import { useAuth } from "@/features/auth";
import { Button } from "@/shared/ui/button";
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

const SECTIONS = [
  { id: "themes", label: "外观主题", icon: PaletteIcon },
  { id: "providers", label: "模型供应商", icon: ServerIcon },
  { id: "memory", label: "记忆", icon: BrainIcon },
  { id: "tools", label: "工具", icon: WrenchIcon },
  { id: "guardrails", label: "护栏", icon: ShieldCheckIcon },
  { id: "workspace", label: "工作区", icon: FolderCogIcon },
  { id: "storage", label: "存储", icon: DatabaseIcon },
  { id: "usage", label: "用量统计", icon: BarChart3Icon },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

export function SettingsPage() {
  const { settingsSection, setSettingsSection, setActiveView } = useWorkbench();
  const { user, signOut } = useAuth();
  const section = (
    SECTIONS.some((s) => s.id === settingsSection) ? settingsSection : "themes"
  ) as SectionId;

  return (
    <SidebarProvider
      className="h-svh w-full items-stretch"
      style={{ "--sidebar-width": "13rem", minHeight: 0 } as React.CSSProperties}
    >
      <Sidebar collapsible="none" className="shrink-0 border-r border-border bg-sidebar">
        {/* 与供应商列/详情列的 header 统一 h-12 + border-b,保证水平分割线对齐 */}
        <SidebarHeader className="h-12 border-b border-border p-0!">
          <SidebarMenuButton
            onClick={() => setActiveView("chat")}
            tooltip="返回应用"
            className="h-12 rounded-none px-3 text-xs"
          >
            <ArrowLeftIcon />
            <span className="font-medium">返回应用</span>
          </SidebarMenuButton>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup className="p-1.5">
            <SidebarGroupContent>
              <SidebarMenu>
                {SECTIONS.map((s) => (
                  <SidebarMenuItem key={s.id}>
                    <SidebarMenuButton
                      isActive={section === s.id}
                      onClick={() => setSettingsSection(s.id)}
                      className="text-xs font-normal"
                    >
                      <s.icon />
                      <span>{s.label}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
        {/* h-12 与供应商列 footer 对齐 */}
        <SidebarFooter className="h-12 shrink-0 border-t border-border px-3!">
          <div className="flex size-full min-w-0 items-center justify-between gap-1.5">
            <div className="flex min-w-0 flex-col">
              <span
                className="truncate text-xs font-medium text-sidebar-foreground"
                title={user?.name ?? user?.email}
              >
                {user?.name || "用户"}
              </span>
              <span className="truncate text-[10px] text-muted-foreground" title={user?.email}>
                {user?.email}
              </span>
            </div>
            <Button
              size="icon-xs"
              variant="ghost"
              title="退出登录"
              aria-label="退出登录"
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
