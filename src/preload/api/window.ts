import type { IpcRenderer } from "electron";
import { SetMinimumWidthRequestSchema, WINDOW_CHANNELS } from "../../shared/window-contract";

export function createWindowApi(ipcRenderer: IpcRenderer) {
  return {
    setMinimumWidth: (width: number) =>
      ipcRenderer.send(WINDOW_CHANNELS.setMinimumWidth, SetMinimumWidthRequestSchema.parse(width)),
  };
}
