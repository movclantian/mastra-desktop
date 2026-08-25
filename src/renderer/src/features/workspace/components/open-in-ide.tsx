"use client";

import { CheckIcon, ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { apiFetch, MASTRA_SERVER_URL } from "@/api/client";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Separator } from "@/components/ui/separator";
import { useAuth } from "@/features/auth";
import { useWorkbench } from "@/features/workbench";
import { toastError } from "@/lib/errors";
import { cn } from "@/lib/utils";

// ==========================================
// 本地桌面 IDE / 工具支持 (打开当前会话工作区目录)
// ==========================================

export interface LocalIdeItem {
  id: string;
  name: string;
  command: string;
  category: "ide" | "system";
  icon?: React.ReactNode;
}

export const IDE_ICON_MAP: Record<string, React.ReactNode> = {
  vscode: (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      className="size-4 shrink-0"
      xmlns="http://www.w3.org/2000/svg"
    >
      <title>Visual Studio Code</title>
      <path
        d="M23.15 2.587L18.21.21a1.494 1.494 0 0 0-1.705.29l-9.46 8.63-4.12-3.128a.999.999 0 0 0-1.276.057L.327 7.276a1 1 0 0 0-.004 1.446l4.24 3.92-4.24 3.92a1 1 0 0 0 .004 1.446l1.322 1.217a1 1 0 0 0 1.276.057l4.12-3.128 9.46 8.63a1.492 1.492 0 0 0 1.704.29l4.942-2.377A1.5 1.5 0 0 0 24 21.36V3.957a1.5 1.5 0 0 0-.85-1.37zM18 17.525l-7.38-6.185L18 5.155v12.37z"
        fill="#007ACC"
      />
    </svg>
  ),
  terminal: (
    <div className="flex size-4 shrink-0 items-center justify-center rounded bg-zinc-800 text-[9px] font-mono font-bold text-zinc-200 shadow-xs">
      &gt;_
    </div>
  ),
  explorer: (
    <svg
      viewBox="0 0 24 24"
      fill="#F59E0B"
      className="size-4 shrink-0"
      xmlns="http://www.w3.org/2000/svg"
    >
      <title>文件资源管理器</title>
      <path d="M19.5 21a3 3 0 0 0 3-3v-4.5a3 3 0 0 0-3-3h-1.5V9a3 3 0 0 0-3-3h-3.379a3 3 0 0 1-2.121-.879L8.379 4.12A3 3 0 0 0 6.257 3.243H4.5A3 3 0 0 0 1.5 6.243V18a3 3 0 0 0 3 3h15z" />
    </svg>
  ),
};

export async function openPathInApp(appId: string, targetPath: string, appName: string) {
  try {
    if (window.api?.workspace.openInApp) {
      const result = await window.api.workspace.openInApp(appId, targetPath);
      if (result && !result.ok && result.error) {
        throw new Error(result.error);
      }
    } else {
      const response = await apiFetch(`${MASTRA_SERVER_URL}/work/workspace/open-in`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ app: appId, path: targetPath }),
      });
      if (!response.ok) {
        const payload = (await response.json()) as { error?: string; message?: string };
        throw new Error(payload.error || payload.message || "启动应用失败");
      }
    }
    toast.success(`已在 ${appName} 中打开工作区`);
  } catch (error) {
    toastError(error, `在 ${appName} 中打开失败`);
  }
}

/** 首选 IDE 偏好。与项目其余 localStorage 键名统一走 mastra-work: 前缀 */
const PREFERRED_IDE_KEY = "mastra-work:preferred-ide";

/**
 * OpenInIde: 动态检测并列出用户操作系统中真正已安装的各类本地 IDE 与系统工具
 */
export function OpenInIde({ className }: { className?: string }) {
  const { threads, activeThreadId } = useWorkbench();
  const { user } = useAuth();
  const preferredIdeKey = user
    ? `${PREFERRED_IDE_KEY}:${encodeURIComponent(user.id)}`
    : `${PREFERRED_IDE_KEY}:anonymous`;
  const [open, setOpen] = React.useState(false);
  const [detectedIdes, setDetectedIdes] = React.useState<LocalIdeItem[]>([
    {
      id: "vscode",
      name: "Visual Studio Code",
      command: "code",
      category: "ide",
      icon: IDE_ICON_MAP.vscode,
    },
    {
      id: "terminal",
      name: "终端",
      command: "terminal",
      category: "system",
      icon: IDE_ICON_MAP.terminal,
    },
    {
      id: "explorer",
      name: "文件资源管理器",
      command: "explorer",
      category: "system",
      icon: IDE_ICON_MAP.explorer,
    },
  ]);

  const [preferredId, setPreferredId] = React.useState<string>(() => {
    try {
      return localStorage.getItem(preferredIdeKey) || "vscode";
    } catch {
      return "vscode";
    }
  });

  React.useEffect(() => {
    let cancelled = false;
    async function loadInstalledIdes() {
      try {
        let rawList: Array<{
          id: string;
          name: string;
          command: string;
          category: "ide" | "system";
        }> = [];
        if (window.api?.workspace.detectIdes) {
          rawList = await window.api.workspace.detectIdes();
        } else {
          const res = await apiFetch(`${MASTRA_SERVER_URL}/work/workspace/detected-ides`);
          if (res.ok) {
            rawList = (await res.json()) as Array<{
              id: string;
              name: string;
              command: string;
              category: "ide" | "system";
            }>;
          }
        }
        if (cancelled || !rawList || rawList.length === 0) return;

        const mapped: LocalIdeItem[] = rawList.map((item) => ({
          ...item,
          icon: IDE_ICON_MAP[item.id] || (
            <svg
              viewBox="0 0 24 24"
              fill="none"
              className="size-4 shrink-0"
              stroke="currentColor"
              strokeWidth="2"
            >
              <title>本地应用</title>
              <rect x="3" y="3" width="18" height="18" rx="3" />
              <path d="M9 8l4 4-4 4" />
            </svg>
          ),
        }));

        setDetectedIdes(mapped);

        setPreferredId((currentId) => {
          if (mapped.some((item) => item.id === currentId)) {
            return currentId;
          }
          const fallback = mapped[0]?.id || "terminal";
          try {
            localStorage.setItem(preferredIdeKey, fallback);
          } catch {
            // ignore
          }
          return fallback;
        });
      } catch (err) {
        console.warn("[OpenInIde] 检测本地 IDE 失败:", err);
      }
    }
    void loadInstalledIdes();
    return () => {
      cancelled = true;
    };
  }, [preferredIdeKey]);

  const activeThread = threads.find((t) => t.id === activeThreadId);

  const currentIde = detectedIdes.find((opt) => opt.id === preferredId) || detectedIdes[0];

  const handleOpen = async (ide: LocalIdeItem) => {
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
      toast.error("当前会话尚未关联本地工作区目录");
      return;
    }
    setPreferredId(ide.id);
    try {
      localStorage.setItem(preferredIdeKey, ide.id);
    } catch {
      // 忽略
    }
    void openPathInApp(ide.id, targetDir, ide.name);
  };

  const ideOptions = detectedIdes.filter((i) => i.category === "ide");
  const systemOptions = detectedIdes.filter((i) => i.category === "system");

  return (
    <div
      className={cn(
        "inline-flex items-center rounded-md border border-input bg-background/80 shadow-xs h-7.5",
        className,
      )}
    >
      <Button
        variant="ghost"
        size="sm"
        className="h-full px-2.5 text-xs font-normal gap-1.5 rounded-r-none hover:bg-muted/80"
        onClick={() => currentIde && handleOpen(currentIde)}
        title={currentIde ? `在 ${currentIde.name} 中打开工作区` : "打开工作区"}
      >
        <span className="text-muted-foreground">在</span>
        {currentIde?.icon}
        <span className="text-muted-foreground">中打开</span>
      </Button>
      <Separator orientation="vertical" className="h-4" />
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              className="size-7.5 rounded-l-none px-1 hover:bg-muted/80 text-muted-foreground hover:text-foreground"
              aria-label="选择本地打开工具"
            >
              {open ? (
                <ChevronUpIcon className="size-3.5" />
              ) : (
                <ChevronDownIcon className="size-3.5" />
              )}
            </Button>
          }
        />
        <DropdownMenuContent
          align="end"
          className="w-max min-w-44 max-w-[min(calc(100vw-2rem),22rem)] p-1"
        >
          {ideOptions.map((ide) => {
            const isSelected = ide.id === preferredId;
            return (
              <DropdownMenuItem
                key={ide.id}
                onClick={() => handleOpen(ide)}
                className="flex items-center gap-2.5 px-2.5 py-2 text-sm cursor-pointer"
              >
                {ide.icon}
                <span className="flex-1 font-medium text-xs sm:text-sm">{ide.name}</span>
                {isSelected ? <CheckIcon className="size-4 text-emerald-500 shrink-0" /> : null}
              </DropdownMenuItem>
            );
          })}
          {ideOptions.length > 0 && systemOptions.length > 0 ? (
            <DropdownMenuSeparator className="my-1" />
          ) : null}
          {systemOptions.map((ide) => {
            const isSelected = ide.id === preferredId;
            return (
              <DropdownMenuItem
                key={ide.id}
                onClick={() => handleOpen(ide)}
                className="flex items-center gap-2.5 px-2.5 py-2 text-sm cursor-pointer"
              >
                {ide.icon}
                <span className="flex-1 font-medium text-xs sm:text-sm">{ide.name}</span>
                {isSelected ? <CheckIcon className="size-4 text-emerald-500 shrink-0" /> : null}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
