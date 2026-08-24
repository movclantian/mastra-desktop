import type { IpcRenderer } from "electron";

export function createWindowApi(ipcRenderer: IpcRenderer) {
  return {
    setMinimumWidth: (width: number) => ipcRenderer.send("set-minimum-width", width),
  };
}
