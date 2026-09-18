"use client";

import { useLocation, useNavigate, useRouterState } from "@tanstack/react-router";
import {
  HelpCircleIcon,
  KeyboardIcon,
  SearchIcon,
  SparklesIcon,
} from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import {
  useCreateThreadMutation,
  useDeleteThreadMutation,
  usePinThreadMutation,
  useThreadsQuery,
  useWorkbenchStore,
  viewFromPath,
} from "@/entities/workbench";
import { useAuth } from "@/features/auth";
import { ThreadSearchDialog } from "@/features/thread-search";
import { openPathInApp } from "@/features/workspace-session";
import { apiFetch, MASTRA_SERVER_URL } from "@/shared/api";
import { useTranslation } from "@/shared/i18n";
import { cn } from "@/shared/lib";
import { useTheme } from "@/shared/theme";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/shared/ui/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { ScrollArea } from "@/shared/ui/scroll-area";
import type { WorkspaceApp } from "../../../../../shared/workspace-contract";
import {
  buildShortcutMenuGroups,
  CORE_SHORTCUT_SPECS,
  focusChatPromptInput,
  formatShortcutDisplay,
  isEditableTarget,
  isMacPlatform,
  matchesShortcut,
  type ShortcutMenuItem,
  type ShortcutSpec,
} from "./shortcut-menu";

/**
 * 顶部导航栏命令面板快速触发按钮 (参考 VS Code / Linear / Raycast 交互风格)
 */
export function CommandPaletteTrigger({ className }: { className?: string }) {
  const { t } = useTranslation();
  const isMac = React.useMemo(() => isMacPlatform(), []);
  const setCommandPaletteOpen = useWorkbenchStore((state) => state.setCommandPaletteOpen);
  const shortcutBadge = isMac ? "⌘K" : "Ctrl+K";

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() => setCommandPaletteOpen(true)}
      className={cn(
        "h-7.5 gap-2 rounded-lg border-input/50 bg-muted/30 px-2.5 text-xs text-muted-foreground transition-all select-none hover:border-input hover:bg-muted/70 hover:text-foreground shrink-0 shadow-none cursor-pointer",
        className,
      )}
      title={t("commandPalette:triggerTooltip", { shortcut: shortcutBadge })}
      aria-label={t("commandPalette:triggerTooltip", { shortcut: shortcutBadge })}
    >
      <SearchIcon className="size-3.5 shrink-0 opacity-70" />
      <span className="hidden sm:inline font-normal">{t("commandPalette:triggerText")}</span>
      <kbd className="pointer-events-none hidden sm:inline-flex h-4.5 items-center gap-0.5 rounded border border-border/70 bg-background px-1.5 font-mono text-[10px] font-medium text-muted-foreground select-none shadow-2xs">
        {shortcutBadge}
      </kbd>
    </Button>
  );
}

/**
 * 全局命令面板核心弹窗 (基于 shadcn cmdk 构建)
 */
export function CommandPaletteDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const userId = user?.id ?? "anonymous";
  const navigate = useNavigate();
  const location = useLocation();
  const activeView = viewFromPath(location.pathname);
  const activeThreadId = useRouterState({
    select: (state) => (state.location.search as { thread?: string }).thread ?? null,
  });
  const threads = useThreadsQuery(userId).data ?? [];
  const activeThread = threads.find((th) => th.id === activeThreadId) ?? null;

  const createThreadMutation = useCreateThreadMutation(userId);
  const { toggleSidebar } = useSidebar();
  const { isDark, setMode } = useTheme();

  const workspacePanelOpen = useWorkbenchStore((state) => state.workspacePanelOpen);
  const setWorkspacePanelOpen = useWorkbenchStore((state) => state.setWorkspacePanelOpen);
  const terminalPanelOpen = useWorkbenchStore((state) => state.terminalPanelOpen);
  const setTerminalPanelOpen = useWorkbenchStore((state) => state.setTerminalPanelOpen);
  const setThreadSearchOpen = useWorkbenchStore((state) => state.setThreadSearchOpen);
  const setShortcutsHelpOpen = useWorkbenchStore((state) => state.setShortcutsHelpOpen);
  const setThreadSummaryOpen = useWorkbenchStore((state) => state.setThreadSummaryOpen);

  const isMac = React.useMemo(() => isMacPlatform(), []);
  const [search, setSearch] = React.useState("");

  const handleOpenInIde = React.useCallback(async () => {
    let targetDir = activeThread?.metadata?.workspacePath;
    if (!targetDir && activeThreadId) {
      try {
        const res = await apiFetch(`${MASTRA_SERVER_URL}/work/workspace`);
        if (res.ok) {
          const cfg = (await res.json()) as { defaultDirectory?: string; threadsRoot?: string };
          targetDir = cfg.defaultDirectory || cfg.threadsRoot;
        }
      } catch {
        // ignore
      }
    }
    if (!targetDir) {
      toast.error(t("workspace:noWorkspaceDir"));
      return;
    }
    let preferredApp = "vscode";
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key?.startsWith("mastra-work:preferred-ide")) {
          preferredApp = localStorage.getItem(key) || "vscode";
          break;
        }
      }
    } catch {
      // ignore
    }
    void openPathInApp(preferredApp as WorkspaceApp, targetDir, preferredApp);
  }, [activeThread?.metadata?.workspacePath, activeThreadId, t]);

  const groups = React.useMemo(() => {
    return buildShortcutMenuGroups({
      navigate: (params) => {
        void navigate(params as Parameters<typeof navigate>[0]);
      },
      activeView,
      activeThreadId,
      createNewThread: () => createThreadMutation.mutateAsync().catch(() => null),
      toggleSidebar,
      toggleWorkspacePanel: () => setWorkspacePanelOpen(!workspacePanelOpen),
      toggleTerminalPanel: () => setTerminalPanelOpen(!terminalPanelOpen),
      openSearchMessages: () => setThreadSearchOpen(true),
      openShortcutsHelp: () => setShortcutsHelpOpen(true),
      openThreadSummary: () => setThreadSummaryOpen(true),
      openInIde: () => void handleOpenInIde(),
      toggleThemeMode: () => setMode(isDark ? "light" : "dark"),
      focusChatInput: () => focusChatPromptInput(),
      t,
      isMac,
    });
  }, [
    navigate,
    activeView,
    activeThreadId,
    createThreadMutation,
    toggleSidebar,
    workspacePanelOpen,
    setWorkspacePanelOpen,
    terminalPanelOpen,
    setTerminalPanelOpen,
    setThreadSearchOpen,
    setShortcutsHelpOpen,
    setThreadSummaryOpen,
    handleOpenInIde,
    setMode,
    isDark,
    t,
    isMac,
  ]);

  const handleSelect = (item: ShortcutMenuItem) => {
    if (item.disabled) return;
    onOpenChange(false);
    // 延迟少许以保证 dialog 关闭动画顺畅衔接动作
    window.setTimeout(() => {
      item.onSelect();
    }, 50);
  };

  React.useEffect(() => {
    if (!open) {
      setSearch("");
    }
  }, [open]);

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("commandPalette:triggerTooltip", { shortcut: isMac ? "⌘K" : "Ctrl+K" })}
      description={t("commandPalette:shortcutsGuideDesc")}
      className="max-w-xl"
    >
      <CommandInput
        autoFocus
        value={search}
        onValueChange={setSearch}
        placeholder={t("commandPalette:inputPlaceholder")}
      />
      <CommandList className="max-h-[min(65vh,28rem)]">
        <CommandEmpty>{t("commandPalette:noResults")}</CommandEmpty>
        {groups.map((group, index) => (
          <React.Fragment key={group.id}>
            {index > 0 && <CommandSeparator />}
            <CommandGroup heading={group.heading}>
              {group.items.map((item) => {
                const IconComponent = item.icon;
                const searchTokens = [item.label, item.description ?? "", ...item.keywords].join(
                  " ",
                );
                return (
                  <CommandItem
                    key={item.id}
                    value={searchTokens}
                    disabled={item.disabled}
                    onSelect={() => handleSelect(item)}
                    className="flex items-center gap-2.5 py-2 cursor-pointer"
                  >
                    <IconComponent className="size-4 shrink-0 text-muted-foreground" />
                    <div className="flex min-w-0 flex-1 flex-col">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-sm text-foreground truncate">
                          {item.label}
                        </span>
                        {item.disabled ? (
                          <Badge variant="outline" className="text-[10px] h-4.5 px-1 font-normal">
                            {t("commandPalette:chatRequired")}
                          </Badge>
                        ) : null}
                      </div>
                      {item.description ? (
                        <span className="text-xs text-muted-foreground truncate">
                          {item.description}
                        </span>
                      ) : null}
                    </div>
                    {item.shortcutDisplay ? (
                      <CommandShortcut className="font-mono text-[11px] tracking-normal font-medium text-muted-foreground">
                        {item.shortcutDisplay}
                      </CommandShortcut>
                    ) : null}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </React.Fragment>
        ))}
      </CommandList>
      {/* 底部键盘交互提示栏 */}
      <div className="flex items-center justify-between border-t border-border/40 bg-muted/20 px-3 py-2 text-[11px] text-muted-foreground select-none">
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1">
            <kbd className="rounded border bg-background px-1 py-0.5 font-mono text-[10px] shadow-2xs">
              ↑↓
            </kbd>
            <span>{t("commandPalette:navHelp")}</span>
          </span>
          <span className="flex items-center gap-1">
            <kbd className="rounded border bg-background px-1 py-0.5 font-mono text-[10px] shadow-2xs">
              ↵
            </kbd>
            <span>{t("commandPalette:selectHelp")}</span>
          </span>
          <span className="flex items-center gap-1">
            <kbd className="rounded border bg-background px-1 py-0.5 font-mono text-[10px] shadow-2xs">
              esc
            </kbd>
            <span>{t("commandPalette:closeHelp")}</span>
          </span>
        </div>
        <button
          type="button"
          onClick={() => {
            onOpenChange(false);
            window.setTimeout(() => setShortcutsHelpOpen(true), 100);
          }}
          className="flex items-center gap-1 text-primary hover:underline cursor-pointer"
        >
          <HelpCircleIcon className="size-3.5" />
          <span>{t("commandPalette:guideHelp")}</span>
        </button>
      </div>
    </CommandDialog>
  );
}

/**
 * 快捷键速查指南弹窗 (Keyboard Shortcuts Cheatsheet)
 */
export function ShortcutsHelpDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const isMac = React.useMemo(() => isMacPlatform(), []);

  const categoryLabels: Record<string, string> = {
    general: t("commandPalette:categoryGeneral"),
    navigation: t("commandPalette:categoryNavigation"),
    workbench: t("commandPalette:categoryWorkbench"),
    appearance: t("commandPalette:categoryAppearance"),
  };

  const specsByCategory = React.useMemo(() => {
    const map = new Map<string, ShortcutSpec[]>();
    for (const spec of CORE_SHORTCUT_SPECS) {
      const list = map.get(spec.category) || [];
      list.push(spec);
      map.set(spec.category, list);
    }
    return map;
  }, []);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col p-0 overflow-hidden">
        <DialogHeader className="p-6 pb-2 border-b border-border/40">
          <DialogTitle className="flex items-center gap-2 text-base font-semibold">
            <KeyboardIcon className="size-5 text-primary" />
            <span>{t("commandPalette:shortcutsGuide")}</span>
          </DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            {t("commandPalette:shortcutsGuideDesc")}
          </DialogDescription>
        </DialogHeader>
        <ScrollArea className="flex-1 p-6">
          <div className="space-y-6 pr-3">
            {[...specsByCategory.entries()].map(([cat, specs]) => (
              <section key={cat} className="space-y-2">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  {categoryLabels[cat] || cat}
                </h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                  {specs.map((spec) => {
                    const primaryDisplay = formatShortcutDisplay(spec.keys, isMac);
                    const secondaryDisplay = spec.secondaryKeys
                      ? formatShortcutDisplay(spec.secondaryKeys, isMac)
                      : null;
                    return (
                      <div
                        key={spec.id}
                        className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-card/60 p-2.5 text-xs shadow-2xs transition-colors hover:bg-muted/40"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="font-medium text-foreground truncate">
                            {t(spec.titleKey) || spec.defaultTitle}
                          </p>
                          <p className="text-[11px] text-muted-foreground truncate">
                            {t(spec.descKey) || spec.defaultDesc}
                          </p>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          {primaryDisplay ? (
                            <kbd className="inline-flex h-5 items-center justify-center rounded border border-border/80 bg-muted px-1.5 font-mono text-[10px] font-semibold text-foreground shadow-2xs">
                              {primaryDisplay}
                            </kbd>
                          ) : (
                            <span className="text-[10px] text-muted-foreground">—</span>
                          )}
                          {secondaryDisplay ? (
                            <>
                              <span className="text-[10px] text-muted-foreground">/</span>
                              <kbd className="inline-flex h-5 items-center justify-center rounded border border-border/80 bg-muted px-1.5 font-mono text-[10px] font-semibold text-foreground shadow-2xs">
                                {secondaryDisplay}
                              </kbd>
                            </>
                          ) : null}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}

/**
 * 全局键盘事件监听 Hook
 */
export function useGlobalShortcuts() {
  const { user } = useAuth();
  const userId = user?.id ?? "anonymous";
  const navigate = useNavigate();
  const location = useLocation();
  const activeView = viewFromPath(location.pathname);
  const activeThreadId = useRouterState({
    select: (state) => (state.location.search as { thread?: string }).thread ?? null,
  });
  const threads = useThreadsQuery(userId).data ?? [];
  const activeThread = threads.find((th) => th.id === activeThreadId) ?? null;

  const createThreadMutation = useCreateThreadMutation(userId);
  const pinThreadMutation = usePinThreadMutation(userId);
  const deleteThreadMutation = useDeleteThreadMutation(userId);
  const { isDark, setMode } = useTheme();

  const commandPaletteOpen = useWorkbenchStore((state) => state.commandPaletteOpen);
  const setCommandPaletteOpen = useWorkbenchStore((state) => state.setCommandPaletteOpen);
  const threadSearchOpen = useWorkbenchStore((state) => state.threadSearchOpen);
  const setThreadSearchOpen = useWorkbenchStore((state) => state.setThreadSearchOpen);
  const shortcutsHelpOpen = useWorkbenchStore((state) => state.shortcutsHelpOpen);
  const setShortcutsHelpOpen = useWorkbenchStore((state) => state.setShortcutsHelpOpen);
  const workspacePanelOpen = useWorkbenchStore((state) => state.workspacePanelOpen);
  const setWorkspacePanelOpen = useWorkbenchStore((state) => state.setWorkspacePanelOpen);
  const terminalPanelOpen = useWorkbenchStore((state) => state.terminalPanelOpen);
  const setTerminalPanelOpen = useWorkbenchStore((state) => state.setTerminalPanelOpen);
  const setThreadSummaryOpen = useWorkbenchStore((state) => state.setThreadSummaryOpen);
  const setRenamingThread = useWorkbenchStore((state) => state.setRenamingThread);
  const activeTerminalDrawerSessionId = useWorkbenchStore(
    (state) => state.activeTerminalDrawerSessionId,
  );
  const closeTerminalDrawerSession = useWorkbenchStore(
    (state) => state.closeTerminalDrawerSession,
  );
  const activePanelTab = useWorkbenchStore((state) => state.activePanelTab);
  const closePanelTab = useWorkbenchStore((state) => state.closePanelTab);

  const isMac = React.useMemo(() => isMacPlatform(), []);

  React.useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // 若处于中文等输入法组合状态，跳过快捷键
      if (event.isComposing) return;

      const inEditable = isEditableTarget(event.target);

      // 1. 命令面板唤起 (Mod+K)
      if (matchesShortcut(event, ["Mod", "K"], isMac)) {
        event.preventDefault();
        setCommandPaletteOpen(!commandPaletteOpen);
        return;
      }

      // 2. 消息全局搜索 (Mod+F)
      if (matchesShortcut(event, ["Mod", "F"], isMac)) {
        event.preventDefault();
        setThreadSearchOpen(true);
        return;
      }

      // 3. 快捷键指南唤起 (Mod+/ 或非输入态下的 ?)
      if (matchesShortcut(event, ["Mod", "/"], isMac)) {
        event.preventDefault();
        setShortcutsHelpOpen(!shortcutsHelpOpen);
        return;
      }
      if (!inEditable && event.key === "?") {
        event.preventDefault();
        setShortcutsHelpOpen(true);
        return;
      }

      // 4. 新建任务/会话 (Mod+N)
      if (matchesShortcut(event, ["Mod", "N"], isMac)) {
        event.preventDefault();
        void navigate({ to: "/chat" });
        void createThreadMutation.mutateAsync().catch(() => null);
        return;
      }

      // 5. 聚焦聊天输入框 (Mod+L 或非输入态下的 /)
      if (matchesShortcut(event, ["Mod", "L"], isMac)) {
        event.preventDefault();
        if (activeView !== "chat") {
          void navigate({ to: "/chat" });
          window.setTimeout(() => focusChatPromptInput(), 100);
        } else {
          focusChatPromptInput();
        }
        return;
      }
      if (!inEditable && event.key === "/") {
        event.preventDefault();
        if (activeView !== "chat") {
          void navigate({ to: "/chat" });
          window.setTimeout(() => focusChatPromptInput(), 100);
        } else {
          focusChatPromptInput();
        }
        return;
      }

      // 6. 核心视图数字导航 (Mod+1 ~ Mod+5)
      if (matchesShortcut(event, ["Mod", "1"], isMac)) {
        event.preventDefault();
        void navigate({ to: "/chat" });
        return;
      }
      if (matchesShortcut(event, ["Mod", "2"], isMac)) {
        event.preventDefault();
        void navigate({ to: "/skills" });
        return;
      }
      if (matchesShortcut(event, ["Mod", "3"], isMac)) {
        event.preventDefault();
        void navigate({ to: "/library" });
        return;
      }
      if (matchesShortcut(event, ["Mod", "4"], isMac)) {
        event.preventDefault();
        void navigate({ to: "/agents" });
        return;
      }
      if (matchesShortcut(event, ["Mod", "5"], isMac)) {
        event.preventDefault();
        void navigate({ to: "/schedules" });
        return;
      }

      // 7. 系统设置快捷键 (Mod+,)
      if (matchesShortcut(event, ["Mod", ","], isMac)) {
        event.preventDefault();
        void navigate({ to: "/settings" });
        return;
      }

      // 8. 切换工作区抽屉 (Mod+Shift+E 或 Mod+E)
      if (
        matchesShortcut(event, ["Mod", "Shift", "E"], isMac) ||
        matchesShortcut(event, ["Mod", "E"], isMac)
      ) {
        event.preventDefault();
        if (activeView !== "chat") void navigate({ to: "/chat" });
        setWorkspacePanelOpen(!workspacePanelOpen);
        return;
      }

      // 9. 切换终端抽屉 (Mod+` 或 Mod+J)
      if (
        matchesShortcut(event, ["Mod", "`"], isMac) ||
        matchesShortcut(event, ["Mod", "J"], isMac)
      ) {
        event.preventDefault();
        if (activeView !== "chat") void navigate({ to: "/chat" });
        setTerminalPanelOpen(!terminalPanelOpen);
        return;
      }

      // 10. 会话纪要蒸馏 (Mod+Shift+S)
      if (matchesShortcut(event, ["Mod", "Shift", "S"], isMac)) {
        if (activeThreadId) {
          event.preventDefault();
          if (activeView !== "chat") void navigate({ to: "/chat" });
          setThreadSummaryOpen(true);
        }
        return;
      }

      // 11. 在外部 IDE 打开当前工作区 (Mod+Shift+O)
      if (matchesShortcut(event, ["Mod", "Shift", "O"], isMac)) {
        event.preventDefault();
        let targetDir = activeThread?.metadata?.workspacePath;
        if (!targetDir && activeThreadId) {
          void apiFetch(`${MASTRA_SERVER_URL}/work/workspace`)
            .then((r) => r.json())
            .then((cfg: { defaultDirectory?: string; threadsRoot?: string }) => {
              const dir = cfg.defaultDirectory || cfg.threadsRoot;
              if (dir) {
                void openPathInApp("vscode" as WorkspaceApp, dir, "Visual Studio Code");
              }
            })
            .catch(() => {});
        } else if (targetDir) {
          void openPathInApp("vscode" as WorkspaceApp, targetDir, "Visual Studio Code");
        }
        return;
      }

      // 12. 切换色彩模式 (Mod+Shift+D)
      if (matchesShortcut(event, ["Mod", "Shift", "D"], isMac)) {
        event.preventDefault();
        setMode(isDark ? "light" : "dark");
        return;
      }

      // 13. 会话置顶 / 取消置顶 (Mod+P 或 Mod+Shift+P)
      if (
        matchesShortcut(event, ["Mod", "P"], isMac) ||
        matchesShortcut(event, ["Mod", "Shift", "P"], isMac)
      ) {
        if (activeThread) {
          event.preventDefault();
          const nextPinned = !activeThread.metadata?.pinned;
          void pinThreadMutation.mutateAsync({ threadId: activeThread.id, pinned: nextPinned });
          toast.success(nextPinned ? t("sidebar:pinned") : t("sidebar:unpin"));
          return;
        }
      }

      // 14. 重命名当前会话 (F2)
      if (!inEditable && (event.key === "F2" || event.code === "F2")) {
        if (activeThread) {
          event.preventDefault();
          setRenamingThread(activeThread);
          return;
        }
      }

      // 15. 关闭当前标签页 (Mod+W，优先终端抽屉标签，次之工作区抽屉标签)
      if (matchesShortcut(event, ["Mod", "W"], isMac)) {
        if (terminalPanelOpen && activeTerminalDrawerSessionId) {
          event.preventDefault();
          closeTerminalDrawerSession(activeTerminalDrawerSessionId);
          return;
        }
        if (workspacePanelOpen && activePanelTab.id && activePanelTab.kind !== "welcome") {
          event.preventDefault();
          closePanelTab(activePanelTab.id);
          return;
        }
      }

      // 16. 删除当前会话 (Mod+Backspace 或 Delete)
      if (
        !inEditable &&
        activeThread &&
        (matchesShortcut(event, ["Mod", "Backspace"], isMac) ||
          matchesShortcut(event, ["Mod", "Delete"], isMac) ||
          event.key === "Delete")
      ) {
        event.preventDefault();
        if (
          window.confirm(
            t("sidebar:deleteThreadConfirm", { title: activeThread.title }) ||
              `确定删除会话「${activeThread.title}」吗？`,
          )
        ) {
          void deleteThreadMutation.mutateAsync(activeThread.id);
        }
        return;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    isMac,
    commandPaletteOpen,
    setCommandPaletteOpen,
    threadSearchOpen,
    setThreadSearchOpen,
    shortcutsHelpOpen,
    setShortcutsHelpOpen,
    navigate,
    createThreadMutation,
    activeView,
    activeThreadId,
    workspacePanelOpen,
    setWorkspacePanelOpen,
    terminalPanelOpen,
    setTerminalPanelOpen,
    setThreadSummaryOpen,
    setRenamingThread,
    pinThreadMutation,
    deleteThreadMutation,
    activeTerminalDrawerSessionId,
    closeTerminalDrawerSession,
    activePanelTab,
    closePanelTab,
    activeThread,
    isDark,
    setMode,
    t,
  ]);
}

/**
 * 全局命令面板集成器 (挂载于应用主壳根节点)
 */
export function GlobalCommandPalette() {
  const commandPaletteOpen = useWorkbenchStore((state) => state.commandPaletteOpen);
  const setCommandPaletteOpen = useWorkbenchStore((state) => state.setCommandPaletteOpen);
  const threadSearchOpen = useWorkbenchStore((state) => state.threadSearchOpen);
  const setThreadSearchOpen = useWorkbenchStore((state) => state.setThreadSearchOpen);
  const shortcutsHelpOpen = useWorkbenchStore((state) => state.shortcutsHelpOpen);
  const setShortcutsHelpOpen = useWorkbenchStore((state) => state.setShortcutsHelpOpen);

  useGlobalShortcuts();

  return (
    <>
      <CommandPaletteDialog open={commandPaletteOpen} onOpenChange={setCommandPaletteOpen} />
      <ThreadSearchDialog open={threadSearchOpen} onOpenChange={setThreadSearchOpen} />
      <ShortcutsHelpDialog open={shortcutsHelpOpen} onOpenChange={setShortcutsHelpOpen} />
    </>
  );
}
