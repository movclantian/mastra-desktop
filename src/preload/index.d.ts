import type { ElectronAPI } from "@electron-toolkit/preload";
import type { PreloadApi } from "./api";

declare global {
  interface Window {
    electron: ElectronAPI;
    api: PreloadApi;
  }
}
