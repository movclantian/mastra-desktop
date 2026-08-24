import type { IpcRenderer } from "electron";

export function createStorageApi(ipcRenderer: IpcRenderer) {
  return {
    migrate: (directory: string) =>
      ipcRenderer.invoke("migrate-storage", directory) as Promise<boolean>,
    reset: () => ipcRenderer.invoke("reset-app-data") as Promise<boolean>,
  };
}
