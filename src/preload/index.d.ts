/** 渲染进程可见的 window 类型(electronAPI + terminal IPC 桥)。 */
import { ElectronAPI } from "@electron-toolkit/preload";

declare global {
  interface Window {
    electron: ElectronAPI;
    api: {
      openDirectory: (directory: string) => Promise<string>;
      /** 使用操作系统默认浏览器打开 HTTP(S) URL。 */
      openExternal: (url: string) => Promise<void>;
      /** 打开系统目录选择器;用户取消时返回空串 */
      pickDirectory: () => Promise<string>;
      /** 迁移存储位置到目标目录:杀服务释放句柄 → 搬数据库文件 → 重启;失败 reject */
      migrateStorage: (directory: string) => Promise<boolean>;
      resetAppData: () => Promise<boolean>;
      /**
       * 设置窗口最小宽度。值来自渲染进程实测的布局下限(输入区最小边界 + 外围占用),
       * 所以窗口能缩到多窄由布局自己说话,不写死常量。
       */
      setMinimumWidth: (width: number) => void;
      terminal: {
        create: (request: {
          cwd?: string;
          cols: number;
          rows: number;
        }) => Promise<{ sessionId: string }>;
        write: (request: { sessionId: string; data: string }) => void;
        resize: (request: { sessionId: string; cols: number; rows: number }) => void;
        close: (sessionId: string) => void;
        subscribe: (
          listener: (
            event:
              | { type: "data"; sessionId: string; data: string }
              | { type: "exit"; sessionId: string; exitCode?: number; signal?: number }
              | { type: "error"; sessionId: string; message: string },
          ) => void,
        ) => () => void;
      };
    };
  }
}
