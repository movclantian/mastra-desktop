import {
  CopyIcon,
  DatabaseIcon,
  FolderOpenIcon,
  HardDriveDownloadIcon,
  Trash2Icon,
} from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { useWorkbenchStore } from "@/entities/workbench/model/workbench-store";
import { useAuth } from "@/features/auth";
import { useTranslation } from "@/shared/i18n";
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
  const { t } = useTranslation();
  const { user: authUser } = useAuth();
  const user = authUser ?? { id: "anonymous", name: "Guest", email: "guest@example.com" };
  const agentBusy = useWorkbenchStore(
    (state) => state.agentBusyFlag || Object.keys(state.busyThreadIds).length > 0,
  );
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
      toast.success(t("settings:storage.migratedSuccess", { directory }), {
        ...(prev
          ? {
              action: {
                label: t("settings:storage.undo"),
                onClick: () => {
                  if (window.api?.storage.migrate) {
                    void window.api.storage
                      .migrate(prev)
                      .then(() => {
                        toast.success(t("settings:storage.undoSuccess"));
                        loadInfo();
                      })
                      .catch(() => toast.error(t("settings:storage.undoFailed")));
                  }
                },
              },
            }
          : {}),
      });
      loadInfo();
    } catch {
      toast.error(t("settings:storage.migrateFailed"));
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
        title={t("settings:storage.studioTitle")}
        description={t("settings:storage.studioDesc")}
      >
        <div className="space-y-3 py-4">
          <div className="space-y-1">
            <p className="text-sm leading-none font-medium">
              {t("settings:storage.currentResourceId")}
            </p>
            <p className="text-xs text-muted-foreground">{t("settings:storage.resourceIdDesc")}</p>
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
                toast.success(t("settings:storage.copiedResourceId"));
              }}
            >
              <CopyIcon />
              {t("settings:storage.copy")}
            </Button>
          </div>
        </div>
      </SettingCard>

      <SettingCard
        title={t("settings:storage.storageDirTitle")}
        description={t("settings:storage.storageDirDesc")}
      >
        <div className="space-y-3 py-4">
          <div className="flex items-center gap-2">
            <DatabaseIcon className="size-4 shrink-0 text-muted-foreground" />
            <p className="break-all font-mono text-xs text-muted-foreground">
              {info?.directory ?? t("settings:storage.reading")}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={openDirectory} disabled={!info}>
              <FolderOpenIcon />
              {t("settings:storage.openDir")}
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
              {migrating ? t("settings:storage.migrating") : t("settings:storage.changeLocation")}
            </Button>
          </div>
        </div>
      </SettingCard>

      <SettingCard
        title={t("settings:storage.dangerZone")}
        description={t("settings:storage.dangerZoneDesc")}
      >
        <div className="space-y-3 py-4">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <p className="text-sm font-medium text-destructive">
                {t("settings:storage.resetAppTitle")}
              </p>
              <p className="text-xs text-muted-foreground">{t("settings:storage.resetAppDesc")}</p>
            </div>
            <AlertDialog>
              <AlertDialogTrigger
                render={
                  <Button variant="destructive" size="sm">
                    <Trash2Icon />
                    {t("settings:storage.resetAppButton")}
                  </Button>
                }
              />
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>{t("settings:storage.confirmResetTitle")}</AlertDialogTitle>
                  <AlertDialogDescription>
                    {t("settings:storage.confirmResetDesc")}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>{t("common:cancel")}</AlertDialogCancel>
                  <AlertDialogAction variant="destructive" onClick={resetApp}>
                    {t("settings:storage.confirmResetAndRestart")}
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
            <AlertDialogTitle>{t("settings:storage.pendingTaskTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("settings:storage.pendingTaskDesc", { directory: pendingDir })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setPendingDir(null)}>
              {t("common:cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                const dir = pendingDir;
                setPendingDir(null);
                if (dir) void migrate(dir, info?.directory);
              }}
            >
              {t("settings:storage.interruptAndMigrate")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
