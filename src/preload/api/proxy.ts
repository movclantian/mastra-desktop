import type { IpcRenderer } from "electron";
import {
  GetProxyResultSchema,
  PROXY_CHANNELS,
  type ProxyConfig,
  SetProxyRequestSchema,
  SetProxyResultSchema,
  TestProxyRequestSchema,
  TestProxyResultSchema,
} from "../../shared/proxy-contract";

export function createProxyApi(ipcRenderer: IpcRenderer) {
  return {
    get: async () => GetProxyResultSchema.parse(await ipcRenderer.invoke(PROXY_CHANNELS.get)),
    set: async (config: ProxyConfig) =>
      SetProxyResultSchema.parse(
        await ipcRenderer.invoke(PROXY_CHANNELS.set, SetProxyRequestSchema.parse(config)),
      ),
    test: async (url?: string) =>
      TestProxyResultSchema.parse(
        await ipcRenderer.invoke(PROXY_CHANNELS.test, TestProxyRequestSchema.parse({ url })),
      ),
  };
}
