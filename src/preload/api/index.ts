import type { IpcRenderer } from "electron";
import { createCredentialsApi } from "./credentials";
import { createFilesystemApi } from "./filesystem";
import { createProxyApi } from "./proxy";
import { createStorageApi } from "./storage";
import { createTerminalApi } from "./terminal";
import { createWindowApi } from "./window";
import { createWorkspaceApi } from "./workspace";

export function createPreloadApi(ipcRenderer: IpcRenderer) {
  return {
    credentials: createCredentialsApi(ipcRenderer),
    filesystem: createFilesystemApi(ipcRenderer),
    workspace: createWorkspaceApi(ipcRenderer),
    storage: createStorageApi(ipcRenderer),
    window: createWindowApi(ipcRenderer),
    terminal: createTerminalApi(ipcRenderer),
    proxy: createProxyApi(ipcRenderer),
  };
}

export type PreloadApi = ReturnType<typeof createPreloadApi>;
