import {
  Columns2Icon,
  FileDiffIcon,
  FolderTreeIcon,
  Globe2Icon,
  LayersIcon,
  Maximize2Icon,
  PanelBottomOpenIcon,
  PanelRightCloseIcon,
  PlusIcon,
  TerminalIcon,
  XIcon,
} from "lucide-react";
import * as React from "react";
import { TerminalSession } from "@/entities/workbench";
import { useWorkbenchStore } from "@/entities/workbench/model/workbench-store";
import { formatShortcutDisplay, isMacPlatform } from "@/features/command-palette";
import { useTranslation } from "@/shared/i18n";
import { cn } from "@/shared/lib";
import { Button } from "@/shared/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/shared/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "@/shared/ui/empty";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@/shared/ui/item";
import { PanelHeader, PanelSurface } from "@/shared/ui/panel";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/shared/ui/select";

import { useBrowserSession } from "../model/use-browser-session";
import { BrowserView } from "./browser-view";
import { ChangesWorkspace } from "./changes-workspace";
import { FilesWorkspace } from "./files-workspace";

const NEW_BROWSER_TAB_URL = "https://www.bing.com";
const TAB_DND_TYPE = "application/x-mastra-tab";
const STORAGE_KEY_FLOATING_BOUNDS = "mastra-workspace:floating-bounds";
const MIN_FLOATING_WIDTH = 440;
const MIN_FLOATING_HEIGHT = 300;

interface FloatingBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

type DragOrResizeMode = "move" | "t" | "b" | "l" | "r" | "tl" | "tr" | "bl" | "br";

function getInitialFloatingBounds(): FloatingBounds {
  if (typeof window === "undefined") {
    return { x: 100, y: 80, width: 880, height: 680 };
  }
  const defaultWidth = Math.max(MIN_FLOATING_WIDTH, Math.min(920, window.innerWidth - 64));
  const defaultHeight = Math.max(MIN_FLOATING_HEIGHT, Math.min(720, window.innerHeight - 96));
  const defaultX = Math.max(20, window.innerWidth - defaultWidth - 24);
  const defaultY = Math.max(48, window.innerHeight - defaultHeight - 24);

  try {
    const raw = localStorage.getItem(STORAGE_KEY_FLOATING_BOUNDS);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (
        typeof parsed.width === "number" &&
        typeof parsed.height === "number" &&
        typeof parsed.x === "number" &&
        typeof parsed.y === "number"
      ) {
        const width = Math.max(MIN_FLOATING_WIDTH, Math.min(window.innerWidth - 32, parsed.width));
        const height = Math.max(
          MIN_FLOATING_HEIGHT,
          Math.min(window.innerHeight - 48, parsed.height),
        );
        const x = Math.max(0, Math.min(window.innerWidth - width, parsed.x));
        const y = Math.max(0, Math.min(window.innerHeight - 48, parsed.y));
        return { x, y, width, height };
      }
    }
  } catch {}

  return { x: defaultX, y: defaultY, width: defaultWidth, height: defaultHeight };
}

export function WorkspacePanelShell() {
  const { t } = useTranslation();
  const activePanelTab = useWorkbenchStore((store) => store.activePanelTab);
  const activatePanelTab = useWorkbenchStore((store) => store.activatePanelTab);
  const addPanelTab = useWorkbenchStore((store) => store.addPanelTab);
  const closePanelTab = useWorkbenchStore((store) => store.closePanelTab);
  const panelTabs = useWorkbenchStore((store) => store.panelTabs);
  const reorderPanelTab = useWorkbenchStore((store) => store.reorderPanelTab);
  const moveTerminalTab = useWorkbenchStore((store) => store.moveTerminalTab);
  const workspacePanelMode = useWorkbenchStore((store) => store.workspacePanelMode);
  const setWorkspacePanelMode = useWorkbenchStore((store) => store.setWorkspacePanelMode);
  const setWorkspacePanelOpen = useWorkbenchStore((store) => store.setWorkspacePanelOpen);
  // 会话状态在面板层建立(无条件调用),浏览器视图按当前标签渲染
  const browserSession = useBrowserSession();
  const { action, closeBrowser, closeLastBrowserTab, state } = browserSession;
  const browserActive = activePanelTab.kind === "browser";
  const draggedTabRef = React.useRef<string | null>(null);
  const [draggingTabId, setDraggingTabId] = React.useState<string | null>(null);
  const [dragOverTabId, setDragOverTabId] = React.useState<string | null>(null);

  const [floatingBounds, setFloatingBounds] =
    React.useState<FloatingBounds>(getInitialFloatingBounds);
  const floatingBoundsRef = React.useRef<FloatingBounds>(floatingBounds);
  floatingBoundsRef.current = floatingBounds;
  const isMac = React.useMemo(() => isMacPlatform(), []);
  const [activeInteraction, setActiveInteraction] = React.useState<DragOrResizeMode | null>(null);

  React.useEffect(() => {
    const handleResize = () => {
      setFloatingBounds((prev) => {
        const width = Math.max(MIN_FLOATING_WIDTH, Math.min(window.innerWidth - 32, prev.width));
        const height = Math.max(
          MIN_FLOATING_HEIGHT,
          Math.min(window.innerHeight - 48, prev.height),
        );
        const x = Math.max(0, Math.min(window.innerWidth - width, prev.x));
        const y = Math.max(0, Math.min(window.innerHeight - 48, prev.y));
        if (width === prev.width && height === prev.height && x === prev.x && y === prev.y) {
          return prev;
        }
        const next = { x, y, width, height };
        floatingBoundsRef.current = next;
        return next;
      });
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  const onHeaderPointerDown = (e: React.PointerEvent<HTMLElement>) => {
    if (workspacePanelMode !== "floating") return;
    if (e.button !== 0) return;
    const target = e.target as HTMLElement | null;
    if (
      target?.closest(
        'button, a, input, select, textarea, [role="button"], [data-slot="select-trigger"], [data-slot="select-content"], [data-slot="dropdown-menu-trigger"], [tabindex="0"]',
      )
    ) {
      return;
    }

    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const initialBounds = { ...floatingBoundsRef.current };

    const onPointerMove = (moveEvent: PointerEvent) => {
      const dx = moveEvent.clientX - startX;
      const dy = moveEvent.clientY - startY;
      const maxX = Math.max(0, window.innerWidth - initialBounds.width);
      const maxY = Math.max(0, window.innerHeight - 48);
      const nextX = Math.min(Math.max(0, initialBounds.x + dx), maxX);
      const nextY = Math.min(Math.max(0, initialBounds.y + dy), maxY);

      setFloatingBounds((prev) => {
        const next = { ...prev, x: nextX, y: nextY };
        floatingBoundsRef.current = next;
        return next;
      });
    };

    const onPointerUp = () => {
      setActiveInteraction(null);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      try {
        localStorage.setItem(
          STORAGE_KEY_FLOATING_BOUNDS,
          JSON.stringify(floatingBoundsRef.current),
        );
      } catch {}
    };

    setActiveInteraction("move");
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  };

  const startResize = (direction: DragOrResizeMode, e: React.PointerEvent) => {
    if (workspacePanelMode !== "floating") return;
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();

    const startX = e.clientX;
    const startY = e.clientY;
    const initial = { ...floatingBoundsRef.current };

    const onPointerMove = (moveEvent: PointerEvent) => {
      const dx = moveEvent.clientX - startX;
      const dy = moveEvent.clientY - startY;

      let newWidth = initial.width;
      let newHeight = initial.height;
      let newX = initial.x;
      let newY = initial.y;

      // 水平方向计算
      if (direction.includes("r")) {
        newWidth = Math.max(MIN_FLOATING_WIDTH, initial.width + dx);
        newWidth = Math.min(newWidth, window.innerWidth - newX);
      } else if (direction.includes("l")) {
        const potentialWidth = initial.width - dx;
        if (potentialWidth >= MIN_FLOATING_WIDTH) {
          const clampedX = Math.max(0, initial.x + dx);
          newWidth = initial.x + initial.width - clampedX;
          newX = clampedX;
        } else {
          newWidth = MIN_FLOATING_WIDTH;
          newX = initial.x + (initial.width - MIN_FLOATING_WIDTH);
        }
      }

      // 垂直方向计算
      if (direction.includes("b")) {
        newHeight = Math.max(MIN_FLOATING_HEIGHT, initial.height + dy);
        newHeight = Math.min(newHeight, window.innerHeight - newY);
      } else if (direction.includes("t")) {
        const potentialHeight = initial.height - dy;
        if (potentialHeight >= MIN_FLOATING_HEIGHT) {
          const clampedY = Math.max(0, initial.y + dy);
          newHeight = initial.y + initial.height - clampedY;
          newY = clampedY;
        } else {
          newHeight = MIN_FLOATING_HEIGHT;
          newY = initial.y + (initial.height - MIN_FLOATING_HEIGHT);
        }
      }

      setFloatingBounds(() => {
        const next = { x: newX, y: newY, width: newWidth, height: newHeight };
        floatingBoundsRef.current = next;
        return next;
      });
    };

    const onPointerUp = () => {
      setActiveInteraction(null);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      try {
        localStorage.setItem(
          STORAGE_KEY_FLOATING_BOUNDS,
          JSON.stringify(floatingBoundsRef.current),
        );
      } catch {}
    };

    setActiveInteraction(direction);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  };

  const closeBrowserAndReturnToLocalTab = () => {
    closeBrowser();
    const fallback = panelTabs[panelTabs.length - 1];
    if (fallback) {
      activatePanelTab({ kind: fallback.kind, id: fallback.id });
    } else {
      activatePanelTab({ kind: "welcome", id: "welcome" });
    }
  };

  /** 切到某个浏览器页面:先切服务端活动页,再把面板切到浏览器视图 */
  const openBrowserTab = (index: number) => {
    activatePanelTab({ kind: "browser", index });
    void action("switch-tab", index);
  };

  /**
   * 关闭一个页面标签:
   * 1. 优先平滑回退到左侧前一个标签;
   * 2. 若关掉的是唯一一个浏览器标签,回落到最后一个本地标签或起始页,并保持 Chromium 进程常驻预热。
   */
  const closeBrowserTab = (index: number) => {
    if (state.tabs.length <= 1) {
      closeLastBrowserTab();
      const fallback = panelTabs[panelTabs.length - 1];
      if (fallback) {
        activatePanelTab({ kind: fallback.kind, id: fallback.id });
      } else {
        activatePanelTab({ kind: "welcome", id: "welcome" });
      }
      return;
    }
    if (activePanelTab.kind === "browser" && activePanelTab.index === index) {
      const prevIndex = index > 0 ? index - 1 : 0;
      activatePanelTab({ kind: "browser", index: prevIndex });
    } else if (activePanelTab.kind === "browser" && activePanelTab.index > index) {
      activatePanelTab({ kind: "browser", index: activePanelTab.index - 1 });
    }
    void action("close-tab", index);
  };

  const isWelcomeActive =
    activePanelTab.kind === "welcome" ||
    (panelTabs.length === 0 && state.tabs.length === 0 && !browserActive);

  return (
    <>
      {activeInteraction && (
        <div
          style={{
            cursor:
              activeInteraction === "move"
                ? "grabbing"
                : activeInteraction === "t" || activeInteraction === "b"
                  ? "ns-resize"
                  : activeInteraction === "l" || activeInteraction === "r"
                    ? "ew-resize"
                    : activeInteraction === "tl" || activeInteraction === "br"
                      ? "nwse-resize"
                      : "nesw-resize",
          }}
          className={cn(
            "fixed inset-0 z-[9999] select-none",
            activeInteraction === "move" && "cursor-grabbing",
            (activeInteraction === "t" || activeInteraction === "b") && "cursor-ns-resize",
            (activeInteraction === "l" || activeInteraction === "r") && "cursor-ew-resize",
            (activeInteraction === "tl" || activeInteraction === "br") && "cursor-nwse-resize",
            (activeInteraction === "tr" || activeInteraction === "bl") && "cursor-nesw-resize",
          )}
        />
      )}
      <PanelSurface
        style={
          workspacePanelMode === "floating"
            ? {
                left: `${floatingBounds.x}px`,
                top: `${floatingBounds.y}px`,
                width: `${floatingBounds.width}px`,
                height: `${floatingBounds.height}px`,
                minWidth: `${MIN_FLOATING_WIDTH}px`,
                minHeight: `${MIN_FLOATING_HEIGHT}px`,
              }
            : undefined
        }
        className={cn(
          workspacePanelMode === "floating" &&
            "fixed z-40 size-auto max-h-screen max-w-screen overflow-hidden rounded-xl border border-border/80 bg-background/95 shadow-2xl ring-1 ring-border/50 backdrop-blur-sm",
          workspacePanelMode === "fullscreen" && "fixed inset-0 z-50 overflow-hidden bg-background",
        )}
      >
        <PanelHeader
          onPointerDown={onHeaderPointerDown}
          className={cn(
            "h-12 justify-between border-b px-2 py-0",
            workspacePanelMode === "floating" && "cursor-grab active:cursor-grabbing select-none",
          )}
        >
          {/* 一条统一标签栏:前半是前端拥有的实例(文件树 / 终端 / 代码更改),
            后半是由服务端 state.tabs 派生的浏览器页面。支持横向滚轮与横向滚动条。 */}
          <div
            className="flex h-full min-w-0 flex-1 items-center gap-1 overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            data-horizontal-scroll="true"
            onDragOver={(event) => {
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
            }}
            onDrop={(event) => {
              event.preventDefault();
              setDragOverTabId(null);
              setDraggingTabId(null);
              const rawData = event.dataTransfer.getData(TAB_DND_TYPE);
              if (rawData) {
                try {
                  const data = JSON.parse(rawData);
                  if (data.source === "terminal") {
                    moveTerminalTab("terminal", "workspace", data.id, data.title);
                  }
                } catch {}
              }
            }}
          >
            {panelTabs.map((tab) => {
              const isSelected =
                activePanelTab.kind !== "browser" &&
                activePanelTab.kind !== "welcome" &&
                activePanelTab.id === tab.id;
              return (
                <ContextMenu key={tab.id}>
                  <ContextMenuTrigger>
                    <button
                      draggable
                      onDragStart={(event) => {
                        draggedTabRef.current = tab.id;
                        setDraggingTabId(tab.id);
                        event.dataTransfer.setData(
                          TAB_DND_TYPE,
                          JSON.stringify({
                            source: "workspace",
                            id: tab.id,
                            kind: tab.kind,
                            title: tab.title,
                          }),
                        );
                        event.dataTransfer.effectAllowed = "move";
                      }}
                      onDragOver={(event) => {
                        event.preventDefault();
                        event.dataTransfer.dropEffect = "move";
                        if (dragOverTabId !== tab.id) setDragOverTabId(tab.id);
                      }}
                      onDragLeave={() => {
                        if (dragOverTabId === tab.id) setDragOverTabId(null);
                      }}
                      onDrop={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        setDragOverTabId(null);
                        setDraggingTabId(null);
                        const rawData = event.dataTransfer.getData(TAB_DND_TYPE);
                        if (rawData) {
                          try {
                            const data = JSON.parse(rawData);
                            if (data.source === "workspace") {
                              reorderPanelTab(data.id, tab.id);
                            } else if (data.source === "terminal") {
                              moveTerminalTab("terminal", "workspace", data.id, data.title, tab.id);
                            }
                          } catch {
                            if (draggedTabRef.current)
                              reorderPanelTab(draggedTabRef.current, tab.id);
                          }
                        } else if (draggedTabRef.current) {
                          reorderPanelTab(draggedTabRef.current, tab.id);
                        }
                        draggedTabRef.current = null;
                      }}
                      onDragEnd={() => {
                        draggedTabRef.current = null;
                        setDraggingTabId(null);
                        setDragOverTabId(null);
                      }}
                      className={cn(
                        "group relative flex h-7 max-w-44 min-w-0 items-center gap-1.5 rounded-md border px-2 text-xs font-normal transition-colors cursor-pointer select-none",
                        isSelected
                          ? "border-border bg-background text-foreground shadow-xs font-medium"
                          : "border-transparent text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                        draggingTabId === tab.id && "opacity-50",
                        dragOverTabId === tab.id && "ring-2 ring-primary/40",
                      )}
                      onClick={() => activatePanelTab({ kind: tab.kind, id: tab.id })}
                      title={tab.title}
                      type="button"
                    >
                      {tab.kind === "files" ? (
                        <FolderTreeIcon
                          className={cn(
                            "size-3 shrink-0",
                            isSelected ? "text-primary" : "text-muted-foreground",
                          )}
                        />
                      ) : tab.kind === "terminal" ? (
                        <TerminalIcon
                          className={cn(
                            "size-3 shrink-0",
                            isSelected ? "text-primary" : "text-muted-foreground",
                          )}
                        />
                      ) : (
                        <FileDiffIcon
                          className={cn(
                            "size-3 shrink-0",
                            isSelected ? "text-primary" : "text-muted-foreground",
                          )}
                        />
                      )}
                      <span className="truncate">{tab.title}</span>
                      <span
                        role="button"
                        tabIndex={0}
                        aria-label={`${t("common:close")} ${tab.title}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          closePanelTab(tab.id);
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.stopPropagation();
                            closePanelTab(tab.id);
                          }
                        }}
                        className="ml-0.5 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground cursor-pointer"
                      >
                        <XIcon className="size-3" />
                      </span>
                    </button>
                  </ContextMenuTrigger>
                  <ContextMenuContent className="w-48">
                    <ContextMenuGroup>
                      <ContextMenuLabel className="max-w-44 truncate">{tab.title}</ContextMenuLabel>
                      <ContextMenuItem onClick={() => closePanelTab(tab.id)}>
                        <XIcon className="text-muted-foreground" />
                        <span>{t("workspace:closeTab")}</span>
                        <ContextMenuShortcut>
                          {formatShortcutDisplay(["Mod", "W"], isMac)}
                        </ContextMenuShortcut>
                      </ContextMenuItem>
                      <ContextMenuItem
                        onClick={() => {
                          for (const other of panelTabs) {
                            if (other.id !== tab.id) closePanelTab(other.id);
                          }
                        }}
                      >
                        <span>{t("workspace:closeOtherTabs")}</span>
                      </ContextMenuItem>
                      {tab.kind === "terminal" && (
                        <ContextMenuItem
                          onClick={() =>
                            moveTerminalTab("workspace", "terminal", tab.id, tab.title)
                          }
                        >
                          <PanelBottomOpenIcon className="text-muted-foreground" />
                          <span>{t("workspace:moveToTerminalDrawer")}</span>
                        </ContextMenuItem>
                      )}
                    </ContextMenuGroup>
                    <ContextMenuSeparator />
                    <ContextMenuGroup>
                      <ContextMenuSub>
                        <ContextMenuSubTrigger>
                          <PlusIcon className="text-muted-foreground" />
                          <span>{t("workspace:newTab")}</span>
                        </ContextMenuSubTrigger>
                        <ContextMenuSubContent className="w-44">
                          <ContextMenuGroup>
                            <ContextMenuItem onClick={() => addPanelTab("files")}>
                              <FolderTreeIcon className="text-muted-foreground" />
                              <span>{t("workspace:files")}</span>
                            </ContextMenuItem>
                            <ContextMenuItem onClick={() => addPanelTab("terminal")}>
                              <TerminalIcon className="text-muted-foreground" />
                              <span>{t("workspace:terminal")}</span>
                            </ContextMenuItem>
                            <ContextMenuItem onClick={() => addPanelTab("changes")}>
                              <FileDiffIcon className="text-muted-foreground" />
                              <span>{t("workspace:codeChanges")}</span>
                            </ContextMenuItem>
                            <ContextMenuItem
                              onClick={() => {
                                activatePanelTab({
                                  kind: "browser",
                                  index: state.tabs.length,
                                });
                                void action("new-tab", undefined, NEW_BROWSER_TAB_URL);
                              }}
                            >
                              <Globe2Icon className="text-muted-foreground" />
                              <span>{t("workspace:browsePage")}</span>
                            </ContextMenuItem>
                          </ContextMenuGroup>
                        </ContextMenuSubContent>
                      </ContextMenuSub>
                    </ContextMenuGroup>
                  </ContextMenuContent>
                </ContextMenu>
              );
            })}
            {state.tabs.map((tab, index) => {
              const isSelected =
                activePanelTab.kind === "browser" && activePanelTab.index === index;
              return (
                <button
                  key={`${index}:${tab.url}:${tab.title ?? ""}`}
                  className={cn(
                    "group relative flex h-7 max-w-44 min-w-0 items-center gap-1.5 rounded-md border px-2 text-xs font-normal transition-colors cursor-pointer select-none",
                    isSelected
                      ? "border-border bg-background text-foreground shadow-xs font-medium"
                      : "border-transparent text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                  )}
                  onClick={() => openBrowserTab(index)}
                  title={tab.title || tab.url}
                  type="button"
                >
                  <Globe2Icon
                    className={cn(
                      "size-3 shrink-0",
                      isSelected ? "text-primary" : "text-muted-foreground",
                    )}
                  />
                  <span className="truncate">{tab.title || tab.url || t("workspace:newTab")}</span>
                  <span
                    role="button"
                    tabIndex={0}
                    aria-label={t("workspace:closeTab")}
                    onClick={(event) => {
                      event.stopPropagation();
                      closeBrowserTab(index);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.stopPropagation();
                        closeBrowserTab(index);
                      }
                    }}
                    className="ml-0.5 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground cursor-pointer"
                  >
                    <XIcon className="size-3" />
                  </span>
                </button>
              );
            })}
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    aria-label={t("workspace:newTab")}
                    className="size-6 shrink-0"
                    size="icon-xs"
                    title={t("workspace:newTab")}
                    variant="ghost"
                  >
                    <PlusIcon className="size-3.5" />
                  </Button>
                }
              />
              <DropdownMenuContent align="start">
                <DropdownMenuItem
                  onClick={() => {
                    activatePanelTab({
                      kind: "browser",
                      index: state.tabs.length,
                    });
                    void action("new-tab", undefined, NEW_BROWSER_TAB_URL);
                  }}
                >
                  <Globe2Icon />
                  {t("workspace:newBrowserTab")}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => addPanelTab("terminal")}>
                  <TerminalIcon />
                  {t("workspace:newTerminal")}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => addPanelTab("files")}>
                  <FolderTreeIcon />
                  {t("workspace:newFileTree")}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => addPanelTab("changes")}>
                  <FileDiffIcon />
                  {t("workspace:codeChanges")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          <Select
            value={workspacePanelMode}
            onValueChange={(val) => {
              if (val) setWorkspacePanelMode(val as typeof workspacePanelMode);
            }}
          >
            <SelectTrigger
              size="sm"
              aria-label={t("workspace:layoutMode")}
              title={t("workspace:layoutMode")}
              className="h-7 w-auto min-w-[5.25rem] gap-1.5 border-transparent bg-transparent px-2 text-xs text-muted-foreground hover:border-border hover:bg-muted/60 hover:text-foreground focus-visible:ring-1"
            >
              <SelectValue>
                {(value: string | null) => {
                  if (value === "floating") {
                    return (
                      <span className="flex items-center gap-1.5">
                        <LayersIcon className="size-3.5 shrink-0" />
                        <span>{t("workspace:floating")}</span>
                      </span>
                    );
                  }
                  if (value === "fullscreen") {
                    return (
                      <span className="flex items-center gap-1.5">
                        <Maximize2Icon className="size-3.5 shrink-0" />
                        <span>{t("workspace:fullscreen")}</span>
                      </span>
                    );
                  }
                  return (
                    <span className="flex items-center gap-1.5">
                      <Columns2Icon className="size-3.5 shrink-0" />
                      <span>{t("workspace:docked")}</span>
                    </span>
                  );
                }}
              </SelectValue>
            </SelectTrigger>
            <SelectContent align="end" className="min-w-28">
              <SelectItem value="docked">
                <Columns2Icon className="size-3.5 shrink-0" />
                <span>{t("workspace:docked")}</span>
              </SelectItem>
              <SelectItem value="floating">
                <LayersIcon className="size-3.5 shrink-0" />
                <span>{t("workspace:floating")}</span>
              </SelectItem>
              <SelectItem value="fullscreen">
                <Maximize2Icon className="size-3.5 shrink-0" />
                <span>{t("workspace:fullscreen")}</span>
              </SelectItem>
            </SelectContent>
          </Select>
          {/* 收起工作区面板按钮:面板展开时从顶栏迁移至此,占据原收起按钮位置 ——
            收起与关闭语义合一,按钮在屏幕上始终贴近右缘 */}
          <Button
            aria-label={t("workspace:collapse")}
            className="size-7 shrink-0"
            onClick={() => setWorkspacePanelOpen(false)}
            size="icon-sm"
            title={t("workspace:collapse")}
            variant="ghost"
          >
            <PanelRightCloseIcon />
          </Button>
        </PanelHeader>
        {/* 所有标签内容常驻,靠 hidden 切换:xterm 卸载会丢 scrollback 与会话,
          文件树卸载会丢展开层级。浏览器只有一个实例 —— screencast 是每线程单路的,
          页面之间靠 switch-tab 切换而不是多份视图。 */}
        <div className="relative min-h-0 flex-1 overflow-hidden">
          {panelTabs.map((tab) => {
            const selected =
              !isWelcomeActive && activePanelTab.kind !== "browser" && activePanelTab.id === tab.id;
            return (
              <div className={cn("size-full", selected ? "block" : "hidden")} key={tab.id}>
                {tab.kind === "files" ? (
                  <FilesWorkspace active={selected} tabId={tab.id} />
                ) : tab.kind === "changes" ? (
                  <ChangesWorkspace active={selected} />
                ) : (
                  <div className="size-full px-3 py-2">
                    <TerminalSession sessionId={tab.id} active={selected} />
                  </div>
                )}
              </div>
            );
          })}
          <div className={cn("size-full", !isWelcomeActive && browserActive ? "block" : "hidden")}>
            <BrowserView
              onCloseBrowser={closeBrowserAndReturnToLocalTab}
              session={browserSession}
            />
          </div>
          {isWelcomeActive ? (
            <div className="flex size-full flex-col items-center justify-center p-6 select-none">
              <Empty className="max-w-sm w-full p-0">
                <EmptyHeader className="space-y-1 pb-4">
                  <EmptyTitle className="text-base font-semibold">
                    {t("workspace:startFromHere")}
                  </EmptyTitle>
                  <EmptyDescription className="text-xs">
                    {t("workspace:startDesc")}
                  </EmptyDescription>
                </EmptyHeader>
                <EmptyContent className="w-full">
                  <ItemGroup className="w-full gap-1.5">
                    <Item
                      variant="outline"
                      size="sm"
                      className="cursor-pointer transition-colors hover:bg-muted/70"
                      render={<button type="button" onClick={() => addPanelTab("files")} />}
                    >
                      <ItemMedia variant="icon">
                        <FolderTreeIcon className="size-4 text-foreground" />
                      </ItemMedia>
                      <ItemContent className="min-w-0 flex-1">
                        <ItemTitle className="text-xs font-medium">
                          {t("workspace:fileBrowser")}
                        </ItemTitle>
                        <ItemDescription className="truncate text-xs text-muted-foreground">
                          {t("workspace:fileBrowserDesc")}
                        </ItemDescription>
                      </ItemContent>
                    </Item>

                    <Item
                      variant="outline"
                      size="sm"
                      className="cursor-pointer transition-colors hover:bg-muted/70"
                      render={
                        <button
                          type="button"
                          onClick={() => {
                            activatePanelTab({
                              kind: "browser",
                              index: state.tabs.length,
                            });
                            void action("new-tab", undefined, NEW_BROWSER_TAB_URL);
                          }}
                        />
                      }
                    >
                      <ItemMedia variant="icon">
                        <Globe2Icon className="size-4 text-foreground" />
                      </ItemMedia>
                      <ItemContent className="min-w-0 flex-1">
                        <ItemTitle className="text-xs font-medium">
                          {t("workspace:browser")}
                        </ItemTitle>
                        <ItemDescription className="truncate text-xs text-muted-foreground">
                          {t("workspace:browserDesc")}
                        </ItemDescription>
                      </ItemContent>
                    </Item>

                    <Item
                      variant="outline"
                      size="sm"
                      className="cursor-pointer transition-colors hover:bg-muted/70"
                      render={<button type="button" onClick={() => addPanelTab("terminal")} />}
                    >
                      <ItemMedia variant="icon">
                        <TerminalIcon className="size-4 text-foreground" />
                      </ItemMedia>
                      <ItemContent className="min-w-0 flex-1">
                        <ItemTitle className="text-xs font-medium">
                          {t("workspace:terminal")}
                        </ItemTitle>
                        <ItemDescription className="truncate text-xs text-muted-foreground">
                          {t("workspace:terminalDesc")}
                        </ItemDescription>
                      </ItemContent>
                    </Item>

                    <Item
                      variant="outline"
                      size="sm"
                      className="cursor-pointer transition-colors hover:bg-muted/70"
                      render={<button type="button" onClick={() => addPanelTab("changes")} />}
                    >
                      <ItemMedia variant="icon">
                        <FileDiffIcon className="size-4 text-foreground" />
                      </ItemMedia>
                      <ItemContent className="min-w-0 flex-1">
                        <ItemTitle className="text-xs font-medium">
                          {t("workspace:codeChanges")}
                        </ItemTitle>
                        <ItemDescription className="truncate text-xs text-muted-foreground">
                          {t("workspace:codeChangesDesc")}
                        </ItemDescription>
                      </ItemContent>
                    </Item>
                  </ItemGroup>
                </EmptyContent>
              </Empty>
            </div>
          ) : null}
        </div>
        {workspacePanelMode === "floating" && (
          <>
            {/* 四边边缘拖拽手柄:显式 style cursor 与易于命中的手柄宽度 */}
            <div
              className="absolute inset-x-6 top-0 h-2 z-30 select-none"
              style={{ cursor: "ns-resize" }}
              onPointerDown={(e) => startResize("t", e)}
            />
            <div
              className="absolute inset-x-6 bottom-0 h-2.5 z-30 select-none"
              style={{ cursor: "ns-resize" }}
              onPointerDown={(e) => startResize("b", e)}
            />
            <div
              className="absolute inset-y-6 left-0 w-2 z-30 select-none"
              style={{ cursor: "ew-resize" }}
              onPointerDown={(e) => startResize("l", e)}
            />
            <div
              className="absolute inset-y-6 right-0 w-2 z-30 select-none"
              style={{ cursor: "ew-resize" }}
              onPointerDown={(e) => startResize("r", e)}
            />

            {/* 四角拖拽手柄:扩充至 24px - 32px 舒适感应区,并带有显式 style cursor */}
            <div
              className="absolute top-0 left-0 size-6 z-40 select-none"
              style={{ cursor: "nwse-resize" }}
              onPointerDown={(e) => startResize("tl", e)}
            />
            <div
              className="absolute top-0 right-0 size-6 z-40 select-none"
              style={{ cursor: "nesw-resize" }}
              onPointerDown={(e) => startResize("tr", e)}
            />
            <div
              className="absolute bottom-0 left-0 size-6 z-40 select-none"
              style={{ cursor: "nesw-resize" }}
              onPointerDown={(e) => startResize("bl", e)}
            />
            <div
              className="group/resize absolute bottom-0 right-0 size-8 z-40 flex items-end justify-end p-1 select-none"
              style={{ cursor: "nwse-resize" }}
              onPointerDown={(e) => startResize("br", e)}
              title={t("workspace:resizeWindow")}
            >
              {/* 右下角微型尺寸缩放指示器:hover 时提升可见度 */}
              <svg
                viewBox="0 0 12 12"
                className="size-3 stroke-muted-foreground stroke-1 fill-none opacity-40 transition-opacity group-hover/resize:opacity-100"
                aria-hidden="true"
              >
                <line x1="10" y1="2" x2="2" y2="10" />
                <line x1="11" y1="6" x2="6" y2="11" />
                <line x1="11" y1="10" x2="10" y2="11" />
              </svg>
            </div>
          </>
        )}
      </PanelSurface>
    </>
  );
}
