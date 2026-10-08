import type { IpcRenderer, IpcRendererEvent } from "electron";
import {
  type BrowserAction,
  type BrowserState,
  NATIVE_BROWSER_VIEW_CHANNELS,
  NativeBrowserActionSchema,
  NativeBrowserBindGuestSchema,
  type NativeBrowserBounds,
  NativeBrowserBoundsSchema,
  type NativeBrowserConfig,
  NativeBrowserConfigSchema,
  type NativeBrowserEvent,
  NativeBrowserEventSchema,
  NativeBrowserNavigateSchema,
  type NativeBrowserSession,
  NativeBrowserSessionSchema,
  type NativeBrowserSurface,
  NativeBrowserSurfacesSchema,
} from "../../shared/browser-contract";

export function createBrowserViewApi(ipcRenderer: IpcRenderer) {
  return {
    configure: (config: NativeBrowserConfig): Promise<void> =>
      ipcRenderer.invoke(
        NATIVE_BROWSER_VIEW_CHANNELS.configure,
        NativeBrowserConfigSchema.parse(config),
      ),
    bindGuest: (tabId: string, guestId: number): Promise<void> =>
      ipcRenderer.invoke(
        NATIVE_BROWSER_VIEW_CHANNELS.bindGuest,
        NativeBrowserBindGuestSchema.parse({ tabId, guestId }),
      ),
    getSurfaces: async (): Promise<NativeBrowserSurface[]> =>
      NativeBrowserSurfacesSchema.parse(
        await ipcRenderer.invoke(NATIVE_BROWSER_VIEW_CHANNELS.getSurfaces),
      ),
    onSurfaces: (listener: (surfaces: NativeBrowserSurface[]) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, value: unknown) => {
        const parsed = NativeBrowserSurfacesSchema.safeParse(value);
        if (parsed.success) listener(parsed.data);
      };
      ipcRenderer.on(NATIVE_BROWSER_VIEW_CHANNELS.surfaces, handler);
      return () => ipcRenderer.removeListener(NATIVE_BROWSER_VIEW_CHANNELS.surfaces, handler);
    },
    ensure: async (session: NativeBrowserSession): Promise<BrowserState> =>
      ipcRenderer.invoke(
        NATIVE_BROWSER_VIEW_CHANNELS.ensure,
        NativeBrowserSessionSchema.parse(session),
      ),
    setBounds: (bounds: NativeBrowserBounds) => {
      ipcRenderer.send(
        NATIVE_BROWSER_VIEW_CHANNELS.setBounds,
        NativeBrowserBoundsSchema.parse(bounds),
      );
    },
    navigate: async (session: NativeBrowserSession, url: string): Promise<BrowserState> =>
      ipcRenderer.invoke(
        NATIVE_BROWSER_VIEW_CHANNELS.navigate,
        NativeBrowserNavigateSchema.parse({ ...session, url }),
      ),
    action: async (
      session: NativeBrowserSession,
      action: BrowserAction,
      index?: number,
      url?: string,
      tabId?: string,
    ): Promise<BrowserState> =>
      ipcRenderer.invoke(
        NATIVE_BROWSER_VIEW_CHANNELS.action,
        NativeBrowserActionSchema.parse({
          ...session,
          ...(tabId ? { tabId } : {}),
          request: {
            action,
            ...(index === undefined ? {} : { index }),
            ...(url ? { url } : {}),
          },
        }),
      ),
    getState: async (session: NativeBrowserSession): Promise<BrowserState | null> =>
      ipcRenderer.invoke(
        NATIVE_BROWSER_VIEW_CHANNELS.getState,
        NativeBrowserSessionSchema.parse(session),
      ),
    close: async (session: NativeBrowserSession): Promise<void> =>
      ipcRenderer.invoke(
        NATIVE_BROWSER_VIEW_CHANNELS.close,
        NativeBrowserSessionSchema.parse(session),
      ),
    onEvent: (listener: (event: NativeBrowserEvent) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, value: unknown) => {
        const parsed = NativeBrowserEventSchema.safeParse(value);
        if (parsed.success) listener(parsed.data);
      };
      ipcRenderer.on(NATIVE_BROWSER_VIEW_CHANNELS.event, handler);
      return () => ipcRenderer.removeListener(NATIVE_BROWSER_VIEW_CHANNELS.event, handler);
    },
  };
}
