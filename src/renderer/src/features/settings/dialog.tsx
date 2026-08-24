import {
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
import type * as React from "react";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from "@/components/ui/sidebar";
import { useAuth } from "@/features/auth/auth-provider";
import { useWorkbench } from "@/features/workbench";
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
// 设置弹窗:照搬官方 Settings Dialog 布局
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

export function SettingsDialog() {
  const { settingsOpen, setSettingsOpen, settingsSection, setSettingsSection } = useWorkbench();
  const { user, signOut } = useAuth();
  const section = (
    SECTIONS.some((s) => s.id === settingsSection) ? settingsSection : "themes"
  ) as SectionId;
  const current = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0];

  return (
    <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
      <DialogContent className="flex h-[min(640px,calc(100dvh-2rem))] max-h-[calc(100dvh-2rem)] min-w-0 flex-col overflow-hidden p-0 md:max-w-[840px] lg:max-w-[960px]">
        <DialogTitle className="sr-only">设置</DialogTitle>
        <DialogDescription className="sr-only">自定义 MastraWork 设置。</DialogDescription>
        {/* 必须保持横向子项 stretch:main 才能继承受限的 Dialog 高度并形成滚动区。 */}
        <SidebarProvider
          className="h-full min-h-0 w-full items-stretch"
          style={
            {
              "--sidebar-width": "160px",
              minHeight: 0,
              height: "100%",
            } as React.CSSProperties
          }
        >
          <Sidebar
            collapsible="none"
            className="hidden w-40 shrink-0 border-r border-border bg-sidebar md:flex"
          >
            <div className="flex h-10 shrink-0 items-center border-b border-border px-3">
              <span className="text-xs font-medium text-muted-foreground">应用设置</span>
            </div>
            <SidebarContent>
              <SidebarGroup className="p-1">
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
            <SidebarFooter className="border-t border-border p-2">
              <div className="flex min-w-0 items-center justify-between gap-1.5 px-1 py-0.5">
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
                  onClick={() => {
                    signOut();
                    setSettingsOpen(false);
                  }}
                >
                  <LogOutIcon className="size-3.5" />
                </Button>
              </div>
            </SidebarFooter>
          </Sidebar>
          <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
            <header className="flex h-10 shrink-0 items-center justify-between border-b border-border bg-background px-4 pr-12">
              <Breadcrumb>
                <BreadcrumbList>
                  <BreadcrumbItem className="hidden md:block">
                    <BreadcrumbPage>设置</BreadcrumbPage>
                  </BreadcrumbItem>
                  <BreadcrumbSeparator className="hidden md:block" />
                  <BreadcrumbItem>
                    <BreadcrumbPage>{current.label}</BreadcrumbPage>
                  </BreadcrumbItem>
                </BreadcrumbList>
              </Breadcrumb>
            </header>

            {section === "themes" ? (
              <div className="flex flex-1 min-h-0 min-w-0 overflow-hidden">
                <ThemeSection />
              </div>
            ) : (
              <ScrollArea className="min-h-0 flex-1">
                <div className="flex min-w-0 flex-col">
                  {section === "providers" ? <ProvidersSection /> : null}
                  {section !== "providers" ? (
                    <div className="flex min-w-0 flex-col gap-4 p-4">
                      {section === "memory" ? <MemorySection /> : null}
                      {section === "tools" ? <ToolsSection /> : null}
                      {section === "guardrails" ? <GuardrailsSection /> : null}
                      {section === "workspace" ? <WorkspaceSection /> : null}
                      {section === "storage" ? <StorageSection /> : null}
                      {section === "usage" ? <UsageSection /> : null}
                    </div>
                  ) : null}
                </div>
              </ScrollArea>
            )}
          </main>
        </SidebarProvider>
      </DialogContent>
    </Dialog>
  );
}
