import type { IpcRenderer } from "electron";
import {
  MigrateStorageRequestSchema,
  MigrateStorageResultSchema,
  ResetAppDataResultSchema,
  STORAGE_CHANNELS,
} from "../../shared/storage-contract";

export function createStorageApi(ipcRenderer: IpcRenderer) {
  return {
    migrate: async (directory: string) =>
      MigrateStorageResultSchema.parse(
        await ipcRenderer.invoke(
          STORAGE_CHANNELS.migrate,
          MigrateStorageRequestSchema.parse(directory),
        ),
      ),
    reset: async () =>
      ResetAppDataResultSchema.parse(await ipcRenderer.invoke(STORAGE_CHANNELS.reset)),
  };
}
