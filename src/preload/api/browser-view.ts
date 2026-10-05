import type { IpcRenderer, IpcRendererEvent } from "electron";
import {
  type BrowserAction,
  type BrowserState,
  NATIVE_BROWSER_VIEW_CHANNELS,
  NativeBrowserActionSchema,
  type NativeBrowserBounds,
  NativeBrowserBoundsSchema,
  type NativeBrowserEvent,
  NativeBrowserEventSchema,
  NativeBrowserNavigateSchema,
  type NativeBrowserSession,
  NativeBrowserSessionSchema,
} from "../../shared/browser-contract";

export function createBrowserViewApi(ipcRenderer: IpcRenderer) {
  return {
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
    ): Promise<BrowserState> =>
      ipcRenderer.invoke(
        NATIVE_BROWSER_VIEW_CHANNELS.action,
        NativeBrowserActionSchema.parse({
          ...session,
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

export type BrowserViewApi = ReturnType<typeof createBrowserViewApi>;
