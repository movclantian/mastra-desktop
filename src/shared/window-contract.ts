import { z } from "zod";

export const WINDOW_CHANNELS = {
  setMinimumWidth: "window:set-minimum-width",
  getSettings: "window:get-settings",
  updateSettings: "window:update-settings",
  notify: "window:notify",
  notificationClick: "window:notification-click",
} as const;

export const SetMinimumWidthRequestSchema = z.number().finite().positive().max(32_767);

export const DesktopPreferencesSchema = z
  .object({
    showWorkDetails: z.boolean(),
    scheduledTaskNotifications: z.boolean(),
    desktopNotifications: z.boolean(),
    openLocalLinksInBrowser: z.boolean(),
  })
  .strict();
export const DEFAULT_DESKTOP_PREFERENCES = {
  showWorkDetails: false,
  scheduledTaskNotifications: false,
  desktopNotifications: false,
  openLocalLinksInBrowser: true,
} satisfies z.infer<typeof DesktopPreferencesSchema>;
export const DesktopSettingsSchema = DesktopPreferencesSchema.extend({
  launchAtLogin: z.boolean(),
  launchAtLoginSupported: z.boolean(),
  notificationsSupported: z.boolean(),
});
export const DesktopSettingsPatchSchema = DesktopPreferencesSchema.extend({
  launchAtLogin: z.boolean(),
}).partial();
export type DesktopSettingsPatch = z.infer<typeof DesktopSettingsPatchSchema>;
export const DesktopNotificationSchema = z
  .object({
    id: z.string().min(1).max(256),
    resourceId: z.string().min(1).max(256),
    threadId: z.string().min(1).max(256),
    kind: z.enum(["task", "schedule"]),
    title: z.string().min(1).max(256),
    body: z.string().max(500),
  })
  .strict();
export type DesktopNotification = z.infer<typeof DesktopNotificationSchema>;

/** Local development URLs belong in the workbench; external web links keep the OS default. */
export function isLocalWebUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      (url.hostname === "localhost" ||
        url.hostname.endsWith(".localhost") ||
        url.hostname === "[::1]" ||
        url.hostname === "0.0.0.0" ||
        /^127(?:\.\d{1,3}){3}$/.test(url.hostname))
    );
  } catch {
    return false;
  }
}
