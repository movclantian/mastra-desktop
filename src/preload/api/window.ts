import type { IpcRenderer } from "electron";
import {
  SetMinimumWidthRequestSchema,
  type ShowWindowMenuRequest,
  ShowWindowMenuRequestSchema,
  WINDOW_CHANNELS,
} from "../../shared/window-contract";

export function createWindowApi(ipcRenderer: IpcRenderer) {
  return {
    showMenu: (request: ShowWindowMenuRequest): Promise<string | null> =>
      ipcRenderer.invoke(WINDOW_CHANNELS.showMenu, ShowWindowMenuRequestSchema.parse(request)),
    setMinimumWidth: (width: number) =>
      ipcRenderer.send(WINDOW_CHANNELS.setMinimumWidth, SetMinimumWidthRequestSchema.parse(width)),
  };
}
