import { ElectronAPI } from "@electron-toolkit/preload";

declare global {
  interface Window {
    electron: ElectronAPI;
    api: {
      openDirectory: (directory: string) => Promise<string>;
      resetAppData: () => Promise<boolean>;
    };
  }
}
