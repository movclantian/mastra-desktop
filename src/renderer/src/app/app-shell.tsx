import * as React from "react";
import { useDefaultLayout, usePanelRef } from "react-resizable-panels";
import { BlurFade } from "@/components/ui/blur-fade";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { SmoothCursor } from "@/components/ui/smooth-cursor";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AgentHub } from "@/features/agents";
import { AppTopBar } from "@/features/app-shell/app-top-bar";
import { PanelFallback, TerminalDrawer, WorkspaceDrawer } from "@/features/app-shell/drawers";
import { useHorizontalWheelScroll } from "@/features/app-shell/hooks/use-horizontal-wheel-scroll";
import { useLinkRouting } from "@/features/app-shell/hooks/use-link-routing";
import { useWindowMinWidth } from "@/features/app-shell/hooks/use-window-min-width";
import { ChatPanel } from "@/features/chat";
import { AppSidebar } from "@/features/navigation";
import { SettingsDialog } from "@/features/settings";
import { SkillHub } from "@/features/skills";
import { useWorkbench, WorkbenchProvider } from "@/features/workbench";
import { cn } from "@/lib/utils";

const KnowledgeLibrary = React.lazy(() =>
  import("@/features/library").then((module) => ({ default: module.KnowledgeLibrary })),
);

/**
 * 右侧工作区面板的可用性下限。
 *
 * 这个数**不能**像 chatMinWidth 那样实测:面板顶层的标签栏是 min-w-0 + overflow-x-auto,
 * min-content 就是 0,量出来只剩右侧几个图标按钮的宽度(≈120px)—— 技术上不溢出,
 * 但浏览器视图与文件树在那个宽度下已经没有使用价值。所以它是产品判断,
 * 性质等同 VS Code 侧边栏的 minSize,不是待消除的魔数。
 */
const WORKSPACE_MIN_WIDTH = 340;
/**
 * 输入区左右内距之外,聊天区自己还要留的水平留白(promptArea 外层的 px-4)。
 * 聊天区下限 = 输入区实测最小边界 + 这一项 —— 没有别的常量参与。
 */
const CHAT_HORIZONTAL_PADDING = 32;
/** 终端抽屉的默认高度与下限。和 WORKSPACE_MIN_WIDTH 一样是产品判断,不是可实测量 */
const TERMINAL_DEFAULT_HEIGHT = 280;
const TERMINAL_MIN_HEIGHT = 140;
/** 两组面板布局各自持久化。按用户隔离,与 workbench 里那批偏好同一套约定 */
const SHELL_LAYOUT_ID = "mastra-work:shell-layout";
const CHAT_LAYOUT_ID = "mastra-work:chat-layout";

/**
 * 库用 flex-grow 表达布局,所以过渡挂在 flex-grow 上,并且要穿透到它自己渲染的
 * 那层 [data-panel](Panel 的 className 落在更内层,动不了尺寸)。
 *
 * 必须是直接子代选择器:两个 Group 是嵌套的,用后代选择器会让外层的过渡规则一并
 * 命中内层的 Panel —— 那样拖终端分隔条时,外层还挂着过渡,拖手就变成橡皮筋。
 */
const DRAWER_TRANSITION =
  "[&>[data-panel]]:transition-[flex-grow] [&>[data-panel]]:duration-200 [&>[data-panel]]:ease-linear";

/**
 * Panel 内层 div 的 `overflow: auto` 是库写死的 inline style,className 压不过它 ——
 * 只能同样经 style 覆盖。抽屉收起时正是靠这一层把「撑住下限的内容」裁掉。
 */
const PANEL_CLIP = { overflow: "hidden" } as const;

/**
 * 抽屉开合的过渡开关。
 *
 * react-resizable-panels 不做动画,而库作者明确说明过:常开 CSS transition 能让
 * 折叠/展开动起来,但会破坏 drag-to-resize —— 拖手会变成橡皮筋追赶。库又不暴露
 * 拖拽态,没法靠 CSS 反选,所以这里自己关掉两种情况:
 *
 *   · 拖拽期间 —— 从 Separator 的 pointerdown 到 pointerup
 *   · 首帧 —— 挂载时那次 collapse 只是把恢复出来的布局与「抽屉默认收起」对齐,
 *     不该表演成一次滑出
 *
 * 其余时候过渡常挂着,于是开合动画不需要任何时序配合:命令式 collapse()/expand()
 * 改的就是 flex-grow,CSS 自然把它补成 200ms。
 */
function useDrawerTransition() {
  const [ready, setReady] = React.useState(false);
  const [resizing, setResizing] = React.useState(false);

  React.useEffect(() => {
    const frame = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  const onPointerDown = React.useCallback(() => {
    setResizing(true);
    // pointercancel 也要收尾:触摸被系统手势接管时不会有 pointerup,漏掉它 resizing
    // 就永久为真 —— 过渡再也挂不回来,依赖它的尺寸约束也永久冻结(见 AppShell)
    const stop = () => {
      setResizing(false);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  }, []);

  return {
    /** 加在 Group 上 */
    className: ready && !resizing ? DRAWER_TRANSITION : undefined,
    /** 拖拽进行中。Panel 的尺寸约束必须在这期间保持不变,理由见 AppShell */
    resizing,
    /** 摊到 ResizableHandle 上 */
    handleProps: { onPointerDown },
  };
}

/**
 * 拖手的状态:抽屉收起时一并停掉,展开时 hover 高亮。
 *
 * 不条件渲染它:Separator 必须是 Group 的直接 DOM 子元素,增删会打乱库按
 * Panel/Separator 顺序推出来的布局。留在原位隐藏掉,结构就始终是稳定的。
 */
function drawerHandleProps(open: boolean) {
  return {
    disabled: !open,
    className: open ? "transition-colors hover:bg-primary" : "pointer-events-none opacity-0",
  };
}

/**
 * 抽屉内容。收起时 Panel 尺寸是 0,`w-full` 会把内容一起压瘪,所以另外用可用性下限
 * 撑住 —— 超出的部分由 Panel 的 PANEL_CLIP 裁掉,滑出于是看起来是「被推出视野」
 * 而不是「被挤扁」。收起时连边框一起去掉,否则会在边缘留一条 1px 的线。
 */
/** 会话页 = 聊天区 + 底部终端抽屉。这个 Group 只存在于本页,布局也就单独持久化 */
function ChatWithTerminal({ userId }: { userId: string }) {
  const { terminalPanelOpen } = useWorkbench();
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: `${CHAT_LAYOUT_ID}:${encodeURIComponent(userId)}`,
    storage: localStorage,
    // 只记用户亲手拖出来的高度。空间不足时库夹取出来的结果不算偏好,
    // 否则一次挤压就会被固化成「用户想要的高度」
    onlySaveAfterUserInteractions: true,
  });
  const terminalRef = usePanelRef();
  const transition = useDrawerTransition();

  React.useEffect(() => {
    const panel = terminalRef.current;
    if (!panel) return;
    // collapse() 会记住当前高度,expand() 原样恢复 —— 不需要自己存一份
    if (terminalPanelOpen) panel.expand();
    else panel.collapse();
  }, [terminalPanelOpen, terminalRef]);

  return (
    <ResizablePanelGroup
      orientation="vertical"
      defaultLayout={defaultLayout}
      onLayoutChanged={onLayoutChanged}
      className={cn("min-h-0", transition.className)}
    >
      <ResizablePanel style={PANEL_CLIP} className="flex min-h-0 flex-col">
        <ChatPanel />
      </ResizablePanel>
      <ResizableHandle {...transition.handleProps} {...drawerHandleProps(terminalPanelOpen)} />
      <ResizablePanel
        panelRef={terminalRef}
        collapsible
        collapsedSize={0}
        defaultSize={TERMINAL_DEFAULT_HEIGHT}
        minSize={TERMINAL_MIN_HEIGHT}
        maxSize="60%"
        groupResizeBehavior="preserve-pixel-size"
        style={PANEL_CLIP}
      >
        <TerminalDrawer open={terminalPanelOpen} minHeight={TERMINAL_MIN_HEIGHT} />
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}

function AppShell() {
  const { user, activeView, workspacePanelOpen, openBrowserUrl, promptMinWidth } = useWorkbench();
  const [librarySettingsOpen, setLibrarySettingsOpen] = React.useState(false);

  React.useEffect(() => {
    if (activeView !== "library") setLibrarySettingsOpen(false);
  }, [activeView]);

  useHorizontalWheelScroll();
  useLinkRouting(openBrowserUrl);

  const transition = useDrawerTransition();

  /**
   * 聊天区能接受的最窄宽度,完全由输入区实测的最小边界推出(见 workbench 的
   * promptMinWidth)。测到之前为 0,即不施加约束 —— 不拿任何猜测值去限制布局。
   */
  const chatMinWidth = promptMinWidth > 0 ? promptMinWidth + CHAT_HORIZONTAL_PADDING : 0;
  /**
   * 拖拽期间冻结这个下限,拖完再让新值生效。
   *
   * minSize 是 Panel 的 prop,一变 react-resizable-panels 就会注销并重新注册这个
   * Panel;而它的拖拽状态里存的是 pointerdown 那一刻的 Panel 对象引用,换了对象就
   * 定位不到 pivot 索引,进行中的拖拽当场断掉 —— 表现正是「拖一点点就拖不动,
   * 松开手重来又只能拖一点点」。
   *
   * 输入区里本来就有会自己变宽的内容(上下文占比的数字位数、模型名),边生成边拖
   * 分隔条一定撞上,所以这不是在防假想情况。冻结期间下限最多差几像素,无妨。
   */
  const frozenChatMinWidth = React.useRef(chatMinWidth);
  if (!transition.resizing) frozenChatMinWidth.current = chatMinWidth;
  const panelMinWidth = transition.resizing ? frozenChatMinWidth.current : chatMinWidth;
  /**
   * 用户的**意图**。按钮状态、窗口最小宽度要替面板留多少额度,都只看这个。
   *
   * 意图与实际刻意分离:空间不够时由库把面板折叠掉,而这里不回写 workspacePanelOpen。
   * 于是窗口一放大、sidebar 一收起,面板自己就回来了,不用用户再点一次。
   */
  const wantsWorkspace = workspacePanelOpen && activeView === "chat";

  const groupRef = React.useRef<HTMLDivElement>(null);
  useWindowMinWidth({
    elementRef: groupRef,
    // 同样用冻结值:拖分隔条的半途窗口自己变宽会更难受,整套约束一起按住到松手
    contentMinWidth: panelMinWidth,
    // 只保面板的可用性下限,而不是它当前有多宽:窗口该长到「面板刚好能用」为止。
    // 留当前宽度的话,用户每拖宽一次就把窗口下限顶高一次,再也缩不回来。
    reservedWidth: wantsWorkspace ? WORKSPACE_MIN_WIDTH : 0,
  });

  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: `${SHELL_LAYOUT_ID}:${encodeURIComponent(user.id)}`,
    storage: localStorage,
    onlySaveAfterUserInteractions: true,
  });
  const workspaceRef = usePanelRef();

  React.useEffect(() => {
    const panel = workspaceRef.current;
    if (!panel) return;
    if (wantsWorkspace) panel.expand();
    else panel.collapse();
  }, [wantsWorkspace, workspaceRef]);

  return (
    <SidebarProvider className="h-svh overflow-hidden">
      <AppSidebar />
      <SidebarInset className="overflow-hidden border shadow-sm">
        <ResizablePanelGroup
          orientation="horizontal"
          elementRef={groupRef}
          defaultLayout={defaultLayout}
          onLayoutChanged={onLayoutChanged}
          className={cn("min-h-0 min-w-0 overflow-hidden bg-background", transition.className)}
        >
          {/* 左侧主体(会话 / 技能 / 资料库 / 专家)。聊天区下限是硬的:预算不够时
              正确的反应是右侧面板让位,而不是把 promptInput 压坏 */}
          <ResizablePanel
            minSize={panelMinWidth}
            style={PANEL_CLIP}
            className="flex min-w-0 flex-col"
          >
            <AppTopBar onOpenLibrarySettings={() => setLibrarySettingsOpen(true)} />
            <main className="relative z-0 flex min-h-0 flex-1 flex-col overflow-hidden">
              {activeView === "agents" ? (
                <BlurFade key="agent-hub" duration={0.2} blur="3px" className="size-full">
                  <AgentHub />
                </BlurFade>
              ) : activeView === "skills" ? (
                <BlurFade key="skill-hub" duration={0.2} blur="3px" className="size-full">
                  <SkillHub />
                </BlurFade>
              ) : activeView === "library" ? (
                <BlurFade key="library-hub" duration={0.2} blur="3px" className="size-full">
                  <React.Suspense fallback={<PanelFallback />}>
                    <KnowledgeLibrary
                      settingsOpen={librarySettingsOpen}
                      onSettingsOpenChange={setLibrarySettingsOpen}
                    />
                  </React.Suspense>
                </BlurFade>
              ) : (
                <ChatWithTerminal userId={user.id} />
              )}
            </main>
          </ResizablePanel>
          <ResizableHandle {...transition.handleProps} {...drawerHandleProps(wantsWorkspace)} />
          {/* 右侧工作区抽屉。collapsible 顺带实现了「放不下就让位」:尺寸被压到
              minSize 以下时库自动折叠,不需要额外的预算判断 */}
          <ResizablePanel
            panelRef={workspaceRef}
            collapsible
            collapsedSize={0}
            minSize={WORKSPACE_MIN_WIDTH}
            // sidebar 展开让这一行变窄时,面板保持原宽、由聊天区吸收
            groupResizeBehavior="preserve-pixel-size"
            style={PANEL_CLIP}
          >
            <WorkspaceDrawer open={wantsWorkspace} minWidth={WORKSPACE_MIN_WIDTH} />
          </ResizablePanel>
        </ResizablePanelGroup>
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
