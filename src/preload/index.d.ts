import { ElectronAPI } from "@electron-toolkit/preload";

declare global {
  interface Window {
    electron: ElectronAPI;
    api: {
      openDirectory: (directory: string) => Promise<string>;
      /** 打开系统目录选择器;用户取消时返回空串 */
      pickDirectory: () => Promise<string>;
      /** 迁移存储位置到目标目录:杀服务释放句柄 → 搬数据库文件 → 重启;失败 reject */
      migrateStorage: (directory: string) => Promise<boolean>;
      resetAppData: () => Promise<boolean>;
    };
  }
}
