/**
 * Code-based 路由树 + hash history。
 * Electron 打包后渲染器运行在 file:// 协议上,browser history 的 pushState
 * 会触发真实文件加载;hash 路由(#/chat)在 dev(localhost)与 prod(file://)
 * 都安全,刷新/崩溃恢复后还能还原当前视图。
 *
 * URL 即状态:视图 = 路径;/chat 的 ?thread=(挂在 root,所有视图共享,
 * 跨视图导航自动保留)、/skills 的 ?skill=、/settings 的 ?section=、
 * /library 的 ?settings= 都是 search params。
 */
import {
  createHashHistory,
  createRootRoute,
  createRoute,
  createRouter,
  type ErrorComponentProps,
  redirect,
} from "@tanstack/react-router";
import * as React from "react";
import { useAuth } from "@/features/auth";
import { AgentHubPage } from "@/pages/agents";
import { ChatPage } from "@/pages/chat";
import { SchedulesPage } from "@/pages/schedules";
import { PluginHubPage } from "@/pages/skills";
import { useTranslation } from "@/shared/i18n";
import { describeError } from "@/shared/lib/errors";
import { BlurFade } from "@/shared/ui/blur-fade";
import { Button } from "@/shared/ui/button";
import { WindowTitleBar } from "@/shared/ui/panel";
import { ScrollArea } from "@/shared/ui/scroll-area";
import { RootShell } from "./app-shell";

const KnowledgeLibraryPage = React.lazy(() =>
  import("@/pages/library").then((module) => ({ default: module.KnowledgeLibraryPage })),
);

function PanelFallback() {
  const { t } = useTranslation();
  return (
    <div className="flex size-full items-center justify-center bg-background">
      <span className="text-xs text-muted-foreground">{t("common:loading")}</span>
    </div>
  );
}

/** root 路由壳:认证后的主壳 */
function RootRouteShell() {
  const { user } = useAuth();
  if (!user) return null;
  return <RootShell />;
}

function RouteError({ error, reset }: ErrorComponentProps) {
  const { t } = useTranslation();
  const described = describeError(error);
  return (
    <div className="flex h-dvh min-w-0 flex-col bg-background text-foreground">
      <WindowTitleBar />
      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto flex min-h-[calc(100dvh-var(--app-titlebar-height))] w-full max-w-lg flex-col justify-center gap-3 p-4">
          <h1 className="text-base font-medium">{t("common:pageError")}</h1>
          <p className="text-sm text-muted-foreground">{t("common:pageErrorHint")}</p>
          <pre className="whitespace-pre-wrap break-words rounded-lg border bg-muted/50 p-3 text-xs">
            {described.detail ?? described.title}
          </pre>
          <div className="flex flex-wrap gap-2">
            <Button onClick={reset}>{t("common:retry")}</Button>
            <Button variant="outline" onClick={() => window.location.reload()}>
              {t("common:reloadPage")}
            </Button>
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}

const rootRoute = createRootRoute({
  component: RootRouteShell,
  errorComponent: RouteError,
  // thread 挂在 root:任何视图都能读到当前线程,跨视图导航自动保留
  validateSearch: (search: Record<string, unknown>): { thread?: string } => ({
    ...(typeof search.thread === "string" && search.thread ? { thread: search.thread } : {}),
  }),
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/chat" });
  },
});

function ChatRoute() {
  const { user } = useAuth();
  if (!user) return null;
  return <ChatPage userId={user.id} />;
}

const chatRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/chat",
  component: ChatRoute,
});

function AgentsRoute() {
  return (
    <BlurFade key="agent-hub" duration={0.2} blur="3px" className="size-full">
      <AgentHubPage />
    </BlurFade>
  );
}

const agentsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/agents",
  component: AgentsRoute,
});

function SkillsRoute() {
  const search = skillsRoute.useSearch();
  return (
    <BlurFade key="skill-hub" duration={0.2} blur="3px" className="size-full">
      <PluginHubPage
        key={`${search.view}:${search.component}`}
        initialView={search.view}
        initialComponent={search.component}
      />
    </BlurFade>
  );
}

const skillsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/skills",
  validateSearch: (
    search: Record<string, unknown>,
  ): { view?: "discover" | "installed" | "sources"; component?: "skill" | "mcp" } => ({
    ...(search.view === "discover" || search.view === "installed" || search.view === "sources"
      ? { view: search.view }
      : {}),
    ...(search.component === "skill" || search.component === "mcp"
      ? { component: search.component }
      : {}),
  }),
  component: SkillsRoute,
});

function LibraryRoute() {
  const { settings } = libraryRoute.useSearch();
  const navigate = libraryRoute.useNavigate();
  return (
    <BlurFade key="library-hub" duration={0.2} blur="3px" className="size-full">
      <React.Suspense fallback={<PanelFallback />}>
        <KnowledgeLibraryPage
          settingsOpen={settings === true}
          onSettingsOpenChange={(open) =>
            navigate({ search: (prev) => ({ ...prev, settings: open || undefined }) })
          }
        />
      </React.Suspense>
    </BlurFade>
  );
}

const libraryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/library",
  validateSearch: (search: Record<string, unknown>): { thread?: string; settings?: boolean } => ({
    ...(typeof search.thread === "string" && search.thread ? { thread: search.thread } : {}),
    ...(search.settings === true ? { settings: true } : {}),
  }),
  component: LibraryRoute,
});

function SchedulesRoute() {
  return (
    <BlurFade key="schedules" duration={0.2} blur="3px" className="size-full">
      <SchedulesPage />
    </BlurFade>
  );
}

const schedulesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/schedules",
  component: SchedulesRoute,
});

/** 设置页由 RootShell 渲染,共享窗口顶栏;路由本体仅作占位。 */
function SettingsRoute() {
  return null;
}

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  validateSearch: (search: Record<string, unknown>): { section?: string } => ({
    ...(typeof search.section === "string" && search.section ? { section: search.section } : {}),
  }),
  component: SettingsRoute,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  chatRoute,
  agentsRoute,
  skillsRoute,
  libraryRoute,
  schedulesRoute,
  settingsRoute,
]);

export const router = createRouter({ routeTree, history: createHashHistory() });
