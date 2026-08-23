import {
  ArrowLeftIcon,
  PanelBottomCloseIcon,
  PanelBottomOpenIcon,
  PanelRightCloseIcon,
  PanelRightOpenIcon,
  PlusIcon,
  Settings2Icon,
  Trash2Icon,
} from "lucide-react";
import * as React from "react";

import { OpenInIde } from "@/components/ai-elements/open-in-chat";
import { AgentHub } from "@/components/app/agents";
import { ChatPanel } from "@/components/app/chat";
import { PanelHeader } from "@/components/app/primitives";
import { SettingsDialog } from "@/components/app/settings";
import { AppSidebar } from "@/components/app/sidebar";
import { SkillHub } from "@/components/app/skills";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { SmoothCursor } from "@/components/ui/smooth-cursor";
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

/**
 * 右侧工作区面板的可用性下限。
 *
 * 这个数**不能**像 chatMinWidth 那样实测:面板顶层的标签栏是 min-w-0 + overflow-x-auto,
 * min-content 就是 0,量出来只剩右侧几个图标按钮的宽度(≈120px)—— 技术上不溢出,
 * 但浏览器视图与文件树在那个宽度下已经没有使用价值。所以它是产品判断,
 * 性质等同 VS Code 侧边栏的 minSize,不是待消除的魔数。
 *
 * 三处用到:面板的默认宽度(最保守的那一端)、拖拽的下界,以及窗口撑不大时
 * 「面板放不下就让位」的判据。
 */
const WORKSPACE_MIN_WIDTH = 340;
/**
 * 输入区左右内距之外,聊天区自己还要留的水平留白(promptArea 外层的 px-4)。
 * 聊天区下限 = 输入区实测最小边界 + 这一项 —— 没有别的常量参与。
 */
const CHAT_HORIZONTAL_PADDING = 32;
/** 终端抽屉的默认高度。和 WORKSPACE_MIN_WIDTH 一样是产品判断,不是可实测量 */
const TERMINAL_DEFAULT_HEIGHT = 280;
const WORKSPACE_WIDTH_KEY = "mastra-work:workspace-width";
const TERMINAL_HEIGHT_KEY = "mastra-work:terminal-height";

/**
 * 用户拖出来的面板尺寸,持久化到 localStorage —— 与 workbench 里那批偏好同一套约定
 * (mastra-work: 前缀、读不出来就退回默认值)。
 *
 * 存的是**意图**而不是当前渲染值,所以不会把某次空间不足时的夹取结果记成偏好。
 */
function usePersistentSize(key: string, fallback: number) {
  const [value, setValue] = React.useState(() => {
    const stored = Number.parseFloat(localStorage.getItem(key) ?? "");
    return Number.isFinite(stored) && stored > 0 ? stored : fallback;
  });
  React.useEffect(() => {
    localStorage.setItem(key, String(value));
  }, [key, value]);
  return [value, setValue] as const;
}

function AppShell() {
  const {
    threads,
    activeThreadId,
    createThread,
    libraryOpen,
    setLibraryOpen,
    skillOpen,
    activeSkill,
    setActiveSkill,
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
   *
   * 初值取下限:窗口最小宽度里含着这个数(见下面的 setMinimumWidth),所以初值越大,
   * 首次打开面板就把用户的窗口撑得越多。默认该是干扰最小的那一端,想要更宽自己拖。
   */
  const [preferredWorkspaceWidth, setPreferredWorkspaceWidth] = usePersistentSize(
    WORKSPACE_WIDTH_KEY,
    WORKSPACE_MIN_WIDTH,
  );
  const [isDraggingWorkspace, setIsDraggingWorkspace] = React.useState(false);
  const [terminalHeight, setTerminalHeight] = usePersistentSize(
    TERMINAL_HEIGHT_KEY,
    TERMINAL_DEFAULT_HEIGHT,
  );
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
   * 面板能分到的宽度预算 = 总额 - 聊天区下限。
   *
   * 这两个值都与面板当前宽度无关,所以可以在渲染期直接算出来、把宽度夹住,
   * 而不是先渲染成超宽再由 ResizeObserver 事后收回 —— 后者会实打实地挤压一帧,
   * 叠上 200ms 的宽度过渡就是肉眼可见的「先压瘪再弹回」。
   *
   * 这里**不**用面板自己的下限兜底:两个下限只能有一个是硬的,而聊天区那个才是
   * 不可侵犯的。让面板坚持它的 WORKSPACE_MIN_WIDTH,结果只会是 promptInput 被压坏 ——
   * 预算不够时的正确反应是面板让位,而不是硬挤。
   *
   * 硬边界另有 aside 上那条等价的 CSS max-width 兜着(同帧生效、不滞后);
   * 这个 JS 版本负责拖拽夹取和内层宽度。
   */
  const workspaceBudget =
    shellWidth > 0 && chatMinWidth > 0 ? shellWidth - chatMinWidth : Number.POSITIVE_INFINITY;
  /**
   * 真正用于渲染与拖拽计算的宽度:意图宽度被预算夹过之后的结果。
   * 下界只是防出负数(预算可能小于 0) —— 面板真被渲染出来时预算已 ≥ 下限,夹不到。
   */
  const workspaceWidth = Math.max(
    WORKSPACE_MIN_WIDTH,
    Math.min(preferredWorkspaceWidth, workspaceBudget),
  );
  /** 用户的意图。按钮状态、以及窗口最小宽度要替面板留多少额度,都只看这个 */
  const wantsWorkspace = workspacePanelOpen && !skillOpen && !libraryOpen && !agentOpen;
  /**
   * 实际是否渲染面板:预算连面板自己的下限都到不了就干脆不渲染,整块让给聊天区。
   *
   * 这是渲染期的派生值而不是 effect,所以既没有「先打开、再由 effect 检查该不该关」
   * 的竞态,也不存在 effect 依赖不再变化、挤压被永久固化的死角。
   *
   * 刻意不把 workspacePanelOpen 改回 false —— 意图与实际分离,和
   * preferredWorkspaceWidth / workspaceWidth 是同一个套路:窗口一放大、sidebar 一收起,
   * 面板自己就回来了,不用用户再点一次。
   */
  const showWorkspace = wantsWorkspace && workspaceBudget >= WORKSPACE_MIN_WIDTH;

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

  // 窗口宽度同样由实测下限决定,而不是写死的 minWidth。
  // 外围占用(sidebar + 窗口边框)= 窗口宽度 - 这一行的总额,都是实测值。
  //
  // 关键:面板开着时,额度里留的是它**当前的宽度**,而不是它的可用性下限。于是
  // 「面板以期望宽度展开所需的宽度」既是窗口要长到的目标、也是窗口的最小宽度 ——
  // 窗口去适应内容,而不是把内容压进窗口。这几件事因此自动自洽,不需要额外分支:
  //   · 点开面板 → 窗口不够就正好长到那个宽度,不多也不少
  //   · 面板开着 → 窗口再也缩不到会挤压面板的程度
  //   · 拖窄面板 → 额度跟着降,窗口立刻又能缩了
  //   · 拖宽面板 → 已被 workspaceBudget 夹在总额内,算出的额度最多等于当前窗口宽,
  //     所以永远不会反向把窗口撑大;拖到底时额度正好等于窗口宽,窗口就地被钉住
  //   · 展开 sidebar → chrome 变大 → 窗口跟着长,面板与聊天区都保持原宽
  //
  // 这里必须看**意图**(wantsWorkspace)而不是实际渲染:用 showWorkspace 会死锁 ——
  // 空间不足 → 不渲染 → 不留额度 → 窗口不被撑大 → 永远不足。
  React.useEffect(() => {
    if (chatMinWidth <= 0 || shellWidth <= 0) return;
    const chrome = window.innerWidth - shellWidth;
    const reserve = wantsWorkspace ? preferredWorkspaceWidth : 0;
    window.api?.setMinimumWidth?.(chatMinWidth + chrome + reserve);
  }, [chatMinWidth, preferredWorkspaceWidth, shellWidth, wantsWorkspace]);

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
        // 上限直接用渲染期那个 workspaceBudget:拖拽与渲染共用同一条边界,
        // 所以拖到底的位置正好是「弹性空白刚被消费完」,不会先超出再被夹回来。
        // 存的是夹过的值 —— 拖到上限就记上限,空间变大后也不擅自替用户变宽。
        setPreferredWorkspaceWidth(
          Math.max(WORKSPACE_MIN_WIDTH, Math.min(workspaceBudget, startWidth + deltaX)),
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
    [setPreferredWorkspaceWidth, workspaceBudget, workspaceWidth],
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
    [setTerminalHeight, terminalHeight],
  );

  React.useEffect(() => {
    const routeClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0) return;
      const anchor = httpLinkFromTarget(event.target);
      if (!anchor || anchor.hasAttribute("download")) return;
      event.preventDefault();
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        if (window.api?.openExternal) void window.api.openExternal(anchor.href);
        else window.open(anchor.href, "_blank", "noopener,noreferrer");
      } else {
        openBrowserUrl(anchor.href);
      }
    };
    const routeAuxClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 1) return;
      const anchor = httpLinkFromTarget(event.target);
      if (!anchor || anchor.hasAttribute("download")) return;
      event.preventDefault();
      if (window.api?.openExternal) void window.api.openExternal(anchor.href);
      else window.open(anchor.href, "_blank", "noopener,noreferrer");
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
                {skillOpen && activeSkill ? (
                  <>
                    <Separator orientation="vertical" className="mx-1 h-4" />
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setActiveSkill(null)}
                      className="h-7 gap-1 px-2 text-xs font-normal text-muted-foreground hover:text-foreground cursor-pointer"
                    >
                      <ArrowLeftIcon className="size-3.5" />
                      返回插件市场
                    </Button>
                    <Separator orientation="vertical" className="mx-1 h-4" />
                    <p className="truncate text-sm font-medium">{activeSkill.name}</p>
                  </>
                ) : (
                  <>
                    <Separator orientation="vertical" className="mx-1 h-4" />
                    <p className="truncate text-sm font-medium">{title}</p>
                  </>
                )}
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
              // 压过下限、让标签抖一下。100% 即 shell 宽度,算式与 workspaceBudget 逐项对应。
              //
              // 这里不给面板留下限:滞后帧里宁可让面板临时更窄,也不能压聊天区。
              // 稳态下 showWorkspace 已经保证了预算 ≥ WORKSPACE_MIN_WIDTH。
              maxWidth: chatMinWidth > 0 ? `calc(100% - ${chatMinWidth}px)` : undefined,
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
        <SmoothCursor />
        <Toaster position="bottom-right" />
      </TooltipProvider>
    </WorkbenchProvider>
  );
}
