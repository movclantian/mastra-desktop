import { electronAPI } from "@electron-toolkit/preload";
import { contextBridge, ipcRenderer } from "electron";
import {
  TERMINAL_CLOSE_CHANNEL,
  TERMINAL_CREATE_CHANNEL,
  TERMINAL_EVENT_CHANNEL,
  TERMINAL_RESIZE_CHANNEL,
  TERMINAL_WRITE_CHANNEL,
  parseTerminalCreateRequest,
  parseTerminalCreateResult,
  parseTerminalEvent,
  parseTerminalResizeRequest,
  parseTerminalSessionId,
  parseTerminalWriteRequest,
  type TerminalCreateRequest,
  type TerminalEvent,
  type TerminalResizeRequest,
  type TerminalWriteRequest,
} from "../shared/terminal-contract";

// Custom APIs for renderer
const api = {
  openDirectory: (directory: string) => ipcRenderer.invoke("open-directory", directory),
  openExternal: (url: string) => ipcRenderer.invoke("open-external", url),
  pickDirectory: () => ipcRenderer.invoke("pick-directory"),
  migrateStorage: (directory: string) => ipcRenderer.invoke("migrate-storage", directory),
  resetAppData: () => ipcRenderer.invoke("reset-app-data"),
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
