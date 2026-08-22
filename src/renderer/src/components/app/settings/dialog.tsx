import {
  BrainIcon,
  DatabaseIcon,
  FolderCogIcon,
  ServerIcon,
  ShieldCheckIcon,
  WrenchIcon,
} from "lucide-react";
import * as React from "react";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from "@/components/ui/sidebar";
import { useWorkbench } from "@/lib/workbench";
import {
  GuardrailsSection,
  MemorySection,
  ProvidersSection,
  StorageSection,
  ToolsSection,
  WorkspaceSection,
} from "./sections";

// 布局照搬 .vscode/1.txt(shadcn 官方 Settings Dialog):
// Dialog 内嵌 SidebarProvider + Sidebar(collapsible="none") 左侧导航,
// 右侧 main = Breadcrumb header + 滚动内容区。

// ---------------------------------------------------------------------------
// 设置弹窗:照搬 .vscode/1.txt 官方布局
// ---------------------------------------------------------------------------

const SECTIONS = [
  { id: "providers", label: "模型供应商", icon: ServerIcon },
  { id: "memory", label: "记忆", icon: BrainIcon },
  { id: "tools", label: "工具", icon: WrenchIcon },
  { id: "guardrails", label: "护栏", icon: ShieldCheckIcon },
  { id: "workspace", label: "工作区", icon: FolderCogIcon },
  { id: "storage", label: "存储", icon: DatabaseIcon },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

export function SettingsDialog() {
  const { settingsOpen, setSettingsOpen } = useWorkbench();
  const [section, setSection] = React.useState<SectionId>("providers");
  const current = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0];

  return (
    <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
      <DialogContent className="flex h-[min(560px,calc(100dvh-2rem))] max-h-[calc(100dvh-2rem)] min-w-0 flex-col overflow-hidden p-0 md:max-w-[700px] lg:max-w-[800px]">
        <DialogTitle className="sr-only">设置</DialogTitle>
        <DialogDescription className="sr-only">自定义 MastraWork 设置。</DialogDescription>
        {/* 必须保持横向子项 stretch:main 才能继承受限的 Dialog 高度并形成滚动区。 */}
        <SidebarProvider
          className="h-full min-h-0 w-full items-stretch"
          style={
            {
              "--sidebar-width": "fit-content",
              minHeight: 0,
              height: "100%",
            } as React.CSSProperties
          }
        >
          <Sidebar collapsible="none" className="hidden w-fit min-w-[112px] max-w-[180px] md:flex">
            <SidebarContent>
              <SidebarGroup>
                <SidebarGroupContent>
                  <SidebarMenu>
                    {SECTIONS.map((s) => (
                      <SidebarMenuItem key={s.id}>
                        <SidebarMenuButton
                          isActive={section === s.id}
                          onClick={() => setSection(s.id)}
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
          </Sidebar>
          <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            <header className="flex h-16 shrink-0 items-center gap-2 bg-background transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-12">
              <div className="flex items-center gap-2 px-4">
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
              </div>
            </header>
            <ScrollArea className="min-h-0 flex-1">
              <div className="flex min-w-0 flex-col">
                {section === "providers" ? <ProvidersSection /> : null}
                {section !== "providers" ? (
                  <div className="flex min-w-0 flex-col gap-2 p-4 pt-0">
                    {section === "memory" ? <MemorySection /> : null}
                    {section === "tools" ? <ToolsSection /> : null}
                    {section === "guardrails" ? <GuardrailsSection /> : null}
                    {section === "workspace" ? <WorkspaceSection /> : null}
                    {section === "storage" ? <StorageSection /> : null}
                  </div>
                ) : null}
              </div>
            </ScrollArea>
          </main>
        </SidebarProvider>
      </DialogContent>
    </Dialog>
  );
}
