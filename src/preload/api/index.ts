import type { IpcRenderer } from "electron";
import { createFilesystemApi } from "./filesystem";
import { createStorageApi } from "./storage";
import { createTerminalApi } from "./terminal";
import { createWindowApi } from "./window";
import { createWorkspaceApi } from "./workspace";

export function createPreloadApi(ipcRenderer: IpcRenderer) {
  return {
    filesystem: createFilesystemApi(ipcRenderer),
    workspace: createWorkspaceApi(ipcRenderer),
    storage: createStorageApi(ipcRenderer),
    window: createWindowApi(ipcRenderer),
    terminal: createTerminalApi(ipcRenderer),
  };
}
