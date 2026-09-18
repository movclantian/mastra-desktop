import { useLocation, useNavigate, useRouterState } from "@tanstack/react-router";
import {
  CopyIcon,
  KeyboardIcon,
  Loader2Icon,
  NotebookPenIcon,
  PanelBottomCloseIcon,
  PanelBottomOpenIcon,
  PanelRightOpenIcon,
  Settings2Icon,
  SquareCheckIcon,
} from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { CommandPaletteTrigger } from "@/features/command-palette";
import {
  buildRequestModel,
  summarizeThreadRequest,
  type ThreadSummaryResult,
} from "@/entities/workbench";
import { useProviderConfigQuery } from "@/entities/workbench/model/queries/config";
import { useIsThreadBusy, useThreadsQuery } from "@/entities/workbench/model/queries/threads";
import { viewFromPath } from "@/entities/workbench/model/types";
import { useWorkbenchStore } from "@/entities/workbench/model/workbench-store";
import { useAuth } from "@/features/auth";
import { OpenInIde } from "@/features/workspace-session";
import { useTranslation } from "@/shared/i18n";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/shared/ui/breadcrumb";
import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { Dotm3x3_6 } from "@/shared/ui/dotm-3x3-6";
import { PanelHeader } from "@/shared/ui/panel";
import { ScrollArea } from "@/shared/ui/scroll-area";
import { Separator } from "@/shared/ui/separator";
import { SidebarTrigger } from "@/shared/ui/sidebar";

/**
 * 「生成本次对话纪要」(官方 Memory.summarizeThread + Extractor):一键蒸馏
 * 整段对话并提取核心待办,不写入 memory、不消耗会话上下文。模型取当前
 * 选定(与服务端 chat 同一解析链),未配置时由服务端回退默认模型。
 */
function ThreadSummaryButton() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const userId = user?.id ?? "anonymous";
  const activeThreadId = useRouterState({
    select: (state) => (state.location.search as { thread?: string }).thread ?? null,
  });
  const providers = useProviderConfigQuery().data?.providers ?? [];
  const modelSelection = useWorkbenchStore((state) => state.modelSelection);
  const open = useWorkbenchStore((state) => state.threadSummaryOpen);
  const setOpen = useWorkbenchStore((state) => state.setThreadSummaryOpen);
  const [loading, setLoading] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const [result, setResult] = React.useState<ThreadSummaryResult | null>(null);
  const selectedProvider = providers.find((p) => p.id === modelSelection?.providerId);
  const model =
    selectedProvider && modelSelection
      ? buildRequestModel(selectedProvider, modelSelection.modelId)
      : undefined;

  const runSummary = React.useCallback(async () => {
    if (!activeThreadId) return;
    setLoading(true);
    setFailed(false);
    try {
      setResult(await summarizeThreadRequest(activeThreadId, userId, model));
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [activeThreadId, userId, model]);

  React.useEffect(() => {
    if (open && !result && !loading && !failed && activeThreadId) {
      void runSummary();
    }
  }, [open, result, loading, failed, activeThreadId, runSummary]);

  const handleCopy = () => {
    if (!result) return;
    const text = [
      `【${t("topbar:summarySection")}】`,
      result.summary,
      ...(result.todos.length > 0
        ? [
            "",
            `【${t("topbar:todosSection")}】`,
            ...result.todos.map((todo, index) => `${index + 1}. ${todo}`),
          ]
        : []),
    ].join("\n");
    void navigator.clipboard.writeText(text);
    toast.success(t("topbar:copiedSummary"));
  };

  const handleTrigger = () => {
    setResult(null);
    setFailed(false);
    setOpen(true);
    void runSummary();
  };

  return (
    <>
      <Button
        aria-label={t("topbar:btnAriaLabel")}
        disabled={!activeThreadId}
        onClick={handleTrigger}
        size="icon-sm"
        title={t("topbar:btnTitle")}
        variant="ghost"
      >
        <NotebookPenIcon />
      </Button>
      <Dialog
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) {
            setResult(null);
            setFailed(false);
          }
        }}
        open={open}
      >
        <DialogContent className="flex max-h-[min(80vh,40rem)] max-w-lg flex-col">
          <DialogHeader>
            <DialogTitle>{t("topbar:summaryTitle")}</DialogTitle>
            <DialogDescription>{t("topbar:summaryDesc")}</DialogDescription>
          </DialogHeader>
          <ScrollArea className="min-h-0 flex-1">
            <div className="flex flex-col gap-4 pr-3 text-sm">
              {loading ? (
                <p className="flex items-center gap-2 py-8 text-muted-foreground">
                  <Loader2Icon className="size-4 animate-spin" />
                  {t("topbar:summaryExtracting")}
                </p>
              ) : failed ? (
                <div className="flex flex-col items-center gap-3 py-8 text-muted-foreground">
                  <p>{t("topbar:summaryFailed")}</p>
                  <Button onClick={() => void runSummary()} size="sm" variant="outline">
                    {t("topbar:regenerate")}
                  </Button>
                </div>
              ) : result ? (
                <>
                  <section className="flex flex-col gap-2">
                    <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                      {t("topbar:summarySection")}
                    </h3>
                    <p className="leading-relaxed whitespace-pre-wrap break-words">
                      {result.summary}
                    </p>
                  </section>
                  {result.todos.length > 0 ? (
                    <section className="flex flex-col gap-2">
                      <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                        {t("topbar:todosSection")}
                      </h3>
                      <ul className="flex flex-col gap-1.5">
                        {result.todos.map((todo, index) => (
                          <li className="flex items-start gap-2" key={`${index}-${todo}`}>
                            <SquareCheckIcon className="mt-0.5 size-4 shrink-0 text-primary" />
                            <span className="min-w-0 break-words">{todo}</span>
                          </li>
                        ))}
                      </ul>
                    </section>
                  ) : null}
                </>
              ) : null}
            </div>
          </ScrollArea>
          {result && !loading ? (
            <DialogFooter>
              <Button onClick={() => void runSummary()} size="sm" variant="outline">
                {t("topbar:regenerate")}
              </Button>
              <Button onClick={handleCopy} size="sm">
                <CopyIcon />
                {t("topbar:copyAll")}
              </Button>
            </DialogFooter>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}

export function AppTopBar() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { user } = useAuth();
  const userId = user?.id ?? "anonymous";
  const location = useLocation();
  const activeView = viewFromPath(location.pathname);
  const activeThreadId = useRouterState({
    select: (state) => (state.location.search as { thread?: string }).thread ?? null,
  });
  const threads = useThreadsQuery(userId).data ?? [];
  const activeSkillPath = useRouterState({
    select: (state) => (state.location.search as { skill?: string }).skill ?? null,
  });
  const workspacePanelOpen = useWorkbenchStore((state) => state.workspacePanelOpen);
  const setWorkspacePanelOpen = useWorkbenchStore((state) => state.setWorkspacePanelOpen);
  const terminalPanelOpen = useWorkbenchStore((state) => state.terminalPanelOpen);
  const setTerminalPanelOpen = useWorkbenchStore((state) => state.setTerminalPanelOpen);
  const setShortcutsHelpOpen = useWorkbenchStore((state) => state.setShortcutsHelpOpen);
  const isThreadBusy = useIsThreadBusy(userId);

  const title =
    activeView === "agents"
      ? t("sidebar:agents")
      : activeView === "skills"
        ? t("sidebar:skills")
        : activeView === "library"
          ? t("sidebar:library")
          : activeView === "schedules"
            ? t("sidebar:schedules")
            : (threads.find((thread) => thread.id === activeThreadId)?.title ?? "MastraWork");
  const isCurrentThreadBusy = activeThreadId ? isThreadBusy(activeThreadId) : false;

  return (
    <PanelHeader className="relative z-10 pl-4 pr-2">
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        <SidebarTrigger className="-ml-1" />
        <Separator orientation="vertical" className="mx-1 h-4" />
        <Breadcrumb className="min-w-0">
          <BreadcrumbList className="flex-nowrap text-xs sm:text-sm">
            {activeView === "skills" && activeSkillPath ? (
              <>
                <BreadcrumbItem className="shrink-0">
                  <BreadcrumbLink
                    className="cursor-pointer"
                    render={
                      <button
                        type="button"
                        onClick={() =>
                          void navigate({
                            to: "/skills",
                            search: (prev) => ({ ...prev, skill: undefined }),
                          })
                        }
                      />
                    }
                  >
                    {t("sidebar:skills")}
                  </BreadcrumbLink>
                </BreadcrumbItem>
                <BreadcrumbSeparator />
                <BreadcrumbItem className="min-w-0">
                  <BreadcrumbPage className="max-w-64 truncate font-medium">
                    {activeSkillPath.split("/").pop() || activeSkillPath}
                  </BreadcrumbPage>
                </BreadcrumbItem>
              </>
            ) : (
              <BreadcrumbItem className="min-w-0">
                <BreadcrumbPage className="flex min-w-0 items-center gap-2 font-medium">
                  <span className="truncate">{title}</span>
                  {isCurrentThreadBusy && activeView === "chat" ? (
                    <span
                      className="flex shrink-0 items-center text-primary"
                      title={t("topbar:runningTooltip")}
                    >
                      <Dotm3x3_6 size={12} dotSize={2} colorPreset="solid-theme" />
                    </span>
                  ) : null}
                </BreadcrumbPage>
              </BreadcrumbItem>
            )}
          </BreadcrumbList>
        </Breadcrumb>
      </div>
      {/* 全局命令面板快捷入口与快捷键指南 */}
      <div className="flex items-center gap-1.5 shrink-0 mx-1">
        <CommandPaletteTrigger />
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => setShortcutsHelpOpen(true)}
          title={t("commandPalette:shortcutsGuide")}
          aria-label={t("commandPalette:shortcutsGuide")}
        >
          <KeyboardIcon />
        </Button>
      </div>
      {/* 动态页面动作插槽: 供当前页面或详情模式挂载顶栏快捷按钮 */}
      <div id="app-top-bar-actions" className="flex items-center gap-2 shrink-0 empty:hidden" />
      {activeView === "chat" ? (
        <>
          <ThreadSummaryButton />
          <OpenInIde />
          <Separator orientation="vertical" className="mx-0.5 h-4" />
          <Button
            aria-label={
              terminalPanelOpen ? t("topbar:collapseTerminal") : t("topbar:expandTerminal")
            }
            aria-pressed={terminalPanelOpen}
            onClick={() => setTerminalPanelOpen(!terminalPanelOpen)}
            size="icon-sm"
            title={terminalPanelOpen ? t("topbar:collapseTerminal") : t("topbar:expandTerminal")}
            variant={terminalPanelOpen ? "secondary" : "ghost"}
          >
            {terminalPanelOpen ? <PanelBottomCloseIcon /> : <PanelBottomOpenIcon />}
          </Button>
          {/* 工作区面板显隐按钮随容器迁移:面板展开后,收起按钮迁移到工作区面板头部
              (原关闭按钮位置);顶栏只在面板收起时承载展开入口 —— 按钮在屏幕上
              始终贴近右缘,展开/收起前后位置完全一致 */}
          {!workspacePanelOpen ? (
            <Button
              aria-label={t("topbar:expandWorkspace")}
              className="size-7 shrink-0"
              onClick={() => setWorkspacePanelOpen(true)}
              size="icon-sm"
              title={t("topbar:expandWorkspace")}
              variant="ghost"
            >
              <PanelRightOpenIcon />
            </Button>
          ) : null}
        </>
      ) : null}
      {activeView === "library" ? (
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={t("topbar:librarySettings")}
          title={t("topbar:librarySettings")}
          onClick={() => {
            void navigate({
              to: "/library",
              search: (prev) => ({ ...prev, settings: true }),
            });
          }}
        >
          <Settings2Icon />
        </Button>
      ) : null}
    </PanelHeader>
  );
}
