/** 渲染进程可见的 window 类型(electronAPI + terminal IPC 桥)。 */
import { ElectronAPI } from "@electron-toolkit/preload";

declare global {
  interface Window {
    electron: ElectronAPI;
    api: {
      filesystem: {
        openDirectory: (directory: string) => Promise<string>;
        pickDirectory: () => Promise<string>;
      };
      workspace: {
        detectIdes: () => Promise<
          Array<{ id: string; name: string; command: string; category: "ide" | "system" }>
        >;
        openInApp: (app: string, targetPath: string) => Promise<{ ok: boolean; error?: string }>;
        openExternal: (url: string) => Promise<void>;
      };
      storage: {
        migrate: (directory: string) => Promise<boolean>;
        reset: () => Promise<boolean>;
      };
      window: {
        setMinimumWidth: (width: number) => void;
      };
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
