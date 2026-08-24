import type { IpcRenderer } from "electron";

export function createWorkspaceApi(ipcRenderer: IpcRenderer) {
  return {
    detectIdes: () =>
      ipcRenderer.invoke("detect-ides") as Promise<
        Array<{ id: string; name: string; command: string; category: "ide" | "system" }>
      >,
    openInApp: (app: string, targetPath: string) =>
      ipcRenderer.invoke("open-in-app", { app, targetPath }) as Promise<{
        ok: boolean;
        error?: string;
      }>,
    openExternal: (url: string) => ipcRenderer.invoke("open-external", url) as Promise<void>,
  };
}
