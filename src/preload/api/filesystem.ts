import type { IpcRenderer } from "electron";
import {
  FILESYSTEM_CHANNELS,
  OpenDirectoryRequestSchema,
  OpenDirectoryResultSchema,
  PickDirectoryResultSchema,
} from "../../shared/filesystem-contract";

export function createFilesystemApi(ipcRenderer: IpcRenderer) {
  return {
    openDirectory: async (directory: string) =>
      OpenDirectoryResultSchema.parse(
        await ipcRenderer.invoke(
          FILESYSTEM_CHANNELS.openDirectory,
          OpenDirectoryRequestSchema.parse(directory),
        ),
      ),
    pickDirectory: async () =>
      PickDirectoryResultSchema.parse(await ipcRenderer.invoke(FILESYSTEM_CHANNELS.pickDirectory)),
  };
}
