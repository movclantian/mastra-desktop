import type { IpcRenderer } from "electron";
import {
  type DesktopNotification,
  DesktopNotificationSchema,
  type DesktopSettingsPatch,
  DesktopSettingsPatchSchema,
  DesktopSettingsSchema,
  SetMinimumWidthRequestSchema,
  WINDOW_CHANNELS,
} from "../../shared/window-contract";

export function createWindowApi(ipcRenderer: IpcRenderer) {
  return {
    getSettings: async () =>
      DesktopSettingsSchema.parse(await ipcRenderer.invoke(WINDOW_CHANNELS.getSettings)),
    updateSettings: async (patch: DesktopSettingsPatch) =>
      DesktopSettingsSchema.parse(
        await ipcRenderer.invoke(
          WINDOW_CHANNELS.updateSettings,
          DesktopSettingsPatchSchema.parse(patch),
        ),
      ),
    notify: (notification: DesktopNotification) =>
      ipcRenderer.invoke(
        WINDOW_CHANNELS.notify,
        DesktopNotificationSchema.parse(notification),
      ) as Promise<boolean>,
    onNotificationClick: (callback: (notification: DesktopNotification) => void) => {
      const listener = (_event: unknown, value: unknown) => {
        const notification = DesktopNotificationSchema.safeParse(value);
        if (notification.success) callback(notification.data);
      };
      ipcRenderer.on(WINDOW_CHANNELS.notificationClick, listener);
      return () => {
        ipcRenderer.removeListener(WINDOW_CHANNELS.notificationClick, listener);
      };
    },
    setMinimumWidth: (width: number) =>
      ipcRenderer.send(WINDOW_CHANNELS.setMinimumWidth, SetMinimumWidthRequestSchema.parse(width)),
  };
}
