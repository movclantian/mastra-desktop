import {
  PanelBottomCloseIcon,
  PanelBottomOpenIcon,
  PanelRightCloseIcon,
  PanelRightOpenIcon,
  PlusIcon,
  Settings2Icon,
} from "lucide-react";
import * as React from "react";

import { OpenInIde } from "@/components/ai-elements/open-in-chat";
import { ChatPanel } from "@/components/app/chat";
import { PanelHeader } from "@/components/app/primitives";
import { SettingsDialog } from "@/components/app/settings";
import { AppSidebar } from "@/components/app/sidebar";
import { SkillHub } from "@/components/app/skills";
import { AgentHub } from "@/components/app/agents";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { Toaster } from "@/components/ui/sonner";
import { Spinner } from "@/components/ui/spinner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useWorkbench, WorkbenchProvider } from "@/lib/workbench";

const WorkspacePanel = React.lazy(() => import("@/components/app/workbench/workspace-panel"));
const TerminalPanel = React.lazy(() => import("@/components/app/workbench/terminal-panel"));
const KnowledgeLibrary = React.lazy(() =>
  import("@/components/app/library").then((module) => ({ default: module.KnowledgeLibrary })),
);

function PanelFallback() {
  return (
    <div className="flex size-full items-center justify-center bg-background">
      <Spinner className="size-5" />
    </div>
  );
}

function httpLinkFromTarget(target: EventTarget | null): HTMLAnchorElement | null {
  if (!(target instanceof Element)) return null;
  const anchor = target.closest("a[href]") as HTMLAnchorElement | null;
  if (!anchor || anchor.hasAttribute("download")) return null;
  try {
    return /^https?:$/i.test(new URL(anchor.href).protocol) ? anchor : null;
  } catch {
    return null;
  }
}

/** 右侧工作区面板自身的最小宽度 */
const WORKSPACE_MIN_WIDTH = 340;
/**
 * 输入区左右内距之外,聊天区自己还要留的水平留白(promptArea 外层的 px-4)。
 * 聊天区下限 = 输入区实测最小边界 + 这一项 —— 没有别的常量参与。
 */
const CHAT_HORIZONTAL_PADDING = 32;

function AppShell() {
  const {
    threads,
    activeThreadId,
    createThread,
    libraryOpen,
    setLibraryOpen,
    skillOpen,
    agentOpen,
    setAgentOpen,
    workspacePanelOpen,
    setWorkspacePanelOpen,
    terminalPanelOpen,
    setTerminalPanelOpen,
    openBrowserUrl,
    promptMinWidth,
  } = useWorkbench();
  const [librarySettingsOpen, setLibrarySettingsOpen] = React.useState(false);
  /**
   * 用户拖出来的**意图**宽度。它只在拖拽时改变,不会被空间不足反向改写 ——
   * 真正渲染的是下面夹过的 workspaceWidth。这样空间回来时面板自动回到意图宽度,
   * 不会停在被压扁的状态,也不需要额外记一份"原始值"。
   */
  const [preferredWorkspaceWidth, setPreferredWorkspaceWidth] = React.useState(560);
  const [isDraggingWorkspace, setIsDraggingWorkspace] = React.useState(false);
  const [terminalHeight, setTerminalHeight] = React.useState(280);
  const [isDraggingTerminal, setIsDraggingTerminal] = React.useState(false);
  /** 聊天区 + 右侧面板共同占据的那一行容器,是分配宽度的总额 */
  const shellRef = React.useRef<HTMLDivElement>(null);
  const [shellWidth, setShellWidth] = React.useState(0);
  /**
   * 聊天区能接受的最窄宽度,完全由输入区实测的最小边界推出(见 workbench 的
   * promptMinWidth)。测到之前为 0,即不施加约束 —— 不拿任何猜测值去限制布局。
   */
  const chatMinWidth = promptMinWidth > 0 ? promptMinWidth + CHAT_HORIZONTAL_PADDING : 0;
  /**
   * 面板允许的最大宽度 = 总额 - 聊天区下限。
   *
   * 这两个值都与面板当前宽度无关,所以可以在渲染期直接算出来、把宽度夹住,
   * 而不是先渲染成超宽再由 ResizeObserver 事后收回 —— 后者会实打实地挤压一帧,
   * 叠上 200ms 的宽度过渡就是肉眼可见的「先压瘪再弹回」。
   *
   * 硬边界另有 aside 上那条等价的 CSS max-width 兜着(同帧生效、不滞后);
   * 这个 JS 版本负责拖拽夹取、内层宽度和自动收起的判据。
   */
  const maxWorkspaceWidth =
    shellWidth > 0 && chatMinWidth > 0
      ? Math.max(WORKSPACE_MIN_WIDTH, shellWidth - chatMinWidth)
      : Number.POSITIVE_INFINITY;
  /** 真正用于渲染与拖拽计算的宽度:意图宽度被总额夹过之后的结果 */
  const workspaceWidth = Math.min(preferredWorkspaceWidth, maxWorkspaceWidth);
  const showWorkspace = workspacePanelOpen && !skillOpen && !libraryOpen && !agentOpen;

  React.useEffect(() => {
    if (!libraryOpen) setLibrarySettingsOpen(false);
  }, [libraryOpen]);

  // 全局滚轮横向转换:当鼠标悬浮在任意可横向滚动的区域(如标签栏、操作条、代码块)上时,
  // 标准鼠标垂直滚轮(deltaY)自动转化为平滑横向滚动,支持极速浏览海量标签。
  React.useEffect(() => {
    const handleGlobalWheel = (event: WheelEvent) => {
      // 若已有横向分量或垂直滚轮为 0,直接由系统原生处理
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX) || event.deltaY === 0) return;

      let target = event.target as HTMLElement | null;
      while (target && target !== document.body && target !== document.documentElement) {
        const style = window.getComputedStyle(target);
        const overflowX = style.overflowX;
        const overflowY = style.overflowY;

        const isScrollableX =
          (overflowX === "auto" || overflowX === "scroll") &&
          target.scrollWidth > target.clientWidth;
        const isScrollableY =
          (overflowY === "auto" || overflowY === "scroll") &&
          target.scrollHeight > target.clientHeight;

        // 如果容器可横向滚动且纵向不可滚动(或显式声明了 data-horizontal-scroll)
        if (isScrollableX && (!isScrollableY || target.dataset.horizontalScroll === "true")) {
          const isScrollingRight = event.deltaY > 0;
          const canScroll = isScrollingRight
            ? target.scrollLeft < target.scrollWidth - target.clientWidth - 1
            : target.scrollLeft > 1;

          if (canScroll) {
            target.scrollLeft += event.deltaY;
            event.preventDefault();
            return;
          }
        }
        target = target.parentElement;
      }
    };

    window.addEventListener("wheel", handleGlobalWheel, { passive: false });
    return () => window.removeEventListener("wheel", handleGlobalWheel);
  }, []);

  // 只做一件事:把「可分配总额」测出来。聊天区被挤窄的来源不止一个(窗口缩放、
  // sidebar 展开/收起、面板显隐),但它们最终都体现为这一行容器的宽度变化,
  // 所以观察它一个就够 —— 也包括 sidebar 折叠,那件事压根不发 window.resize。
  //
  // 注意这里不再回写面板宽度:宽度是渲染期从「总额 - 聊天区下限」直接夹出来的
  // 派生值,不存在观察-写回的回路,也就没有先挤压再回弹的那一帧。
  React.useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;
    const observer = new ResizeObserver(() => {
      const width = shell.clientWidth;
      setShellWidth((current) => (current === width ? current : width));
    });
    observer.observe(shell);
    return () => observer.disconnect();
  }, []);

  // 窗口能缩到多窄同样由实测下限决定,而不是写死的 minWidth。
  // 外围占用(sidebar + 窗口边框)= 窗口宽度 - 这一行的总额,都是实测值;
  // 面板开着才为它保留自己的下限,关着就不占额度 —— 于是折叠 sidebar、
  // 关掉面板都会让窗口能缩得更小。
  React.useEffect(() => {
    if (chatMinWidth <= 0 || shellWidth <= 0) return;
    const chrome = window.innerWidth - shellWidth;
    const reserve = showWorkspace ? WORKSPACE_MIN_WIDTH : 0;
    window.api?.setMinimumWidth(chatMinWidth + chrome + reserve);
  }, [chatMinWidth, shellWidth, showWorkspace]);

  // 总额连「聊天区下限 + 面板自己的下限」都装不下时(典型场景:展开 sidebar,或把
  // 窗口缩到很小),继续留着面板只会把两边一起压坏 —— 此时把整块让给聊天区、
  // 收起面板。折叠 sidebar 或放大窗口后再手动打开即可。
  //
  // 「刚打开」那一轮要跳过:上一个 effect 刚通过 IPC 请求撑大窗口,而那是异步的,
  // 此刻 shellWidth 还是旧的小值,不跳过就会出现「点开面板立刻自己关掉」。
  // 窗口撑大后 shellWidth 变化会让本 effect 再跑一次,该收的仍然会收。
  const wasShowingWorkspaceRef = React.useRef(showWorkspace);
  React.useEffect(() => {
    const justOpened = showWorkspace && !wasShowingWorkspaceRef.current;
    wasShowingWorkspaceRef.current = showWorkspace;
    if (justOpened || !showWorkspace || chatMinWidth <= 0 || shellWidth <= 0) return;
    if (shellWidth - chatMinWidth < WORKSPACE_MIN_WIDTH) setWorkspacePanelOpen(false);
  }, [chatMinWidth, setWorkspacePanelOpen, shellWidth, showWorkspace]);

  const activeThread = threads.find((t) => t.id === activeThreadId);

  // 工作区水平拖拽拉伸
  const handleWorkspaceResizeStart = React.useCallback(
    (event: React.PointerEvent) => {
      event.preventDefault();
      setIsDraggingWorkspace(true);
      const startX = event.clientX;
      const startWidth = workspaceWidth;

      const onPointerMove = (e: PointerEvent) => {
        const deltaX = startX - e.clientX;
        // 上限直接用渲染期那个 maxWorkspaceWidth:拖拽与渲染共用同一条边界,
        // 所以拖到底的位置正好是「弹性空白刚被消费完」,不会先超出再被夹回来。
        // 存的是夹过的值 —— 拖到上限就记上限,空间变大后也不擅自替用户变宽。
        setPreferredWorkspaceWidth(
          Math.max(WORKSPACE_MIN_WIDTH, Math.min(maxWorkspaceWidth, startWidth + deltaX)),
        );
      };

      const onPointerUp = () => {
        setIsDraggingWorkspace(false);
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
      };

      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
    },
    [maxWorkspaceWidth, workspaceWidth],
  );

  // 终端垂直拖拽拉伸
  const handleTerminalResizeStart = React.useCallback(
    (event: React.PointerEvent) => {
      event.preventDefault();
      setIsDraggingTerminal(true);
      const startY = event.clientY;
      const startHeight = terminalHeight;

      const onPointerMove = (e: PointerEvent) => {
        const deltaY = startY - e.clientY;
        const newHeight = Math.max(140, Math.min(window.innerHeight * 0.6, startHeight + deltaY));
        setTerminalHeight(newHeight);
      };

      const onPointerUp = () => {
        setIsDraggingTerminal(false);
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
      };

      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
    },
    [terminalHeight],
  );

  React.useEffect(() => {
    const routeClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0) return;
      const anchor = httpLinkFromTarget(event.target);
      if (!anchor || anchor.hasAttribute("download")) return;
      event.preventDefault();
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        void window.api.openExternal(anchor.href);
      } else {
        openBrowserUrl(anchor.href);
      }
    };
    const routeAuxClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 1) return;
      const anchor = httpLinkFromTarget(event.target);
      if (!anchor || anchor.hasAttribute("download")) return;
      event.preventDefault();
      void window.api.openExternal(anchor.href);
    };
    document.addEventListener("click", routeClick, true);
    document.addEventListener("auxclick", routeAuxClick, true);
    return () => {
      document.removeEventListener("click", routeClick, true);
      document.removeEventListener("auxclick", routeAuxClick, true);
    };
  }, [openBrowserUrl]);

  // 顶栏标题按页面切换;新建会话只属于会话页,资料库设置固定在资料库页右上角
  const title = agentOpen
    ? "专家"
    : skillOpen
    ? "技能套件"
    : libraryOpen
      ? "资料库"
      : (activeThread?.title ?? "MastraWork");

  return (
    <SidebarProvider className="h-svh overflow-hidden">
      <AppSidebar />
      <SidebarInset className="overflow-hidden border shadow-sm">
        {/* ref 必须挂在这一层:它同时含聊天区与右侧面板,宽度才是「可分配总额」。
            挂到里面的聊天区上就只能量到扣掉面板之后的余量,算出来的上限会偏小。 */}
        <div
          className="flex size-full min-h-0 min-w-0 overflow-hidden bg-background"
          ref={shellRef}
        >
          {/* 左侧主体(聊天 / 技能 / 资料库 / 终端) */}
          <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
            <PanelHeader className="relative z-10 px-4">
              <div className="flex items-center gap-1.5 min-w-0 flex-1">
                <SidebarTrigger className="-ml-1" />
                <Separator orientation="vertical" className="mx-1 h-4" />
                <p className="truncate text-sm font-medium">{title}</p>
              </div>
              {!skillOpen && !libraryOpen && !agentOpen ? (
                <>
                  <OpenInIde />
                  <Separator orientation="vertical" className="mx-0.5 h-4" />
                  <Button
                    aria-label={terminalPanelOpen ? "收起终端面板" : "展开终端面板"}
                    aria-pressed={terminalPanelOpen}
                    onClick={() => setTerminalPanelOpen(!terminalPanelOpen)}
                    size="icon-sm"
                    title={terminalPanelOpen ? "收起终端面板" : "展开终端面板"}
                    variant={terminalPanelOpen ? "secondary" : "ghost"}
                  >
                    {terminalPanelOpen ? <PanelBottomCloseIcon /> : <PanelBottomOpenIcon />}
                  </Button>
                  <Button
                    aria-label={workspacePanelOpen ? "收起工作区面板" : "展开工作区面板"}
                    aria-pressed={workspacePanelOpen}
                    onClick={() => setWorkspacePanelOpen(!workspacePanelOpen)}
                    size="icon-sm"
                    title={workspacePanelOpen ? "收起工作区面板" : "展开工作区面板"}
                    variant={workspacePanelOpen ? "secondary" : "ghost"}
                  >
                    {workspacePanelOpen ? <PanelRightCloseIcon /> : <PanelRightOpenIcon />}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setLibraryOpen(false);
                      setAgentOpen(false);
                      void createThread();
                    }}
                  >
                    <PlusIcon />
                    新建会话
                  </Button>
                </>
              ) : null}
              {libraryOpen ? (
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label="资料库设置"
                  title="资料库设置"
                  onClick={() => setLibrarySettingsOpen(true)}
                >
                  <Settings2Icon />
                </Button>
              ) : null}
            </PanelHeader>

            <main className="relative z-0 flex min-h-0 flex-1 flex-col overflow-hidden">
              {agentOpen ? (
                <AgentHub />
              ) : skillOpen ? (
                <SkillHub />
              ) : libraryOpen ? (
                <React.Suspense fallback={<PanelFallback />}>
                  <KnowledgeLibrary
                    settingsOpen={librarySettingsOpen}
                    onSettingsOpenChange={setLibrarySettingsOpen}
                  />
                </React.Suspense>
              ) : (
                <div className="flex size-full min-h-0 flex-col overflow-hidden">
                  <div className="min-h-0 flex-1 overflow-hidden">
                    <ChatPanel />
                  </div>

                  {/* 底部终端抽屉:平滑滑入/滑出与可拉伸高度 */}
                  <aside
                    style={{
                      height: terminalPanelOpen ? `${terminalHeight}px` : 0,
                    }}
                    className={cn(
                      "relative flex w-full min-w-0 flex-col border-t bg-background overflow-hidden shrink-0",
                      !isDraggingTerminal && "transition-[height,opacity] duration-200 ease-linear",
                      terminalPanelOpen
                        ? "opacity-100"
                        : "border-t-0 opacity-0 pointer-events-none",
                    )}
                  >
                    {terminalPanelOpen ? (
                      <div
                        onPointerDown={handleTerminalResizeStart}
                        className="group/resizer absolute -top-1.5 inset-x-0 z-30 h-3 cursor-row-resize select-none"
                      >
                        <div className="my-auto h-px w-full bg-border group-hover/resizer:h-0.5 group-hover/resizer:bg-primary transition-colors" />
                      </div>
                    ) : null}
                    <div
                      style={{ height: `${terminalHeight}px` }}
                      className={cn(
                        "flex w-full min-h-0 shrink-0 flex-col",
                        !isDraggingTerminal && "transition-transform duration-200 ease-linear",
                        terminalPanelOpen ? "translate-y-0" : "translate-y-4",
                      )}
                    >
                      <React.Suspense fallback={<PanelFallback />}>
                        <TerminalPanel />
                      </React.Suspense>
                    </div>
                  </aside>
                </div>
              )}
            </main>
          </div>

          {/* 右侧工作区抽屉:平滑滑入/滑出与可拉伸宽度 */}
          <aside
            style={{
              width: showWorkspace ? `${workspaceWidth}px` : 0,
              // 硬边界交给浏览器在布局期算,与 shell 宽度同帧生效。
              // 下面那条 ResizeObserver → setState → 渲染 的链路天生滞后一帧,
              // 而 sidebar 展开是 200ms 里连续变窄(≈21px/帧),那一帧就足以把聊天区
              // 压过下限、让标签抖一下。100% 即 shell 宽度,算式与 maxWorkspaceWidth 逐项对应。
              maxWidth:
                chatMinWidth > 0
                  ? `max(${WORKSPACE_MIN_WIDTH}px, calc(100% - ${chatMinWidth}px))`
                  : undefined,
            }}
            className={cn(
              "relative flex h-full min-h-0 flex-col border-l bg-background overflow-hidden shrink-0",
              !isDraggingWorkspace && "transition-[width,opacity] duration-200 ease-linear",
              showWorkspace ? "opacity-100" : "border-l-0 opacity-0 pointer-events-none",
            )}
          >
            {showWorkspace ? (
              <div
                onPointerDown={handleWorkspaceResizeStart}
                className="group/resizer absolute inset-y-0 -left-1.5 z-30 w-3 cursor-col-resize select-none"
              >
                <div className="mx-auto h-full w-px bg-border group-hover/resizer:w-0.5 group-hover/resizer:bg-primary transition-colors" />
              </div>
            ) : null}
            {/* 这一层刻意保持固定宽度、不跟着 aside 走:滑入过渡期 aside 宽度是 0,
                用 w-full 会让内容也从 0 长出来、被压瘪。它也不需要上面那条 CSS 上限 ——
                真滞后了一帧,多出来的部分被 aside 的 overflow-hidden 裁掉即可,
                聊天区已经被 aside 的 max-width 护住,不会挨挤。 */}
            <div
              style={{ width: `${workspaceWidth}px` }}
              className={cn(
                "flex h-full min-h-0 shrink-0 flex-col",
                !isDraggingWorkspace && "transition-transform duration-200 ease-linear",
                showWorkspace ? "translate-x-0" : "translate-x-4",
              )}
            >
              <React.Suspense fallback={<PanelFallback />}>
                <WorkspacePanel />
              </React.Suspense>
            </div>
          </aside>
        </div>
      </SidebarInset>
      <SettingsDialog />
    </SidebarProvider>
  );
}

export default function App(): React.JSX.Element {
  return (
    <WorkbenchProvider>
      <TooltipProvider>
        <AppShell />
        <Toaster position="bottom-right" />
      </TooltipProvider>
    </WorkbenchProvider>
  );
}
