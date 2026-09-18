import type { IpcRenderer } from "electron";
import {
  CREDENTIAL_CHANNELS,
  CredentialDeleteRequestSchema,
  CredentialDeleteResultSchema,
  CredentialPutRequestSchema,
  CredentialPutResultSchema,
} from "../../shared/credential-contract";

export function createCredentialsApi(ipcRenderer: IpcRenderer) {
  return {
    put: async (request: unknown) =>
      CredentialPutResultSchema.parse(
        await ipcRenderer.invoke(
          CREDENTIAL_CHANNELS.put,
          CredentialPutRequestSchema.parse(request),
        ),
      ),
    delete: async (request: unknown) =>
      CredentialDeleteResultSchema.parse(
        await ipcRenderer.invoke(
          CREDENTIAL_CHANNELS.delete,
          CredentialDeleteRequestSchema.parse(request),
        ),
      ),
  };
}
