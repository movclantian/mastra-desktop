import type { IpcRenderer } from "electron";

export function createFilesystemApi(ipcRenderer: IpcRenderer) {
  return {
    openDirectory: (directory: string) =>
      ipcRenderer.invoke("open-directory", directory) as Promise<string>,
    pickDirectory: () => ipcRenderer.invoke("pick-directory") as Promise<string>,
  };
}
