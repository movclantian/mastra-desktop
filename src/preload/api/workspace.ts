import type { IpcRenderer } from "electron";
import {
  DetectIdesResultSchema,
  OpenExternalRequestSchema,
  OpenExternalResultSchema,
  type OpenInAppRequest,
  OpenInAppRequestSchema,
  OpenInAppResultSchema,
  WORKSPACE_CHANNELS,
} from "../../shared/workspace-contract";

export function createWorkspaceApi(ipcRenderer: IpcRenderer) {
  return {
    detectIdes: async () =>
      DetectIdesResultSchema.parse(await ipcRenderer.invoke(WORKSPACE_CHANNELS.detectIdes)),
    openInApp: async (app: OpenInAppRequest["app"], targetPath: string) =>
      OpenInAppResultSchema.parse(
        await ipcRenderer.invoke(
          WORKSPACE_CHANNELS.openInApp,
          OpenInAppRequestSchema.parse({ app, targetPath }),
        ),
      ),
    openExternal: async (url: string) =>
      OpenExternalResultSchema.parse(
        await ipcRenderer.invoke(
          WORKSPACE_CHANNELS.openExternal,
          OpenExternalRequestSchema.parse(url),
        ),
      ),
  };
}
