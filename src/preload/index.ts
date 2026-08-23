/**
 * Electron preload:contextBridge 暴露终端 IPC 与 electronAPI,
 * 消息在进入主进程前先经 terminal-contract 的解析校验。
 */
import { electronAPI } from "@electron-toolkit/preload";
import { contextBridge, ipcRenderer } from "electron";
import {
  parseTerminalCreateRequest,
  parseTerminalCreateResult,
  parseTerminalEvent,
  parseTerminalResizeRequest,
  parseTerminalSessionId,
  parseTerminalWriteRequest,
  TERMINAL_CLOSE_CHANNEL,
  TERMINAL_CREATE_CHANNEL,
  TERMINAL_EVENT_CHANNEL,
  TERMINAL_RESIZE_CHANNEL,
  TERMINAL_WRITE_CHANNEL,
  type TerminalCreateRequest,
  type TerminalEvent,
  type TerminalResizeRequest,
  type TerminalWriteRequest,
} from "../shared/terminal-contract";

// Custom APIs for renderer
const api = {
  openDirectory: (directory: string) => ipcRenderer.invoke("open-directory", directory),
  /** 动态检测用户系统中已安装的各类本地 IDE 与系统工具 */
  detectIdes: () =>
    ipcRenderer.invoke("detect-ides") as Promise<
      Array<{ id: string; name: string; command: string; category: "ide" | "system" }>
    >,
  openInApp: (app: string, targetPath: string) =>
    ipcRenderer.invoke("open-in-app", { app, targetPath }),
  openExternal: (url: string) => ipcRenderer.invoke("open-external", url),
  pickDirectory: () => ipcRenderer.invoke("pick-directory"),
  migrateStorage: (directory: string) => ipcRenderer.invoke("migrate-storage", directory),
  resetAppData: () => ipcRenderer.invoke("reset-app-data"),
  /** 把渲染进程实测的布局宽度需求设为窗口最小宽度(单向通知,不需要回执) */
  setMinimumWidth: (width: number) => ipcRenderer.send("set-minimum-width", width),
  terminal: {
    create: async (request: TerminalCreateRequest) =>
      parseTerminalCreateResult(
        await ipcRenderer.invoke(TERMINAL_CREATE_CHANNEL, parseTerminalCreateRequest(request)),
      ),
    write: (request: TerminalWriteRequest) =>
      ipcRenderer.send(TERMINAL_WRITE_CHANNEL, parseTerminalWriteRequest(request)),
    resize: (request: TerminalResizeRequest) =>
      ipcRenderer.send(TERMINAL_RESIZE_CHANNEL, parseTerminalResizeRequest(request)),
    close: (sessionId: string) =>
      ipcRenderer.send(TERMINAL_CLOSE_CHANNEL, parseTerminalSessionId(sessionId)),
    subscribe: (listener: (event: TerminalEvent) => void) => {
      const wrapped = (_event: unknown, value: unknown) => {
        try {
          listener(parseTerminalEvent(value));
        } catch {
          // Ignore malformed events at the renderer boundary.
        }
      };
      ipcRenderer.on(TERMINAL_EVENT_CHANNEL, wrapped);
      return () => ipcRenderer.off(TERMINAL_EVENT_CHANNEL, wrapped);
    },
  },
};

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
