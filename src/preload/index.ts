/**
 * Electron preload:contextBridge 暴露终端 IPC 与 electronAPI,
 * 消息在进入主进程前先经 terminal-contract 的解析校验。
 */
import { electronAPI } from "@electron-toolkit/preload";
import { contextBridge, ipcRenderer } from "electron";
import { createPreloadApi } from "./api";

// Custom APIs for renderer
const api = createPreloadApi(ipcRenderer);

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld("electron", electronAPI);
    contextBridge.exposeInMainWorld("api", api);
  } catch (error) {
    console.error(error);
  }
} else {
  // @ts-expect-error (define in dts)
  window.electron = electronAPI;
  // @ts-expect-error (define in dts)
  window.api = api;
}
