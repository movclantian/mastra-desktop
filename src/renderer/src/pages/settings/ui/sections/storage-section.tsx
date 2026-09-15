import {
  CopyIcon,
  DatabaseIcon,
  FolderOpenIcon,
  HardDriveDownloadIcon,
  Trash2Icon,
} from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { useWorkbench } from "@/entities/workbench";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/shared/ui/alert-dialog";
import { Button } from "@/shared/ui/button";
import { Dotm3x3_1 } from "@/shared/ui/dotm-3x3-1";
import { fetchStorageInfo, type StorageInfo } from "../../api/settings-api";
import { SettingCard } from "../controls";

// ---------------------------------------------------------------------------
// 存储(目录展示 / 打开目录 / 更改位置 / 一键重置)
// ---------------------------------------------------------------------------

export function StorageSection() {
  const { user, agentBusy } = useWorkbench();
  const [info, setInfo] = React.useState<StorageInfo | null>(null);
  const [picking, setPicking] = React.useState(false);
  const [migrating, setMigrating] = React.useState(false);
  /** 待迁移目录(有进行中任务时先弹二次确认,确认后执行) */
  const [pendingDir, setPendingDir] = React.useState<string | null>(null);

  /**
   * 执行迁移(主进程 IPC):杀服务释放数据库文件句柄 → 搬迁数据库文件 →
   * 切换配置 → 重启服务。数据完整保留。
   */
  const migrate = async (directory: string, prev: string | undefined) => {
    setMigrating(true);
    try {
      if (window.api?.storage.migrate) await window.api.storage.migrate(directory);
      toast.success(`存储位置已迁移至 ${directory}`, {
        ...(prev
          ? {
              action: {
                label: "撤回",
                onClick: () => {
                  if (window.api?.storage.migrate) {
                    void window.api.storage
                      .migrate(prev)
                      .then(() => {
                        toast.success("已撤回存储位置更改");
                        loadInfo();
                      })
                      .catch(() => toast.error("撤回失败,请重试"));
                  }
                },
              },
            }
          : {}),
      });
      loadInfo();
    } catch {
      toast.error("迁移失败,已保留原存储位置");
    } finally {
      setMigrating(false);
    }
  };

  // 系统目录选择器选目录即迁移:有进行中任务先二次确认,否则直接执行
  const pickDirectory = async () => {
    setPicking(true);
    try {
      const dir = await window.api?.filesystem.pickDirectory?.();
      if (dir && dir !== info?.directory) {
        if (agentBusy) {
          setPendingDir(dir);
          return;
        }
        await migrate(dir, info?.directory);
      }
    } finally {
      setPicking(false);
    }
  };

  const loadInfo = React.useCallback(() => {
    fetchStorageInfo()
      .then((data: StorageInfo) => setInfo(data))
      .catch(() => undefined);
  }, []);

  React.useEffect(() => {
    loadInfo();
  }, [loadInfo]);

  const openDirectory = () => {
    if (info && window.api?.filesystem.openDirectory)
      void window.api.filesystem.openDirectory(info.directory);
  };

  const resetApp = () => {
    if (window.api?.storage.reset) void window.api.storage.reset();
  };

  return (
    <>
      <SettingCard
        title="Studio 联动"
        description="Studio 与本应用共用同一份存储,在浏览器打开 localhost:4111 即可查看 trace、指标与日志。"
      >
        <div className="space-y-3 py-4">
          <div className="space-y-1">
            <p className="text-sm leading-none font-medium">当前 resourceId</p>
            <p className="text-xs text-muted-foreground">
              线程按 resourceId 归属。要在 Studio 的会话列表里看到本应用的对话,需把 Studio 侧的
              resourceId 填成此值。
            </p>
          </div>
          <div className="flex items-center gap-2">
            <p className="min-w-0 flex-1 break-all rounded-md border px-2.5 py-2 font-mono text-xs text-muted-foreground">
              {user.id}
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void navigator.clipboard.writeText(user.id);
                toast.success("已复制 resourceId");
              }}
            >
              <CopyIcon />
              复制
            </Button>
          </div>
        </div>
      </SettingCard>

      <SettingCard
        title="存储目录"
        description="LibSQL(threads/记忆)+ DuckDB(observability)复合存储。"
      >
        <div className="space-y-3 py-4">
          <div className="flex items-center gap-2">
            <DatabaseIcon className="size-4 shrink-0 text-muted-foreground" />
            <p className="break-all font-mono text-xs text-muted-foreground">
              {info?.directory ?? "正在读取..."}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={openDirectory} disabled={!info}>
              <FolderOpenIcon />
              打开目录
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={picking || migrating}
              onClick={() => void pickDirectory()}
            >
              {picking || migrating ? (
                <Dotm3x3_1 size={14} dotSize={2.2} colorPreset="solid-theme" />
              ) : (
                <HardDriveDownloadIcon />
              )}
              {migrating ? "迁移中..." : "更改位置"}
            </Button>
          </div>
        </div>
      </SettingCard>

      <SettingCard title="危险区" description="重置将清空全部本地数据且不可恢复。">
        <div className="space-y-3 py-4">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <p className="text-sm font-medium text-destructive">重置软件数据</p>
              <p className="text-xs text-muted-foreground">
                清空全部本地数据(线程、供应商配置、存储文件),应用将自动重启。
              </p>
            </div>
            <AlertDialog>
              <AlertDialogTrigger
                render={
                  <Button variant="destructive" size="sm">
                    <Trash2Icon />
                    一键重置
                  </Button>
                }
              />
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>确认重置软件数据？</AlertDialogTitle>
                  <AlertDialogDescription>
                    此操作无法撤销。将清空全部本地数据（包括会话历史、供应商配置与存储文件），应用将立即自动重启。
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>取消</AlertDialogCancel>
                  <AlertDialogAction variant="destructive" onClick={resetApp}>
                    确认重置并重启
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </div>
      </SettingCard>

      {/* 有进行中任务时的二次确认:迁移会重启服务,当前生成会被中断 */}
      <AlertDialog
        onOpenChange={(open) => {
          if (!open) setPendingDir(null);
        }}
        open={pendingDir !== null}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>有正在进行的任务</AlertDialogTitle>
            <AlertDialogDescription>
              迁移存储位置需要重启 Mastra
              服务,当前线程的生成任务将被中断,已生成的部分会保留。确认继续迁移到
              {pendingDir} 吗?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setPendingDir(null)}>取消</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                const dir = pendingDir;
                setPendingDir(null);
                if (dir) void migrate(dir, info?.directory);
              }}
            >
              中断任务并迁移
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
