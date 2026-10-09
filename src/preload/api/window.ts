import type { IpcRenderer } from "electron";
import {
  ComputerPermissionActionSchema,
  ComputerPermissionsSchema,
  type DesktopNotification,
  DesktopNotificationSchema,
  type DesktopSettingsPatch,
  DesktopSettingsPatchSchema,
  DesktopSettingsSchema,
  SetMinimumWidthRequestSchema,
  WINDOW_CHANNELS,
  type WindowControlAction,
  WindowControlActionSchema,
  type WindowState,
  WindowStateSchema,
} from "../../shared/window-contract";

export function createWindowApi(ipcRenderer: IpcRenderer) {
  return {
    control: async (action: WindowControlAction): Promise<void> => {
      await ipcRenderer.invoke(WINDOW_CHANNELS.control, WindowControlActionSchema.parse(action));
    },
    getState: async () =>
      WindowStateSchema.parse(await ipcRenderer.invoke(WINDOW_CHANNELS.getState)),
    onStateChange: (callback: (state: WindowState) => void) => {
      const listener = (_event: unknown, value: unknown) => {
        const state = WindowStateSchema.safeParse(value);
        if (state.success) callback(state.data);
      };
      ipcRenderer.on(WINDOW_CHANNELS.stateChanged, listener);
      return () => {
        ipcRenderer.removeListener(WINDOW_CHANNELS.stateChanged, listener);
      };
    },
    computerPermissions: async (action: "status" | "request") =>
      ComputerPermissionsSchema.parse(
        await ipcRenderer.invoke(
          WINDOW_CHANNELS.computerPermissions,
          ComputerPermissionActionSchema.parse(action),
        ),
      ),
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
